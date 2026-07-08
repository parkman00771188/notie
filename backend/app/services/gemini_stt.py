"""Gemini 오디오 전사(STT) — 등록된 Gemini API 키로 음성→텍스트 변환.

Notie의 STT는 Gemini 전용으로 동작한다. 별도 키 없이 summarizer와 같은
Gemini 키를 재사용한다.

동작:
1) 어떤 입력 포맷이든(webm/m4a/mp3/...) PyAV로 16kHz 모노 WAV로 변환 (Gemini가 확실히 지원)
2) Gemini Files API에 업로드(재개형 프로토콜) 후 ACTIVE 될 때까지 대기
3) generateContent(JSON 강제)로 "[{start, end, text}]" 세그먼트 전사 요청
4) 방어적 파싱(MM:SS/H:MM:SS → 초), 업로드 파일은 사용 후 삭제(베스트 에포트)

실패 시 한국어 RuntimeError — pipeline이 실패 상태로 남겨 임시저장 음성을 재시도할 수 있게 한다.
"""

import base64
import json
import logging
import re
import tempfile
import wave
from pathlib import Path

from .. import config
from .summarizer import extract_first_json, get_gemini_key, get_gemini_model

logger = logging.getLogger("gimnote.gemini_stt")

# 이 크기 이하면 Files API 대신 요청에 인라인(base64) 첨부 (요청 한도 ~20MB)
_INLINE_LIMIT_BYTES = 15 * 1024 * 1024
# 전사 응답 대기 (장시간 회의 대비)
_GENERATE_TIMEOUT = 600.0
# 긴 오디오는 조각으로 나눠 전사 — 응답이 출력 토큰 한도에 잘려 JSON이 깨지는 것을 방지
_CHUNK_SECONDS = 600  # 10분
_MAX_OUTPUT_TOKENS = 65536
# 이 진폭(int16 최대 32767 기준) 이하면 무음으로 보고 전사하지 않음 — 환각 방지
_SILENCE_PEAK = 350

_TS_RE = re.compile(r"^\s*(?:(\d+):)?(\d{1,2}):(\d{2}(?:\.\d+)?)\s*$")


def get_engine() -> str:
    """현재 STT 엔진. Gemini 전용으로 고정한다."""
    return "gemini"


def _root_url() -> str:
    """GEMINI_BASE_URL(.../v1beta)에서 호스트 루트를 얻는다."""
    base = config.GEMINI_BASE_URL.rstrip("/")
    return base[: -len("/v1beta")] if base.endswith("/v1beta") else base


