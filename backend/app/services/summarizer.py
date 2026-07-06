"""요약 서비스 — Gemini(키 등록 시) → Ollama → 한국어 추출 요약 폴백.

계약 (SPEC.md):
- summarize(meeting, segments, bookmarks, participants) ->
  {"key_points": [str], "decisions": [str],
   "action_items": [{"text": str, "owner": str|None, "due": str|None}],
   "minutes_md": str, "engine": str}
- 1차: Gemini — API 키(app_settings 'gemini_api_key' 우선, 없으면 환경변수)가 있으면
  POST {GEMINI_BASE_URL}/models/{GEMINI_MODEL}:generateContent
  (generationConfig.response_mime_type="application/json", timeout 120s).
  engine="gemini:<model>". 응답 파싱은 방어적으로(코드펜스 제거, 항목별 폴백 병합).
- 2차: Ollama — GET {OLLAMA_URL}/api/tags (timeout 2s)로 가용성 확인,
  POST /api/chat (stream=False, format="json", timeout 300s). engine="ollama:<model>".
  응답 JSON 파싱은 방어적으로: 키 누락/타입 오류 시 추출 요약 결과를 병합.
- 폴백: 추출 요약 (engine="extractive"). 각 엔진 실패는 로그 출력 후 다음으로.
- minutes_md 마크다운 구조는 모든 엔진 공통 (Gemini의 detail 문단은 상세 내용 섹션에 사용).
- 세그먼트 0개(무음)면 빈 배열 + "인식된 음성이 없습니다" 안내.
- test_gemini_key(key) -> (ok, message): settings API의 연결 테스트에서 재사용.
"""

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
_WORD_RE = re.compile(r"[가-힣a-zA-Z0-9]{2,}")

_MIN_SENTENCE_LEN = 10       # 이보다 짧은 문장 제외
_MAX_ITEMS_EXTRACTIVE = 5    # 폴백 시 각 항목 최대 개수
_MAX_ITEMS_LLM = 8           # LLM(Gemini/Ollama) 응답 방어적 상한
_MAX_TRANSCRIPT_CHARS = 12000  # 프롬프트에 넣을 녹취록 길이 제한

