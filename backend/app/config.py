import os
from pathlib import Path

# 프로젝트 루트 기준 데이터 경로 (backend/app/config.py -> 프로젝트 루트)
ROOT_DIR = Path(__file__).resolve().parents[2]
DATA_DIR = Path(os.environ.get("GIMNOTE_DATA_DIR", ROOT_DIR / "data"))
AUDIO_DIR = DATA_DIR / "audio"
DB_PATH = DATA_DIR / "gimnote.db"

# STT 설정 — tiny/base/small/medium/large-v3 (클수록 정확, 느림. 한국어는 small 이상 권장)
WHISPER_MODEL = os.environ.get("GIMNOTE_WHISPER_MODEL", "small")
LANGUAGE = os.environ.get("GIMNOTE_LANGUAGE", "ko")
# auto: CUDA GPU가 있으면 GPU(float16), 없거나 로드 실패 시 CPU(int8) 폴백. cpu/cuda로 강제 가능
WHISPER_DEVICE = os.environ.get("GIMNOTE_WHISPER_DEVICE", "auto").lower()
WHISPER_COMPUTE = os.environ.get("GIMNOTE_WHISPER_COMPUTE", "")  # 빈 값이면 디바이스별 기본값

# 요약 엔진 우선순위: Gemini(키 등록 시) → Ollama → 내장 추출 요약
# Gemini API 키는 앱 설정(UI)에서 등록해 DB(app_settings)에 저장하거나 환경변수로 지정
GEMINI_API_KEY_ENV = os.environ.get("GIMNOTE_GEMINI_API_KEY", "")
GEMINI_MODEL = os.environ.get("GIMNOTE_GEMINI_MODEL", "gemini-2.0-flash")
GEMINI_BASE_URL = os.environ.get(
    "GIMNOTE_GEMINI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta"
)
# 전체 스크립트가 이 글자 수를 넘으면 프롬프트 인라인 대신 텍스트 파일 파트로 첨부
GEMINI_ATTACH_THRESHOLD = int(os.environ.get("GIMNOTE_GEMINI_ATTACH_THRESHOLD", "20000"))

OLLAMA_URL = os.environ.get("GIMNOTE_OLLAMA_URL", "http://127.0.0.1:11434")
OLLAMA_MODEL = os.environ.get("GIMNOTE_OLLAMA_MODEL", "")  # 빈 값이면 설치된 첫 모델 사용

DATA_DIR.mkdir(parents=True, exist_ok=True)
AUDIO_DIR.mkdir(parents=True, exist_ok=True)
