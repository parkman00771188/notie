"""회의(meetings) 라우터.

경로는 main.py에서 prefix "/api/meetings" 로 include 된다.
모든 조회/수정은 현재 로그인 사용자(user_id)로 스코프하며, 남의 리소스는 404.
"""

import json
import mimetypes
import re
import shutil
import sqlite3
from contextlib import closing
from datetime import datetime
from pathlib import Path
from typing import List, Optional
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from .. import config, db
from ..auth_utils import get_current_user
from ..services import pipeline, waveform

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
    ".mp4": "audio/mp4",
    ".aac": "audio/aac",
    ".wav": "audio/wav",
    ".flac": "audio/flac",
}

# 업로드 파일명 suffix 폴백 시 허용하는 확장자 화이트리스트 (그 외는 .webm)
_ALLOWED_UPLOAD_EXTS = {".mp3", ".m4a", ".wav", ".webm", ".ogg", ".mp4", ".aac", ".flac"}


class MeetingCreate(BaseModel):
    title: str
    tag: Optional[str] = None
    started_at: Optional[str] = None
    participant_ids: Optional[List[int]] = None


class MeetingScheduleCreate(BaseModel):
    title: str
    tag: Optional[str] = None
    started_at: str
    participant_ids: Optional[List[int]] = None


class MeetingUpdate(BaseModel):
    title: Optional[str] = None
    tag: Optional[str] = None
    started_at: Optional[str] = None
    participant_ids: Optional[List[int]] = None
    locked: Optional[bool] = None
    is_shared: Optional[bool] = None


class SummaryUpdate(BaseModel):
    discussion: Optional[str] = None
    key_points: Optional[List[str]] = None
    decisions: Optional[List[str]] = None
    followups: Optional[List[str]] = None
    action_items: Optional[list] = None  # [str] 또는 [{text, owner?, due?}]


class TranscriptSegmentUpdate(BaseModel):
    text: str


class ManualTranscriptCreate(BaseModel):
    text: str
    duration_sec: Optional[float] = None


def payload_fields(model: BaseModel) -> dict:
    """요청 본문에 실제로 포함된 필드만 dict로 (pydantic v1/v2 호환)."""
    if hasattr(model, "model_dump"):
        return model.model_dump(exclude_unset=True)
    return model.dict(exclude_unset=True)


def get_owned_meeting(
    conn: sqlite3.Connection, meeting_id: int, user_id: int, include_deleted: bool = False
) -> sqlite3.Row:
    """현재 사용자 소유의 meeting row를 반환. 없거나 남의 것이면 404.

    휴지통(소프트 삭제)의 회의는 기본적으로 제외한다 — restore/permanent만 include_deleted=True.
    """
    sql = "SELECT * FROM meetings WHERE id = ? AND user_id = ?"
    if not include_deleted:
        sql += " AND deleted_at IS NULL"
    row = conn.execute(sql, (meeting_id, user_id)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="회의를 찾을 수 없습니다")
    return row


def _normalize_meeting_tag(value: str | None) -> str | None:
    tag_name = (value or "").strip()
    if not tag_name:
        return None
    return tag_name


def _meeting_tag_rows(
    conn: sqlite3.Connection,
    tag_name: str | None,
    owner_user_id: int,
) -> list[sqlite3.Row]:
    tag_name = _normalize_meeting_tag(tag_name)
    if tag_name is None:
        return []
    return conn.execute(
        """
        SELECT DISTINCT
          t.id, t.user_id, t.name, t.is_global,
          CASE
            WHEN EXISTS (SELECT 1 FROM project_tags pt WHERE pt.tag_id = t.id)
            THEN 1
            ELSE 0
          END AS is_project_tag
        FROM tags t
        LEFT JOIN tag_permissions owner_perm
          ON owner_perm.tag_id = t.id AND owner_perm.user_id = ?
        WHERE t.name = ?
          AND (
            t.user_id = ?
            OR owner_perm.user_id IS NOT NULL
            OR t.is_global = 1
          )
        ORDER BY is_project_tag DESC, t.is_global DESC, t.id DESC
        """,
        (owner_user_id, tag_name, owner_user_id),
    ).fetchall()


def _meeting_tag_row(conn: sqlite3.Connection, row: sqlite3.Row) -> sqlite3.Row | None:
    rows = _meeting_tag_rows(conn, row["tag"], row["user_id"])
    return rows[0] if rows else None


