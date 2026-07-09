"""Tag/project and organization-option routes."""

import sqlite3
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import db
from ..auth_utils import get_current_user

router = APIRouter()

TAG_COLOR_PALETTE = [
    "#16a34a",
    "#2563eb",
    "#e8590c",
    "#7048e8",
    "#d6336c",
    "#0ca678",
    "#f08c00",
    "#1098ad",
]

ORG_KINDS = ("department", "role", "organization")
ORG_USER_COLUMNS = {
    "organization": "organization",
    "department": "department",
    "role": "position",
}


class TagCreate(BaseModel):
    name: str = Field(min_length=1)
    color: str | None = None
    is_global: bool | None = None
    allowed_user_ids: list[int] | None = None


class TagUpdate(BaseModel):
    name: str | None = None
    color: str | None = None
    is_global: bool | None = None
    allowed_user_ids: list[int] | None = None


class OrgOptionCreate(BaseModel):
    kind: Literal["department", "role", "organization"]
    name: str = Field(min_length=1)
    color: str | None = None


class OrgOptionUpdate(BaseModel):
    name: str | None = None
    color: str | None = None


def _tag_permission_user_ids(conn: sqlite3.Connection, tag_id: int) -> list[int]:
    rows = conn.execute(
        "SELECT user_id FROM tag_permissions WHERE tag_id = ? ORDER BY user_id",
        (tag_id,),
    ).fetchall()
    return [row["user_id"] for row in rows]


def _replace_tag_permissions(
    conn: sqlite3.Connection, tag_id: int, user_ids: list[int] | None
) -> None:
    conn.execute("DELETE FROM tag_permissions WHERE tag_id = ?", (tag_id,))
    if not user_ids:
        return
    normalized = sorted({int(user_id) for user_id in user_ids if int(user_id) > 0})
    for user_id in normalized:
        exists = conn.execute(
            "SELECT id FROM users WHERE id = ? AND active = 1",
            (user_id,),
        ).fetchone()
        if exists is not None:
            conn.execute(
                "INSERT OR IGNORE INTO tag_permissions (tag_id, user_id) VALUES (?, ?)",
                (tag_id, user_id),
            )


def _is_project_tag(conn: sqlite3.Connection, tag_id: int) -> bool:
    row = conn.execute(
        "SELECT 1 FROM project_tags WHERE tag_id = ? LIMIT 1",
        (tag_id,),
    ).fetchone()
    return row is not None


def _to_tag(
    row: sqlite3.Row,
    conn: sqlite3.Connection | None = None,
    user: dict | None = None,
) -> dict:
    is_project_tag = _is_project_tag(conn, row["id"]) if conn else False
    data = {
        "id": row["id"],
        "name": row["name"],
        "color": row["color"],
        "is_global": bool(row["is_global"]),
        "is_project_tag": is_project_tag,
    }
    data["allowed_user_ids"] = _tag_permission_user_ids(conn, row["id"]) if conn else []
    if user is not None:
        data["can_manage"] = _can_manage_tag(row, user)
    return data


def _can_manage_org_option(row: sqlite3.Row, user: dict) -> bool:
    return row["user_id"] == user["id"] or (
        user.get("role") == "admin" and row["owner_role"] == "admin"
    )


def _to_org_option(row: sqlite3.Row, user: dict | None = None) -> dict:
    data = {
        "id": row["id"],
        "kind": row["kind"],
        "name": row["name"],
        "color": row["color"],
        "is_shared": row["owner_role"] == "admin",
    }
    if user is not None:
        data["can_manage"] = _can_manage_org_option(row, user)
    return data


def _can_manage_tag(row: sqlite3.Row, user: dict) -> bool:
    if row["is_global"]:
        return user.get("role") == "admin"
    return row["user_id"] == user["id"]


@router.get("/tags")
def list_tags(user: dict = Depends(get_current_user)) -> list[dict]:
    conn = db.get_conn()
    try:
        rows = conn.execute(
            """
            SELECT DISTINCT t.id, t.user_id, t.name, t.color, t.is_global
            FROM tags t
            LEFT JOIN tag_permissions mine
              ON mine.tag_id = t.id AND mine.user_id = ?
            WHERE
              t.user_id = ?
              OR mine.user_id IS NOT NULL
              OR (
                t.is_global = 1
                AND (
                  ? = 'admin'
                  OR NOT EXISTS (
                    SELECT 1 FROM tag_permissions p WHERE p.tag_id = t.id
                  )
                )
              )
            ORDER BY t.is_global DESC, t.name ASC
            """,
            (user["id"], user["id"], user.get("role") or "user"),
        ).fetchall()
        result = [_to_tag(row, conn, user) for row in rows]
    finally:
        conn.close()
    return result


