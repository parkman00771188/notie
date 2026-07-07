# Notie — 로컬 AI 회의록 도우미 (구 Gimnote)

녹음하면, 요약과 회의록이 자동으로 완성됩니다. 모든 처리는 **로컬**에서 이루어집니다.

- 브라우저에서 음성 녹음 (일시정지 / 마크 / 실시간 메모 북마크)
- [faster-whisper](https://github.com/SYSTRAN/faster-whisper)로 음성 → 텍스트 변환 (한국어)
- 핵심 요약 · 결정 사항 · 할 일 추출 + 마크다운 회의록 자동 생성
  - 로컬 [Ollama](https://ollama.com)가 실행 중이면 LLM 요약, 아니면 내장 추출 요약으로 자동 폴백
- 참석자 라벨 관리, 최근 회의 패널 / 전체 보기 팝업

## 요구 사항

- Python 3.10+ / Node.js 18+
- (선택) Ollama — 더 좋은 요약 품질을 원하면 `ollama pull exaone3.5` 등 아무 모델이나 받아 실행

## 실행 방법

터미널 2개로 각각 실행:

```powershell
# 1) 백엔드 (http://127.0.0.1:8000)
.\start-backend.ps1

# 2) 프론트엔드 (http://localhost:5173)
.\start-frontend.ps1
```

그다음 브라우저에서 <http://localhost:5173> 접속 → 회원가입 → 새 회의 기록.

> 첫 녹음 종료 시 Whisper 모델(기본 `small`, 약 480MB)이 자동 다운로드됩니다.
> 이후에는 오프라인으로 동작합니다.

## 환경 변수

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `GIMNOTE_WHISPER_MODEL` | `small` | `tiny`/`base`/`small`/`medium`/`large-v3` — 클수록 정확·느림 |
| `GIMNOTE_LANGUAGE` | `ko` | STT 언어 |
| `GIMNOTE_OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama 주소 |
| `GIMNOTE_OLLAMA_MODEL` | (첫 모델) | 요약에 사용할 Ollama 모델명 |
| `GIMNOTE_DATA_DIR` | `./data` | DB·오디오 저장 경로 |

## 구조

```
backend/   FastAPI + SQLite + faster-whisper (요약 파이프라인은 백그라운드 스레드)
frontend/  React + Vite + TypeScript (dev 서버가 /api를 8000 포트로 프록시)
data/      gimnote.db, audio/  (자동 생성)
```

상세 설계는 [SPEC.md](SPEC.md) 참고.
