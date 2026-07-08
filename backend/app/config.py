import os
from pathlib import Path


def _env(name: str, default: str = "") -> str:
    """환경변수 조회 — 새 이름 NOTIE_* 우선, 구 이름 GIMNOTE_*도 호환 지원."""
    value = os.environ.get(f"NOTIE_{name}")
    if value is None:
        value = os.environ.get(f"GIMNOTE_{name}")
    return default if value is None else value


# 프로젝트 루트 기준 데이터 경로 (backend/app/config.py -> 프로젝트 루트)
ROOT_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = Path(_env("DATA_DIR", str(ROOT_DIR / "data")))
AUDIO_DIR = DATA_DIR / "audio"
# DB 파일명은 기존 데이터 호환을 위해 유지한다
DB_PATH = DATA_DIR / "gimnote.db"

# STT 설정 — tiny/base/small/medium/large-v3 (클수록 정확, 느림. 한국어는 small 이상 권장)
WHISPER_MODEL = _env("WHISPER_MODEL", "small")
LANGUAGE = _env("LANGUAGE", "ko")
# auto: CUDA GPU가 있으면 GPU(float16), 없거나 로드 실패 시 CPU(int8) 폴백. cpu/cuda로 강제 가능
WHISPER_DEVICE = _env("WHISPER_DEVICE", "auto").lower()
WHISPER_COMPUTE = _env("WHISPER_COMPUTE", "")  # 빈 값이면 디바이스별 기본값

# 요약 엔진 우선순위: Gemini(키 등록 시) → Ollama → 내장 추출 요약
# Gemini API 키는 앱 설정(UI)에서 등록해 DB(app_settings)에 저장하거나 환경변수로 지정
GEMINI_API_KEY_ENV = _env("GEMINI_API_KEY", "")
# gemini-2.0-flash는 2026-06 은퇴 → 2.5-flash가 안전한 기본값 (설정 UI에서 변경 가능)
GEMINI_MODEL = _env("GEMINI_MODEL", "gemini-2.5-flash")
GEMINI_BASE_URL = _env("GEMINI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta")
# 전체 스크립트가 이 글자 수를 넘으면 프롬프트 인라인 대신 텍스트 파일 파트로 첨부
GEMINI_ATTACH_THRESHOLD = int(_env("GEMINI_ATTACH_THRESHOLD", "20000"))

OLLAMA_URL = _env("OLLAMA_URL", "http://127.0.0.1:11434")
OLLAMA_MODEL = _env("OLLAMA_MODEL", "")  # 빈 값이면 설치된 첫 모델 사용

SUPERADMIN_USERNAME = _env("SUPERADMIN_USERNAME", "admin")
SUPERADMIN_PASSWORD = _env("SUPERADMIN_PASSWORD", "admin123!@#")
SUPERADMIN_NAME = _env("SUPERADMIN_NAME", "관리자")
SUPERADMIN_EMAIL = _env("SUPERADMIN_EMAIL", "admin@notie.local")

DATA_DIR.mkdir(parents=True, exist_ok=True)
AUDIO_DIR.mkdir(parents=True, exist_ok=True)
