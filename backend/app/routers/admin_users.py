"""Admin-only user management routes."""

import sqlite3
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import config, db
from ..auth_utils import get_current_user, hash_password, require_admin

router = APIRouter()

UserRole = Literal["admin", "user", "other"]


class UserCreate(BaseModel):
    username: str = Field(min_length=1)
    password: str = Field(min_length=1)
    name: str = Field(min_length=1)
    role: UserRole = "user"
    email: str | None = None
    organization: str | None = None
    department: str | None = None
    position: str | None = None
    phone: str | None = None
    team: str | None = None


class UserUpdate(BaseModel):
    password: str | None = None
    name: str | None = None
    role: UserRole | None = None
    email: str | None = None
    organization: str | None = None
    department: str | None = None
    position: str | None = None
    phone: str | None = None
    team: str | None = None
    active: bool | None = None


def _clean(value: str | None) -> str | None:
    if value is None:
        return None
    value = value.strip()
    return value or None


def _clean_username(value: str) -> str:
    username = value.strip().lower()
    if not username:
        raise HTTPException(status_code=400, detail="사용자 ID를 입력해주세요")
    if any(ch.isspace() for ch in username):
        raise HTTPException(status_code=400, detail="사용자 ID에는 공백을 사용할 수 없습니다")
    return username


def _fallback_email(username: str) -> str:
    return f"{username}@notie.local"


def _delete_audio_file(filename: str | None) -> None:
    if not filename:
        return
    try:
        audio_root = config.AUDIO_DIR.resolve()
        path = (audio_root / filename).resolve()
        if path != audio_root and audio_root in path.parents:
            path.unlink(missing_ok=True)
    except OSError:
        pass


def _admin_count(conn: sqlite3.Connection) -> int:
    return conn.execute(
        "SELECT COUNT(*) FROM users WHERE role = 'admin' AND active = 1"
    ).fetchone()[0]


def _to_admin_user(row: sqlite3.Row) -> dict:
    return {
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
        "meeting_count": row["meeting_count"],
        "created_at": row["created_at"],
    }


@router.get("")
def list_users(current: dict = Depends(get_current_user)) -> list[dict]:
    require_admin(current)
    conn = db.get_conn()
    try:
        rows = conn.execute(
            """
            SELECT
              u.id, u.username, u.email, u.name, u.team, u.organization,
              u.department, u.position, u.phone, u.role, u.active, u.created_at,
              COUNT(m.id) AS meeting_count
            FROM users u
            LEFT JOIN meetings m ON m.user_id = u.id AND m.deleted_at IS NULL
            GROUP BY u.id
            ORDER BY lower(u.name) ASC, u.id ASC
            """
        ).fetchall()
    finally:
        conn.close()
    return [_to_admin_user(row) for row in rows]


@router.post("")
def create_user(body: UserCreate, current: dict = Depends(get_current_user)) -> dict:
    require_admin(current)
    username = _clean_username(body.username)
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="이름을 입력해주세요")
    email = (_clean(body.email) or _fallback_email(username)).lower()
    team = _clean(body.team) or _clean(body.department)

    conn = db.get_conn()
    try:
        with conn:
            try:
                cur = conn.execute(
                    """
                    INSERT INTO users (
                      username, email, password_hash, name, team, organization,
                      department, position, phone, role, active
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
                    """,
                    (
                        username,
                        email,
                        hash_password(body.password),
                        name,
                        team,
                        _clean(body.organization),
                        _clean(body.department),
                        _clean(body.position),
                        _clean(body.phone),
                        body.role,
                    ),
                )
            except sqlite3.IntegrityError:
                raise HTTPException(status_code=400, detail="이미 사용 중인 사용자 ID 또는 이메일입니다")
            user_id = cur.lastrowid
        row = conn.execute(
            """
            SELECT
              u.id, u.username, u.email, u.name, u.team, u.organization,
              u.department, u.position, u.phone, u.role, u.active, u.created_at,
              0 AS meeting_count
            FROM users u
            WHERE u.id = ?
            """,
            (user_id,),
        ).fetchone()
    finally:
        conn.close()
    return _to_admin_user(row)


