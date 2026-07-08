"""요약 서비스 — Gemini(키 등록 시) → Ollama → 한국어 추출 요약 폴백.

계약 (SPEC.md):
- summarize(meeting, segments, bookmarks, participants) ->
  {"key_points": [str], "decisions": [str], "followups": [str],
   "action_items": [{"text": str, "owner": str|None, "due": str|None}],
   "discussion": str, "minutes_md": str, "engine": str, "engine_note": str|None}
- 1차: Gemini — API 키(app_settings 'gemini_api_key' 우선, 없으면 환경변수)가 있으면
  POST {GEMINI_BASE_URL}/models/{GEMINI_MODEL}:generateContent
  (generationConfig.response_mime_type="application/json", timeout 120s).
  engine="gemini:<model>". 응답 파싱은 방어적으로(코드펜스 제거, 항목별 폴백 병합).
- 2차: Ollama — GET {OLLAMA_URL}/api/tags (timeout 2s)로 가용성 확인,
  POST /api/chat (stream=False, format="json", timeout 300s). engine="ollama:<model>".
  응답 JSON 파싱은 방어적으로: 키 누락/타입 오류 시 추출 요약 결과를 병합.
- 폴백: 추출 요약 (engine="extractive"). 각 엔진 실패는 로그 출력 후 다음으로.
- minutes_md 마크다운 구조는 모든 엔진 공통 (K1: 참석자/회의내용/핵심내용/결정사항/
  추가 확인 필요/타임라인/일반 메모 — 액션 아이템은 AI 요약 탭에만 노출).
- discussion(str): 주제별로 묶은 회의내용 마크다운. followups(list[str]): 추가 확인 필요 사항.
  engine_note(str|None): Gemini/Ollama 실패로 폴백했을 때 사람이 읽을 한국어 사유
  (HTTP 상태 포함, API 키는 절대 미포함). 정상이면 None.
- 세그먼트 0개(무음)면 빈 배열 + "인식된 음성이 없습니다" 안내.
- test_gemini_key(key) -> (ok, message): settings API의 연결 테스트에서 재사용.
- 2차 개선 A: get_summary_prompt() — app_settings 'summary_prompt' 조회(사용자 지정 지시사항).
  LLM 프롬프트에 (a) 사용자 지시사항 섹션(있을 때만), (b) 북마크 목록 + 메모를
  요약/회의록에 반드시 반영하라는 지시 포함.
- SPEC H+I(메모 필터/일반 메모): LLM 프롬프트의 북마크 목록은 kind='mark' 제외,
  kind='memo'(또는 kind 없는 레거시 dict)는 "[HH:MM:SS] 제목", kind='note'는 "(일반 메모) 제목".
- SPEC H(장문 스크립트 파일 첨부): Gemini 호출 시 전체 스크립트가
  config.GEMINI_ATTACH_THRESHOLD 초과이면 프롬프트에 인라인하지 않고
  parts=[{text: 지시문+메모목록+transcript.txt 참고 안내}, {inline_data: base64 텍스트 파일}]로 첨부.
  임계값 이하는 기존 인라인 유지. Ollama는 항상 인라인.
- SPEC J5(Gemini 모델 선택): get_gemini_model() — app_settings 'gemini_model' 우선,
  없으면 config.GEMINI_MODEL. _try_gemini/test_gemini_key가 사용(URL·engine 문자열 모두).
"""

import base64
import json
import logging
import re
from collections import Counter

from .. import config, db

logger = logging.getLogger("gimnote.summarizer")

# 추출 요약 패턴 (SPEC 고정)
_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?다요죠음됨함])\s+")
_DECISION_RE = re.compile(r"결정|확정|하기로|승인|합의|채택|진행하기로")
_ACTION_RE = re.compile(r"해야|할 일|까지|담당|예정|부탁|준비|공유하기로")
_FOLLOWUP_RE = re.compile(r"확인 필요|검토|추후|다시 논의|파악")  # K1 추가 확인 필요 사항 패턴
_WORD_RE = re.compile(r"[가-힣a-zA-Z0-9]{2,}")

_MIN_SENTENCE_LEN = 10       # 이보다 짧은 문장 제외
_MAX_ITEMS_EXTRACTIVE = 5    # 폴백 시 각 항목 최대 개수
_MAX_DISCUSSION_EXTRACTIVE = 8  # 폴백 회의내용 불릿 상위 문장 최대 개수 (5~8)
_MAX_ITEMS_LLM = 8           # LLM(Gemini/Ollama) 응답 방어적 상한
_MAX_TRANSCRIPT_CHARS = 12000  # 프롬프트에 넣을 녹취록 길이 제한

# HTTP 상태 코드 → 사람이 읽을 한국어 사유 (engine_note용 — 민감정보 미포함)
_HTTP_REASONS = {
    400: "잘못된 요청",
    401: "인증 실패(API 키 확인 필요)",
    403: "접근 거부(API 키 확인 필요)",
    404: "모델 또는 엔드포인트 없음",
    429: "요청 한도 초과",
    500: "서버 오류",
    503: "서버 일시적 사용 불가",
}

GEMINI_KEY_SETTING = "gemini_api_key"
GEMINI_MODEL_SETTING = "gemini_model"
SUMMARY_PROMPT_SETTING = "summary_prompt"
MANUAL_SUMMARY_PROMPT_SETTING = "manual_summary_prompt"


# ---------------------------------------------------------------------------
# 공개 API
# ---------------------------------------------------------------------------

