"""처리 파이프라인 — STT/요약 백그라운드 잡 큐.

계약 (SPEC.md):
- 모듈 레벨 ThreadPoolExecutor(max_workers=1) — STT/요약 잡 순차 처리.
- enqueue(meeting_id): status='transcribing' → gemini_stt.transcribe → 세그먼트 교체 저장
  → status='summarizing' → summarizer.summarize → summaries upsert → status='done'.
- enqueue_summary(meeting_id): 요약 단계만 재실행.
- 각 잡은 자체 db.get_conn() 사용(스레드 안전). 예외 시 status='failed' + error_message
  저장, traceback 로그 출력. 세그먼트 0개(무음/잡음)는 실패 상태로 남겨 가짜 요약을 막는다.
- summaries upsert는 INSERT OR REPLACE, JSON 컬럼은 json.dumps(ensure_ascii=False).
"""

import json
import logging
import traceback
from concurrent.futures import ThreadPoolExecutor

from .. import config, db
from . import gemini_stt, summarizer

logger = logging.getLogger("gimnote.pipeline")

# 긴 오디오 전사/요약이 겹치지 않도록 워커 1개로 고정
_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="gimnote-pipeline")


class ProcessingStopped(Exception):
    """사용자가 취소했거나 상태가 바뀐 작업을 조용히 중단하기 위한 내부 예외."""


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
        if meeting.get("status") != "queued":
            logger.info("pipeline: meeting %s 상태가 queued가 아니어서 전체 잡을 중단합니다", meeting_id)
            return

        audio_filename = meeting.get("audio_filename")
        if not audio_filename:
            raise RuntimeError("업로드된 오디오 파일이 없습니다")
        audio_path = config.AUDIO_DIR / audio_filename
        if not audio_path.exists():
            raise RuntimeError(f"오디오 파일을 찾을 수 없습니다: {audio_filename}")

        # 새 오디오 전체 처리에서는 예전 스크립트/요약을 먼저 비운다.
        # 전사 실패 시에도 낡은 텍스트로 재요약되는 일을 막고, 임시저장 상태를 명확히 한다.
        _ensure_status(conn, meeting_id, "queued")
        with conn:
            conn.execute("DELETE FROM transcript_segments WHERE meeting_id = ?", (meeting_id,))
            conn.execute("DELETE FROM summaries WHERE meeting_id = ?", (meeting_id,))

        # 0) 파형 피크 미리 계산 (변환 중에도 UI에 파형이 보이도록 — 실패해도 진행)
        _transition_status(conn, meeting_id, "queued", "transcribing")
        try:
            from . import waveform

            waveform.get_peaks(audio_path)
        except Exception:
            logger.warning("pipeline: 파형 계산 실패 — 요청 시 재계산됨 (meeting %s)", meeting_id)
        _ensure_status(conn, meeting_id, "transcribing")

        # 1) 변환 — Gemini 키/네트워크 오류를 실패로 남긴다.
        # 그래야 음성 파일을 임시저장해두고, 키 수정 후 같은 오디오로 다시 전사할 수 있다.
        try:
            segments = gemini_stt.transcribe(
                str(audio_path),
                usage_ctx={"user_id": meeting.get("user_id"), "meeting_id": meeting_id},
            )
        except Exception as exc:
            raise RuntimeError(f"음성 변환 실패: {exc}") from exc

        if not segments:
            raise RuntimeError(
                "인식 가능한 음성이 없습니다. 마이크 입력을 확인한 뒤 다시 녹음해주세요."
            )

        # 세그먼트 삽입
        _ensure_status(conn, meeting_id, "transcribing")
        with conn:
            current = conn.execute("SELECT status FROM meetings WHERE id = ?", (meeting_id,)).fetchone()
            if current is None or current["status"] != "transcribing":
                raise ProcessingStopped()
            conn.executemany(
                "INSERT INTO transcript_segments (meeting_id, start_sec, end_sec, text)"
                " VALUES (?, ?, ?, ?)",
                [
                    (meeting_id, seg["start"], seg["end"], seg["text"])
                    for seg in segments
                ],
            )
            # duration_sec이 NULL/0이면(브라우저가 duration을 못 읽은 업로드 대비)
            # 마지막 세그먼트 end_sec으로 보정
            if segments and not meeting.get("duration_sec"):
                conn.execute(
                    "UPDATE meetings SET duration_sec = ? WHERE id = ?",
                    (segments[-1]["end"], meeting_id),
                )

        # 2) 요약
        _transition_status(conn, meeting_id, "transcribing", "summarizing")
        _summarize_and_store(conn, meeting_id)

        _transition_status(conn, meeting_id, "summarizing", "done")
    except ProcessingStopped:
        logger.info("pipeline: meeting %s 작업이 취소되었거나 상태가 바뀌어 중단됐습니다", meeting_id)
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

        _ensure_status(conn, meeting_id, "summarizing")
        _summarize_and_store(conn, meeting_id)
        _transition_status(conn, meeting_id, "summarizing", "done")
    except ProcessingStopped:
        logger.info("pipeline: meeting %s 요약 작업이 취소되었거나 상태가 바뀌어 중단됐습니다", meeting_id)
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


def _ensure_status(conn, meeting_id: int, expected_status: str) -> None:
    row = conn.execute("SELECT status FROM meetings WHERE id = ?", (meeting_id,)).fetchone()
    if row is None or row["status"] != expected_status:
        raise ProcessingStopped()


def _transition_status(
    conn, meeting_id: int, expected_status: str, next_status: str, error_message: str | None = None
) -> None:
    with conn:
        cur = conn.execute(
            """
            UPDATE meetings
            SET status = ?, error_message = ?
            WHERE id = ? AND status = ?
            """,
            (next_status, error_message, meeting_id, expected_status),
        )
    if cur.rowcount == 0:
        raise ProcessingStopped()


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
            "SELECT id, time_sec, title, note, kind FROM bookmarks"
            " WHERE meeting_id = ? ORDER BY time_sec ASC",
            (meeting_id,),
        )
    ]
    participants = [
        dict(r)
        for r in conn.execute(
            "SELECT p.id, p.name, p.role, p.department, p.organization, p.color"
            " FROM participants p"
            " JOIN meeting_participants mp ON mp.participant_id = p.id"
            " WHERE mp.meeting_id = ? ORDER BY p.id ASC",
            (meeting_id,),
        )
    ]

    prompt_kind = "manual" if not meeting.get("audio_filename") else "recording"
    summary = summarizer.summarize(
        meeting, segments, bookmarks, participants, prompt_kind=prompt_kind
    )

    _ensure_status(conn, meeting_id, "summarizing")
    with conn:
        conn.execute(
            "INSERT OR REPLACE INTO summaries"
            " (meeting_id, key_points, decisions, action_items,"
            " discussion, followups, engine_note, minutes_md, engine)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                meeting_id,
                json.dumps(summary["key_points"], ensure_ascii=False),
                json.dumps(summary["decisions"], ensure_ascii=False),
                json.dumps(summary["action_items"], ensure_ascii=False),
                summary["discussion"],
                json.dumps(summary["followups"], ensure_ascii=False),
                summary["engine_note"],
                summary["minutes_md"],
                summary["engine"],
            ),
        )