def _tag_has_share_scope(conn: sqlite3.Connection, tag_id: int) -> bool:
    return conn.execute(
        "SELECT 1 FROM tag_permissions WHERE tag_id = ? LIMIT 1",
        (tag_id,),
    ).fetchone() is not None


def _tag_allows_user(conn: sqlite3.Connection, tag_id: int, user_id: int) -> bool:
    return conn.execute(
        "SELECT 1 FROM tag_permissions WHERE tag_id = ? AND user_id = ?",
        (tag_id, user_id),
    ).fetchone() is not None


def _meeting_has_share_scope(
    conn: sqlite3.Connection,
    tag_name: str | None,
    owner_user_id: int,
) -> bool:
    return any(_tag_has_share_scope(conn, tag["id"]) for tag in _meeting_tag_rows(conn, tag_name, owner_user_id))


def _meeting_owner_can_share(conn: sqlite3.Connection, owner_user_id: int) -> bool:
    owner = conn.execute(
        "SELECT role, active FROM users WHERE id = ?",
        (owner_user_id,),
    ).fetchone()
    return owner is not None and owner["active"] and owner["role"] != "other"


def _assert_shareable_tag(
    conn: sqlite3.Connection,
    tag_name: str | None,
    owner_user_id: int,
) -> None:
    tag_name = _normalize_meeting_tag(tag_name)
    if tag_name is None:
        raise HTTPException(status_code=400, detail="태그를 설정하세요")
    if not _meeting_has_share_scope(conn, tag_name, owner_user_id):
        raise HTTPException(
            status_code=400,
            detail="프로젝트에 연결된 태그를 설정한 다음 공유해주세요",
        )


def _effective_is_shared(conn: sqlite3.Connection, row: sqlite3.Row) -> bool:
    if not row["is_shared"]:
        return False
    if not _meeting_owner_can_share(conn, row["user_id"]):
        return False
    return _meeting_has_share_scope(conn, row["tag"], row["user_id"])


def _can_read_meeting_row(conn: sqlite3.Connection, row: sqlite3.Row, user: dict) -> bool:
    if row["user_id"] == user["id"]:
        return True
    if not row["is_shared"]:
        return False
    if not _meeting_owner_can_share(conn, row["user_id"]):
        return False
    return any(
        _tag_allows_user(conn, tag["id"], user["id"])
        for tag in _meeting_tag_rows(conn, row["tag"], row["user_id"])
    )


def get_readable_meeting(
    conn: sqlite3.Connection,
    meeting_id: int,
    user_id: int,
    user_role: str = "user",
    include_deleted: bool = False,
) -> sqlite3.Row:
    """현재 사용자 소유이거나 공유된 meeting row를 반환."""
    sql = """
        SELECT m.*, u.name AS owner_name
        FROM meetings m
        JOIN users u ON u.id = m.user_id
        WHERE m.id = ? AND (m.user_id = ? OR m.is_shared = 1)
    """
    if not include_deleted:
        sql += " AND m.deleted_at IS NULL"
    row = conn.execute(sql, (meeting_id, user_id)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="회의를 찾을 수 없습니다")
    if not _can_read_meeting_row(conn, row, {"id": user_id, "role": user_role}):
        raise HTTPException(status_code=404, detail="회의를 찾을 수 없습니다")
        raise HTTPException(status_code=404, detail="?뚯쓽瑜?李얠쓣 ???놁뒿?덈떎")
    return row


def ensure_unlocked(row: sqlite3.Row, detail: str) -> None:
    """잠긴 회의에서 막아야 하는 파괴적/AI 변경 작업을 공통으로 차단."""
    if row["locked"]:
        raise HTTPException(status_code=423, detail=detail)