def summarize(
    meeting: dict,
    segments: list[dict],
    bookmarks: list[dict],
    participants: list[dict],
    prompt_kind: str = "recording",
) -> dict:
    """회의를 요약하여 key_points/decisions/action_items/minutes_md/engine을 반환한다."""
    meeting = meeting or {}
    segments = segments or []
    bookmarks = bookmarks or []
    participants = participants or []
    prompt_kind = "manual" if prompt_kind == "manual" else "recording"

    texts = [str(s.get("text") or "").strip() for s in segments]
    texts = [t for t in texts if t]

    # 무음(세그먼트 0개) — 빈 요약 + 안내 문구로 정상 처리
    if not texts:
        notice = (
            "인식된 음성이 없습니다. 녹음 파일에서 인식 가능한 음성을 찾지 못했어요. "
            "마이크 상태를 확인한 뒤 다시 녹음해보세요."
        )
        minutes_md = _build_minutes_md(
            meeting, participants, bookmarks, [], [], [], notice, []
        )
        return {
            "key_points": [],
            "decisions": [],
            "action_items": [],
            "discussion": notice,
            "followups": [],
            "minutes_md": minutes_md,
            "engine": "extractive",
            "engine_note": None,
        }

    transcript = "\n".join(texts)

    # 폴백(추출 요약)은 필요할 때 한 번만 계산
    _fallback_cache: dict = {}

    def fallback() -> dict:
        if not _fallback_cache:
            _fallback_cache.update(_extractive_summary(transcript))
        return _fallback_cache

    engine = "extractive"
    key_points: list | None = None
    decisions: list | None = None
    action_items: list | None = None
    followups: list | None = None
    discussion: str | None = None
    # 폴백 사유 (사람이 읽을 한국어, 민감정보 미포함) — engine_note 구성에 사용
    gemini_note: str | None = None
    ollama_note: str | None = None

    # 1차: Gemini (API 키가 등록된 경우)
    gemini_key = get_gemini_key()
    if gemini_key:
        try:
            parsed, model_name = _try_gemini(
                meeting, transcript, bookmarks, participants, gemini_key, prompt_kind
            )
            engine = f"gemini:{model_name}"
            key_points = _clean_str_list(parsed.get("key_points"), _MAX_ITEMS_LLM)
            decisions = _clean_str_list(parsed.get("decisions"), _MAX_ITEMS_LLM)
            followups = _clean_str_list(parsed.get("followups"), _MAX_ITEMS_LLM)
            action_items = _clean_action_items(parsed.get("action_items"), _MAX_ITEMS_LLM)
            discussion = _clean_discussion(parsed.get("discussion"))
        except Exception as exc:
            # 네트워크/HTTP 오류/JSON 파싱 실패 → Ollama로 폴백
            logger.warning("summarizer: Gemini 요약 실패 — Ollama로 폴백: %s", exc)
            gemini_note = _describe_llm_error("Gemini", exc)
            engine = "extractive"

    # 2차: Ollama (Gemini 키가 없거나 실패한 경우)
    if engine == "extractive":
        try:
            parsed, model_name = _summarize_with_ollama(
                meeting, transcript, bookmarks, participants, prompt_kind
            )
            engine = f"ollama:{model_name}"
            key_points = _clean_str_list(parsed.get("key_points"), _MAX_ITEMS_LLM)
            decisions = _clean_str_list(parsed.get("decisions"), _MAX_ITEMS_LLM)
            followups = _clean_str_list(parsed.get("followups"), _MAX_ITEMS_LLM)
            action_items = _clean_action_items(parsed.get("action_items"), _MAX_ITEMS_LLM)
            discussion = _clean_discussion(parsed.get("discussion"))
        except Exception as exc:
            # Ollama 미설치/미실행/타임아웃/JSON 파싱 실패 → 전체 추출 요약 폴백
            logger.warning("summarizer: Ollama 요약 실패 — 추출 요약으로 폴백: %s", exc)
            ollama_note = _describe_llm_error("Ollama", exc)
            engine = "extractive"

    # 방어적 병합: 키 누락/타입 오류(None) 시 폴백(추출 요약) 결과 사용.
    # followups는 빈 배열([])이 유효(확인 필요 사항 없음)하므로 None일 때만 병합.
    if not key_points:
        key_points = fallback()["key_points"]
    if decisions is None:
        decisions = fallback()["decisions"]
    if action_items is None:
        action_items = fallback()["action_items"]
    if followups is None:
        followups = fallback()["followups"]
    if not discussion:
        discussion = fallback()["discussion"]

    engine_note = _build_engine_note(engine, gemini_note, ollama_note)

    minutes_md = _build_minutes_md(
        meeting, participants, bookmarks, key_points, decisions, action_items,
        discussion, followups,
    )
    return {
        "key_points": key_points,
        "decisions": decisions,
        "action_items": action_items,
        "discussion": discussion,
        "followups": followups,
        "minutes_md": minutes_md,
        "engine": engine,
        "engine_note": engine_note,
    }


# ---------------------------------------------------------------------------
# LLM 공통 (프롬프트)
# ---------------------------------------------------------------------------

_LLM_SYSTEM_PROMPT = (
    "당신은 한국어 회의록 작성 전문가입니다. "
    "반드시 유효한 JSON 객체 하나만 출력하고, JSON 외의 텍스트는 절대 포함하지 마세요. "
    "사용자 지정 지시사항이 출력 형식이나 섹션 형식을 요구하더라도, "
    "최종 응답 형식은 JSON 스키마를 최우선으로 따르세요."
)


