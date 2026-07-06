"""회의(meetings) 라우터.

경로는 main.py에서 prefix "/api/meetings" 로 include 된다.
모든 조회/수정은 현재 로그인 사용자(user_id)로 스코프하며, 남의 리소스는 404.
"""

import json
import mimetypes
import shutil
import sqlite3
from contextlib import closing
from datetime import datetime
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .. import config, db
from ..auth_utils import get_current_user
from ..services import pipeline

router = APIRouter()

# 업로드 content_type → 저장 확장자 (기본 .webm)
_EXT_BY_CONTENT_TYPE = {
    "audio/webm": ".webm",
    "video/webm": ".webm",
    "audio/ogg": ".ogg",
    "application/ogg": ".ogg",
    "audio/mpeg": ".mp3",
    "audio/mp3": ".mp3",
    "audio/mp4": ".m4a",
    "audio/x-m4a": ".m4a",
    "audio/aac": ".aac",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/wave": ".wav",
    "audio/flac": ".flac",
}

# 스트리밍용 확장자 → media_type
_MEDIA_BY_EXT = {
    ".webm": "audio/webm",
    ".ogg": "audio/ogg",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".wav": "audio/wav",
    ".flac": "audio/flac",
}


class MeetingCreate(BaseModel):
    title: str
    tag: Optional[str] = None
    participant_ids: Optional[List[int]] = None


class MeetingUpdate(BaseModel):
    title: Optional[str] = None
    tag: Optional[str] = None
    participant_ids: Optional[List[int]] = None


def payload_fields(model: BaseModel) -> dict:
    """요청 본문에 실제로 포함된 필드만 dict로 (pydantic v1/v2 호환)."""
    if hasattr(model, "model_dump"):
        return model.model_dump(exclude_unset=True)
    return model.dict(exclude_unset=True)


def get_owned_meeting(conn: sqlite3.Connection, meeting_id: int, user_id: int) -> sqlite3.Row:
    """현재 사용자 소유의 meeting row를 반환. 없거나 남의 것이면 404."""
    row = conn.execute(
        "SELECT * FROM meetings WHERE id = ? AND user_id = ?",
        (meeting_id, user_id),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="회의를 찾을 수 없습니다")
    return row


def serialize_meeting(conn: sqlite3.Connection, row: sqlite3.Row) -> dict:
    """meetings row → Meeting 응답 dict (participants 조인 포함)."""
    participants = conn.execute(
        """
        SELECT p.id, p.name, p.role, p.color
        FROM meeting_participants mp
        JOIN participants p ON p.id = mp.participant_id
        WHERE mp.meeting_id = ?
        ORDER BY p.id
        """,
        (row["id"],),
    ).fetchall()
    return {
        "id": row["id"],
        "title": row["title"],
        "tag": row["tag"],
        "status": row["status"],
        "started_at": row["started_at"],
        "duration_sec": row["duration_sec"],
        "audio_filename": row["audio_filename"],
        "created_at": row["created_at"],
        "participants": [dict(p) for p in participants],
    }


def _replace_participants(
    conn: sqlite3.Connection, meeting_id: int, user_id: int, participant_ids: List[int]
) -> None:
    """meeting_participants 전체 교체. 현재 사용자 소유 참석자만 반영."""
    conn.execute("DELETE FROM meeting_participants WHERE meeting_id = ?", (meeting_id,))
    for pid in participant_ids:
        owned = conn.execute(
            "SELECT id FROM participants WHERE id = ? AND user_id = ?",
            (pid, user_id),
        ).fetchone()
        if owned is not None:
            conn.execute(
                "INSERT OR IGNORE INTO meeting_participants (meeting_id, participant_id) VALUES (?, ?)",
                (meeting_id, pid),
            )


@router.post("")
def create_meeting(payload: MeetingCreate, user: dict = Depends(get_current_user)) -> dict:
    started_at = datetime.now().isoformat(timespec="seconds")
    with closing(db.get_conn()) as conn:
        with conn:
            cur = conn.execute(
                "INSERT INTO meetings (user_id, title, tag, status, started_at) VALUES (?, ?, ?, 'recording', ?)",
                (user["id"], payload.title, payload.tag, started_at),
            )
            meeting_id = cur.lastrowid
            if payload.participant_ids:
                _replace_participants(conn, meeting_id, user["id"], payload.participant_ids)
        row = get_owned_meeting(conn, meeting_id, user["id"])
        return serialize_meeting(conn, row)


@router.get("")
def list_meetings(q: Optional[str] = None, user: dict = Depends(get_current_user)) -> list:
    with closing(db.get_conn()) as conn:
        if q:
            rows = conn.execute(
                "SELECT * FROM meetings WHERE user_id = ? AND title LIKE ? ORDER BY created_at DESC, id DESC",
                (user["id"], f"%{q}%"),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM meetings WHERE user_id = ? ORDER BY created_at DESC, id DESC",
                (user["id"],),
            ).fetchall()
        return [serialize_meeting(conn, row) for row in rows]


