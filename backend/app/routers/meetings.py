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
    participant_ids: Optional[List[int]] = None


class MeetingUpdate(BaseModel):
    title: Optional[str] = None
    tag: Optional[str] = None
    started_at: Optional[str] = None
    participant_ids: Optional[List[int]] = None


class SummaryUpdate(BaseModel):
    discussion: Optional[str] = None
    key_points: Optional[List[str]] = None
    decisions: Optional[List[str]] = None
    followups: Optional[List[str]] = None
    action_items: Optional[list] = None  # [str] 또는 [{text, owner?, due?}]


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


def serialize_meeting(conn: sqlite3.Connection, row: sqlite3.Row) -> dict:
    """meetings row → Meeting 응답 dict (participants 조인 포함)."""
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
def list_meetings(
    q: Optional[str] = None,
    tag: Optional[str] = None,
    user: dict = Depends(get_current_user),
) -> list:
    with closing(db.get_conn()) as conn:
        where = ["user_id = ?", "deleted_at IS NULL"]
        values: list = [user["id"]]
        if q:
            where.append("title LIKE ?")
            values.append(f"%{q}%")
        if tag:
            where.append("tag = ?")
            values.append(tag)
        rows = conn.execute(
            f"SELECT * FROM meetings WHERE {' AND '.join(where)} ORDER BY created_at DESC, id DESC",
            values,
        ).fetchall()
        return [serialize_meeting(conn, row) for row in rows]


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
        row = get_owned_meeting(conn, meeting_id, user["id"])
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
            if "started_at" in data and data["started_at"]:
                try:
                    parsed = datetime.fromisoformat(data["started_at"])
                except ValueError:
                    raise HTTPException(status_code=400, detail="날짜 형식이 올바르지 않습니다")
                sets.append("started_at = ?")
                values.append(parsed.isoformat(timespec="seconds"))
            if sets:
                values.append(meeting_id)
                conn.execute(f"UPDATE meetings SET {', '.join(sets)} WHERE id = ?", values)
            if data.get("participant_ids") is not None:
                _replace_participants(conn, meeting_id, user["id"], data["participant_ids"])
        row = get_owned_meeting(conn, meeting_id, user["id"])
        return serialize_meeting(conn, row)


@router.delete("/{meeting_id}")
def delete_meeting(meeting_id: int, user: dict = Depends(get_current_user)) -> dict:
    """소프트 삭제 — 휴지통으로 이동 (오디오 파일 유지, 복원 가능)."""
    deleted_at = datetime.now().isoformat(timespec="seconds")
    with closing(db.get_conn()) as conn:
        get_owned_meeting(conn, meeting_id, user["id"])
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


@router.get("/{meeting_id}/waveform")
def get_waveform(meeting_id: int, user: dict = Depends(get_current_user)) -> dict:
    """파형 피크(≤600개) — 서버에서 스트리밍 계산·캐시. 브라우저 디코딩 OOM 방지."""
    with closing(db.get_conn()) as conn:
        row = get_owned_meeting(conn, meeting_id, user["id"])
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
        row = get_owned_meeting(conn, meeting_id, user["id"])
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
        except RuntimeError as exc:  # 한글 폰트 없음 등
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
        row = get_owned_meeting(conn, meeting_id, user["id"])
        return {"status": row["status"], "error_message": row["error_message"]}


@router.patch("/{meeting_id}/summary")
def update_summary(
    meeting_id: int, body: SummaryUpdate, user: dict = Depends(get_current_user)
) -> dict:
    """요약 내용을 사용자가 직접 수정 — 회의록(minutes_md)도 함께 재생성한다."""
    from ..services import summarizer

    data = payload_fields(body)

    def clean_list(value) -> list[str]:
        return [str(x).strip() for x in (value or []) if str(x).strip()]

    with closing(db.get_conn()) as conn:
        row = get_owned_meeting(conn, meeting_id, user["id"])
        srow = conn.execute(
            "SELECT * FROM summaries WHERE meeting_id = ?", (meeting_id,)
        ).fetchone()
        if srow is None:
            raise HTTPException(status_code=400, detail="아직 요약이 없어요. 먼저 AI 요약을 실행해주세요")

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