def get_summary_prompt(prompt_kind: str = "recording") -> str | None:
    """사용자 지정 요약 지시사항 조회 — 녹음/직접 작성 프롬프트를 분리한다."""
    setting_key = (
        MANUAL_SUMMARY_PROMPT_SETTING if prompt_kind == "manual" else SUMMARY_PROMPT_SETTING
    )
    try:
        conn = db.get_conn()
        try:
            row = conn.execute(
                "SELECT value FROM app_settings WHERE key = ?",
                (setting_key,),
            ).fetchone()
        finally:
            conn.close()
        if row is not None:
            value = str(row["value"] or "").strip()
            if value:
                return value
    except Exception as exc:
        logger.warning("summarizer: %s 조회 실패 — 기본 프롬프트만 사용: %s", setting_key, exc)
    return None


def _build_llm_user_prompt(
    meeting: dict,
    transcript: str,
    bookmarks: list[dict],
    participants: list[dict],
    include_transcript: bool = True,
    prompt_kind: str = "recording",
) -> str:
    """Gemini/Ollama 공용 요약 프롬프트 (K1 JSON 스키마).

    include_transcript=False면 녹취록을 인라인하지 않고 첨부 파일(transcript.txt)을
    참고하라는 안내 문구로 대체한다 (SPEC H — Gemini 장문 스크립트 파일 첨부).
    """
    names = ", ".join(str(p.get("name") or "") for p in participants if p.get("name")) or "미지정"

    # 메모 목록 (SPEC H+I) — kind='mark'는 시간 핀일 뿐이므로 제외,
    # kind='memo'(kind 없는 레거시 dict 포함)는 "[HH:MM:SS] 제목", kind='note'는 "(일반 메모) 제목"
    memo_lines: list[str] = []
    for b in bookmarks:
        kind = str(b.get("kind") or "memo")  # 레거시 dict(kind 없음)는 memo 취급
        if kind == "mark":
            continue
        title = str(b.get("title") or "").strip()
        if kind == "note":
            memo_lines.append(f"(일반 메모) {title}")
        else:
            memo_lines.append(f"[{_format_clock(b.get('time_sec') or 0)}] {title}")
    if memo_lines:
        bookmark_block = (
            "회의 중 메모(북마크):\n" + "\n".join(memo_lines) + "\n"
            "사용자가 회의 중 남긴 메모는 중요 포인트이니 요약과 회의록에 반드시 반영하라.\n"
        )
    else:
        bookmark_block = "회의 중 메모(북마크): 없음\n"

    # 사용자 지정 추가 지시사항 (있을 때만 — SPEC 2차 개선 A)
    prompt_kind = "manual" if prompt_kind == "manual" else "recording"
    user_instructions = get_summary_prompt(prompt_kind)
    user_block = (
        "\n사용자 지정 작성 지시사항:\n"
        f"{user_instructions}\n"
        "단, 위 지시사항은 회의록의 내용 선택, 문체, 정리 방식에만 적용한다. "
        "출력 형식, JSON 키 이름, 값 타입, JSON 외 텍스트 금지 규칙은 아래 JSON 스키마를 반드시 따른다. "
        "[회의내용], [핵심내용], [결정사항] 같은 섹션 표기는 필요한 경우 discussion 문자열 내부의 표현으로만 사용한다.\n"
        if user_instructions
        else ""
    )

    content_label = "직접 작성한 회의 내용" if prompt_kind == "manual" else "녹취록"
    if include_transcript:
        transcript_block = f"{content_label}:\n{transcript[:_MAX_TRANSCRIPT_CHARS]}\n"
    else:
        transcript_block = "전체 스크립트는 첨부된 텍스트 파일(transcript.txt)을 참고하라.\n"

    return (
        f"다음 회의 {content_label}을 분석해서 아래 JSON 형식으로 요약해주세요.\n\n"
        f"회의 제목: {str(meeting.get('title') or '제목 없음')}\n"
        f"참석자: {names}\n"
        f"{bookmark_block}\n"
        f"{transcript_block}\n"
        f"{user_block}\n"
        "작성 규칙:\n"
        "- discussion(회의내용): 논의된 주제별로 묶어 마크다운으로 정리하라. "
        "주제마다 '### 소제목'을 달고 그 아래 '- 불릿'으로 요점을 적는다. "
        "발언을 시간 순서대로 나열하지 말고 주제 중심으로 재구성하라.\n"
        "- key_points(핵심내용): 요구사항/문제점/검토가 필요한 점/주요 의견 등 핵심을 3~7개.\n"
        "- decisions(결정사항): 회의에서 명확하게 확정/결정된 것만 넣어라. "
        "명확한 결정이 없으면 반드시 빈 배열([])로 두고, 논의만 되고 확정되지 않은 내용은 "
        "decisions가 아니라 followups(추가 확인 필요 사항)에 넣어라.\n"
        "- followups(추가 확인 필요 사항): 결정되지 않고 추가 확인/검토가 필요한 사항.\n\n"
        "출력 JSON 형식 (모든 값은 한국어로 작성):\n"
        "{\n"
        '  "discussion": "회의내용을 주제별로 묶은 마크다운(### 소제목 + - 불릿)",\n'
        '  "key_points": ["핵심내용 3~7개"],\n'
        '  "decisions": ["명확하게 확정된 결정사항만 (없으면 빈 배열)"],\n'
        '  "followups": ["추가로 확인/검토가 필요한 사항 (없으면 빈 배열)"],\n'
        '  "action_items": [{"text": "해야 할 일", "owner": "담당자 이름 또는 null", "due": "기한 또는 null"}]\n'
        "}\n"
        "중요: 위 JSON 객체 하나만 출력한다. 설명 문장, 마크다운 코드펜스, JSON 바깥 섹션 제목은 출력하지 않는다."
    )


# ---------------------------------------------------------------------------
# Gemini
# ---------------------------------------------------------------------------