def _transcode_to_wav(src: Path, dst: Path) -> float:
    """어떤 오디오든 16kHz 모노 s16 WAV로 변환. 반환: 길이(초)."""
    import av

    resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
    frames_written = 0
    with av.open(str(src)) as container, wave.open(str(dst), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(16000)
        stream = container.streams.audio[0]
        for frame in container.decode(stream):
            for rf in resampler.resample(frame):
                data = rf.to_ndarray().tobytes()
                out.writeframes(data)
                frames_written += rf.samples
        try:  # 리샘플러 잔여 플러시 (구버전 PyAV는 미지원 — 무시)
            for rf in resampler.resample(None):
                data = rf.to_ndarray().tobytes()
                out.writeframes(data)
                frames_written += rf.samples
        except Exception:
            pass
    return frames_written / 16000.0


def _upload_file(httpx, api_key: str, wav_path: Path) -> dict:
    """Files API 재개형 업로드 → file dict({name, uri, state, ...})."""
    size = wav_path.stat().st_size
    start = httpx.post(
        f"{_root_url()}/upload/v1beta/files",
        headers={
            "x-goog-api-key": api_key,
            "X-Goog-Upload-Protocol": "resumable",
            "X-Goog-Upload-Command": "start",
            "X-Goog-Upload-Header-Content-Length": str(size),
            "X-Goog-Upload-Header-Content-Type": "audio/wav",
            "Content-Type": "application/json",
        },
        json={"file": {"display_name": "meeting-audio.wav"}},
        timeout=30.0,
    )
    start.raise_for_status()
    upload_url = start.headers.get("x-goog-upload-url")
    if not upload_url:
        raise RuntimeError("Gemini 파일 업로드 URL을 받지 못했습니다")

    with wav_path.open("rb") as fh:
        up = httpx.post(
            upload_url,
            headers={
                "X-Goog-Upload-Offset": "0",
                "X-Goog-Upload-Command": "upload, finalize",
                "Content-Length": str(size),
            },
            content=fh,
            timeout=600.0,
        )
    up.raise_for_status()
    file_info = up.json().get("file") or {}
    if not file_info.get("uri"):
        raise RuntimeError("Gemini 파일 업로드 응답이 올바르지 않습니다")
    return file_info


def _wait_active(httpx, api_key: str, file_info: dict) -> dict:
    """업로드 파일이 ACTIVE 될 때까지 폴링(최대 ~120초)."""
    import time

    name = file_info.get("name") or ""
    for _ in range(60):
        if (file_info.get("state") or "").upper() == "ACTIVE":
            return file_info
        time.sleep(2)
        resp = httpx.get(
            f"{_root_url()}/v1beta/{name}",
            headers={"x-goog-api-key": api_key},
            timeout=15.0,
        )
        resp.raise_for_status()
        file_info = resp.json()
    raise RuntimeError("Gemini 파일 처리(ACTIVE) 대기가 시간 초과됐습니다")


def _delete_file(httpx, api_key: str, name: str) -> None:
    try:
        httpx.delete(
            f"{_root_url()}/v1beta/{name}",
            headers={"x-goog-api-key": api_key},
            timeout=15.0,
        )
    except Exception:
        pass  # 48시간 후 자동 삭제되므로 실패해도 무방


def _parse_ts(value) -> float | None:
    """'MM:SS' | 'H:MM:SS' | 숫자(초) → 초. 해석 불가면 None."""
    if isinstance(value, (int, float)):
        return max(0.0, float(value))
    if not isinstance(value, str):
        return None
    m = _TS_RE.match(value)
    if not m:
        try:
            return max(0.0, float(value.strip()))
        except ValueError:
            return None
    h = int(m.group(1) or 0)
    return h * 3600 + int(m.group(2)) * 60 + float(m.group(3))


def _build_prompt() -> str:
    return (
        "다음 오디오는 한국어 회의 녹음입니다. 전체 내용을 빠짐없이 전사하세요.\n"
        "반드시 JSON 배열만 출력하세요. 각 원소는 다음 형식입니다:\n"
        '{"start": "MM:SS", "end": "MM:SS", "text": "발화 내용"}\n'
        "- 문장 단위(대략 5~15초)로 나누고, start/end는 오디오 안에서의 실제 발화 시각\n"
        "- 1시간이 넘으면 H:MM:SS 형식 사용\n"
        "- 무음·잡음 구간은 제외하고, 들리는 그대로 자연스러운 한국어로 표기\n"
        "- 사람 음성이 전혀 없거나 무음이면 빈 배열 []만 출력하고, 내용을 지어내지 마세요"
    )


def _parse_segments(text: str) -> list[dict]:
    try:
        # 여분 데이터가 뒤에 붙어도 첫 완결 JSON 값만 파싱 (요약과 공용)
        data = extract_first_json(text)
    except Exception:
        # 응답이 토큰 한도로 중간에 잘린 경우 — 완결된 평면 객체만 건져서 복구
        data = []
        for chunk in re.findall(r"\{[^{}]*\}", text):
            try:
                data.append(json.loads(chunk))
            except json.JSONDecodeError:
                continue
        if not data:
            raise RuntimeError("Gemini 전사 응답 JSON을 해석하지 못했습니다")
        logger.warning("gemini_stt: 잘린 JSON에서 %d개 세그먼트 복구", len(data))
    if isinstance(data, dict):  # {"segments": [...]} 형태도 방어적으로 허용
        data = data.get("segments") or data.get("transcript") or []
    if not isinstance(data, list):
        raise RuntimeError("Gemini 전사 응답 형식이 올바르지 않습니다")

    segments: list[dict] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        text_value = str(item.get("text") or "").strip()
        if not text_value:
            continue
        start = _parse_ts(item.get("start"))
        end = _parse_ts(item.get("end"))
        if start is None:
            start = segments[-1]["end"] if segments else 0.0
        if end is None or end < start:
            end = start + 5.0
        segments.append({"start": round(start, 2), "end": round(end, 2), "text": text_value})
    segments.sort(key=lambda s: s["start"])
    return segments


def _wav_peak(wav_path: Path) -> int:
    """16bit WAV의 최대 절대 진폭(0~32767). 무음 판정용."""
    import numpy as np

    peak = 0
    with wave.open(str(wav_path), "rb") as w:
        while True:
            frames = w.readframes(160000)  # ~10초씩
            if not frames:
                break
            arr = np.frombuffer(frames, dtype=np.int16)
            if arr.size:
                peak = max(peak, int(np.abs(arr).max()))
    return peak


def _split_wav(src: Path, chunk_seconds: int) -> list[tuple[Path, float]]:
    """16kHz 모노 WAV를 chunk_seconds 단위 조각 파일들로 분할. 반환: [(경로, 시작오프셋초)]."""
    chunks: list[tuple[Path, float]] = []
    with wave.open(str(src), "rb") as inp:
        rate = inp.getframerate()
        frames_per_chunk = rate * chunk_seconds
        total = inp.getnframes()
        offset_frames = 0
        index = 0
        while offset_frames < total:
            n = min(frames_per_chunk, total - offset_frames)
            data = inp.readframes(n)
            part_path = src.with_name(f"{src.stem}_part{index}.wav")
            with wave.open(str(part_path), "wb") as out:
                out.setnchannels(1)
                out.setsampwidth(2)
                out.setframerate(rate)
                out.writeframes(data)
            chunks.append((part_path, offset_frames / rate))
            offset_frames += n
            index += 1
    return chunks


def _transcribe_one(httpx, api_key: str, model: str, wav_path: Path) -> list[dict]:
    """WAV 파일 하나를 전사 (작으면 인라인, 크면 Files API 업로드)."""
    uploaded_name: str | None = None
    try:
        size = wav_path.stat().st_size
        if size <= _INLINE_LIMIT_BYTES:
            audio_part = {
                "inline_data": {
                    "mime_type": "audio/wav",
                    "data": base64.b64encode(wav_path.read_bytes()).decode("ascii"),
                }
            }
        else:
            file_info = _upload_file(httpx, api_key, wav_path)
            uploaded_name = file_info.get("name")
            file_info = _wait_active(httpx, api_key, file_info)
            audio_part = {
                "file_data": {
                    "mime_type": file_info.get("mimeType") or "audio/wav",
                    "file_uri": file_info["uri"],
                }
            }

        payload = {
            "contents": [{"parts": [audio_part, {"text": _build_prompt()}]}],
            "generationConfig": {
                "response_mime_type": "application/json",
                "maxOutputTokens": _MAX_OUTPUT_TOKENS,
                "temperature": 0,
            },
        }
        url = f"{config.GEMINI_BASE_URL.rstrip('/')}/models/{model}:generateContent"
        # 응답이 확률적이라 가끔 JSON이 깨진다 — 파싱 실패 시 재시도
        last_err: Exception | None = None
        for attempt in range(2):
            resp = httpx.post(
                url, headers={"x-goog-api-key": api_key}, json=payload, timeout=_GENERATE_TIMEOUT
            )
            resp.raise_for_status()
            body = resp.json()
            try:
                parts = body["candidates"][0]["content"]["parts"]
                text = "".join(
                    p["text"]
                    for p in parts
                    if isinstance(p, dict) and isinstance(p.get("text"), str) and not p.get("thought")
                )
                return _parse_segments(text)
            except (RuntimeError, KeyError, IndexError, TypeError) as exc:
                last_err = exc
                logger.warning("gemini_stt: 전사 파싱 실패(시도 %d/2) — 재시도: %s", attempt + 1, exc)
        raise RuntimeError(f"Gemini 전사 응답 파싱 실패: {last_err}")
    finally:
        if uploaded_name:
            _delete_file(httpx, api_key, uploaded_name)


def transcribe(audio_path: str) -> list[dict]:
    """Gemini로 오디오 전사 → [{"start", "end", "text"}]. 실패 시 RuntimeError.

    긴 오디오는 10분 조각으로 나눠 순차 전사한다 — 조각별 응답이 짧아
    출력 토큰 한도에 잘리지 않고, 타임스탬프 오차 누적도 줄어든다.
    """
    try:
        import httpx
    except ImportError as exc:
        raise RuntimeError("httpx 패키지가 설치되어 있지 않습니다") from exc

    api_key = get_gemini_key()
    if not api_key:
        raise RuntimeError("등록된 Gemini API 키가 없습니다")
    model = get_gemini_model()

    src = Path(audio_path)
    tmp = Path(tempfile.gettempdir()) / f"notie_stt_{src.stem}.wav"
    chunk_files: list[Path] = []
    try:
        duration = _transcode_to_wav(src, tmp)

        # 무음/거의 무음이면 전사하지 않는다 — 생성형 모델이 무음을 환각으로 받아 적는 것 방지
        peak = _wav_peak(tmp)
        if peak < _SILENCE_PEAK:
            logger.info("gemini_stt: 무음 감지(peak=%d) — 전사 생략", peak)
            return []

        if duration > _CHUNK_SECONDS * 1.2:
            chunks = _split_wav(tmp, _CHUNK_SECONDS)
            chunk_files = [p for p, _ in chunks]
        else:
            chunks = [(tmp, 0.0)]

        segments: list[dict] = []
        for i, (part_path, offset) in enumerate(chunks):
            part_segments = _transcribe_one(httpx, api_key, model, part_path)
            for s in part_segments:
                start = s["start"] + offset
                end = s["end"] + offset
                # 오디오 길이를 벗어나는 환각성 타임스탬프는 버리거나 클램프
                if start > duration + 1:
                    continue
                segments.append(
                    {
                        "start": round(min(start, duration), 2),
                        "end": round(min(end, duration), 2),
                        "text": s["text"],
                    }
                )
            if len(chunks) > 1:
                logger.info(
                    "gemini_stt: 조각 %d/%d 전사 완료 (%d개 세그먼트)",
                    i + 1,
                    len(chunks),
                    len(part_segments),
                )

        segments.sort(key=lambda s: s["start"])
        logger.info("gemini_stt: 전사 완료 — %d개 세그먼트 (model=%s)", len(segments), model)
        return segments
    except RuntimeError:
        raise
    except Exception as exc:
        status = getattr(getattr(exc, "response", None), "status_code", None)
        detail = f"HTTP {status}" if status else exc.__class__.__name__
        raise RuntimeError(f"Gemini 음성 변환 실패 ({detail})") from exc
    finally:
        for p in [tmp, *chunk_files]:
            try:
                p.unlink(missing_ok=True)
            except OSError:
                pass