def serialize_meeting(conn: sqlite3.Connection, row: sqlite3.Row) -> dict:
    """meetings row → Meeting 응답 dict (participants 조인 포함)."""
    row_keys = row.keys()
    participants = conn.execute(
        """
        SELECT p.id, p.name, p.role, p.department, p.organization, p.email, p.phone, p.color
        FROM meeting_participants mp
        JOIN participants p ON p.id = mp.participant_id
        WHERE mp.meeting_id = ?
        ORDER BY p.id
        """,
        (row["id"],),
    ).fetchall()
    return {
        "id": row["id"],
        "user_id": row["user_id"],
        "title": row["title"],
        "tag": row["tag"],
        "status": row["status"],
        "started_at": row["started_at"],
        "duration_sec": row["duration_sec"],
        "audio_filename": row["audio_filename"],
        "locked": bool(row["locked"]),
        "is_shared": _effective_is_shared(conn, row),
        "owner_name": row["owner_name"] if "owner_name" in row_keys else None,
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
    if payload.started_at:
        try:
            started_at = datetime.fromisoformat(payload.started_at).isoformat(timespec="seconds")
        except ValueError:
            raise HTTPException(status_code=400, detail="날짜 형식이 올바르지 않습니다")
    else:
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


@router.post("/schedule")
def create_schedule(payload: MeetingScheduleCreate, user: dict = Depends(get_current_user)) -> dict:
    title = payload.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="일정 제목을 입력해주세요")
    try:
        started_at = datetime.fromisoformat(payload.started_at).isoformat(timespec="seconds")
    except ValueError:
        raise HTTPException(status_code=400, detail="날짜 형식이 올바르지 않습니다")

    tag = payload.tag.strip() if payload.tag and payload.tag.strip() else None
    with closing(db.get_conn()) as conn:
        with conn:
            cur = conn.execute(
                "INSERT INTO meetings (user_id, title, tag, status, started_at) VALUES (?, ?, ?, 'scheduled', ?)",
                (user["id"], title, tag, started_at),
            )
            meeting_id = cur.lastrowid
            if payload.participant_ids:
                _replace_participants(conn, meeting_id, user["id"], payload.participant_ids)
        row = get_owned_meeting(conn, meeting_id, user["id"])
        return serialize_meeting(conn, row)


@router.get("")
def list_meetings(
    q: Optional[str] = None,
    tag: Optional[str] = None,
    user: dict = Depends(get_current_user),
) -> list:
    with closing(db.get_conn()) as conn:
        where = ["(m.user_id = ? OR m.is_shared = 1)", "m.deleted_at IS NULL"]
        values: list = [user["id"]]
        if q:
            where.append("m.title LIKE ?")
            values.append(f"%{q}%")
        if tag:
            where.append("m.tag = ?")
            values.append(tag)
        rows = conn.execute(
            f"""
            SELECT m.*, u.name AS owner_name
            FROM meetings m
            JOIN users u ON u.id = m.user_id
            WHERE {' AND '.join(where)}
            ORDER BY m.created_at DESC, m.id DESC
            """,
            values,
        ).fetchall()
        readable = [row for row in rows if _can_read_meeting_row(conn, row, user)]
        return [serialize_meeting(conn, row) for row in readable]


# 주의: /{meeting_id}보다 먼저 선언해야 "trash"가 int 경로 매칭에 걸리지 않는다.
@router.get("/trash")
def list_trash(user: dict = Depends(get_current_user)) -> list:
    """휴지통 목록 — 소프트 삭제된 회의 (deleted_at DESC)."""
    with closing(db.get_conn()) as conn:
        rows = conn.execute(
            "SELECT * FROM meetings WHERE user_id = ? AND deleted_at IS NOT NULL "
            "ORDER BY deleted_at DESC, id DESC",
            (user["id"],),
        ).fetchall()
        result = []
        for row in rows:
            item = serialize_meeting(conn, row)
            item["deleted_at"] = row["deleted_at"]
            result.append(item)
        return result