def get_gemini_key() -> str | None:
    """Gemini API 키 조회 — app_settings(DB) 우선, 없으면 환경변수, 둘 다 없으면 None."""
    try:
        conn = db.get_conn()
        try:
            row = conn.execute(
                "SELECT value FROM app_settings WHERE key = ?",
                (GEMINI_KEY_SETTING,),
            ).fetchone()
        finally:
            conn.close()
        if row is not None:
            value = str(row["value"] or "").strip()
            if value:
                return value
    except Exception as exc:
        logger.warning("summarizer: app_settings 조회 실패 — 환경변수로 폴백: %s", exc)
    env_key = (config.GEMINI_API_KEY_ENV or "").strip()
    return env_key or None


def get_gemini_model() -> str:
    """Gemini 모델명 조회 — app_settings(DB) 우선, 없으면 config.GEMINI_MODEL (SPEC J5)."""
    try:
        conn = db.get_conn()
        try:
            row = conn.execute(
                "SELECT value FROM app_settings WHERE key = ?",
                (GEMINI_MODEL_SETTING,),
            ).fetchone()
        finally:
            conn.close()
        if row is not None:
            value = str(row["value"] or "").strip()
            if value:
                return value
    except Exception as exc:
        logger.warning("summarizer: gemini_model 조회 실패 — 기본 모델 사용: %s", exc)
    return config.GEMINI_MODEL


def _try_gemini(
    meeting: dict,
    transcript: str,
    bookmarks: list[dict],
    participants: list[dict],
    api_key: str,
    prompt_kind: str = "recording",
) -> tuple[dict, str]:
    """Gemini generateContent REST 호출로 요약 JSON을 받는다. 실패 시 예외를 던진다.

    전체 스크립트가 config.GEMINI_ATTACH_THRESHOLD 초과이면 프롬프트에 인라인하지 않고
    별도 inline_data 파트(text/plain, base64)로 첨부한다 (SPEC H).
    """
    import httpx  # 미설치 시 ImportError → 폴백

    model_name = get_gemini_model()
    attach_transcript = len(transcript) > config.GEMINI_ATTACH_THRESHOLD
    prompt = _LLM_SYSTEM_PROMPT + "\n\n" + _build_llm_user_prompt(
        meeting,
        transcript,
        bookmarks,
        participants,
        include_transcript=not attach_transcript,
        prompt_kind=prompt_kind,
    )

    parts: list[dict] = [{"text": prompt}]
    if attach_transcript:
        parts.append(
            {
                "inline_data": {
                    "mime_type": "text/plain",
                    "data": base64.b64encode(transcript.encode("utf-8")).decode("ascii"),
                }
            }
        )

    payload = {
        "contents": [{"parts": parts}],
        "generationConfig": {
            "response_mime_type": "application/json",
            "maxOutputTokens": 16384,
            "temperature": 0,  # 재현성·유효 JSON 확률을 높인다
        },
    }
    url = f"{config.GEMINI_BASE_URL.rstrip('/')}/models/{model_name}:generateContent"

    # Gemini는 호출마다 응답이 달라 가끔 깨진 JSON을 반환한다 — 파싱 실패 시 재시도
    last_err: Exception | None = None
    for attempt in range(3):
        resp = httpx.post(url, headers={"x-goog-api-key": api_key}, json=payload, timeout=120.0)
        resp.raise_for_status()  # HTTP 오류(400/403 등)는 재시도하지 않고 즉시 전파
        try:
            text = _extract_gemini_text(resp.json())
            parsed = _parse_llm_response_text(text)
            return parsed, model_name
        except (json.JSONDecodeError, ValueError) as exc:
            last_err = exc
            logger.warning(
                "summarizer: Gemini JSON 파싱 실패(시도 %d/3) — 재시도: %s", attempt + 1, exc
            )
    raise last_err or ValueError("Gemini 응답 파싱 실패")


def _extract_gemini_text(body) -> str:
    """Gemini 응답에서 candidates[0].content.parts[*].text를 모두 이어붙여 추출.

    Gemini 3.x 사고형 모델은 응답을 여러 파트로 나눠 보낼 수 있으므로 parts[0]만
    보지 않고 모든 text 파트를 결합한다.
    """
    candidates = body.get("candidates") if isinstance(body, dict) else None
    if not isinstance(candidates, list) or not candidates:
        raise ValueError("Gemini 응답에 candidates가 없습니다")
    content = candidates[0].get("content") if isinstance(candidates[0], dict) else None
    parts = content.get("parts") if isinstance(content, dict) else None
    if not isinstance(parts, list) or not parts:
        raise ValueError("Gemini 응답에 parts가 없습니다")
    texts = [
        p["text"]
        for p in parts
        if isinstance(p, dict) and isinstance(p.get("text"), str) and not p.get("thought")
    ]
    text = "".join(texts).strip()
    if not text:
        raise ValueError("Gemini 응답에 text가 없습니다")
    return text


def _strip_code_fences(text: str) -> str:
    """마크다운 코드펜스(```json ... ```)로 감싸진 JSON 응답 방어적 정리."""
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[\w-]*[ \t]*\r?\n?", "", text)
        if text.rstrip().endswith("```"):
            text = text.rstrip()[:-3]
    return text.strip()


def extract_first_json(text: str):
    """텍스트에서 첫 번째 완결 JSON 값만 파싱한다 (뒤에 붙은 여분 데이터는 무시).

    Gemini가 JSON 뒤에 설명/중복을 덧붙여 'Extra data' 오류가 나는 것을 방지.
    STT(gemini_stt)와 요약 양쪽에서 공용으로 사용.
    """
    cleaned = _strip_code_fences(text)
    start = next((i for i, ch in enumerate(cleaned) if ch in "{["), None)
    if start is None:
        raise ValueError("응답에서 JSON을 찾지 못했습니다")
    obj, _end = json.JSONDecoder().raw_decode(cleaned, start)
    return obj