@router.get("/users/directory")
def list_user_directory(user: dict = Depends(get_current_user)) -> list[dict]:
    if user.get("role") == "other":
        return []
    conn = db.get_conn()
    try:
        rows = conn.execute(
            """
            SELECT id, username, email, name, team, organization, department,
                   position, phone, role, active
            FROM users
            WHERE active = 1 AND role <> 'other'
            ORDER BY lower(name), lower(username), id
            """
        ).fetchall()
    finally:
        conn.close()
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


@router.post("/tags")
def create_tag(body: TagCreate, user: dict = Depends(get_current_user)) -> dict:
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="태그 이름을 입력해주세요")
    color = body.color.strip() if body.color and body.color.strip() else None
    is_global = 1 if user.get("role") == "admin" and body.is_global is True else 0

    conn = db.get_conn()
    try:
        with conn:
            if color is None:
                count = conn.execute(
                    "SELECT COUNT(*) FROM tags WHERE user_id = ?",
                    (user["id"],),
                ).fetchone()[0]
                color = TAG_COLOR_PALETTE[count % len(TAG_COLOR_PALETTE)]
            if is_global:
                exists = conn.execute(
                    "SELECT id FROM tags WHERE is_global = 1 AND name = ?",
                    (name,),
                ).fetchone()
                if exists is not None:
                    raise HTTPException(status_code=400, detail="이미 있는 공유 태그입니다")
            try:
                cur = conn.execute(
                    "INSERT INTO tags (user_id, name, color, is_global) VALUES (?, ?, ?, ?)",
                    (user["id"], name, color, is_global),
                )
            except sqlite3.IntegrityError:
                raise HTTPException(status_code=400, detail="이미 있는 태그입니다")
            tag_id = cur.lastrowid
            if body.allowed_user_ids is not None:
                _replace_tag_permissions(conn, tag_id, body.allowed_user_ids)
            row = conn.execute(
                "SELECT id, user_id, name, color, is_global FROM tags WHERE id = ?",
                (tag_id,),
            ).fetchone()
            result = _to_tag(row, conn, user)
    finally:
        conn.close()

    return result


@router.patch("/tags/{tag_id}")
def update_tag(
    tag_id: int, body: TagUpdate, user: dict = Depends(get_current_user)
) -> dict:
    updates = body.model_dump(exclude_unset=True)
    permission_update = "allowed_user_ids" in updates
    conn = db.get_conn()
    try:
        row = conn.execute(
            "SELECT id, user_id, name, color, is_global FROM tags WHERE id = ?",
            (tag_id,),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="태그를 찾을 수 없습니다")
        if not _can_manage_tag(row, user):
            raise HTTPException(status_code=403, detail="관리자 공유 태그는 수정할 수 없습니다")

        old_name = row["name"]
        is_project_tag = _is_project_tag(conn, tag_id)
        fields: list[str] = []
        values: list = []
        new_name: str | None = None
        if "name" in updates:
            value = (updates["name"] or "").strip()
            if not value:
                raise HTTPException(status_code=400, detail="태그 이름을 입력해주세요")
            new_name = value
            fields.append("name = ?")
            values.append(value)
        if "color" in updates:
            value = (updates["color"] or "").strip()
            if value:
                fields.append("color = ?")
                values.append(value)
        if "is_global" in updates:
            if user.get("role") != "admin":
                raise HTTPException(status_code=403, detail="태그 공유 여부는 관리자만 수정할 수 있습니다")
            fields.append("is_global = ?")
            values.append(1 if updates["is_global"] else 0)

        if fields or permission_update:
            try:
                with conn:
                    if fields:
                        conn.execute(f"UPDATE tags SET {', '.join(fields)} WHERE id = ?", (*values, tag_id))
                    if new_name is not None and new_name != old_name:
                        if row["is_global"] or is_project_tag:
                            conn.execute("UPDATE meetings SET tag = ? WHERE tag = ?", (new_name, old_name))
                        else:
                            conn.execute(
                                "UPDATE meetings SET tag = ? WHERE user_id = ? AND tag = ?",
                                (new_name, user["id"], old_name),
                            )
                    if permission_update:
                        _replace_tag_permissions(
                            conn,
                            tag_id,
                            updates.get("allowed_user_ids") or [],
                        )
            except sqlite3.IntegrityError:
                raise HTTPException(status_code=400, detail="이미 있는 태그입니다")

        updated = conn.execute(
            "SELECT id, user_id, name, color, is_global FROM tags WHERE id = ?", (tag_id,)
        ).fetchone()
        result = _to_tag(updated, conn, user)
    finally:
        conn.close()
    return result


