"""Project management routes."""

import sqlite3

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import db
from ..auth_utils import get_current_user

router = APIRouter()

PROJECT_COLORS = [
    "#16a34a",
    "#2563eb",
    "#e8590c",
    "#7048e8",
    "#d6336c",
    "#0ca678",
    "#f08c00",
    "#1098ad",
]


class ProjectCreate(BaseModel):
    title: str = Field(min_length=1)
    task_number: str | None = None
    task_title: str | None = None
    principal_investigator: str | None = None
    research_institution: str | None = None
    period_start: str | None = None
    period_end: str | None = None
    color: str | None = None
    tag_ids: list[int] | None = None
    member_user_ids: list[int] | None = None
    active: bool | None = None


class ProjectUpdate(BaseModel):
    title: str | None = None
    task_number: str | None = None
    task_title: str | None = None
    principal_investigator: str | None = None
    research_institution: str | None = None
    period_start: str | None = None
    period_end: str | None = None
    color: str | None = None
    tag_ids: list[int] | None = None
    member_user_ids: list[int] | None = None
    active: bool | None = None


def _clean(value: str | None) -> str | None:
    if value is None:
        return None
    value = value.strip()
    return value or None


def _clean_title(value: str | None) -> str:
    title = (value or "").strip()
    if not title:
        raise HTTPException(status_code=400, detail="프로젝트 이름을 입력해주세요")
    return title


def _normalize_ids(values: list[int] | None) -> list[int]:
    if not values:
        return []
    return sorted({int(value) for value in values if int(value) > 0})


def _next_color(conn: sqlite3.Connection) -> str:
    count = conn.execute("SELECT COUNT(*) FROM projects").fetchone()[0]
    return PROJECT_COLORS[count % len(PROJECT_COLORS)]


def _project_tags(conn: sqlite3.Connection, project_id: int) -> list[dict]:
    rows = conn.execute(
        """
        SELECT t.id, t.name, t.color, t.is_global
        FROM project_tags pt
        JOIN tags t ON t.id = pt.tag_id
        WHERE pt.project_id = ?
        ORDER BY lower(t.name), t.id
        """,
        (project_id,),
    ).fetchall()
    result: list[dict] = []
    for row in rows:
        permissions = conn.execute(
            "SELECT user_id FROM tag_permissions WHERE tag_id = ? ORDER BY user_id",
            (row["id"],),
        ).fetchall()
        result.append(
            {
                "id": row["id"],
                "name": row["name"],
                "color": row["color"],
                "is_global": bool(row["is_global"]),
                "is_project_tag": True,
                "allowed_user_ids": [item["user_id"] for item in permissions],
            }
        )
    return result


def _project_members(conn: sqlite3.Connection, project_id: int) -> list[dict]:
    rows = conn.execute(
        """
        SELECT
          u.id, u.username, u.email, u.name, u.team, u.organization,
          u.department, u.position, u.phone, u.role, u.active
        FROM project_members pm
        JOIN users u ON u.id = pm.user_id
        WHERE pm.project_id = ?
        ORDER BY lower(u.name), lower(u.username), u.id
        """,
        (project_id,),
    ).fetchall()
    return [
        {
            "id": row["id"],
            "username": row["username"],
            "email": row["email"],
            "name": row["name"],
            "team": row["team"],
            "organization": row["organization"],
            "department": row["department"],
            "position": row["position"],
            "phone": row["phone"],
            "role": row["role"],
            "active": bool(row["active"]),
        }
        for row in rows
    ]


def _replace_project_tags(conn: sqlite3.Connection, project_id: int, tag_ids: list[int]) -> None:
    conn.execute("DELETE FROM project_tags WHERE project_id = ?", (project_id,))
    for tag_id in _normalize_ids(tag_ids):
        exists = conn.execute("SELECT id FROM tags WHERE id = ?", (tag_id,)).fetchone()
        if exists is not None:
            conn.execute(
                "INSERT OR IGNORE INTO project_tags (project_id, tag_id) VALUES (?, ?)",
                (project_id, tag_id),
            )


def _replace_project_members(
    conn: sqlite3.Connection, project_id: int, user_ids: list[int]
) -> None:
    conn.execute("DELETE FROM project_members WHERE project_id = ?", (project_id,))
    for user_id in _normalize_ids(user_ids):
        exists = conn.execute(
            "SELECT id FROM users WHERE id = ? AND active = 1",
            (user_id,),
        ).fetchone()
        if exists is not None:
            conn.execute(
                "INSERT OR IGNORE INTO project_members (project_id, user_id) VALUES (?, ?)",
                (project_id, user_id),
            )


