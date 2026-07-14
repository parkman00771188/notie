"""Gemini API 사용량 기록 + 비용 추정 서비스.

모든 Gemini generateContent 호출(STT 전사/요약/연결 테스트)의 usageMetadata를
api_usage 테이블에 기록하고, 공식 가격표 기준으로 요청당 비용(USD)을 추정한다.

- record(kind, model, usage_metadata, user_id, meeting_id): 호출 1건 기록.
  실패해도 절대 예외를 던지지 않는다(사용량 기록이 본 기능을 깨면 안 됨).
- estimate_cost_usd(model, ...): 토큰 수 → 예상 비용(USD).
- 가격표는 https://ai.google.dev/gemini-api/docs/pricing 기준 (PRICING_ASOF).
  미등록 모델은 _DEFAULT_RATE로 추정하고 estimated=True로 표시한다.
"""

import logging

from .. import db

logger = logging.getLogger("gimnote.usage")

# 가격 확인 일자 — 가격표 갱신 시 함께 수정
PRICING_ASOF = "2026-07-14"

# USD / 1M tokens. tier가 있으면 프롬프트가 tier_threshold 토큰을 넘는 요청 전체에
# tier_input/tier_output 단가가 적용된다(Gemini 과금 방식). 출력 단가는 사고(thinking)
# 토큰 포함. match는 모델명 접두사 — 구체적인 것(flash-lite)을 먼저 매칭하도록
# 접두사 길이 내림차순으로 검사한다.
PRICING: list[dict] = [
    {"match": "gemini-3.5-flash", "input": 1.50, "input_audio": 1.50, "output": 9.00},
    {"match": "gemini-3.1-flash-lite", "input": 0.25, "input_audio": 0.50, "output": 1.50},
    {
        "match": "gemini-3.1-pro",
        "input": 2.00, "input_audio": 2.00, "output": 12.00,
        "tier_threshold": 200_000, "tier_input": 4.00, "tier_output": 18.00,
    },
    {
        "match": "gemini-3-pro",
        "input": 2.00, "input_audio": 2.00, "output": 12.00,
        "tier_threshold": 200_000, "tier_input": 4.00, "tier_output": 18.00,
    },
    {"match": "gemini-3-flash", "input": 0.50, "input_audio": 1.00, "output": 3.00},
    {
        "match": "gemini-2.5-pro",
        "input": 1.25, "input_audio": 1.25, "output": 10.00,
        "tier_threshold": 200_000, "tier_input": 2.50, "tier_output": 15.00,
    },
    {"match": "gemini-2.5-flash-lite", "input": 0.10, "input_audio": 0.30, "output": 0.40},
    {"match": "gemini-2.5-flash", "input": 0.30, "input_audio": 1.00, "output": 2.50},
    {"match": "gemini-2.0-flash-lite", "input": 0.075, "input_audio": 0.075, "output": 0.30},
    {"match": "gemini-2.0-flash", "input": 0.10, "input_audio": 0.70, "output": 0.40},
    # 은퇴 세대 — 과거 기록 비용 계산용으로 유지
    {"match": "gemini-1.5-pro", "input": 1.25, "input_audio": 1.25, "output": 5.00},
    {"match": "gemini-1.5-flash", "input": 0.075, "input_audio": 0.075, "output": 0.30},
    # 별칭 — 현재 최신 세대 단가로 매핑
    {"match": "gemini-flash-lite-latest", "input": 0.25, "input_audio": 0.50, "output": 1.50},
    {"match": "gemini-flash-latest", "input": 1.50, "input_audio": 1.50, "output": 9.00},
]

# 가격표에 없는 모델의 추정 단가 (중간급 flash 수준으로 가정)
_DEFAULT_RATE = {"input": 0.50, "input_audio": 1.00, "output": 3.00}

# 접두사 긴 것부터 — "gemini-2.5-flash-lite"가 "gemini-2.5-flash"보다 먼저 잡히게
_PRICING_SORTED = sorted(PRICING, key=lambda e: len(e["match"]), reverse=True)


def find_rate(model: str) -> tuple[dict, bool]:
    """모델명에 맞는 단가 엔트리 반환. 반환: (엔트리, 가격표에 있는 모델인지)."""
    name = (model or "").strip().lower()
    if name.startswith("models/"):
        name = name[len("models/"):]
    for entry in _PRICING_SORTED:
        if name.startswith(entry["match"]):
            return entry, True
    return {"match": name or "(unknown)", **_DEFAULT_RATE}, False