@router.get("/{meeting_id}")
def get_meeting(meeting_id: int, user: dict = Depends(get_current_user)) -> dict:
    with closing(db.get_conn()) as conn:
        row = get_readable_meeting(conn, meeting_id, user["id"], user.get("role") or "user")
        detail = serialize_meeting(conn, row)
        detail["error_message"] = row["error_message"]

        bookmarks = conn.execute(
            "SELECT id, meeting_id, time_sec, title, note, kind, created_at FROM bookmarks WHERE meeting_id = ? ORDER BY time_sec ASC, id ASC",
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
                # 레거시 행(마이그레이션 이전) 방어: discussion '', followups [], engine_note None
                "discussion": summary_row["discussion"] or "",
                "followups": json.loads(summary_row["followups"]) if summary_row["followups"] else [],
                "engine_note": summary_row["engine_note"],
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
        current = get_owned_meeting(conn, meeting_id, user["id"])
        with conn:
            updates: dict[str, object] = {}
            if "title" in data and data["title"] is not None:
                updates["title"] = data["title"]

            next_tag = _normalize_meeting_tag(current["tag"])
            if "tag" in data:
                next_tag = _normalize_meeting_tag(data["tag"])
                updates["tag"] = next_tag

            if "started_at" in data and data["started_at"]:
                try:
                    parsed = datetime.fromisoformat(data["started_at"])
                except ValueError:
                    raise HTTPException(status_code=400, detail="날짜 형식이 올바르지 않습니다")
                updates["started_at"] = parsed.isoformat(timespec="seconds")

            share_requested = "is_shared" in data and data["is_shared"] is not None
            locked_requested = "locked" in data and data["locked"] is not None
            if share_requested and user.get("role") not in ("admin", "user"):
                raise HTTPException(status_code=403, detail="기타 권한은 회의 공유를 사용할 수 없습니다")
            next_shared = bool(current["is_shared"])
            next_locked = bool(current["locked"])
            if share_requested:
                next_shared = bool(data["is_shared"])
            if locked_requested:
                next_locked = bool(data["locked"])

            auto_unshare = False
            if next_shared:
                has_share_scope = _meeting_has_share_scope(conn, next_tag, current["user_id"])
                if not has_share_scope:
                    if share_requested and bool(data["is_shared"]):
                        _assert_shareable_tag(conn, next_tag, current["user_id"])
                    next_shared = False
                    auto_unshare = True
                    if not locked_requested:
                        next_locked = False

            if share_requested:
                if next_shared:
                    _assert_shareable_tag(conn, next_tag, current["user_id"])
                next_locked = next_shared
                updates["is_shared"] = 1 if next_shared else 0
                updates["locked"] = 1 if next_locked else 0
            elif auto_unshare:
                updates["is_shared"] = 0
                updates["locked"] = 1 if next_locked else 0
            elif locked_requested:
                updates["locked"] = 1 if next_locked else 0

            if updates:
                sets = [f"{field} = ?" for field in updates]
                values = list(updates.values())
                values.append(meeting_id)
                conn.execute(f"UPDATE meetings SET {', '.join(sets)} WHERE id = ?", values)
            if data.get("participant_ids") is not None:
                _replace_participants(conn, meeting_id, user["id"], data["participant_ids"])
        row = get_owned_meeting(conn, meeting_id, user["id"])
        return serialize_meeting(conn, row)


@router.patch("/{meeting_id}/segments/{segment_id}")
def update_transcript_segment(
    meeting_id: int,
    segment_id: int,
    payload: TranscriptSegmentUpdate,
    user: dict = Depends(get_current_user),
) -> dict:
    text = payload.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="스크립트 내용을 입력해주세요")
    if len(text) > 200000:
        raise HTTPException(status_code=400, detail="스크립트 내용이 너무 깁니다")

    with closing(db.get_conn()) as conn:
        get_owned_meeting(conn, meeting_id, user["id"])
        row = conn.execute(
            """
            SELECT id, meeting_id, start_sec, end_sec, text
            FROM transcript_segments
            WHERE id = ? AND meeting_id = ?
            """,
            (segment_id, meeting_id),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="스크립트 행을 찾을 수 없습니다")
        with conn:
            conn.execute(
                "UPDATE transcript_segments SET text = ? WHERE id = ? AND meeting_id = ?",
                (text, segment_id, meeting_id),
            )
        updated = conn.execute(
            """
            SELECT id, start_sec, end_sec, text
            FROM transcript_segments
            WHERE id = ? AND meeting_id = ?
            """,
            (segment_id, meeting_id),
        ).fetchone()
        return dict(updated)


@router.delete("/{meeting_id}")
def delete_meeting(meeting_id: int, user: dict = Depends(get_current_user)) -> dict:
    """소프트 삭제 — 휴지통으로 이동 (오디오 파일 유지, 복원 가능)."""
    deleted_at = datetime.now().isoformat(timespec="seconds")
    with closing(db.get_conn()) as conn:
        row = get_owned_meeting(conn, meeting_id, user["id"])
        ensure_unlocked(row, "잠긴 회의는 삭제할 수 없어요. 잠금을 해제한 뒤 다시 시도해주세요.")
        with conn:
            conn.execute(
                "UPDATE meetings SET deleted_at = ? WHERE id = ?", (deleted_at, meeting_id)
            )
    return {"ok": True}


