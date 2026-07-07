"""Gemini 오디오 전사(STT) — 등록된 Gemini API 키로 음성→텍스트 변환.

로컬 Whisper 대신 선택할 수 있는 클라우드 STT 엔진. 별도 키 없이
summarizer와 같은 Gemini 키를 재사용한다 (app_settings 'stt_engine' == 'gemini').

동작:
1) 어떤 입력 포맷이든(webm/m4a/mp3/...) PyAV로 16kHz 모노 WAV로 변환 (Gemini가 확실히 지원)
2) Gemini Files API에 업로드(재개형 프로토콜) 후 ACTIVE 될 때까지 대기
3) generateContent(JSON 강제)로 "[{start, end, text}]" 세그먼트 전사 요청
4) 방어적 파싱(MM:SS/H:MM:SS → 초), 업로드 파일은 사용 후 삭제(베스트 에포트)

실패 시 한국어 RuntimeError — pipeline이 잡아서 로컬 Whisper로 폴백한다.
"""

import base64
import json
import logging
import re
import tempfile
import wave
from pathlib import Path

from .. import config, db
from .summarizer import get_gemini_key, get_gemini_model

logger = logging.getLogger("gimnote.gemini_stt")

STT_ENGINE_SETTING = "stt_engine"

# 이 크기 이하면 Files API 대신 요청에 인라인(base64) 첨부 (요청 한도 ~20MB)
_INLINE_LIMIT_BYTES = 15 * 1024 * 1024
# 전사 응답 대기 (장시간 회의 대비)
_GENERATE_TIMEOUT = 600.0

_TS_RE = re.compile(r"^\s*(?:(\d+):)?(\d{1,2}):(\d{2}(?:\.\d+)?)\s*$")


def get_engine() -> str:
    """현재 STT 엔진 설정 — 'local'(기본) | 'gemini'."""
    try:
        conn = db.get_conn()
        try:
            row = conn.execute(
                "SELECT value FROM app_settings WHERE key = ?", (STT_ENGINE_SETTING,)
            ).fetchone()
        finally:
            conn.close()
        if row is not None and str(row["value"]).strip() == "gemini":
            return "gemini"
    except Exception as exc:
        logger.warning("gemini_stt: stt_engine 조회 실패 — local 사용: %s", exc)
    return "local"


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
        "- 무음·잡음 구간은 제외하고, 들리는 그대로 자연스러운 한국어로 표기"
    )


def _parse_segments(text: str) -> list[dict]:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```[a-zA-Z]*\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned)
    data = json.loads(cleaned)
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


def transcribe(audio_path: str) -> list[dict]:
    """Gemini로 오디오 전사 → [{"start", "end", "text"}]. 실패 시 RuntimeError."""
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
    uploaded_name: str | None = None
    try:
        _transcode_to_wav(src, tmp)
        size = tmp.stat().st_size

        if size <= _INLINE_LIMIT_BYTES:
            audio_part = {
                "inline_data": {
                    "mime_type": "audio/wav",
                    "data": base64.b64encode(tmp.read_bytes()).decode("ascii"),
                }
            }
        else:
            file_info = _upload_file(httpx, api_key, tmp)
            uploaded_name = file_info.get("name")
            file_info = _wait_active(httpx, api_key, file_info)
            audio_part = {
                "file_data": {
                    "mime_type": file_info.get("mimeType") or "audio/wav",
                    "file_uri": file_info["uri"],
                }
            }

        resp = httpx.post(
            f"{config.GEMINI_BASE_URL.rstrip('/')}/models/{model}:generateContent",
            headers={"x-goog-api-key": api_key},
            json={
                "contents": [{"parts": [audio_part, {"text": _build_prompt()}]}],
                "generationConfig": {"response_mime_type": "application/json"},
            },
            timeout=_GENERATE_TIMEOUT,
        )
        resp.raise_for_status()
        body = resp.json()
        try:
            text = body["candidates"][0]["content"]["parts"][0]["text"]
        except (KeyError, IndexError, TypeError) as exc:
            raise RuntimeError("Gemini 전사 응답에서 텍스트를 찾지 못했습니다") from exc

        segments = _parse_segments(text)
        logger.info("gemini_stt: 전사 완료 — %d개 세그먼트 (model=%s)", len(segments), model)
        return segments
    except RuntimeError:
        raise
    except Exception as exc:
        status = getattr(getattr(exc, "response", None), "status_code", None)
        detail = f"HTTP {status}" if status else exc.__class__.__name__
        raise RuntimeError(f"Gemini 음성 변환 실패 ({detail})") from exc
    finally:
        if uploaded_name:
            _delete_file(httpx, api_key, uploaded_name)
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