def _sync_tag_permissions(conn: sqlite3.Connection, tag_ids: list[int]) -> None:
    for tag_id in _normalize_ids(tag_ids):
        member_rows = conn.execute(
            """
            SELECT DISTINCT pm.user_id
            FROM project_tags pt
            JOIN project_members pm ON pm.project_id = pt.project_id
            JOIN users u ON u.id = pm.user_id AND u.active = 1
            WHERE pt.tag_id = ?
            ORDER BY pm.user_id
            """,
            (tag_id,),
        ).fetchall()
        member_ids = [row["user_id"] for row in member_rows]
        conn.execute("DELETE FROM tag_permissions WHERE tag_id = ?", (tag_id,))
        for user_id in member_ids:
            conn.execute(
                "INSERT OR IGNORE INTO tag_permissions (tag_id, user_id) VALUES (?, ?)",
                (tag_id, user_id),
            )


def _project_tag_ids(conn: sqlite3.Connection, project_id: int) -> list[int]:
    rows = conn.execute(
        "SELECT tag_id FROM project_tags WHERE project_id = ?",
        (project_id,),
    ).fetchall()
    return [row["tag_id"] for row in rows]


def _is_admin(user: dict) -> bool:
    return user.get("role") == "admin"


def _can_manage_project(conn: sqlite3.Connection, project_id: int, user: dict) -> bool:
    if _is_admin(user):
        return True
    row = conn.execute(
        "SELECT created_by FROM projects WHERE id = ?",
        (project_id,),
    ).fetchone()
    return row is not None and row["created_by"] == user["id"]