@router.post("/{meeting_id}/restore")
def restore_meeting(meeting_id: int, user: dict = Depends(get_current_user)) -> dict:
    """휴지통에서 복원."""
    with closing(db.get_conn()) as conn:
        row = get_owned_meeting(conn, meeting_id, user["id"], include_deleted=True)
        if row["deleted_at"] is None:
            raise HTTPException(status_code=400, detail="휴지통에 있는 회의가 아닙니다")
        with conn:
            conn.execute("UPDATE meetings SET deleted_at = NULL WHERE id = ?", (meeting_id,))
        row = get_owned_meeting(conn, meeting_id, user["id"])
        return serialize_meeting(conn, row)


@router.delete("/{meeting_id}/permanent")
def purge_meeting(meeting_id: int, user: dict = Depends(get_current_user)) -> dict:
    """완전 삭제 — 복구 불가 (오디오 파일 포함, FK cascade로 관련 기록 전부 삭제)."""
    with closing(db.get_conn()) as conn:
        row = get_owned_meeting(conn, meeting_id, user["id"], include_deleted=True)
        ensure_unlocked(row, "잠긴 회의는 완전 삭제할 수 없어요. 잠금을 해제한 뒤 다시 시도해주세요.")
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
    # 확장자 결정: content_type 매핑 → 업로드 파일명 suffix 폴백 → 최종 기본 .webm
    content_type = (file.content_type or "").split(";")[0].strip().lower()
    ext = _EXT_BY_CONTENT_TYPE.get(content_type)
    if ext is None:
        suffix = Path(file.filename or "").suffix.lower()
        ext = suffix if suffix in _ALLOWED_UPLOAD_EXTS else ".webm"
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


@router.post("/{meeting_id}/manual-transcript")
def submit_manual_transcript(
    meeting_id: int,
    payload: ManualTranscriptCreate,
    user: dict = Depends(get_current_user),
) -> dict:
    """직접 작성한 회의 내용을 스크립트로 저장하고 STT 없이 요약만 실행한다."""
    text = payload.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="회의 내용을 입력해주세요")
    if len(text) > 200000:
        raise HTTPException(status_code=400, detail="회의 내용이 너무 깁니다")

    duration_sec = max(float(payload.duration_sec or 0), 0.0)
    with closing(db.get_conn()) as conn:
        row = get_owned_meeting(conn, meeting_id, user["id"])
        ensure_unlocked(row, "잠긴 회의는 직접 작성 내용을 요약할 수 없어요. 잠금을 해제한 뒤 다시 시도해주세요.")
        if row["audio_filename"]:
            raise HTTPException(status_code=400, detail="이미 음성 파일이 있는 회의입니다")
        with conn:
            conn.execute("DELETE FROM transcript_segments WHERE meeting_id = ?", (meeting_id,))
            conn.execute("DELETE FROM summaries WHERE meeting_id = ?", (meeting_id,))
            conn.execute(
                """
                INSERT INTO transcript_segments (meeting_id, start_sec, end_sec, text)
                VALUES (?, 0, ?, ?)
                """,
                (meeting_id, duration_sec, text),
            )
            conn.execute(
                """
                UPDATE meetings
                SET duration_sec = ?, status = 'summarizing', error_message = NULL
                WHERE id = ?
                """,
                (duration_sec, meeting_id),
            )
        row = get_owned_meeting(conn, meeting_id, user["id"])
        result = serialize_meeting(conn, row)

    pipeline.enqueue_summary(meeting_id)
    return result


@router.get("/{meeting_id}/audio")
def get_audio(meeting_id: int, user: dict = Depends(get_current_user)) -> FileResponse:
    """오디오 스트리밍. get_current_user가 ?token= 쿼리 인증도 지원한다."""
    with closing(db.get_conn()) as conn:
        row = get_readable_meeting(conn, meeting_id, user["id"], user.get("role") or "user")
        audio_filename = row["audio_filename"]

    if not audio_filename:
        raise HTTPException(status_code=404, detail="오디오 파일이 없습니다")
    path = config.AUDIO_DIR / audio_filename
    if not path.is_file():
        raise HTTPException(status_code=404, detail="오디오 파일이 없습니다")

    ext = path.suffix.lower()
    media_type = _MEDIA_BY_EXT.get(ext) or mimetypes.guess_type(str(path))[0] or "audio/webm"
    return FileResponse(path, media_type=media_type)