def estimate_cost_usd(
    model: str,
    prompt_tokens: int,
    prompt_audio_tokens: int,
    output_tokens: int,
) -> float:
    """요청 1건의 예상 비용(USD). 오디오 프롬프트 토큰은 별도 단가 적용."""
    rate, _known = find_rate(model)
    threshold = rate.get("tier_threshold")
    if threshold and prompt_tokens > threshold:
        in_rate = rate.get("tier_input", rate["input"])
        out_rate = rate.get("tier_output", rate["output"])
        audio_rate = in_rate  # 장문 tier에서는 오디오 구분 단가가 공개되지 않음
    else:
        in_rate = rate["input"]
        out_rate = rate["output"]
        audio_rate = rate.get("input_audio", rate["input"])

    text_tokens = max(0, prompt_tokens - prompt_audio_tokens)
    cost = (
        text_tokens * in_rate
        + prompt_audio_tokens * audio_rate
        + output_tokens * out_rate
    ) / 1_000_000
    return round(cost, 8)


def _modality_tokens(details, modality: str) -> int:
    """promptTokensDetails 배열에서 특정 modality 토큰 수를 꺼낸다."""
    if not isinstance(details, list):
        return 0
    total = 0
    for item in details:
        if isinstance(item, dict) and str(item.get("modality") or "").upper() == modality:
            try:
                total += int(item.get("tokenCount") or 0)
            except (TypeError, ValueError):
                pass
    return total


def parse_usage_metadata(usage_metadata) -> dict:
    """generateContent 응답의 usageMetadata → 정규화된 토큰 카운트 dict."""
    meta = usage_metadata if isinstance(usage_metadata, dict) else {}

    def _int(key: str) -> int:
        try:
            return max(0, int(meta.get(key) or 0))
        except (TypeError, ValueError):
            return 0

    prompt = _int("promptTokenCount")
    candidates = _int("candidatesTokenCount")
    thoughts = _int("thoughtsTokenCount")
    total = _int("totalTokenCount") or (prompt + candidates + thoughts)
    audio = min(prompt, _modality_tokens(meta.get("promptTokensDetails"), "AUDIO"))
    return {
        "prompt_tokens": prompt,
        "prompt_audio_tokens": audio,
        "output_tokens": candidates + thoughts,  # 사고 토큰도 출력 단가로 과금됨
        "thoughts_tokens": thoughts,
        "total_tokens": total,
    }


def record(
    kind: str,
    model: str,
    usage_metadata,
    user_id: int | None = None,
    meeting_id: int | None = None,
) -> None:
    """Gemini 호출 1건의 사용량을 기록한다. 어떤 경우에도 예외를 던지지 않는다.

    kind: 'stt'(음성 변환) | 'summary'(요약) | 'test'(연결 테스트) | 'other'
    """
    try:
        counts = parse_usage_metadata(usage_metadata)
        if counts["total_tokens"] <= 0:
            return  # usageMetadata가 없거나 비어 있으면 기록할 것이 없다
        cost = estimate_cost_usd(
            model,
            counts["prompt_tokens"],
            counts["prompt_audio_tokens"],
            counts["output_tokens"],
        )
        conn = db.get_conn()
        try:
            user_name = None
            user_role = None
            user_organization = None
            user_department = None
            if user_id is not None:
                row = conn.execute(
                    "SELECT name, role, organization, department FROM users WHERE id = ?",
                    (user_id,),
                ).fetchone()
                if row is not None:
                    user_name = row["name"]
                    user_role = row["role"]
                    # 빈 문자열은 '호출 당시 미지정'이라는 유효한 스냅샷이다.
                    user_organization = row["organization"] or ""
                    user_department = row["department"] or ""
            with conn:
                conn.execute(
                    """
                    INSERT INTO api_usage (
                      user_id, user_name, user_role, user_organization,
                      user_department, meeting_id, kind, model,
                      prompt_tokens, prompt_audio_tokens, output_tokens,
                      thoughts_tokens, total_tokens, est_cost_usd
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        user_id,
                        user_name,
                        user_role,
                        user_organization,
                        user_department,
                        meeting_id,
                        kind or "other",
                        (model or "").strip(),
                        counts["prompt_tokens"],
                        counts["prompt_audio_tokens"],
                        counts["output_tokens"],
                        counts["thoughts_tokens"],
                        counts["total_tokens"],
                        cost,
                    ),
                )
        finally:
            conn.close()
    except Exception as exc:
        logger.warning("usage: 사용량 기록 실패(무시됨): %s", exc)


def pricing_table() -> list[dict]:
    """프론트 표시용 가격표 (USD / 1M tokens)."""
    return [
        {
            "model": e["match"],
            "input": e["input"],
            "input_audio": e.get("input_audio", e["input"]),
            "output": e["output"],
            "tier_threshold": e.get("tier_threshold"),
            "tier_input": e.get("tier_input"),
            "tier_output": e.get("tier_output"),
        }
        for e in PRICING
    ]
