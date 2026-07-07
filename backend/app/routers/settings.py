"""settings 라우터 — 앱 설정(Gemini API 키) 조회/저장 + 연결 테스트.

main.py에서 prefix="/api/settings"로 include된다.

계약 (SPEC.md):
- GET ""  → {gemini_api_key_set, gemini_key_preview, gemini_model, ollama_available, summary_prompt}
  (preview는 키 마지막 4자 "...abcd", ollama_available은 /api/tags 1.5초 체크,
   summary_prompt는 사용자 지정 요약 프롬프트 — 없으면 "")
- PUT ""  {gemini_api_key?: str, summary_prompt?: str} → 값 upsert(공백 trim), 빈 문자열이면 삭제
  → GET과 동일 응답
- POST "/test-gemini" → 등록된 키로 generateContent 미니 호출 → {ok: bool, message: str}
"""

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from .. import config, db
from ..auth_utils import get_current_user
from ..services import summarizer

router = APIRouter()

GEMINI_KEY_SETTING = "gemini_api_key"
SUMMARY_PROMPT_SETTING = "summary_prompt"


class SettingsUpdate(BaseModel):
    gemini_api_key: str | None = None
    summary_prompt: str | None = None


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
    key = summarizer.get_gemini_key()
    return {
        "gemini_api_key_set": bool(key),
        "gemini_key_preview": f"...{key[-4:]}" if key else None,
        "gemini_model": config.GEMINI_MODEL,
        "ollama_available": _check_ollama_available(),
        "summary_prompt": _get_summary_prompt(),
    }


@router.get("")
def get_settings(user: dict = Depends(get_current_user)) -> dict:
    return _settings_response()


@router.put("")
def update_settings(
    body: SettingsUpdate, user: dict = Depends(get_current_user)
) -> dict:
    updates = body.model_dump(exclude_unset=True)
    field_to_setting = {
        "gemini_api_key": GEMINI_KEY_SETTING,
        "summary_prompt": SUMMARY_PROMPT_SETTING,
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
    key = summarizer.get_gemini_key()
    if not key:
        return {
            "ok": False,
            "message": "등록된 Gemini API 키가 없어요. 먼저 키를 저장해주세요.",
        }
    ok, message = summarizer.test_gemini_key(key)
    return {"ok": ok, "message": message}