@router.get("/{meeting_id}/waveform")
def get_waveform(meeting_id: int, user: dict = Depends(get_current_user)) -> dict:
    """파형 피크(≤600개) — 서버에서 스트리밍 계산·캐시. 브라우저 디코딩 OOM 방지."""
    with closing(db.get_conn()) as conn:
        row = get_readable_meeting(conn, meeting_id, user["id"], user.get("role") or "user")
        audio_filename = row["audio_filename"]
        duration_sec = row["duration_sec"]

    if not audio_filename:
        raise HTTPException(status_code=404, detail="오디오 파일이 없습니다")
    path = config.AUDIO_DIR / audio_filename
    if not path.is_file():
        raise HTTPException(status_code=404, detail="오디오 파일이 없습니다")

    try:
        return waveform.get_peaks(path)
    except Exception:  # 디코드 실패 시 프론트가 균일 점으로 폴백
        return {"peaks": [], "duration_sec": duration_sec}


@router.get("/{meeting_id}/export")
def export_minutes(
    meeting_id: int,
    format: str = "docx",
    user: dict = Depends(get_current_user),
) -> Response:
    """회의록 다운로드(?format=docx|pdf) — [회의록] 양식 레이아웃 재현."""
    from ..services import export_doc

    with closing(db.get_conn()) as conn:
        row = get_readable_meeting(conn, meeting_id, user["id"], user.get("role") or "user")
        meeting = dict(row)
        participants = [
            dict(p)
            for p in conn.execute(
                """
                SELECT p.name, p.role, p.department, p.organization
                FROM meeting_participants mp JOIN participants p ON p.id = mp.participant_id
                WHERE mp.meeting_id = ? ORDER BY p.id
                """,
                (meeting_id,),
            ).fetchall()
        ]
        bookmarks = [
            dict(b)
            for b in conn.execute(
                "SELECT time_sec, title, kind FROM bookmarks WHERE meeting_id = ? ORDER BY time_sec ASC, id ASC",
                (meeting_id,),
            ).fetchall()
        ]
        summary_row = conn.execute(
            "SELECT * FROM summaries WHERE meeting_id = ?", (meeting_id,)
        ).fetchone()

    summary = export_doc.parse_summary_row(summary_row)
    if format == "pdf":
        from ..services import export_pdf

        try:
            data = export_pdf.build_minutes_pdf(meeting, participants, bookmarks, summary)
        except (ImportError, RuntimeError) as exc:  # fpdf2 미설치, 한글 폰트 없음 등
            raise HTTPException(status_code=500, detail=str(exc))
        ext, media_type = "pdf", "application/pdf"
    else:
        data = export_doc.build_minutes_docx(meeting, participants, bookmarks, summary)
        ext = "docx"
        media_type = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

    # 파일명: [회의록] 태그 - 제목 (YYYY.MM.DD HH.MM).<ext>
    # (콜론은 윈도우 파일명 금지 문자라 시간 구분자는 '.'을 사용)
    def _safe(text: str) -> str:
        return re.sub(r'[\\/:*?"<>|]+', " ", text).strip()

    safe_title = _safe(meeting["title"]) or "회의록"
    safe_tag = _safe(meeting["tag"] or "")
    date_part = ""
    try:
        d = datetime.fromisoformat(meeting["started_at"] or "")
        date_part = f" ({d.year}.{d.month:02d}.{d.day:02d} {d.hour:02d}.{d.minute:02d})"
    except ValueError:
        pass
    filename = f"[회의록] {safe_tag + ' - ' if safe_tag else ''}{safe_title}{date_part}.{ext}"
    return Response(
        content=data,
        media_type=media_type,
        headers={
            "Content-Disposition": f"attachment; filename=\"minutes.{ext}\"; filename*=UTF-8''{quote(filename)}"
        },
    )


