"""STT 서비스 — faster-whisper 지연 로딩 싱글턴 (GPU 자동 감지).

계약 (SPEC.md):
- transcribe(audio_path) -> [{"start": float, "end": float, "text": str}, ...]
- config.WHISPER_DEVICE = auto|cpu|cuda:
  - auto: ctranslate2.get_cuda_device_count() > 0 이면 cuda(float16), 아니면 cpu(int8)
  - cuda 로드/워밍업 실패 시 한국어 경고 로그 후 cpu(int8) 폴백 (폴백 상태 기억)
- Windows에서 nvidia pip 패키지(nvidia-cublas-cu12/nvidia-cudnn-cu12)가 있으면
  DLL 디렉터리를 os.add_dll_directory 로 등록 (실패는 조용히 무시)
- compute_type: config.WHISPER_COMPUTE 우선, 비어 있으면 cuda→float16 / cpu→int8
- get_device_info(): 로드 전 "cuda(예정)"/"cpu(예정)", 로드 후 "cuda:float16"/"cpu:int8"
- 지연 로딩 + threading.Lock 으로 스레드 안전 보장.
- faster_whisper 미설치 시 한국어 RuntimeError.
"""

import importlib.util
import logging
import os
import threading

from .. import config

logger = logging.getLogger(__name__)

_model = None
_model_lock = threading.Lock()

# 실제 로드된 디바이스/연산 타입 (로드 후에만 값이 채워짐)
_active_device: str | None = None
_active_compute: str | None = None
# cuda 로드/워밍업 실패로 cpu 폴백했는지 기억
_cuda_fallback = False

_dll_registered = False


def _register_nvidia_dlls() -> None:
    """venv에 설치된 nvidia pip 패키지의 DLL 디렉터리를 등록한다.

    Windows에서 ctranslate2가 CUDA 라이브러리(cuBLAS/cuDNN)를 찾을 수 있도록
    site-packages\\nvidia\\<pkg>\\bin 등 존재하는 디렉터리를 os.add_dll_directory
    로 추가한다. 패키지 미설치 등 모든 실패는 조용히 무시한다.
    """
    global _dll_registered
    if _dll_registered:
        return
    _dll_registered = True
    if os.name != "nt" or not hasattr(os, "add_dll_directory"):
        return
    for pkg in ("nvidia.cublas", "nvidia.cudnn"):
        try:
            spec = importlib.util.find_spec(pkg)
        except Exception:
            continue
        if spec is None:
            continue
        locations = list(spec.submodule_search_locations or [])
        if not locations and spec.origin:
            locations = [os.path.dirname(spec.origin)]
        for base in locations:
            for sub in ("bin", "lib"):
                dll_dir = os.path.join(base, sub)
                if os.path.isdir(dll_dir):
                    try:
                        os.add_dll_directory(dll_dir)
                    except OSError:
                        pass
                    # ctranslate2는 plain LoadLibrary로 CUDA DLL을 찾으므로
                    # add_dll_directory만으로는 부족하다 — PATH에도 추가해야 한다.
                    if dll_dir not in os.environ.get("PATH", ""):
                        os.environ["PATH"] = dll_dir + os.pathsep + os.environ.get("PATH", "")


def _cuda_available() -> bool:
    """ctranslate2 기준으로 사용 가능한 CUDA 디바이스가 있는지 확인한다."""
    try:
        import ctranslate2

        return ctranslate2.get_cuda_device_count() > 0
    except Exception:
        return False


def _resolve_device() -> str:
    """config.WHISPER_DEVICE(auto|cpu|cuda)에 따라 사용할 디바이스를 결정한다."""
    _register_nvidia_dlls()
    device = config.WHISPER_DEVICE
    if device == "cuda":
        return "cuda"
    if device == "cpu":
        return "cpu"
    # auto (또는 알 수 없는 값)
    return "cuda" if _cuda_available() else "cpu"


def _resolve_compute(device: str) -> str:
    """compute_type 결정 — config.WHISPER_COMPUTE 우선, 없으면 디바이스별 기본값."""
    if config.WHISPER_COMPUTE:
        return config.WHISPER_COMPUTE
    return "float16" if device == "cuda" else "int8"


def _warmup(model) -> None:
    """짧은 무음 오디오로 실제 추론을 1회 실행한다.

    CUDA는 모델 생성이 성공해도 cuBLAS/cuDNN DLL 문제 등이 첫 추론 시점에
    드러나므로, 여기서 미리 실행해 실패를 조기에 감지한다.
    """
    import numpy as np

    silence = np.zeros(8000, dtype=np.float32)  # 16kHz 기준 0.5초 무음
    segments, _info = model.transcribe(
        silence,
        language=config.LANGUAGE,
        beam_size=1,
        vad_filter=False,
    )
    next(segments, None)  # 제너레이터를 소비해야 인코더가 실제로 실행됨


def _load_model():
    """디바이스를 결정해 WhisperModel을 로드한다 (cuda 실패 시 cpu 폴백)."""
    global _cuda_fallback
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise RuntimeError(
            "faster-whisper 패키지가 설치되어 있지 않습니다. "
            "백엔드 가상환경에서 `pip install faster-whisper` 를 실행한 뒤 "
            "다시 시도해주세요."
        ) from exc

    device = _resolve_device()
    compute = _resolve_compute(device)

    if device == "cuda":
        try:
            model = WhisperModel(
                config.WHISPER_MODEL,
                device="cuda",
                compute_type=compute,
            )
            _warmup(model)
            logger.info("Whisper 모델 로드 완료: cuda:%s", compute)
            return model, "cuda", compute
        except Exception as exc:
            _cuda_fallback = True
            logger.warning(
                "CUDA로 Whisper 모델 로드/워밍업에 실패하여 CPU(int8)로 폴백합니다: %s",
                exc,
            )
            device, compute = "cpu", "int8"
    else:
        device, compute = "cpu", _resolve_compute("cpu")

    model = WhisperModel(
        config.WHISPER_MODEL,
        device="cpu",
        compute_type=compute,
    )
    logger.info("Whisper 모델 로드 완료: cpu:%s", compute)
    return model, "cpu", compute


def _get_model():
    """WhisperModel 싱글턴을 지연 로딩으로 반환한다 (double-checked locking)."""
    global _model, _active_device, _active_compute
    if _model is None:
        with _model_lock:
            if _model is None:
                model, device, compute = _load_model()
                _active_device = device
                _active_compute = compute
                _model = model
    return _model


def get_device_info() -> str:
    """현재 STT 디바이스 정보 문자열을 반환한다.

    - 모델 로드 전: "cuda(예정)" | "cpu(예정)"
    - 모델 로드 후: "cuda:float16" | "cpu:int8" 등 실제 사용 값
    """
    if _model is not None and _active_device and _active_compute:
        return f"{_active_device}:{_active_compute}"
    try:
        device = _resolve_device()
    except Exception:
        device = "cpu"
    return f"{device}(예정)"


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
