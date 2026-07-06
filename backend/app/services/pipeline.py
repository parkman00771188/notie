"""처리 파이프라인 — STT/요약 백그라운드 잡 큐.

계약 (SPEC.md):
- 모듈 레벨 ThreadPoolExecutor(max_workers=1) — Whisper 동시 실행 방지.
- enqueue(meeting_id): status='transcribing' → stt.transcribe → 세그먼트 교체 저장
  → status='summarizing' → summarizer.summarize → summaries upsert → status='done'.
- enqueue_summary(meeting_id): 요약 단계만 재실행.
- 각 잡은 자체 db.get_conn() 사용(스레드 안전). 예외 시 status='failed' + error_message
  저장, traceback 로그 출력. 세그먼트 0개(무음)도 정상 done 처리.
- summaries upsert는 INSERT OR REPLACE, JSON 컬럼은 json.dumps(ensure_ascii=False).
"""

import json
import logging
import traceback
from concurrent.futures import ThreadPoolExecutor

from .. import config, db
from . import stt, summarizer

logger = logging.getLogger("gimnote.pipeline")

# Whisper 모델 동시 실행 방지를 위해 워커 1개로 고정
_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="gimnote-pipeline")


def enqueue(meeting_id: int) -> None:
    """전체 파이프라인(STT → 요약) 잡을 큐에 넣는다."""
    _executor.submit(_run_full_job, meeting_id)


def enqueue_summary(meeting_id: int) -> None:
    """요약 단계만 재실행하는 잡을 큐에 넣는다."""
    _executor.submit(_run_summary_job, meeting_id)


# ---------------------------------------------------------------------------
# 잡 구현 (워커 스레드에서 실행 — 반드시 자체 커넥션 사용)
# ---------------------------------------------------------------------------

def _run_full_job(meeting_id: int) -> None:
    conn = None
    try:
        conn = db.get_conn()
        row = conn.execute("SELECT * FROM meetings WHERE id = ?", (meeting_id,)).fetchone()
        if row is None:
            logger.warning("pipeline: meeting %s 이(가) 존재하지 않아 잡을 건너뜁니다", meeting_id)
            return
        meeting = dict(row)

        audio_filename = meeting.get("audio_filename")
        if not audio_filename:
            raise RuntimeError("업로드된 오디오 파일이 없습니다")
        audio_path = config.AUDIO_DIR / audio_filename
        if not audio_path.exists():
            raise RuntimeError(f"오디오 파일을 찾을 수 없습니다: {audio_filename}")

        # 1) 변환
        _set_status(conn, meeting_id, "transcribing")
        segments = stt.transcribe(str(audio_path))

        # 기존 세그먼트 삭제 후 삽입 (무음이면 0개 — 정상 진행)
        with conn:
            conn.execute(
                "DELETE FROM transcript_segments WHERE meeting_id = ?", (meeting_id,)
            )
            conn.executemany(
                "INSERT INTO transcript_segments (meeting_id, start_sec, end_sec, text)"
                " VALUES (?, ?, ?, ?)",
                [
                    (meeting_id, seg["start"], seg["end"], seg["text"])
                    for seg in segments
                ],
            )

        # 2) 요약
        _set_status(conn, meeting_id, "summarizing")
        _summarize_and_store(conn, meeting_id)

        _set_status(conn, meeting_id, "done")
    except Exception as exc:
        _mark_failed(meeting_id, exc)
    finally:
        if conn is not None:
            conn.close()


def _run_summary_job(meeting_id: int) -> None:
    conn = None
    try:
        conn = db.get_conn()
        row = conn.execute("SELECT id FROM meetings WHERE id = ?", (meeting_id,)).fetchone()
        if row is None:
            logger.warning("pipeline: meeting %s 이(가) 존재하지 않아 잡을 건너뜁니다", meeting_id)
            return

        _set_status(conn, meeting_id, "summarizing")
        _summarize_and_store(conn, meeting_id)
        _set_status(conn, meeting_id, "done")
    except Exception as exc:
        _mark_failed(meeting_id, exc)
    finally:
        if conn is not None:
            conn.close()


# ---------------------------------------------------------------------------
# 헬퍼
# ---------------------------------------------------------------------------

def _set_status(conn, meeting_id: int, status: str, error_message: str | None = None) -> None:
    with conn:
        conn.execute(
            "UPDATE meetings SET status = ?, error_message = ? WHERE id = ?",
            (status, error_message, meeting_id),
        )


def _mark_failed(meeting_id: int, exc: Exception) -> None:
    """실패 상태 기록 + traceback 로그 출력. 새 커넥션 사용(기존 커넥션이 깨졌을 수 있음)."""
    logger.error("pipeline: meeting %s 처리 실패: %s", meeting_id, exc)
    traceback.print_exc()
    message = str(exc).strip() or exc.__class__.__name__
    try:
        conn = db.get_conn()
        try:
            _set_status(conn, meeting_id, "failed", message)
        finally:
            conn.close()
    except Exception:
        logger.error("pipeline: meeting %s 실패 상태 기록 중 오류", meeting_id)
        traceback.print_exc()


def _summarize_and_store(conn, meeting_id: int) -> None:
    """DB에서 컨텍스트를 읽어 요약을 생성하고 summaries에 upsert 한다."""
    meeting = dict(
        conn.execute("SELECT * FROM meetings WHERE id = ?", (meeting_id,)).fetchone()
    )
    segments = [
        dict(r)
        for r in conn.execute(
            "SELECT start_sec, end_sec, text FROM transcript_segments"
            " WHERE meeting_id = ? ORDER BY start_sec ASC",
            (meeting_id,),
        )
    ]
    bookmarks = [
        dict(r)
        for r in conn.execute(
            "SELECT id, time_sec, title, note FROM bookmarks"
            " WHERE meeting_id = ? ORDER BY time_sec ASC",
            (meeting_id,),
        )
    ]
    participants = [
        dict(r)
        for r in conn.execute(
            "SELECT p.id, p.name, p.role, p.color FROM participants p"
            " JOIN meeting_participants mp ON mp.participant_id = p.id"
            " WHERE mp.meeting_id = ? ORDER BY p.id ASC",
            (meeting_id,),
        )
    ]

    summary = summarizer.summarize(meeting, segments, bookmarks, participants)

    with conn:
        conn.execute(
            "INSERT OR REPLACE INTO summaries"
            " (meeting_id, key_points, decisions, action_items, minutes_md, engine)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (
                meeting_id,
                json.dumps(summary["key_points"], ensure_ascii=False),
                json.dumps(summary["decisions"], ensure_ascii=False),
                json.dumps(summary["action_items"], ensure_ascii=False),
                summary["minutes_md"],
                summary["engine"],
            ),
        )