def _parse_llm_response_text(text: str) -> dict:
    """LLM 응답을 요약 dict로 파싱한다.

    정상 경로는 JSON 객체다. 다만 사용자 지정 프롬프트가 강하게 작용하면 Gemini가
    "[회의내용]" 같은 문서형 섹션으로 답하는 경우가 있어, 가능한 범위에서 내부 요약
    스키마로 변환한다.
    """
    try:
        parsed = extract_first_json(text)
    except (json.JSONDecodeError, ValueError) as json_exc:
        try:
            return _parse_structured_summary_text(text)
        except ValueError:
            raise json_exc
    return _normalize_summary_payload(parsed)


def _normalize_summary_payload(value) -> dict:
    """영문/한국어 키와 단일 배열 래핑을 내부 요약 스키마로 정규화한다."""
    if isinstance(value, list):
        dict_items = [item for item in value if isinstance(item, dict)]
        if len(dict_items) == 1:
            value = dict_items[0]
        else:
            raise ValueError("LLM 응답이 JSON 객체가 아닙니다")
    if not isinstance(value, dict):
        raise ValueError("LLM 응답이 JSON 객체가 아닙니다")

    for wrapper_key in ("summary", "minutes", "result", "회의록"):
        wrapped = value.get(wrapper_key)
        if isinstance(wrapped, dict):
            value = wrapped
            break

    aliases = {
        "discussion": ("discussion", "회의내용", "회의 내용", "논의내용", "논의 내용", "본문"),
        "key_points": ("key_points", "keyPoints", "핵심내용", "핵심 내용", "주요내용", "주요 내용"),
        "decisions": ("decisions", "결정사항", "결정 사항"),
        "followups": (
            "followups",
            "follow_ups",
            "추가확인필요사항",
            "추가 확인 필요 사항",
            "추가 확인",
            "검토사항",
            "검토 사항",
        ),
        "action_items": ("action_items", "actionItems", "할일", "할 일", "액션아이템", "액션 아이템"),
    }

    normalized: dict = {}
    for canonical, keys in aliases.items():
        for key in keys:
            if key in value:
                normalized[canonical] = value[key]
                break

    for key in ("key_points", "decisions", "followups"):
        if isinstance(normalized.get(key), str):
            normalized[key] = _section_text_to_items(normalized[key])

    if isinstance(normalized.get("action_items"), str):
        normalized["action_items"] = [
            {"text": item, "owner": None, "due": None}
            for item in _section_text_to_items(normalized["action_items"])
        ]

    discussion = normalized.get("discussion")
    if isinstance(discussion, list):
        normalized["discussion"] = "\n".join(
            f"- {str(item).strip()}" for item in discussion if str(item).strip()
        )
    elif isinstance(discussion, dict):
        normalized["discussion"] = "\n".join(
            f"### {str(k).strip()}\n{str(v).strip()}"
            for k, v in discussion.items()
            if str(k).strip() and str(v).strip()
        )

    return normalized


_SECTION_NAME_MAP = {
    "회의내용": "discussion",
    "논의내용": "discussion",
    "핵심내용": "key_points",
    "주요내용": "key_points",
    "결정사항": "decisions",
    "추가확인필요사항": "followups",
    "추가확인": "followups",
    "검토사항": "followups",
    "할일": "action_items",
    "액션아이템": "action_items",
}

_SECTION_HEADING_RE = re.compile(
    r"^\s*(?:#{1,6}\s*)?(?:\[)?\s*"
    r"(회의\s*내용|논의\s*내용|핵심\s*내용|주요\s*내용|결정\s*사항|"
    r"추가\s*확인\s*필요\s*사항|추가\s*확인|검토\s*사항|할\s*일|액션\s*아이템)"
    r"\s*(?:\])?\s*:?\s*$",
    re.IGNORECASE,
)

_SECTION_INLINE_RE = re.compile(
    r"^\s*(?:#{1,6}\s*)?(?:\[)?\s*"
    r"(회의\s*내용|논의\s*내용|핵심\s*내용|주요\s*내용|결정\s*사항|"
    r"추가\s*확인\s*필요\s*사항|추가\s*확인|검토\s*사항|할\s*일|액션\s*아이템)"
    r"\s*(?:\])?\s*[:：]\s*(.+?)\s*$",
    re.IGNORECASE,
)


def _parse_structured_summary_text(text: str) -> dict:
    """[회의내용]/[핵심내용] 형식의 문서형 응답을 요약 dict로 변환한다."""
    sections: dict[str, list[str]] = {}
    current: str | None = None
    for raw_line in _strip_code_fences(text).splitlines():
        line = raw_line.rstrip()
        inline_match = _SECTION_INLINE_RE.match(line)
        if inline_match:
            title = re.sub(r"\s+", "", inline_match.group(1))
            current = _SECTION_NAME_MAP.get(title)
            if current:
                sections.setdefault(current, [])
                content = inline_match.group(2).strip()
                if content:
                    sections[current].append(content)
            continue
        match = _SECTION_HEADING_RE.match(line)
        if match:
            title = re.sub(r"\s+", "", match.group(1))
            current = _SECTION_NAME_MAP.get(title)
            if current:
                sections.setdefault(current, [])
            continue
        if current:
            sections.setdefault(current, []).append(line)

    compact = {key: "\n".join(lines).strip() for key, lines in sections.items()}
    if not compact:
        raise ValueError("문서형 요약 섹션을 찾지 못했습니다")

    result = {
        "discussion": compact.get("discussion", ""),
        "key_points": _section_text_to_items(compact.get("key_points", "")),
        "decisions": _section_text_to_items(compact.get("decisions", "")),
        "followups": _section_text_to_items(compact.get("followups", "")),
        "action_items": [
            {"text": item, "owner": None, "due": None}
            for item in _section_text_to_items(compact.get("action_items", ""))
        ],
    }
    if not any(result.values()):
        raise ValueError("문서형 요약 내용이 비어 있습니다")
    return result


