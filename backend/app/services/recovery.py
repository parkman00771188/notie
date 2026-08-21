"""녹음 비정상 종료 복구 — 라이브 청크 저장 + 끊긴 녹음 자동 확정.

프런트는 녹음 중 5초마다 지금까지의 오디오 바이트를 live-chunk API로 이어 보낸다
(새 청크가 없어도 하트비트로 파일 mtime을 갱신). 브라우저/컴퓨터가 꺼지면 업로드가
끊기고, 여기 스위퍼가 일정 시간 신호가 없는 'recording' 회의를 찾아:
- 저장된 청크가 있으면 그 시점까지의 음원으로 확정하고 STT/요약 파이프라인 실행
- 저장된 청크가 없으면 실패 상태로 전환해 '녹음 중' 표시가 영원히 남지 않게 한다

MediaRecorder(timeslice)가 만드는 webm 청크는 이어 붙이면 그대로 유효한 스트림이라
(헤더는 첫 청크에 포함) 부분 파일도 디코드/전사가 가능하다.
"""

import logging
import os
import threading
import time
from datetime import datetime
from pathlib import Path

from .. import config, db
from . import pipeline

logger = logging.getLogger("gimnote.recovery")

# 마지막 청크/하트비트 이후 이 시간이 지나면 끊긴 녹음으로 판단.
# 백그라운드 탭은 타이머가 분 단위로 스로틀될 수 있어 하트비트(5초)보다 넉넉히 잡는다.
STALE_AFTER_SEC = 180
# 라이브 청크가 한 번도 안 온 'recording' 회의(구버전 프런트, 생성 직후 이탈 등)를
# 정리하기까지의 유예 — 생성 시각 기준.
NO_DATA_GRACE_SEC = 600
SWEEP_INTERVAL_SEC = 60

NO_DATA_MESSAGE = "녹음이 예기치 않게 종료되어 저장된 음성이 없어요. 새 회의로 다시 녹음해주세요."


def live_part_path(meeting_id: int) -> Path:
    """녹음 중 청크가 누적되는 임시 파일 경로 (확정 시 meeting_{id}.webm으로 이동)."""
    return config.AUDIO_DIR / f"live_{meeting_id}.webm.part"


def discard_live_part(meeting_id: int) -> None:
    """정상 업로드/완전 삭제 후 임시 청크 파일 정리."""
    try:
        live_part_path(meeting_id).unlink(missing_ok=True)
    except OSError:
        pass


def append_live_chunk(meeting_id: int, data: bytes | None, offset: int) -> int:
    """라이브 청크를 offset 위치에 기록하고 서버에 저장된 총 바이트를 반환.

    - offset > 현재 크기(서버 재시작 등으로 앞부분 유실): 기록하지 않고 현재 크기를
      돌려줘 클라이언트가 그 지점부터 다시 보내게 한다.
    - offset < 현재 크기(재전송 중복): offset으로 잘라내고 덮어써 항상 정합을 유지한다.
    - data가 없으면 하트비트 — mtime만 갱신해 스위퍼가 살아있음을 알게 한다.
    """
    path = live_part_path(meeting_id)
    config.AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    path.touch(exist_ok=True)
    size = path.stat().st_size
    if not data:
        os.utime(path, None)
        return size
    if offset > size:
        os.utime(path, None)
        return size
    with open(path, "r+b") as f:
        f.seek(offset)
        f.truncate()
        f.write(data)
    return offset + len(data)


def finalize_now(meeting_id: int) -> None:
    """부분 녹음을 즉시 확정(데이터 없으면 실패 처리).

    탭/브라우저가 닫히는 순간의 live-abort 신호(sendBeacon)용 — 스위퍼의
    끊김 판정(STALE_AFTER_SEC)을 기다리지 않고 바로 저장·처리로 넘어간다.
    """
    conn = db.get_conn()
    try:
        part = live_part_path(meeting_id)
        if part.exists() and part.stat().st_size > 0:
            _finalize_partial(conn, meeting_id, part)
        else:
            _mark_no_data(conn, meeting_id)
    finally:
        conn.close()