@router.delete("/tags/{tag_id}")
def delete_tag(tag_id: int, user: dict = Depends(get_current_user)) -> dict:
    conn = db.get_conn()
    try:
        row = conn.execute(
            "SELECT id, user_id, name, is_global FROM tags WHERE id = ?", (tag_id,)
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="태그를 찾을 수 없습니다")
        if not _can_manage_tag(row, user):
            raise HTTPException(status_code=403, detail="관리자 공유 태그는 삭제할 수 없습니다")
        is_project_tag = _is_project_tag(conn, tag_id)
        if user.get("role") != "admin" and is_project_tag:
            raise HTTPException(
                status_code=403,
                detail="프로젝트에 연결된 태그는 일반 사용자가 삭제할 수 없습니다",
            )

        with conn:
            if row["is_global"] or is_project_tag:
                conn.execute(
                    """
                    UPDATE meetings
                    SET tag = NULL,
                        is_shared = 0,
                        locked = CASE WHEN is_shared = 1 THEN 0 ELSE locked END
                    WHERE tag = ?
                    """,
                    (row["name"],),
                )
            else:
                conn.execute(
                    """
                    UPDATE meetings
                    SET tag = NULL,
                        is_shared = 0,
                        locked = CASE WHEN is_shared = 1 THEN 0 ELSE locked END
                    WHERE user_id = ? AND tag = ?
                    """,
                    (user["id"], row["name"]),
                )
            conn.execute("DELETE FROM tags WHERE id = ?", (tag_id,))
    finally:
        conn.close()
    return {"ok": True}


