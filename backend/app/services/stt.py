"""STT 서비스 — faster-whisper 지연 로딩 싱글턴.

계약 (SPEC.md):
- transcribe(audio_path) -> [{"start": float, "end": float, "text": str}, ...]
- WhisperModel(config.WHISPER_MODEL, device="cpu", compute_type="int8") 모듈 싱글턴.
- 지연 로딩 + threading.Lock 으로 스레드 안전 보장.
- faster_whisper 미설치 시 한국어 RuntimeError.
"""

import threading

from .. import config

_model = None
_model_lock = threading.Lock()


def _get_model():
    """WhisperModel 싱글턴을 지연 로딩으로 반환한다 (double-checked locking)."""
    global _model
    if _model is None:
        with _model_lock:
            if _model is None:
                try:
                    from faster_whisper import WhisperModel
                except ImportError as exc:
                    raise RuntimeError(
                        "faster-whisper 패키지가 설치되어 있지 않습니다. "
                        "백엔드 가상환경에서 `pip install faster-whisper` 를 실행한 뒤 "
                        "다시 시도해주세요."
                    ) from exc
                _model = WhisperModel(
                    config.WHISPER_MODEL,
                    device="cpu",
                    compute_type="int8",
                )
    return _model


def transcribe(audio_path: str) -> list[dict]:
    """오디오 파일을 한국어로 전사하여 세그먼트 리스트를 반환한다.

    반환: [{"start": float, "end": float, "text": str}, ...]
    빈 텍스트 세그먼트는 제외한다. 무음이면 빈 리스트를 반환한다.
    """
    model = _get_model()
    segments, _info = model.transcribe(
        str(audio_path),
        language=config.LANGUAGE,
        vad_filter=True,
    )
    results: list[dict] = []
    for seg in segments:
        text = (seg.text or "").strip()
        if not text:
            continue
        results.append(
            {
                "start": float(seg.start),
                "end": float(seg.end),
                "text": text,
            }
        )
    return results