def _section_text_to_items(text: str) -> list[str]:
    """문서형 섹션 텍스트를 불릿 리스트로 정규화한다."""
    if not isinstance(text, str):
        return []
    cleaned = text.strip()
    if not cleaned:
        return []
    if re.fullmatch(r".*(없음|확인되지\s*않음|해당\s*없음|없습니다).*", cleaned):
        return []

    items: list[str] = []
    for line in cleaned.splitlines():
        line = line.strip()
        if not line:
            continue
        if _SECTION_HEADING_RE.match(line):
            continue
        line = re.sub(r"^[\-*•·]\s*", "", line)
        line = re.sub(r"^\d+[\).\s]+\s*", "", line)
        line = re.sub(r"^(결정사항|추가\s*확인\s*필요\s*사항)\s*:\s*", "", line).strip()
        if not line or line in items:
            continue
        if re.fullmatch(r".*(없음|확인되지\s*않음|해당\s*없음|없습니다).*", line):
            continue
        items.append(line)
    return items[:_MAX_ITEMS_LLM]


def test_gemini_key(key: str) -> tuple[bool, str]:
    """Gemini API 키 연결 테스트 — 미니 generateContent 호출(timeout 15s).

    settings API의 POST /api/settings/test-gemini 에서 재사용한다.
    반환: (ok, 한국어 메시지).
    """
    key = (key or "").strip()
    if not key:
        return False, "테스트할 Gemini API 키가 없어요"

    model_name = get_gemini_model()
    try:
        import httpx
    except ImportError:
        return False, "httpx 패키지가 설치되어 있지 않아요"

    try:
        resp = httpx.post(
            f"{config.GEMINI_BASE_URL.rstrip('/')}/models/{model_name}:generateContent",
            headers={"x-goog-api-key": key},
            json={"contents": [{"parts": [{"text": "안녕이라고만 답해주세요."}]}]},
            timeout=15.0,
        )
    except httpx.TimeoutException:
        return False, "Gemini 서버가 15초 안에 응답하지 않았어요. 네트워크 상태를 확인해주세요"
    except Exception as exc:
        return False, f"Gemini 연결 실패: {str(exc).strip() or exc.__class__.__name__}"

    if resp.status_code in (400, 401, 403):
        return False, "API 키가 올바르지 않아요"
    if resp.status_code == 429:
        return False, "요청 한도를 초과했어요. 잠시 후 다시 시도해주세요"
    if resp.status_code >= 400:
        return False, f"Gemini 호출 실패 (HTTP {resp.status_code})"
    return True, f"Gemini 연결 성공 — {model_name} 모델을 사용할 수 있어요"


# ---------------------------------------------------------------------------
# Ollama
# ---------------------------------------------------------------------------

def _summarize_with_ollama(
    meeting: dict,
    transcript: str,
    bookmarks: list[dict],
    participants: list[dict],
    prompt_kind: str = "recording",
) -> tuple[dict, str]:
    """Ollama /api/chat 으로 요약 JSON을 받는다. 실패 시 예외를 던진다."""
    import httpx  # 미설치 시 ImportError → 폴백

    base = config.OLLAMA_URL.rstrip("/")

    # 가용성 확인 (2초 타임아웃)
    tags_resp = httpx.get(f"{base}/api/tags", timeout=2.0)
    tags_resp.raise_for_status()
    models = [
        m.get("name")
        for m in (tags_resp.json().get("models") or [])
        if isinstance(m, dict) and m.get("name")
    ]
    model_name = config.OLLAMA_MODEL or (models[0] if models else "")
    if not model_name:
        raise RuntimeError("사용 가능한 Ollama 모델이 없습니다")

    system_prompt = _LLM_SYSTEM_PROMPT
    user_prompt = _build_llm_user_prompt(
        meeting, transcript, bookmarks, participants, prompt_kind=prompt_kind
    )

    chat_resp = httpx.post(
        f"{base}/api/chat",
        json={
            "model": model_name,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "stream": False,
            "format": "json",
            "options": {"temperature": 0.2},
        },
        timeout=300.0,
    )
    chat_resp.raise_for_status()
    body = chat_resp.json()
    message = body.get("message") if isinstance(body, dict) else None
    content = message.get("content") if isinstance(message, dict) else None
    if not isinstance(content, str) or not content.strip():
        raise ValueError("Ollama 응답에 content가 없습니다")

    parsed = _parse_llm_response_text(content)
    return parsed, model_name


def _clean_str_list(value, limit: int) -> list | None:
    """문자열 리스트를 방어적으로 정제. 타입이 리스트가 아니면 None(→폴백 병합)."""
    if not isinstance(value, list):
        return None
    items: list[str] = []
    for v in value:
        if isinstance(v, str):
            text = v.strip()
        elif isinstance(v, (int, float)):
            text = str(v)
        elif isinstance(v, dict):
            raw = v.get("text")
            text = raw.strip() if isinstance(raw, str) else ""
        else:
            continue
        if text and text not in items:
            items.append(text)
    return items[:limit]


