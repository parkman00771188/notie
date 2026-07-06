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

# 요약 엔진 — Ollama가 로컬에서 실행 중이면 사용, 아니면 추출 요약 폴백
OLLAMA_URL = os.environ.get("GIMNOTE_OLLAMA_URL", "http://127.0.0.1:11434")
OLLAMA_MODEL = os.environ.get("GIMNOTE_OLLAMA_MODEL", "")  # 빈 값이면 설치된 첫 모델 사용

DATA_DIR.mkdir(parents=True, exist_ok=True)
AUDIO_DIR.mkdir(parents=True, exist_ok=True)
