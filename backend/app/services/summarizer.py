"""요약 서비스 — Ollama 우선, 실패 시 한국어 추출 요약 폴백.

계약 (SPEC.md):
- summarize(meeting, segments, bookmarks, participants) ->
  {"key_points": [str], "decisions": [str],
   "action_items": [{"text": str, "owner": str|None, "due": str|None}],
   "minutes_md": str, "engine": str}
- 1차: Ollama — GET {OLLAMA_URL}/api/tags (timeout 2s)로 가용성 확인,
  POST /api/chat (stream=False, format="json", timeout 300s). engine="ollama:<model>".
  응답 JSON 파싱은 방어적으로: 키 누락/타입 오류 시 추출 요약 결과를 병합.
- 폴백: 추출 요약 (engine="extractive").
- minutes_md 마크다운 구조는 두 엔진 공통.
- 세그먼트 0개(무음)면 빈 배열 + "인식된 음성이 없습니다" 안내.
"""

import json
import re
from collections import Counter

from .. import config

# 추출 요약 패턴 (SPEC 고정)
_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?다요죠음됨함])\s+")
_DECISION_RE = re.compile(r"결정|확정|하기로|승인|합의|채택|진행하기로")
_ACTION_RE = re.compile(r"해야|할 일|까지|담당|예정|부탁|준비|공유하기로")
_WORD_RE = re.compile(r"[가-힣a-zA-Z0-9]{2,}")

_MIN_SENTENCE_LEN = 10       # 이보다 짧은 문장 제외
_MAX_ITEMS_EXTRACTIVE = 5    # 폴백 시 각 항목 최대 개수
_MAX_ITEMS_OLLAMA = 8        # Ollama 응답 방어적 상한
_MAX_TRANSCRIPT_CHARS = 12000  # 프롬프트에 넣을 녹취록 길이 제한


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

    try:
        parsed, model_name = _summarize_with_ollama(meeting, transcript, bookmarks, participants)
        engine = f"ollama:{model_name}"
        key_points = _clean_str_list(parsed.get("key_points"), _MAX_ITEMS_OLLAMA)
        decisions = _clean_str_list(parsed.get("decisions"), _MAX_ITEMS_OLLAMA)
        action_items = _clean_action_items(parsed.get("action_items"), _MAX_ITEMS_OLLAMA)
        raw_overview = parsed.get("overview")
        if isinstance(raw_overview, str) and raw_overview.strip():
            overview = raw_overview.strip()
    except Exception:
        # Ollama 미설치/미실행/타임아웃/JSON 파싱 실패 → 전체 추출 요약 폴백
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

    names = ", ".join(str(p.get("name") or "") for p in participants if p.get("name")) or "미지정"
    bookmark_lines = "\n".join(
        f"- {_format_clock(b.get('time_sec') or 0)} {str(b.get('title') or '').strip()}"
        for b in bookmarks
    ) or "없음"
    clipped = transcript[:_MAX_TRANSCRIPT_CHARS]

    system_prompt = (
        "당신은 한국어 회의록 작성 전문가입니다. "
        "반드시 유효한 JSON 객체 하나만 출력하고, JSON 외의 텍스트는 절대 포함하지 마세요."
    )
    user_prompt = (
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
        '  "overview": "회의 전체 내용을 3~5문장으로 정리한 상세 요약 문단"\n'
        "}"
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
# 회의록 마크다운 (두 엔진 공통)
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