@router.get("/org-options")
def list_org_options(
    kind: str | None = None, user: dict = Depends(get_current_user)
) -> list[dict]:
    if kind is not None and kind not in ORG_KINDS:
        raise HTTPException(
            status_code=400,
            detail="kind는 department, role 또는 organization이어야 합니다",
        )
    conn = db.get_conn()
    try:
        if kind:
            rows = conn.execute(
                """
                SELECT o.id, o.user_id, o.kind, o.name, o.color, u.role AS owner_role
                FROM org_options o
                JOIN users u ON u.id = o.user_id
                WHERE o.kind = ? AND (u.role = 'admin' OR o.user_id = ?)
                ORDER BY CASE WHEN u.role = 'admin' THEN 0 ELSE 1 END, o.name ASC
                """,
                (kind, user["id"]),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT o.id, o.user_id, o.kind, o.name, o.color, u.role AS owner_role
                FROM org_options o
                JOIN users u ON u.id = o.user_id
                WHERE u.role = 'admin' OR o.user_id = ?
                ORDER BY o.kind ASC, CASE WHEN u.role = 'admin' THEN 0 ELSE 1 END, o.name ASC
                """,
                (user["id"],),
            ).fetchall()
    finally:
        conn.close()
    return [_to_org_option(row, user) for row in rows]


@router.post("/org-options")
def create_org_option(
    body: OrgOptionCreate, user: dict = Depends(get_current_user)
) -> dict:
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="이름을 입력해주세요")
    color = (body.color or "").strip() or None

    conn = db.get_conn()
    try:
        with conn:
            existing = conn.execute(
                """
                SELECT 1
                FROM org_options o
                JOIN users u ON u.id = o.user_id
                WHERE o.kind = ? AND o.name = ? AND (u.role = 'admin' OR o.user_id = ?)
                LIMIT 1
                """,
                (body.kind, name, user["id"]),
            ).fetchone()
            if existing is not None:
                raise HTTPException(status_code=400, detail="이미 등록되어 있습니다")
            try:
                cur = conn.execute(
                    "INSERT INTO org_options (user_id, kind, name, color) VALUES (?, ?, ?, ?)",
                    (user["id"], body.kind, name, color),
                )
            except sqlite3.IntegrityError:
                raise HTTPException(status_code=400, detail="이미 등록되어 있습니다")
            option_id = cur.lastrowid
            row = conn.execute(
                """
                SELECT o.id, o.user_id, o.kind, o.name, o.color, u.role AS owner_role
                FROM org_options o
                JOIN users u ON u.id = o.user_id
                WHERE o.id = ?
                """,
                (option_id,),
            ).fetchone()
    finally:
        conn.close()

    return _to_org_option(row, user)


@router.patch("/org-options/{option_id}")
def update_org_option(
    option_id: int, body: OrgOptionUpdate, user: dict = Depends(get_current_user)
) -> dict:
    updates = body.model_dump(exclude_unset=True)
    conn = db.get_conn()
    try:
        row = conn.execute(
            """
            SELECT o.id, o.user_id, o.kind, o.name, o.color, u.role AS owner_role
            FROM org_options o
            JOIN users u ON u.id = o.user_id
            WHERE o.id = ?
            """,
            (option_id,),
        ).fetchone()
        if row is None or not _can_manage_org_option(row, user):
            raise HTTPException(status_code=404, detail="항목을 찾을 수 없습니다")

        fields: list[str] = []
        values: list = []
        new_name: str | None = None
        old_name = row["name"]

        if "name" in updates:
            name = (updates["name"] or "").strip()
            if not name:
                raise HTTPException(status_code=400, detail="이름을 입력해주세요")
            existing = conn.execute(
                """
                SELECT 1
                FROM org_options o
                JOIN users u ON u.id = o.user_id
                WHERE o.id <> ? AND o.kind = ? AND o.name = ? AND (u.role = 'admin' OR o.user_id = ?)
                LIMIT 1
                """,
                (option_id, row["kind"], name, user["id"]),
            ).fetchone()
            if existing is not None:
                raise HTTPException(status_code=400, detail="이미 등록되어 있습니다")
            new_name = name
            fields.append("name = ?")
            values.append(name)
        if "color" in updates:
            color = (updates["color"] or "").strip() or None
            fields.append("color = ?")
            values.append(color)

        if fields:
            try:
                with conn:
                    conn.execute(
                        f"UPDATE org_options SET {', '.join(fields)} WHERE id = ?",
                        (*values, option_id),
                    )
                    if (
                        new_name is not None
                        and new_name != old_name
                        and user.get("role") == "admin"
                    ):
                        column = ORG_USER_COLUMNS[row["kind"]]
                        conn.execute(
                            f"UPDATE users SET {column} = ? WHERE {column} = ?",
                            (new_name, old_name),
                        )
            except sqlite3.IntegrityError:
                raise HTTPException(status_code=400, detail="이미 등록되어 있습니다")
        row = conn.execute(
            """
            SELECT o.id, o.user_id, o.kind, o.name, o.color, u.role AS owner_role
            FROM org_options o
            JOIN users u ON u.id = o.user_id
            WHERE o.id = ?
            """,
            (option_id,),
        ).fetchone()
    finally:
        conn.close()
    return _to_org_option(row, user)


@router.delete("/org-options/{option_id}")
def delete_org_option(
    option_id: int, user: dict = Depends(get_current_user)
) -> dict:
    conn = db.get_conn()
    try:
        with conn:
            row = conn.execute(
                """
                SELECT o.id, o.user_id, o.kind, o.name, o.color, u.role AS owner_role
                FROM org_options o
                JOIN users u ON u.id = o.user_id
                WHERE o.id = ?
                """,
                (option_id,),
            ).fetchone()
            if row is None or not _can_manage_org_option(row, user):
                raise HTTPException(status_code=404, detail="항목을 찾을 수 없습니다")
            cur = conn.execute(
                "DELETE FROM org_options WHERE id = ?",
                (option_id,),
            )
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="항목을 찾을 수 없습니다")
    finally:
        conn.close()
    return {"ok": True}