GEMINI_KEY_SETTING = "gemini_api_key"


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
        overview = (
            "인식된 음성이 없습니다. 녹음 파일에서 인식 가능한 음성을 찾지 못했어요. "
            "마이크 상태를 확인한 뒤 다시 녹음해보세요."
        )
        minutes_md = _build_minutes_md(meeting, participants, bookmarks, [], [], [], overview)
        return {
            "key_points": [],
            "decisions": [],
            "action_items": [],
            "minutes_md": minutes_md,
            "engine": "extractive",
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
    overview: str | None = None

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
            action_items = _clean_action_items(parsed.get("action_items"), _MAX_ITEMS_LLM)
            # detail 문단 → minutes_md의 상세 내용 섹션 (overview 키도 방어적으로 허용)
            overview = _clean_detail(parsed.get("detail")) or _clean_detail(
                parsed.get("overview")
            )
        except Exception as exc:
            # 네트워크/HTTP 오류/JSON 파싱 실패 → Ollama로 폴백
            logger.warning("summarizer: Gemini 요약 실패 — Ollama로 폴백: %s", exc)
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
            action_items = _clean_action_items(parsed.get("action_items"), _MAX_ITEMS_LLM)
            overview = _clean_detail(parsed.get("overview"))
        except Exception as exc:
            # Ollama 미설치/미실행/타임아웃/JSON 파싱 실패 → 전체 추출 요약 폴백
            logger.warning("summarizer: Ollama 요약 실패 — 추출 요약으로 폴백: %s", exc)
            engine = "extractive"

    # 방어적 병합: 키 누락/타입 오류(None) 시 폴백 결과 사용
    if not key_points:
        key_points = fallback()["key_points"]
    if decisions is None:
        decisions = fallback()["decisions"]
    if action_items is None:
        action_items = fallback()["action_items"]
    if not overview:
        joined = " ".join(fallback()["key_points"][:3]).strip()
        overview = joined or transcript[:300].strip()

    minutes_md = _build_minutes_md(
        meeting, participants, bookmarks, key_points, decisions, action_items, overview
    )
    return {
        "key_points": key_points,
        "decisions": decisions,
        "action_items": action_items,
        "minutes_md": minutes_md,
        "engine": engine,
    }


# ---------------------------------------------------------------------------
# LLM 공통 (프롬프트)
# ---------------------------------------------------------------------------

_LLM_SYSTEM_PROMPT = (
    "당신은 한국어 회의록 작성 전문가입니다. "
    "반드시 유효한 JSON 객체 하나만 출력하고, JSON 외의 텍스트는 절대 포함하지 마세요."
)


def _build_llm_user_prompt(
    meeting: dict,
    transcript: str,
    bookmarks: list[dict],
    participants: list[dict],
    detail_key: str,
) -> str:
    """Gemini/Ollama 공용 요약 프롬프트. detail_key는 상세 문단의 JSON 키 이름."""
    names = ", ".join(str(p.get("name") or "") for p in participants if p.get("name")) or "미지정"
    bookmark_lines = "\n".join(
        f"- {_format_clock(b.get('time_sec') or 0)} {str(b.get('title') or '').strip()}"
        for b in bookmarks
    ) or "없음"
    clipped = transcript[:_MAX_TRANSCRIPT_CHARS]

    return (
        "다음 회의 녹취록을 분석해서 아래 JSON 형식으로 요약해주세요.\n\n"
        f"회의 제목: {str(meeting.get('title') or '제목 없음')}\n"
        f"참석자: {names}\n"
        f"회의 중 메모(북마크):\n{bookmark_lines}\n\n"
        f"녹취록:\n{clipped}\n\n"
        "출력 JSON 형식 (모든 값은 한국어로 작성):\n"
        "{\n"
        '  "key_points": ["회의의 핵심 내용을 요약한 문장 3~5개"],\n'
        '  "decisions": ["회의에서 확정/결정된 사항 (없으면 빈 배열)"],\n'
        '  "action_items": [{"text": "해야 할 일", "owner": "담당자 이름 또는 null", "due": "기한 또는 null"}],\n'
        f'  "{detail_key}": "회의 전체 내용을 3~5문장으로 정리한 상세 요약 문단"\n'
        "}"
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


def _try_gemini(
    meeting: dict,
    transcript: str,
    bookmarks: list[dict],
    participants: list[dict],
    api_key: str,
) -> tuple[dict, str]:
    """Gemini generateContent REST 호출로 요약 JSON을 받는다. 실패 시 예외를 던진다."""
    import httpx  # 미설치 시 ImportError → 폴백

    model_name = config.GEMINI_MODEL
    prompt = _LLM_SYSTEM_PROMPT + "\n\n" + _build_llm_user_prompt(
        meeting, transcript, bookmarks, participants, detail_key="detail"
    )

    resp = httpx.post(
        f"{config.GEMINI_BASE_URL.rstrip('/')}/models/{model_name}:generateContent",
        params={"key": api_key},
        json={
            "contents": [{"parts": [{"text": prompt}]}],
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

    model_name = config.GEMINI_MODEL
    try:
        import httpx
    except ImportError:
        return False, "httpx 패키지가 설치되어 있지 않아요"

    try:
        resp = httpx.post(
            f"{config.GEMINI_BASE_URL.rstrip('/')}/models/{model_name}:generateContent",
            params={"key": key},
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
    user_prompt = _build_llm_user_prompt(
        meeting, transcript, bookmarks, participants, detail_key="overview"
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


def _clean_detail(value) -> str | None:
    """상세 문단(detail/overview)을 방어적으로 정제. 문자열이 아니거나 비면 None(→폴백)."""
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


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
        return {"key_points": [], "decisions": [], "action_items": []}

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

    top_indices = sorted(
        sorted(range(len(sentences)), key=score, reverse=True)[:_MAX_ITEMS_EXTRACTIVE]
    )  # 상위 3~5문장, 원문 순서 유지
    key_points = [sentences[i] for i in top_indices]

    decisions: list[str] = []
    action_items: list[dict] = []
    for sent in sentences:
        if len(decisions) < _MAX_ITEMS_EXTRACTIVE and _DECISION_RE.search(sent):
            if sent not in decisions:
                decisions.append(sent)
        if len(action_items) < _MAX_ITEMS_EXTRACTIVE and _ACTION_RE.search(sent):
            if all(item["text"] != sent for item in action_items):
                action_items.append({"text": sent, "owner": None, "due": None})

    return {"key_points": key_points, "decisions": decisions, "action_items": action_items}


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


def _build_minutes_md(
    meeting: dict,
    participants: list[dict],
    bookmarks: list[dict],
    key_points: list[str],
    decisions: list[str],
    action_items: list[dict],
    overview: str,
) -> str:
    title = str(meeting.get("title") or "").strip() or "회의록"
    started_at = str(meeting.get("started_at") or "").replace("T", " ")[:16] or "-"
    names = ", ".join(str(p.get("name") or "") for p in participants if p.get("name")) or "없음"
    duration = meeting.get("duration_sec")
    duration_text = _format_clock(duration) if duration else "-"

    lines: list[str] = [
        f"# {title}",
        "",
        f"**일시**: {started_at} · **참석자**: {names} · **소요 시간**: {duration_text}",
        "",
        "## 핵심 요약",
    ]
    lines += [f"- {point}" for point in key_points] or ["_(요약할 내용이 없습니다)_"]

    lines += ["", "## 결정 사항"]
    lines += [f"- [x] {item}" for item in decisions] or ["_(기록된 결정 사항이 없습니다)_"]

    lines += ["", "## 액션 아이템"]
    action_lines: list[str] = []
    for item in action_items:
        text = item.get("text", "")
        extras = []
        if item.get("owner"):
            extras.append(f"담당: {item['owner']}")
        if item.get("due"):
            extras.append(f"기한: {item['due']}")
        suffix = f" ({' · '.join(extras)})" if extras else ""
        action_lines.append(f"- [ ] {text}{suffix}")
    lines += action_lines or ["_(기록된 액션 아이템이 없습니다)_"]

    lines += ["", "## 타임라인"]
    sorted_bookmarks = sorted(bookmarks, key=lambda b: float(b.get("time_sec") or 0))
    timeline_lines = [
        f"- **{_format_clock(b.get('time_sec') or 0)}** — {str(b.get('title') or '').strip() or '(제목 없음)'}"
        for b in sorted_bookmarks
    ]
    lines += timeline_lines or ["_(기록된 북마크가 없습니다)_"]

    lines += ["", "## 상세 내용", overview.strip() or "_(상세 내용이 없습니다)_", ""]
    return "\n".join(lines)