def _clean_action_items(value, limit: int) -> list | None:
    """액션 아이템 리스트를 방어적으로 정제. 타입이 리스트가 아니면 None(→폴백 병합)."""
    if not isinstance(value, list):
        return None
    items: list[dict] = []
    seen: set[str] = set()
    for v in value:
        owner = due = None
        if isinstance(v, str):
            text = v.strip()
        elif isinstance(v, dict):
            raw = v.get("text") or v.get("task") or v.get("item")
            text = raw.strip() if isinstance(raw, str) else ""
            owner = _opt_str(v.get("owner") if v.get("owner") is not None else v.get("assignee"))
            due = _opt_str(
                v.get("due")
                if v.get("due") is not None
                else (v.get("due_date") if v.get("due_date") is not None else v.get("deadline"))
            )
        else:
            continue
        if text and text not in seen:
            seen.add(text)
            items.append({"text": text, "owner": owner, "due": due})
    return items[:limit]


def _opt_str(value) -> str | None:
    """owner/due 값을 str 또는 None으로 정규화."""
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text or text.lower() in ("null", "none", "n/a"):
        return None
    return text


def _clean_discussion(value) -> str | None:
    """회의내용(discussion) 마크다운을 방어적으로 정제. 문자열이 아니거나 비면 None(→폴백)."""
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


# ---------------------------------------------------------------------------
# 폴백 사유 (engine_note) — 사람이 읽을 한국어, API 키 등 민감정보 미포함
# ---------------------------------------------------------------------------

def _describe_llm_error(engine_label: str, exc: Exception) -> str:
    """LLM 호출 예외를 사람이 읽을 한국어 사유로 요약한다 (HTTP 상태 포함, 키 미포함).

    httpx는 함수 내부에서만 import하므로 isinstance 대신 속성/클래스명으로 판별한다.
    """
    reason = _describe_error_reason(exc)
    return f"{engine_label} 호출 실패({reason})"


def _describe_error_reason(exc: Exception) -> str:
    # HTTP 응답이 있으면 상태 코드 기반으로 (URL·헤더 등 민감정보는 노출하지 않음)
    response = getattr(exc, "response", None)
    status = getattr(response, "status_code", None)
    if isinstance(status, int):
        reason = _HTTP_REASONS.get(status)
        return f"HTTP {status}: {reason}" if reason else f"HTTP {status}"

    name = exc.__class__.__name__
    if "Timeout" in name:
        return "응답 시간 초과"
    if "Connect" in name:
        return "서버에 연결할 수 없음"
    if isinstance(exc, ImportError):
        return "httpx 패키지 미설치"
    if isinstance(exc, RuntimeError):
        # 자체 RuntimeError(예: 사용 가능한 모델 없음)는 메시지가 안전하고 유용함
        msg = str(exc).strip()
        return msg or name
    if isinstance(exc, ValueError):
        # json 파싱 실패 및 자체 응답 형식 오류 — 메시지에 민감정보 없음
        return "응답 형식 오류"
    return name


def _build_engine_note(
    engine: str, gemini_note: str | None, ollama_note: str | None
) -> str | None:
    """최종 엔진과 폴백 사유로 engine_note를 구성. 정상(최상위 엔진 성공)이면 None."""
    if engine.startswith("gemini:"):
        return None
    if engine.startswith("ollama:"):
        # Ollama 성공. Gemini 키가 있었으나 실패했다면 그 사유를 알린다.
        if gemini_note:
            return f"{gemini_note} → Ollama 요약으로 대체했어요."
        return None
    # engine == "extractive": LLM이 모두 실패(또는 미가용) → 내장 요약으로 대체.
    # Gemini 키를 등록한 사용자에게만 경고한다 — LLM을 아예 설정하지 않은 경우
    # (키 없음 + Ollama 미실행)는 의도된 동작이므로 배너를 띄우지 않는다.
    if not gemini_note:
        return None
    return f"{gemini_note} → 내장 요약으로 대체했어요."


# ---------------------------------------------------------------------------
# 추출 요약 폴백
# ---------------------------------------------------------------------------

def _split_sentences(text: str) -> list[str]:
    """개행 + 한국어 종결 어미 근사 정규식으로 문장 분리. 짧은 문장(<10자) 제외 + 중복 제거."""
    sentences: list[str] = []
    seen: set[str] = set()
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        for part in _SENTENCE_SPLIT_RE.split(line):
            part = part.strip()
            if len(part) < _MIN_SENTENCE_LEN or part in seen:
                continue
            seen.add(part)
            sentences.append(part)
    return sentences


def _extractive_summary(transcript: str) -> dict:
    """단어 빈도 기반 한국어 추출 요약."""
    sentences = _split_sentences(transcript)
    if not sentences:
        return {
            "key_points": [],
            "decisions": [],
            "action_items": [],
            "discussion": "",
            "followups": [],
        }

    # 단어 빈도 계산
    freq: Counter = Counter()
    tokenized: list[list[str]] = []
    for sent in sentences:
        words = _WORD_RE.findall(sent)
        tokenized.append(words)
        freq.update(words)

    # 문장 점수 = 단어 빈도 합 / 단어 수 (길이 편향 보정)
    def score(idx: int) -> float:
        words = tokenized[idx]
        if not words:
            return 0.0
        return sum(freq[w] for w in words) / len(words)

    ranked = sorted(range(len(sentences)), key=score, reverse=True)
    top_indices = sorted(ranked[:_MAX_ITEMS_EXTRACTIVE])  # 상위 3~5문장, 원문 순서 유지
    key_points = [sentences[i] for i in top_indices]

    # 회의내용(discussion): 상위 점수 문장 5~8개를 불릿 마크다운으로 (원문 순서 유지)
    disc_indices = sorted(ranked[:_MAX_DISCUSSION_EXTRACTIVE])
    discussion = "\n".join(f"- {sentences[i]}" for i in disc_indices)

    decisions: list[str] = []
    action_items: list[dict] = []
    followups: list[str] = []
    for sent in sentences:
        if len(decisions) < _MAX_ITEMS_EXTRACTIVE and _DECISION_RE.search(sent):
            if sent not in decisions:
                decisions.append(sent)
        if len(action_items) < _MAX_ITEMS_EXTRACTIVE and _ACTION_RE.search(sent):
            if all(item["text"] != sent for item in action_items):
                action_items.append({"text": sent, "owner": None, "due": None})
        # 추가 확인 필요 사항(followups): 확인/검토/추후 패턴 문장 (최대 5)
        if len(followups) < _MAX_ITEMS_EXTRACTIVE and _FOLLOWUP_RE.search(sent):
            if sent not in followups:
                followups.append(sent)

    return {
        "key_points": key_points,
        "decisions": decisions,
        "action_items": action_items,
        "discussion": discussion,
        "followups": followups,
    }


