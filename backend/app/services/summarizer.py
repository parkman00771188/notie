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


# ---------------------------------------------------------------------------
# 공개 API
# ---------------------------------------------------------------------------

def summarize(
    meeting: dict,
    segments: list[dict],
    bookmarks: list[dict],
    participants: list[dict],
) -> dict:
    """회의를 요약하여 key_points/decisions/action_items/minutes_md/engine을 반환한다."""
    meeting = meeting or {}
    segments = segments or []
    bookmarks = bookmarks or []
    participants = participants or []

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
                meeting, transcript, bookmarks, participants, gemini_key
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
                meeting, transcript, bookmarks, participants
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
    "반드시 유효한 JSON 객체 하나만 출력하고, JSON 외의 텍스트는 절대 포함하지 마세요."
)


def get_summary_prompt() -> str | None:
    """사용자 지정 요약 지시사항 조회 — app_settings 'summary_prompt', 없거나 비면 None."""
    try:
        conn = db.get_conn()
        try:
            row = conn.execute(
                "SELECT value FROM app_settings WHERE key = ?",
                (SUMMARY_PROMPT_SETTING,),
            ).fetchone()
        finally:
            conn.close()
        if row is not None:
            value = str(row["value"] or "").strip()
            if value:
                return value
    except Exception as exc:
        logger.warning("summarizer: summary_prompt 조회 실패 — 기본 프롬프트만 사용: %s", exc)
    return None


def _build_llm_user_prompt(
    meeting: dict,
    transcript: str,
    bookmarks: list[dict],
    participants: list[dict],
    include_transcript: bool = True,
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
    user_instructions = get_summary_prompt()
    user_block = (
        "\n\n다음은 사용자가 지정한 추가 지시사항이다. "
        f"기본 규칙과 충돌하면 사용자 지시를 우선하라:\n{user_instructions}"
        if user_instructions
        else ""
    )

    if include_transcript:
        transcript_block = f"녹취록:\n{transcript[:_MAX_TRANSCRIPT_CHARS]}\n"
    else:
        transcript_block = "전체 스크립트는 첨부된 텍스트 파일(transcript.txt)을 참고하라.\n"

    return (
        "다음 회의 녹취록을 분석해서 아래 JSON 형식으로 요약해주세요.\n\n"
        f"회의 제목: {str(meeting.get('title') or '제목 없음')}\n"
        f"참석자: {names}\n"
        f"{bookmark_block}\n"
        f"{transcript_block}\n"
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
        "}"
        f"{user_block}"
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

    resp = httpx.post(
        f"{config.GEMINI_BASE_URL.rstrip('/')}/models/{model_name}:generateContent",
        headers={"x-goog-api-key": api_key},
        json={
            "contents": [{"parts": parts}],
            "generationConfig": {"response_mime_type": "application/json"},
        },
        timeout=120.0,
    )
    resp.raise_for_status()

    text = _extract_gemini_text(resp.json())
    parsed = json.loads(_strip_code_fences(text))
    if not isinstance(parsed, dict):
        raise ValueError("Gemini 응답이 JSON 객체가 아닙니다")
    return parsed, model_name


def _extract_gemini_text(body) -> str:
    """Gemini 응답에서 candidates[0].content.parts[0].text를 방어적으로 추출."""
    candidates = body.get("candidates") if isinstance(body, dict) else None
    if not isinstance(candidates, list) or not candidates:
        raise ValueError("Gemini 응답에 candidates가 없습니다")
    content = candidates[0].get("content") if isinstance(candidates[0], dict) else None
    parts = content.get("parts") if isinstance(content, dict) else None
    if not isinstance(parts, list) or not parts:
        raise ValueError("Gemini 응답에 parts가 없습니다")
    text = parts[0].get("text") if isinstance(parts[0], dict) else None
    if not isinstance(text, str) or not text.strip():
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
    user_prompt = _build_llm_user_prompt(meeting, transcript, bookmarks, participants)

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

    parsed = json.loads(content)
    if not isinstance(parsed, dict):
        raise ValueError("Ollama 응답이 JSON 객체가 아닙니다")
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


def _format_participant_line(p: dict) -> str:
    """참석자 한 줄: '- 이름 (소속 · 부서 · 직책 — 있는 값만 " · " 연결)'."""
    name = str(p.get("name") or "").strip() or "이름 없음"
    # 소속(organization) · 부서(department) · 직책(role) 순, 있는 값만
    extras = [
        str(p.get(key) or "").strip()
        for key in ("organization", "department", "role")
    ]
    extras = [v for v in extras if v]
    if extras:
        return f"- {name} ({' · '.join(extras)})"
    return f"- {name}"


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
    duration = meeting.get("duration_sec")
    duration_text = _format_clock(duration) if duration else "-"

    lines: list[str] = [
        f"# {title}",
        "",
        f"**일시**: {started_at} · **소요 시간**: {duration_text}",
        "",
        "## 참석자",
    ]
    lines += [
        _format_participant_line(p) for p in participants if p.get("name")
    ] or ["_(기록된 참석자가 없습니다)_"]

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