def sweep_once() -> None:
    """신호가 끊긴 'recording' 회의를 찾아 확정하거나 실패 처리한다."""
    conn = db.get_conn()
    try:
        rows = conn.execute(
            "SELECT id, created_at FROM meetings WHERE status = 'recording' AND deleted_at IS NULL"
        ).fetchall()
        now = time.time()
        for row in rows:
            meeting_id = row["id"]
            part = live_part_path(meeting_id)
            if part.exists():
                stat = part.stat()
                if now - stat.st_mtime < STALE_AFTER_SEC:
                    continue  # 청크/하트비트가 들어오는 살아있는 녹음
                if stat.st_size > 0:
                    _finalize_partial(conn, meeting_id, part)
                else:
                    _mark_no_data(conn, meeting_id)
            else:
                created = _parse_local_ts(row["created_at"])
                if created is None or now - created >= NO_DATA_GRACE_SEC:
                    _mark_no_data(conn, meeting_id)
        _cleanup_orphan_parts(conn, now)
    finally:
        conn.close()


def _cleanup_orphan_parts(conn, now: float) -> None:
    """녹음 중이 아닌 회의의 임시 청크 파일 정리.

    확정(finalize)과 마지막 청크 업로드가 아슬하게 겹치면 빈 part 파일이
    다시 생길 수 있다 — 상태가 'recording'이 아닌 회의의 오래된 part는 지운다.
    """
    for part in config.AUDIO_DIR.glob("live_*.webm.part"):
        try:
            meeting_id = int(part.name.split("_")[1].split(".")[0])
        except (IndexError, ValueError):
            continue
        try:
            if now - part.stat().st_mtime < STALE_AFTER_SEC:
                continue
        except OSError:
            continue
        row = conn.execute("SELECT status FROM meetings WHERE id = ?", (meeting_id,)).fetchone()
        if row is None or row["status"] != "recording":
            try:
                part.unlink(missing_ok=True)
            except OSError:
                pass


def _finalize_partial(conn, meeting_id: int, part: Path) -> None:
    """저장된 청크까지를 이 회의의 음원으로 확정하고 파이프라인을 시작한다."""
    filename = f"meeting_{meeting_id}.webm"
    # 상태를 먼저 선점(atomic) — 그 사이 정상 종료 업로드가 끝났다면 건드리지 않는다.
    # duration은 webm에 길이 메타데이터가 없어 파이프라인의 디코드 보정에 맡긴다.
    with conn:
        cur = conn.execute(
            """
            UPDATE meetings
            SET audio_filename = ?, duration_sec = NULL, status = 'queued', error_message = NULL
            WHERE id = ? AND status = 'recording'
            """,
            (filename, meeting_id),
        )
    if cur.rowcount == 0:
        return
    try:
        os.replace(part, config.AUDIO_DIR / filename)
    except OSError:
        logger.exception("recovery: meeting %s 임시 청크 파일 이동 실패", meeting_id)
        # audio_filename은 설정됐지만 파일이 없으므로 파이프라인이 실패 상태로 남긴다
    logger.info("recovery: meeting %s 끊긴 녹음을 저장된 분량으로 확정 — 파이프라인 시작", meeting_id)
    pipeline.enqueue(meeting_id)


def _mark_no_data(conn, meeting_id: int) -> None:
    with conn:
        cur = conn.execute(
            "UPDATE meetings SET status = 'failed', error_message = ? WHERE id = ? AND status = 'recording'",
            (NO_DATA_MESSAGE, meeting_id),
        )
    if cur.rowcount:
        discard_live_part(meeting_id)
        logger.info("recovery: meeting %s 저장된 음성 없이 끊긴 녹음을 실패 처리", meeting_id)


def _parse_local_ts(value: str | None) -> float | None:
    """created_at(datetime('now','localtime') 형식)을 epoch 초로."""
    if not value:
        return None
    try:
        return datetime.strptime(value[:19], "%Y-%m-%d %H:%M:%S").timestamp()
    except ValueError:
        return None


_sweeper_started = False


def start_sweeper() -> None:
    """복구 스위퍼 백그라운드 스레드 시작 (중복 호출 무시)."""
    global _sweeper_started
    if _sweeper_started:
        return
    _sweeper_started = True

    def _loop() -> None:
        while True:
            # 서버 재시작 직후 살아있는 클라이언트가 하트비트를 다시 보낼 시간을 준다
            time.sleep(SWEEP_INTERVAL_SEC)
            try:
                sweep_once()
            except Exception:
                logger.exception("recovery: 스위퍼 실행 중 오류")

    threading.Thread(target=_loop, name="gimnote-recovery", daemon=True).start()
