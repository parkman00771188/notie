"""오디오 파형 피크 계산 — 서버 사이드 스트리밍 디코드.

브라우저에서 decodeAudioData로 전체 파일을 디코딩하면 장시간 녹음(1시간+)에서
비압축 PCM이 수 GB가 되어 탭이 Out of Memory로 죽는다. 대신 여기서 PyAV로
프레임 단위 스트리밍 디코드하여 ~600개 피크만 계산해 내려준다.

- get_peaks(audio_path) -> {"peaks": [0..1 float × ≤600], "duration_sec": float}
- 결과는 <오디오파일>.peaks.json 으로 캐시 (오디오보다 오래된 캐시는 재계산)
- 동시 요청은 락으로 직렬화 (같은 파일을 두 번 계산하지 않음)
"""

import json
import logging
import threading
from pathlib import Path

logger = logging.getLogger("gimnote.waveform")

BUCKETS = 600

_lock = threading.Lock()


def _frame_peak(frame) -> float:
    """프레임의 최대 절대 진폭(0..1 근사). 레이아웃/채널 무관하게 전체 샘플 기준."""
    import numpy as np

    arr = frame.to_ndarray()
    if arr.size == 0:
        return 0.0
    if arr.dtype.kind == "i":  # int16/int32 등
        scale = float(np.iinfo(arr.dtype).max)
        return float(np.abs(arr).max()) / scale if scale else 0.0
    if arr.dtype.kind == "u":  # uint8 (offset binary)
        center = (float(np.iinfo(arr.dtype).max) + 1) / 2
        return float(np.abs(arr.astype("float32") - center).max()) / center
    return float(np.abs(arr).max())


def compute_peaks(audio_path: str | Path) -> dict:
    """오디오를 스트리밍 디코드해 시간축 버킷별 피크를 계산한다 (전체 로드 없음)."""
    try:
        import av
    except ImportError as exc:  # faster-whisper 의존성이라 통상 존재
        raise RuntimeError("PyAV(av) 패키지가 설치되어 있지 않습니다") from exc

    frames: list[tuple[float, float]] = []  # (시작 시각, 피크)
    t = 0.0
    with av.open(str(audio_path)) as container:
        stream = container.streams.audio[0]
        container_duration = (
            float(container.duration) / 1_000_000 if container.duration else None
        )
        for frame in container.decode(stream):
            start = float(frame.time) if frame.time is not None else t
            frames.append((start, _frame_peak(frame)))
            rate = frame.sample_rate or stream.rate or 48000
            t = start + (frame.samples / rate if rate else 0.0)

    duration = container_duration or t
    if not frames or duration <= 0:
        return {"peaks": [], "duration_sec": duration}

    n = min(BUCKETS, len(frames))
    peaks = [0.0] * n
    for start, peak in frames:
        idx = min(n - 1, int(start / duration * n))
        if peak > peaks[idx]:
            peaks[idx] = peak

    top = max(peaks)
    if top > 0:
        peaks = [min(1.0, p / top) for p in peaks]
    return {"peaks": [round(p, 4) for p in peaks], "duration_sec": round(duration, 3)}


def get_peaks(audio_path: str | Path) -> dict:
    """캐시 우선 조회 — 없거나 오디오보다 오래됐으면 재계산 후 저장."""
    path = Path(audio_path)
    cache = path.with_suffix(path.suffix + ".peaks.json")

    with _lock:
        try:
            if cache.is_file() and cache.stat().st_mtime >= path.stat().st_mtime:
                data = json.loads(cache.read_text(encoding="utf-8"))
                if isinstance(data, dict) and isinstance(data.get("peaks"), list):
                    return data
        except (OSError, json.JSONDecodeError):
            pass  # 캐시 손상 → 재계산

        data = compute_peaks(path)
        try:
            cache.write_text(json.dumps(data), encoding="utf-8")
        except OSError:
            logger.warning("waveform: 피크 캐시 저장 실패 — %s", cache)
        return data
