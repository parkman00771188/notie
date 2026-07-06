"""북마크(bookmarks) 라우터.

main.py에서 prefix "/api" 로 include 되므로 내부 경로에 /meetings, /bookmarks 를 포함한다.
북마크 소유권은 meeting → user_id 조인으로 검증하며, 남의 리소스는 404.
"""

import sqlite3
from contextlib import closing
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import db
from ..auth_utils import get_current_user
from .meetings import get_owned_meeting, payload_fields

router = APIRouter()


class BookmarkCreate(BaseModel):
    time_sec: float
    title: str
    note: Optional[str] = None


class BookmarkUpdate(BaseModel):
    title: Optional[str] = None
    note: Optional[str] = None
    time_sec: Optional[float] = None


def _serialize_bookmark(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "meeting_id": row["meeting_id"],
        "time_sec": row["time_sec"],
        "title": row["title"],
        "note": row["note"],
        "created_at": row["created_at"],
    }


def _get_owned_bookmark(conn: sqlite3.Connection, bookmark_id: int, user_id: int) -> sqlite3.Row:
    row = conn.execute(
        """
        SELECT b.*
        FROM bookmarks b
        JOIN meetings m ON m.id = b.meeting_id
        WHERE b.id = ? AND m.user_id = ?
        """,
        (bookmark_id, user_id),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="북마크를 찾을 수 없습니다")
    return row


@router.post("/meetings/{meeting_id}/bookmarks")
def create_bookmark(
    meeting_id: int, payload: BookmarkCreate, user: dict = Depends(get_current_user)
) -> dict:
    with closing(db.get_conn()) as conn:
        get_owned_meeting(conn, meeting_id, user["id"])
        with conn:
            cur = conn.execute(
                "INSERT INTO bookmarks (meeting_id, time_sec, title, note) VALUES (?, ?, ?, ?)",
                (meeting_id, payload.time_sec, payload.title, payload.note),
            )
        row = conn.execute("SELECT * FROM bookmarks WHERE id = ?", (cur.lastrowid,)).fetchone()
        return _serialize_bookmark(row)


@router.get("/meetings/{meeting_id}/bookmarks")
def list_bookmarks(meeting_id: int, user: dict = Depends(get_current_user)) -> list:
    with closing(db.get_conn()) as conn:
        get_owned_meeting(conn, meeting_id, user["id"])
        rows = conn.execute(
            "SELECT * FROM bookmarks WHERE meeting_id = ? ORDER BY time_sec ASC, id ASC",
            (meeting_id,),
        ).fetchall()
        return [_serialize_bookmark(row) for row in rows]


@router.patch("/bookmarks/{bookmark_id}")
def update_bookmark(
    bookmark_id: int, payload: BookmarkUpdate, user: dict = Depends(get_current_user)
) -> dict:
    data = payload_fields(payload)
    with closing(db.get_conn()) as conn:
        _get_owned_bookmark(conn, bookmark_id, user["id"])
        with conn:
            sets = []
            values: list = []
            if "title" in data and data["title"] is not None:
                sets.append("title = ?")
                values.append(data["title"])
            if "note" in data:
                sets.append("note = ?")
                values.append(data["note"])
            if "time_sec" in data and data["time_sec"] is not None:
                sets.append("time_sec = ?")
                values.append(data["time_sec"])
            if sets:
                values.append(bookmark_id)
                conn.execute(f"UPDATE bookmarks SET {', '.join(sets)} WHERE id = ?", values)
        row = _get_owned_bookmark(conn, bookmark_id, user["id"])
        return _serialize_bookmark(row)


@router.delete("/bookmarks/{bookmark_id}")
def delete_bookmark(bookmark_id: int, user: dict = Depends(get_current_user)) -> dict:
    with closing(db.get_conn()) as conn:
        _get_owned_bookmark(conn, bookmark_id, user["id"])
        with conn:
            conn.execute("DELETE FROM bookmarks WHERE id = ?", (bookmark_id,))
    return {"ok": True}