# ---------------------------------------------------------------------------
# 회의록 마크다운 (모든 엔진 공통)
# ---------------------------------------------------------------------------

def _format_clock(seconds) -> str:
    """초 → HH:MM:SS."""
    try:
        total = max(0, int(float(seconds)))
    except (TypeError, ValueError):
        total = 0
    hours, rem = divmod(total, 3600)
    minutes, secs = divmod(rem, 60)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}"


def _participant_lines_grouped(participants: list[dict]) -> list[str]:
    """참석자를 소속별로 묶은 마크다운 라인들 (소속·이름 가나다순).

    **소속명**
    - 이름 (부서 · 직책)
    소속 없는 참석자는 마지막에 '**소속 미지정**' 그룹으로.
    """
    grouped: dict[str, list[tuple[str, str]]] = {}  # org -> [(이름, 라인)]
    loose: list[tuple[str, str]] = []
    for p in participants:
        name = str(p.get("name") or "").strip()
        if not name:
            continue
        extras = [str(p.get(k) or "").strip() for k in ("department", "role")]
        extras = [v for v in extras if v]
        line = f"- {name} ({' · '.join(extras)})" if extras else f"- {name}"
        org = str(p.get("organization") or "").strip()
        if org:
            grouped.setdefault(org, []).append((name, line))
        else:
            loose.append((name, line))
    lines: list[str] = []
    for org in sorted(grouped):
        lines.append(f"**{org}**")
        lines += [line for _, line in sorted(grouped[org])]
    if loose:
        if grouped:
            lines.append("**소속 미지정**")
        lines += [line for _, line in sorted(loose)]
    return lines


def render_minutes_md(
    meeting: dict,
    participants: list[dict],
    bookmarks: list[dict],
    key_points: list[str],
    decisions: list[str],
    action_items: list[dict],
    discussion: str,
    followups: list[str],
) -> str:
    """회의록 마크다운 재생성 공개 API — 요약 수동 편집 후 라우터에서 재사용."""
    return _build_minutes_md(
        meeting, participants, bookmarks, key_points, decisions, action_items, discussion, followups
    )


def _build_minutes_md(
    meeting: dict,
    participants: list[dict],
    bookmarks: list[dict],
    key_points: list[str],
    decisions: list[str],
    action_items: list[dict],
    discussion: str,
    followups: list[str],
) -> str:
    title = str(meeting.get("title") or "").strip() or "회의록"
    started_at = str(meeting.get("started_at") or "").replace("T", " ")[:16] or "-"
    tag = str(meeting.get("tag") or "").strip()

    # 소요 시간 대신 태그(프로젝트)를 표시한다 (사용자 요청)
    meta = f"**일시**: {started_at}"
    if tag:
        meta += f" · **태그**: #{tag}"

    lines: list[str] = [
        f"# {title}",
        "",
        meta,
        "",
        "## 참석자",
    ]
    lines += _participant_lines_grouped(participants) or ["_(기록된 참석자가 없습니다)_"]

    lines += ["", "## 회의내용", (discussion or "").strip() or "_(정리된 회의내용이 없습니다)_"]

    lines += ["", "## 핵심내용"]
    lines += [f"- {point}" for point in key_points] or ["_(요약할 내용이 없습니다)_"]

    lines += ["", "## 결정사항"]
    lines += [f"- [x] {item}" for item in decisions] or ["명확히 확정된 결정사항은 없음"]

    if followups:
        lines += ["", "### 추가 확인 필요 사항"]
        lines += [f"- [ ] {item}" for item in followups]

    # 액션 아이템은 AI 요약 탭의 "할 일"로만 노출 — 회의록 문서에는 넣지 않는다 (사용자 요청)

    lines += ["", "## 타임라인"]
    # 일반 메모(note)는 시간 개념이 없으므로 타임라인에서 제외하고 별도 섹션에 나열
    timed = [b for b in bookmarks if b.get("kind") != "note"]
    plain_notes = [b for b in bookmarks if b.get("kind") == "note"]
    sorted_bookmarks = sorted(timed, key=lambda b: float(b.get("time_sec") or 0))
    timeline_lines = [
        f"- **{_format_clock(b.get('time_sec') or 0)}** — {str(b.get('title') or '').strip() or '(제목 없음)'}"
        for b in sorted_bookmarks
    ]
    lines += timeline_lines or ["_(기록된 북마크가 없습니다)_"]

    if plain_notes:
        lines += ["", "## 일반 메모"]
        lines += [f"- {str(b.get('title') or '').strip() or '(내용 없음)'}" for b in plain_notes]

    lines += [""]
    return "\n".join(lines)