@router.get("/{meeting_id}")
def get_meeting(meeting_id: int, user: dict = Depends(get_current_user)) -> dict:
    with closing(db.get_conn()) as conn:
        row = get_owned_meeting(conn, meeting_id, user["id"])
        detail = serialize_meeting(conn, row)
        detail["error_message"] = row["error_message"]

        bookmarks = conn.execute(
            "SELECT id, meeting_id, time_sec, title, note, created_at FROM bookmarks WHERE meeting_id = ? ORDER BY time_sec ASC, id ASC",
            (meeting_id,),
        ).fetchall()
        detail["bookmarks"] = [dict(b) for b in bookmarks]

        segments = conn.execute(
            "SELECT id, start_sec, end_sec, text FROM transcript_segments WHERE meeting_id = ? ORDER BY start_sec ASC, id ASC",
            (meeting_id,),
        ).fetchall()
        detail["segments"] = [dict(s) for s in segments]

        summary_row = conn.execute(
            "SELECT * FROM summaries WHERE meeting_id = ?", (meeting_id,)
        ).fetchone()
        if summary_row is None:
            detail["summary"] = None
        else:
            detail["summary"] = {
                "key_points": json.loads(summary_row["key_points"]),
                "decisions": json.loads(summary_row["decisions"]),
                "action_items": json.loads(summary_row["action_items"]),
                "minutes_md": summary_row["minutes_md"],
                "engine": summary_row["engine"],
                "created_at": summary_row["created_at"],
            }
        return detail


@router.patch("/{meeting_id}")
def update_meeting(
    meeting_id: int, payload: MeetingUpdate, user: dict = Depends(get_current_user)
) -> dict:
    data = payload_fields(payload)
    with closing(db.get_conn()) as conn:
        get_owned_meeting(conn, meeting_id, user["id"])
        with conn:
            sets = []
            values: list = []
            if "title" in data and data["title"] is not None:
                sets.append("title = ?")
                values.append(data["title"])
            if "tag" in data:
                sets.append("tag = ?")
                values.append(data["tag"])
            if sets:
                values.append(meeting_id)
                conn.execute(f"UPDATE meetings SET {', '.join(sets)} WHERE id = ?", values)
            if data.get("participant_ids") is not None:
                _replace_participants(conn, meeting_id, user["id"], data["participant_ids"])
        row = get_owned_meeting(conn, meeting_id, user["id"])
        return serialize_meeting(conn, row)


@router.delete("/{meeting_id}")
def delete_meeting(meeting_id: int, user: dict = Depends(get_current_user)) -> dict:
    with closing(db.get_conn()) as conn:
        row = get_owned_meeting(conn, meeting_id, user["id"])
        audio_filename = row["audio_filename"]
        with conn:
            conn.execute("DELETE FROM meetings WHERE id = ?", (meeting_id,))
    if audio_filename:
        try:
            (config.AUDIO_DIR / audio_filename).unlink(missing_ok=True)
        except OSError:
            pass  # 파일 삭제 실패는 무시 (DB에서는 이미 삭제됨)
    return {"ok": True}


@router.post("/{meeting_id}/audio")
def upload_audio(
    meeting_id: int,
    file: UploadFile = File(...),
    duration_sec: float = Form(...),
    user: dict = Depends(get_current_user),
) -> dict:
    content_type = (file.content_type or "").split(";")[0].strip().lower()
    ext = _EXT_BY_CONTENT_TYPE.get(content_type)
    if ext is None:
        suffix = Path(file.filename or "").suffix.lower()
        ext = suffix if suffix in _MEDIA_BY_EXT else ".webm"
    filename = f"meeting_{meeting_id}{ext}"

    with closing(db.get_conn()) as conn:
        row = get_owned_meeting(conn, meeting_id, user["id"])
        old_filename = row["audio_filename"]

        dest = config.AUDIO_DIR / filename
        with dest.open("wb") as out:
            shutil.copyfileobj(file.file, out)

        if old_filename and old_filename != filename:
            try:
                (config.AUDIO_DIR / old_filename).unlink(missing_ok=True)
            except OSError:
                pass

        with conn:
            conn.execute(
                "UPDATE meetings SET duration_sec = ?, audio_filename = ?, status = 'queued', error_message = NULL WHERE id = ?",
                (duration_sec, filename, meeting_id),
            )
        row = get_owned_meeting(conn, meeting_id, user["id"])
        result = serialize_meeting(conn, row)

    pipeline.enqueue(meeting_id)
    return result


@router.get("/{meeting_id}/audio")
def get_audio(meeting_id: int, user: dict = Depends(get_current_user)) -> FileResponse:
    """오디오 스트리밍. get_current_user가 ?token= 쿼리 인증도 지원한다."""
    with closing(db.get_conn()) as conn:
        row = get_owned_meeting(conn, meeting_id, user["id"])
        audio_filename = row["audio_filename"]

    if not audio_filename:
        raise HTTPException(status_code=404, detail="오디오 파일이 없습니다")
    path = config.AUDIO_DIR / audio_filename
    if not path.is_file():
        raise HTTPException(status_code=404, detail="오디오 파일이 없습니다")

    ext = path.suffix.lower()
    media_type = _MEDIA_BY_EXT.get(ext) or mimetypes.guess_type(str(path))[0] or "audio/webm"
    return FileResponse(path, media_type=media_type)


@router.get("/{meeting_id}/status")
def get_status(meeting_id: int, user: dict = Depends(get_current_user)) -> dict:
    with closing(db.get_conn()) as conn:
        row = get_owned_meeting(conn, meeting_id, user["id"])
        return {"status": row["status"], "error_message": row["error_message"]}


@router.post("/{meeting_id}/summarize")
def resummarize(meeting_id: int, user: dict = Depends(get_current_user)) -> dict:
    with closing(db.get_conn()) as conn:
        get_owned_meeting(conn, meeting_id, user["id"])
        count_row = conn.execute(
            "SELECT COUNT(*) AS cnt FROM transcript_segments WHERE meeting_id = ?",
            (meeting_id,),
        ).fetchone()
        if count_row["cnt"] == 0:
            raise HTTPException(status_code=400, detail="요약할 스크립트가 없습니다")
        with conn:
            conn.execute(
                "UPDATE meetings SET status = 'summarizing', error_message = NULL WHERE id = ?",
                (meeting_id,),
            )

    pipeline.enqueue_summary(meeting_id)
    return {"ok": True}