def _to_project(row: sqlite3.Row, conn: sqlite3.Connection) -> dict:
    return {
        "id": row["id"],
        "task_number": row["task_number"],
        "task_title": row["task_title"],
        "principal_investigator": row["principal_investigator"],
        "research_institution": row["research_institution"],
        "title": row["title"],
        "color": row["color"],
        "active": bool(row["active"]),
        "period_start": row["period_start"],
        "period_end": row["period_end"],
        "created_by": row["created_by"],
        "created_by_name": row["created_by_name"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "tags": _project_tags(conn, row["id"]),
        "members": _project_members(conn, row["id"]),
    }


def _get_project(conn: sqlite3.Connection, project_id: int) -> dict:
    row = conn.execute(
        """
        SELECT
          p.id, p.task_number, p.task_title, p.principal_investigator,
          p.research_institution, p.title, p.color, p.active, p.period_start,
          p.period_end, p.created_by, p.created_at, p.updated_at,
          u.name AS created_by_name
        FROM projects p
        LEFT JOIN users u ON u.id = p.created_by
        WHERE p.id = ?
        """,
        (project_id,),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="프로젝트를 찾을 수 없습니다")
    return _to_project(row, conn)


@router.get("")
def list_projects(
    q: str | None = None,
    current: dict = Depends(get_current_user),
) -> list[dict]:
    clauses: list[str] = []
    values: list[str | int] = []

    if not _is_admin(current):
        clauses.append(
            """
            (
              p.created_by = ?
              OR EXISTS (
                SELECT 1
                FROM project_members pm
                WHERE pm.project_id = p.id AND pm.user_id = ?
              )
            )
            """
        )
        values.extend([current["id"], current["id"]])

    keyword = _clean(q)
    if keyword:
        like = f"%{keyword.lower()}%"
        clauses.append(
            """
            (
              lower(p.title) LIKE ?
              OR lower(COALESCE(p.task_title, '')) LIKE ?
              OR lower(COALESCE(p.task_number, '')) LIKE ?
              OR lower(COALESCE(p.principal_investigator, '')) LIKE ?
              OR lower(COALESCE(p.research_institution, '')) LIKE ?
            )
            """
        )
        values.extend([like, like, like, like, like])

    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    conn = db.get_conn()
    try:
        rows = conn.execute(
            f"""
            SELECT
              p.id, p.task_number, p.task_title, p.principal_investigator,
              p.research_institution, p.title, p.color, p.active, p.period_start,
              p.period_end, p.created_by, p.created_at, p.updated_at,
              u.name AS created_by_name
            FROM projects p
            LEFT JOIN users u ON u.id = p.created_by
            {where}
            ORDER BY lower(p.title) ASC, p.id DESC
            """,
            values,
        ).fetchall()
        return [_to_project(row, conn) for row in rows]
    finally:
        conn.close()


@router.post("")
def create_project(body: ProjectCreate, current: dict = Depends(get_current_user)) -> dict:
    title = _clean_title(body.title)

    conn = db.get_conn()
    try:
        color = _clean(body.color) or _next_color(conn)
        with conn:
            cur = conn.execute(
                """
                INSERT INTO projects (
                  task_number, task_title, principal_investigator, research_institution,
                  title, color, active, period_start, period_end, created_by
                )
                VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
                """,
                (
                    _clean(body.task_number),
                    _clean(body.task_title),
                    _clean(body.principal_investigator),
                    _clean(body.research_institution),
                    title,
                    color,
                    _clean(body.period_start),
                    _clean(body.period_end),
                    current["id"],
                ),
            )
            project_id = cur.lastrowid
            _replace_project_tags(conn, project_id, body.tag_ids or [])
            member_ids = _normalize_ids(body.member_user_ids or [])
            if not _is_admin(current) and current["id"] not in member_ids:
                member_ids.append(current["id"])
            _replace_project_members(conn, project_id, member_ids)
            _sync_tag_permissions(conn, _project_tag_ids(conn, project_id))
        return _get_project(conn, project_id)
    finally:
        conn.close()


@router.patch("/{project_id}")
def update_project(
    project_id: int,
    body: ProjectUpdate,
    current: dict = Depends(get_current_user),
) -> dict:
    updates = body.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(status_code=400, detail="변경할 내용이 없습니다")

    conn = db.get_conn()
    try:
        exists = conn.execute("SELECT id FROM projects WHERE id = ?", (project_id,)).fetchone()
        if exists is None:
            raise HTTPException(status_code=404, detail="프로젝트를 찾을 수 없습니다")
        if not _can_manage_project(conn, project_id, current):
            raise HTTPException(status_code=403, detail="프로젝트를 수정할 권한이 없습니다")

        fields: list[str] = []
        values: list[str | int | None] = []
        if "title" in updates:
            fields.append("title = ?")
            values.append(_clean_title(updates["title"]))
        for key in (
            "task_number",
            "task_title",
            "principal_investigator",
            "research_institution",
            "period_start",
            "period_end",
            "color",
        ):
            if key in updates:
                fields.append(f"{key} = ?")
                values.append(_clean(updates[key]))

        with conn:
            sync_tag_ids = _project_tag_ids(conn, project_id)
            if fields:
                fields.append("updated_at = datetime('now', 'localtime')")
                conn.execute(
                    f"UPDATE projects SET {', '.join(fields)} WHERE id = ?",
                    (*values, project_id),
                )
            if "tag_ids" in updates:
                _replace_project_tags(conn, project_id, updates.get("tag_ids") or [])
                sync_tag_ids.extend(_project_tag_ids(conn, project_id))
            if "member_user_ids" in updates:
                member_ids = _normalize_ids(updates.get("member_user_ids") or [])
                if not _is_admin(current) and current["id"] not in member_ids:
                    member_ids.append(current["id"])
                _replace_project_members(conn, project_id, member_ids)
            if "tag_ids" in updates or "member_user_ids" in updates:
                conn.execute(
                    "UPDATE projects SET updated_at = datetime('now', 'localtime') WHERE id = ?",
                    (project_id,),
                )
                _sync_tag_permissions(conn, sync_tag_ids)

        return _get_project(conn, project_id)
    finally:
        conn.close()


@router.delete("/{project_id}")
def delete_project(project_id: int, current: dict = Depends(get_current_user)) -> dict:
    conn = db.get_conn()
    try:
        exists = conn.execute("SELECT id FROM projects WHERE id = ?", (project_id,)).fetchone()
        if exists is None:
            raise HTTPException(status_code=404, detail="프로젝트를 찾을 수 없습니다")
        if not _can_manage_project(conn, project_id, current):
            raise HTTPException(status_code=403, detail="프로젝트를 삭제할 권한이 없습니다")
        sync_tag_ids = _project_tag_ids(conn, project_id)
        with conn:
            conn.execute("DELETE FROM projects WHERE id = ?", (project_id,))
            _sync_tag_permissions(conn, sync_tag_ids)
    finally:
        conn.close()
    return {"ok": True}