@router.patch("/{user_id}")
def update_user(
    user_id: int, body: UserUpdate, current: dict = Depends(get_current_user)
) -> dict:
    require_admin(current)
    updates = body.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(status_code=400, detail="변경할 내용이 없습니다")

    conn = db.get_conn()
    try:
        row = conn.execute(
            "SELECT id, username, role, active FROM users WHERE id = ?", (user_id,)
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="사용자를 찾을 수 없습니다")

        next_role = updates.get("role") or row["role"]
        next_active = bool(row["active"]) if updates.get("active") is None else bool(updates["active"])
        if row["role"] == "admin" and (next_role != "admin" or not next_active):
            if _admin_count(conn) <= 1:
                raise HTTPException(status_code=400, detail="마지막 관리자는 변경할 수 없습니다")
        if user_id == current["id"] and not next_active:
            raise HTTPException(status_code=400, detail="현재 로그인한 계정은 비활성화할 수 없습니다")

        fields: list[str] = []
        values: list = []
        if "password" in updates and _clean(updates["password"]):
            fields.append("password_hash = ?")
            values.append(hash_password(updates["password"] or ""))
        if "name" in updates:
            name = _clean(updates["name"])
            if not name:
                raise HTTPException(status_code=400, detail="이름을 입력해주세요")
            fields.append("name = ?")
            values.append(name)
        if "role" in updates:
            fields.append("role = ?")
            values.append(updates["role"])
        if "active" in updates:
            fields.append("active = ?")
            values.append(1 if updates["active"] else 0)
        for key in ("organization", "department", "position", "phone", "team"):
            if key in updates:
                fields.append(f"{key} = ?")
                values.append(_clean(updates[key]))
        if "email" in updates:
            email = (_clean(updates["email"]) or _fallback_email(row["username"])).lower()
            fields.append("email = ?")
            values.append(email)

        if not fields:
            raise HTTPException(status_code=400, detail="변경할 내용이 없습니다")

        try:
            with conn:
                conn.execute(f"UPDATE users SET {', '.join(fields)} WHERE id = ?", (*values, user_id))
        except sqlite3.IntegrityError:
            raise HTTPException(status_code=400, detail="이미 사용 중인 사용자 ID 또는 이메일입니다")

        updated = conn.execute(
            """
            SELECT
              u.id, u.username, u.email, u.name, u.team, u.organization,
              u.department, u.position, u.phone, u.role, u.active, u.created_at,
              COUNT(m.id) AS meeting_count
            FROM users u
            LEFT JOIN meetings m ON m.user_id = u.id AND m.deleted_at IS NULL
            WHERE u.id = ?
            GROUP BY u.id
            """,
            (user_id,),
        ).fetchone()
        with conn:
            if updated["role"] == "other" or not updated["active"]:
                conn.execute("DELETE FROM participants WHERE source_user_id = ?", (user_id,))
                conn.execute("DELETE FROM project_members WHERE user_id = ?", (user_id,))
                conn.execute("DELETE FROM tag_permissions WHERE user_id = ?", (user_id,))
                conn.execute(
                    """
                    UPDATE meetings
                    SET
                      locked = CASE WHEN is_shared = 1 THEN 0 ELSE locked END,
                      is_shared = 0
                    WHERE user_id = ?
                    """,
                    (user_id,),
                )
            else:
                conn.execute(
                    """
                    UPDATE participants
                    SET name = ?, role = ?, department = ?, organization = ?, email = ?, phone = ?
                    WHERE source_user_id = ?
                    """,
                    (
                        updated["name"],
                        updated["position"],
                        updated["department"],
                        updated["organization"],
                        updated["email"],
                        updated["phone"],
                        user_id,
                    ),
                )
    finally:
        conn.close()
    return _to_admin_user(updated)


@router.delete("/{user_id}")
def delete_user(user_id: int, current: dict = Depends(get_current_user)) -> dict:
    require_admin(current)
    if user_id == current["id"]:
        raise HTTPException(status_code=400, detail="현재 로그인한 계정은 삭제할 수 없습니다")

    conn = db.get_conn()
    try:
        row = conn.execute(
            "SELECT id, role, active FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="사용자를 찾을 수 없습니다")
        if row["role"] == "admin" and row["active"] and _admin_count(conn) <= 1:
            raise HTTPException(status_code=400, detail="마지막 관리자는 삭제할 수 없습니다")

        audio_filenames = [
            item["audio_filename"]
            for item in conn.execute(
                "SELECT audio_filename FROM meetings WHERE user_id = ? AND audio_filename IS NOT NULL",
                (user_id,),
            ).fetchall()
        ]
        with conn:
            conn.execute("DELETE FROM participants WHERE source_user_id = ?", (user_id,))
            conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
    finally:
        conn.close()
    for filename in audio_filenames:
        _delete_audio_file(filename)
    return {"ok": True}