@router.get("/{meeting_id}/status")
def get_status(meeting_id: int, user: dict = Depends(get_current_user)) -> dict:
    with closing(db.get_conn()) as conn:
        row = get_readable_meeting(conn, meeting_id, user["id"], user.get("role") or "user")
        return {"status": row["status"], "error_message": row["error_message"]}


@router.patch("/{meeting_id}/summary")
def update_summary(
    meeting_id: int, body: SummaryUpdate, user: dict = Depends(get_current_user)
) -> dict:
    """AI 회의록 내용을 사용자가 직접 수정 — 회의록(minutes_md)도 함께 재생성한다."""
    from ..services import summarizer

    data = payload_fields(body)

    def clean_list(value) -> list[str]:
        return [str(x).strip() for x in (value or []) if str(x).strip()]

    with closing(db.get_conn()) as conn:
        row = get_owned_meeting(conn, meeting_id, user["id"])
        ensure_unlocked(row, "잠긴 회의는 AI 회의록을 수정할 수 없어요. 잠금을 해제한 뒤 다시 시도해주세요.")
        srow = conn.execute(
            "SELECT * FROM summaries WHERE meeting_id = ?", (meeting_id,)
        ).fetchone()
        if srow is None:
            raise HTTPException(status_code=400, detail="아직 AI 회의록이 없어요. 먼저 AI 회의록을 실행해주세요")

        # 기존 값 로드 후 요청 필드만 병합
        cur = {
            "key_points": json.loads(srow["key_points"]),
            "decisions": json.loads(srow["decisions"]),
            "action_items": json.loads(srow["action_items"]),
            "discussion": srow["discussion"] or "",
            "followups": json.loads(srow["followups"]) if srow["followups"] else [],
        }
        if "discussion" in data:
            cur["discussion"] = str(data["discussion"] or "").strip()
        for key in ("key_points", "decisions", "followups"):
            if key in data and data[key] is not None:
                cur[key] = clean_list(data[key])
        if "action_items" in data and data["action_items"] is not None:
            items: list[dict] = []
            for it in data["action_items"]:
                if isinstance(it, dict):
                    text = str(it.get("text") or "").strip()
                    owner = it.get("owner") or None
                    due = it.get("due") or None
                elif isinstance(it, str):
                    text, owner, due = it.strip(), None, None
                else:
                    continue
                if text:
                    items.append({"text": text, "owner": owner, "due": due})
            cur["action_items"] = items

        # 회의록 재생성용 참석자/북마크 로드
        participants = [
            dict(p)
            for p in conn.execute(
                """
                SELECT p.name, p.role, p.department, p.organization
                FROM meeting_participants mp JOIN participants p ON p.id = mp.participant_id
                WHERE mp.meeting_id = ? ORDER BY p.id
                """,
                (meeting_id,),
            ).fetchall()
        ]
        bookmarks = [
            dict(b)
            for b in conn.execute(
                "SELECT time_sec, title, kind FROM bookmarks WHERE meeting_id = ? ORDER BY time_sec ASC, id ASC",
                (meeting_id,),
            ).fetchall()
        ]
        minutes_md = summarizer.render_minutes_md(
            dict(row),
            participants,
            bookmarks,
            cur["key_points"],
            cur["decisions"],
            cur["action_items"],
            cur["discussion"],
            cur["followups"],
        )

        with conn:
            conn.execute(
                """
                UPDATE summaries SET
                  key_points = ?, decisions = ?, action_items = ?,
                  discussion = ?, followups = ?, minutes_md = ?, engine_note = NULL
                WHERE meeting_id = ?
                """,
                (
                    json.dumps(cur["key_points"], ensure_ascii=False),
                    json.dumps(cur["decisions"], ensure_ascii=False),
                    json.dumps(cur["action_items"], ensure_ascii=False),
                    cur["discussion"],
                    json.dumps(cur["followups"], ensure_ascii=False),
                    minutes_md,
                    meeting_id,
                ),
            )
        srow = conn.execute(
            "SELECT * FROM summaries WHERE meeting_id = ?", (meeting_id,)
        ).fetchone()
        return {
            "key_points": json.loads(srow["key_points"]),
            "decisions": json.loads(srow["decisions"]),
            "action_items": json.loads(srow["action_items"]),
            "discussion": srow["discussion"] or "",
            "followups": json.loads(srow["followups"]) if srow["followups"] else [],
            "engine_note": srow["engine_note"],
            "minutes_md": srow["minutes_md"],
            "engine": srow["engine"],
            "created_at": srow["created_at"],
        }


