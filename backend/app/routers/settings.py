"""settings 라우터 — 앱 설정(Gemini API 키) 조회/저장 + 연결 테스트.

main.py에서 prefix="/api/settings"로 include된다.

계약 (SPEC.md):
- GET ""  → {gemini_api_key_set, gemini_key_preview, gemini_model, ollama_available, summary_prompt}
  (preview는 키 마지막 4자 "...abcd", gemini_model은 유효값(DB → config 순),
   ollama_available은 /api/tags 1.5초 체크,
   summary_prompt는 사용자 지정 요약 프롬프트 — 없으면 "")
- PUT ""  {gemini_api_key?: str, summary_prompt?: str, gemini_model?: str}
  → 값 upsert(공백 trim), 빈 문자열이면 삭제 → GET과 동일 응답
- POST "/test-gemini" → 등록된 키로 generateContent 미니 호출 → {ok: bool, message: str}
- GET "/gemini-models" → 저장된 키로 GET {GEMINI_BASE_URL}/models?key=...&pageSize=50 (timeout 10s),
  generateContent 지원 + name에 "gemini" 포함 모델만 {models: [{name, display_name}], error: null}
  (name은 "models/" 프리픽스 제거). 키 없음/호출 실패 시 {models: [], error: "<한국어 사유>"} (200으로) — SPEC J5.
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import config, db
from ..auth_utils import get_current_user, require_admin
from ..services import summarizer

router = APIRouter()

GEMINI_KEY_SETTING = "gemini_api_key"
GEMINI_MODEL_SETTING = "gemini_model"
SUMMARY_PROMPT_SETTING = "summary_prompt"
STT_ENGINE_SETTING = "stt_engine"


class SettingsUpdate(BaseModel):
    gemini_api_key: str | None = None
    summary_prompt: str | None = None
    gemini_model: str | None = None
    stt_engine: str | None = None


def _check_ollama_available() -> bool:
    """Ollama 가용성 확인 — GET /api/tags (1.5초 타임아웃)."""
    try:
        import httpx  # 미설치 시 ImportError → 사용 불가 처리

        resp = httpx.get(f"{config.OLLAMA_URL.rstrip('/')}/api/tags", timeout=1.5)
        return resp.status_code == 200
    except Exception:
        return False


def _get_summary_prompt() -> str:
    """app_settings에서 사용자 지정 요약 프롬프트 조회 — 없으면 ""."""
    conn = db.get_conn()
    try:
        row = conn.execute(
            "SELECT value FROM app_settings WHERE key = ?",
            (SUMMARY_PROMPT_SETTING,),
        ).fetchone()
    finally:
        conn.close()
    return str(row["value"]).strip() if row is not None else ""


def _settings_response() -> dict:
    """GET/PUT 공통 응답 — 현재 유효한 키(DB 우선, 없으면 환경변수) 기준."""
    from ..services import gemini_stt

    key = summarizer.get_gemini_key()
    return {
        "gemini_api_key_set": bool(key),
        "gemini_key_preview": f"...{key[-4:]}" if key else None,
        "gemini_model": summarizer.get_gemini_model(),
        "ollama_available": _check_ollama_available(),
        "summary_prompt": _get_summary_prompt(),
        "stt_engine": gemini_stt.get_engine(),
    }


@router.get("")
def get_settings(user: dict = Depends(get_current_user)) -> dict:
    require_admin(user)
    return _settings_response()


@router.put("")
def update_settings(
    body: SettingsUpdate, user: dict = Depends(get_current_user)
) -> dict:
    require_admin(user)
    updates = body.model_dump(exclude_unset=True)
    if "stt_engine" in updates:
        value = (updates["stt_engine"] or "").strip()
        if value and value != "gemini":
            raise HTTPException(status_code=400, detail="STT 엔진은 Gemini만 사용할 수 있습니다")
    field_to_setting = {
        "gemini_api_key": GEMINI_KEY_SETTING,
        "summary_prompt": SUMMARY_PROMPT_SETTING,
        "gemini_model": GEMINI_MODEL_SETTING,
        "stt_engine": STT_ENGINE_SETTING,
    }
    targets = [
        (setting_key, (updates[field] or "").strip())
        for field, setting_key in field_to_setting.items()
        if field in updates
    ]
    if targets:
        conn = db.get_conn()
        try:
            with conn:
                for setting_key, value in targets:
                    if value:
                        conn.execute(
                            """
                            INSERT INTO app_settings(key, value) VALUES(?, ?)
                            ON CONFLICT(key) DO UPDATE SET
                              value = excluded.value,
                              updated_at = datetime('now', 'localtime')
                            """,
                            (setting_key, value),
                        )
                    else:
                        # 빈 문자열 → 등록된 값 삭제
                        conn.execute(
                            "DELETE FROM app_settings WHERE key = ?",
                            (setting_key,),
                        )
        finally:
            conn.close()
    return _settings_response()


@router.post("/test-gemini")
def test_gemini(user: dict = Depends(get_current_user)) -> dict:
    require_admin(user)
    key = summarizer.get_gemini_key()
    if not key:
        return {
            "ok": False,
            "message": "등록된 Gemini API 키가 없어요. 먼저 키를 저장해주세요.",
        }
    ok, message = summarizer.test_gemini_key(key)
    return {"ok": ok, "message": message}


@router.get("/gemini-models")
def list_gemini_models(user: dict = Depends(get_current_user)) -> dict:
    require_admin(user)
    """사용 가능한 Gemini 모델 목록 조회 (SPEC J5) — 실패해도 200 + 한국어 error."""
    key = summarizer.get_gemini_key()
    if not key:
        return {
            "models": [],
            "error": "등록된 Gemini API 키가 없어요. 먼저 키를 저장해주세요.",
        }

    try:
        import httpx  # 미설치 시 ImportError → 아래 error 메시지
    except ImportError:
        return {"models": [], "error": "httpx 패키지가 설치되어 있지 않아요"}

    try:
        # 키는 쿼리 파라미터 대신 헤더로 전달 (오류 로그에 키가 노출되지 않도록)
        resp = httpx.get(
            f"{config.GEMINI_BASE_URL.rstrip('/')}/models",
            headers={"x-goog-api-key": key},
            params={"pageSize": 100},
            timeout=10.0,
        )
    except httpx.TimeoutException:
        return {
            "models": [],
            "error": "Gemini 서버가 10초 안에 응답하지 않았어요. 네트워크 상태를 확인해주세요",
        }
    except Exception as exc:
        return {
            "models": [],
            "error": f"Gemini 연결 실패: {str(exc).strip() or exc.__class__.__name__}",
        }

    if resp.status_code in (400, 401, 403):
        return {"models": [], "error": "API 키가 올바르지 않아요"}
    if resp.status_code == 429:
        return {"models": [], "error": "요청 한도를 초과했어요. 잠시 후 다시 시도해주세요"}
    if resp.status_code >= 400:
        return {"models": [], "error": f"Gemini 호출 실패 (HTTP {resp.status_code})"}

    try:
        body = resp.json()
    except Exception:
        return {"models": [], "error": "Gemini 응답을 해석할 수 없어요"}

    raw_models = body.get("models") if isinstance(body, dict) else None
    # 텍스트 요약에 부적합한 변형(TTS/이미지/실시간/로보틱스 등)은 목록에서 제외
    _EXCLUDE_VARIANTS = ("tts", "image", "live", "robotics", "computer-use", "audio")
    models: list[dict] = []
    for m in raw_models or []:
        if not isinstance(m, dict):
            continue
        name = str(m.get("name") or "")
        if name.startswith("models/"):
            name = name[len("models/"):]
        methods = m.get("supportedGenerationMethods")
        if not isinstance(methods, list) or "generateContent" not in methods:
            continue
        lowered = name.lower()
        if "gemini" not in lowered:
            continue
        if any(v in lowered for v in _EXCLUDE_VARIANTS):
            continue
        display_name = str(m.get("displayName") or "").strip() or name
        models.append({"name": name, "display_name": display_name})

    # 최신 모델이 맨 위로: -latest 별칭 → 버전 내림차순(3.5 > 3.1 > 3 > 2.5) → 이름순
    import re

    def _sort_key(entry: dict) -> tuple:
        n = entry["name"].lower()
        is_latest_alias = 0 if n.endswith("-latest") else 1
        match = re.search(r"gemini-(\d+(?:\.\d+)?)", n)
        version = float(match.group(1)) if match else 0.0
        return (is_latest_alias, -version, n)

    models.sort(key=_sort_key)
    return {"models": models, "error": None}