@router.post("/{meeting_id}/summarize")
def resummarize(meeting_id: int, user: dict = Depends(get_current_user)) -> dict:
    with closing(db.get_conn()) as conn:
        row = get_owned_meeting(conn, meeting_id, user["id"])
        ensure_unlocked(row, "잠긴 회의는 AI 회의록을 다시 생성할 수 없어요. 잠금을 해제한 뒤 다시 시도해주세요.")
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


@router.post("/{meeting_id}/cancel-processing")
def cancel_processing(meeting_id: int, user: dict = Depends(get_current_user)) -> dict:
    """STT 변환 또는 AI 요약을 취소한다."""
    with closing(db.get_conn()) as conn:
        row = get_owned_meeting(conn, meeting_id, user["id"])
        status = row["status"]
        if status not in ("queued", "transcribing", "summarizing"):
            raise HTTPException(status_code=400, detail="취소할 수 있는 처리 작업이 없습니다")

        is_summary_cancel = status == "summarizing"
        if not is_summary_cancel and not row["audio_filename"]:
            raise HTTPException(status_code=400, detail="임시저장할 음성 파일이 없습니다")

        message = (
            "AI 요약이 취소되었습니다. 전체 스크립트는 유지되어 있어요. "
            "필요하면 AI 요약을 다시 진행할 수 있습니다."
            if is_summary_cancel
            else (
                "변환이 취소되었습니다. 음성 파일은 임시저장되어 있어요. "
                "AI 요약을 누르면 텍스트 추출부터 다시 시도할 수 있습니다."
            )
        )

        with conn:
            cur = conn.execute(
                """
                UPDATE meetings
                SET status = 'failed', error_message = ?
                WHERE id = ? AND status = ?
                """,
                (message, meeting_id, status),
            )
            if cur.rowcount > 0 and not is_summary_cancel:
                conn.execute("DELETE FROM transcript_segments WHERE meeting_id = ?", (meeting_id,))
                conn.execute("DELETE FROM summaries WHERE meeting_id = ?", (meeting_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=409, detail="이미 다른 상태로 변경되었습니다")

    return {"ok": True, "message": message}


@router.post("/{meeting_id}/retry-audio")
def retry_audio_processing(meeting_id: int, user: dict = Depends(get_current_user)) -> dict:
    """임시저장된 음성 파일로 STT부터 다시 실행한다.

    일반 재요약(/summarize)은 이미 있는 스크립트 기반으로만 동작한다. 이 엔드포인트는
    전사 단계에서 실패해 스크립트가 없는 회의에 한해, 저장된 오디오를 다시 전사하고
    이어서 요약까지 처리한다.
    """
    with closing(db.get_conn()) as conn:
        row = get_owned_meeting(conn, meeting_id, user["id"])
        ensure_unlocked(row, "잠긴 회의는 음성 변환을 다시 시도할 수 없어요. 잠금을 해제한 뒤 다시 시도해주세요.")
        audio_filename = row["audio_filename"]
        if not audio_filename:
            raise HTTPException(status_code=400, detail="다시 처리할 임시저장 음성이 없습니다")
        if row["status"] != "failed":
            raise HTTPException(status_code=400, detail="실패로 임시저장된 음성만 다시 처리할 수 있습니다")

        audio_path = config.AUDIO_DIR / audio_filename
        if not audio_path.is_file():
            raise HTTPException(status_code=404, detail="임시저장된 음성 파일을 찾을 수 없습니다")

        count_row = conn.execute(
            "SELECT COUNT(*) AS cnt FROM transcript_segments WHERE meeting_id = ?",
            (meeting_id,),
        ).fetchone()
        if count_row["cnt"] > 0:
            raise HTTPException(
                status_code=400,
                detail="이미 스크립트가 있는 회의입니다. AI 요약은 기존 스크립트 기반으로 다시 실행해주세요.",
            )

        with conn:
            conn.execute("DELETE FROM summaries WHERE meeting_id = ?", (meeting_id,))
            conn.execute(
                "UPDATE meetings SET status = 'queued', error_message = NULL WHERE id = ?",
                (meeting_id,),
            )

    pipeline.enqueue(meeting_id)
    return {"ok": True}
