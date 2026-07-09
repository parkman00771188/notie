"""participants 라우터 — 사용자별 참석자 사전(디렉터리) CRUD.

main.py에서 prefix="/api/participants"로 include된다.
모든 조회/변경은 현재 로그인 user_id로 스코프한다.
"""

import sqlite3

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import db
from ..auth_utils import get_current_user

router = APIRouter()

# 색 팔레트 — color 미지정 시 순환 자동 배정 (SPEC.md 고정 값)
COLOR_PALETTE = [
    "#2563eb",
    "#e8590c",
    "#0ca678",
    "#7048e8",
    "#d6336c",
    "#f08c00",
    "#1098ad",
    "#5f3dc4",
]


class ParticipantCreate(BaseModel):
    name: str = Field(min_length=1)
    role: str | None = None
    department: str | None = None
    organization: str | None = None
    email: str | None = None
    phone: str | None = None
    color: str | None = None


class ParticipantUpdate(BaseModel):
    name: str | None = None
    role: str | None = None
    department: str | None = None
    organization: str | None = None
    email: str | None = None
    phone: str | None = None
    color: str | None = None


def _to_participant(row: sqlite3.Row) -> dict:
    keys = row.keys()
    return {
        "id": row["id"],
        "source_user_id": row["source_user_id"],
        "source_username": row["source_username"] if "source_username" in keys else None,
        "name": row["name"],
        "role": row["role"],
        "department": row["department"],
        "organization": row["organization"],
        "email": row["email"],
        "phone": row["phone"],
        "color": row["color"],
        "can_delete": row["source_user_id"] is None,
    }


def _sync_user_participants(
    conn: sqlite3.Connection, owner_user_id: int, owner_role: str | None
) -> None:
    """현재 사용자의 참석자 사전에 앱 사용자 계정을 삭제 불가 항목으로 동기화한다."""
    if owner_role == "other":
        conn.execute(
            "DELETE FROM participants WHERE user_id = ? AND source_user_id IS NOT NULL",
            (owner_user_id,),
        )
        return

    conn.execute(
        """
        DELETE FROM participants
        WHERE user_id = ?
          AND source_user_id IS NOT NULL
          AND source_user_id NOT IN (
            SELECT id FROM users WHERE active = 1 AND role <> 'other'
          )
        """,
        (owner_user_id,),
    )
    users = conn.execute(
        """
        SELECT id, name, position, department, organization, email, phone
        FROM users
        WHERE active = 1 AND role <> 'other'
        ORDER BY id
        """
    ).fetchall()
    for row in users:
        existing = conn.execute(
            """
            SELECT id
            FROM participants
            WHERE user_id = ? AND source_user_id = ?
            LIMIT 1
            """,
            (owner_user_id, row["id"]),
        ).fetchone()
        color = COLOR_PALETTE[(row["id"] - 1) % len(COLOR_PALETTE)]
        values = (
            row["name"],
            row["position"],
            row["department"],
            row["organization"],
            row["email"],
            row["phone"],
            color,
        )
        if existing:
            conn.execute(
                """
                UPDATE participants
                SET name = ?, role = ?, department = ?, organization = ?, email = ?, phone = ?
                WHERE id = ?
                """,
                (*values[:-1], existing["id"]),
            )
        else:
            conn.execute(
                """
                INSERT INTO participants (
                  user_id, source_user_id, name, role, department, organization, email, phone, color
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (owner_user_id, row["id"], *values),
            )


@router.get("")
def list_participants(user: dict = Depends(get_current_user)) -> list[dict]:
    conn = db.get_conn()
    try:
        with conn:
            _sync_user_participants(conn, user["id"], user.get("role"))
        rows = conn.execute(
            """
            SELECT
              p.id, p.source_user_id, su.username AS source_username, p.name, p.role,
              p.department, p.organization, p.email, p.phone, p.color
            FROM participants p
            LEFT JOIN users su ON su.id = p.source_user_id
            WHERE p.user_id = ?
            ORDER BY p.id
            """,
            (user["id"],),
        ).fetchall()
    finally:
        conn.close()
    return [_to_participant(r) for r in rows]


@router.post("")
def create_participant(
    body: ParticipantCreate, user: dict = Depends(get_current_user)
) -> dict:
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="참석자 이름을 입력해주세요")
    role = body.role.strip() if body.role and body.role.strip() else None
    department = (
        body.department.strip() if body.department and body.department.strip() else None
    )
    organization = (
        body.organization.strip()
        if body.organization and body.organization.strip()
        else None
    )
    email = body.email.strip() if body.email and body.email.strip() else None
    phone = body.phone.strip() if body.phone and body.phone.strip() else None
    color = body.color.strip() if body.color and body.color.strip() else None

    conn = db.get_conn()
    try:
        with conn:
            if color is None:
                count = conn.execute(
                    "SELECT COUNT(*) FROM participants WHERE user_id = ?",
                    (user["id"],),
                ).fetchone()[0]
                color = COLOR_PALETTE[count % len(COLOR_PALETTE)]
            cur = conn.execute(
                "INSERT INTO participants "
                "(user_id, name, role, department, organization, email, phone, color) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (user["id"], name, role, department, organization, email, phone, color),
            )
            participant_id = cur.lastrowid
    finally:
        conn.close()

    return {
        "id": participant_id,
        "source_user_id": None,
        "source_username": None,
        "name": name,
        "role": role,
        "department": department,
        "organization": organization,
        "email": email,
        "phone": phone,
        "color": color,
        "can_delete": True,
    }


@router.patch("/{participant_id}")
def update_participant(
    participant_id: int,
    body: ParticipantUpdate,
    user: dict = Depends(get_current_user),
) -> dict:
    updates = body.model_dump(exclude_unset=True)
    conn = db.get_conn()
    try:
        owned = conn.execute(
            "SELECT id, source_user_id FROM participants WHERE id = ? AND user_id = ?",
            (participant_id, user["id"]),
        ).fetchone()
        if owned is not None and owned["source_user_id"] is not None:
            raise HTTPException(status_code=400, detail="사용자 계정에서 동기화된 참석자는 수정할 수 없습니다")
        if owned is None:
            raise HTTPException(status_code=404, detail="참석자를 찾을 수 없습니다")

        fields: list[str] = []
        values: list = []
        for key in (
            "name",
            "role",
            "department",
            "organization",
            "email",
            "phone",
            "color",
        ):
            if key not in updates:
                continue
            value = updates[key]
            if isinstance(value, str):
                value = value.strip()
            if key == "name":
                if not value:
                    raise HTTPException(
                        status_code=400, detail="참석자 이름을 입력해주세요"
                    )
            elif key == "color":
                if not value:
                    continue  # color는 NOT NULL — 빈 값은 무시
            else:  # role/department/organization/email/phone
                value = value or None  # 빈 문자열은 NULL로 저장
            fields.append(f"{key} = ?")
            values.append(value)

        if fields:
            with conn:
                conn.execute(
                    f"UPDATE participants SET {', '.join(fields)} WHERE id = ? AND user_id = ?",
                    (*values, participant_id, user["id"]),
                )

        row = conn.execute(
            "SELECT id, source_user_id, name, role, department, organization, email, phone, color "
            "FROM participants WHERE id = ?",
            (participant_id,),
        ).fetchone()
    finally:
        conn.close()
    return _to_participant(row)


@router.delete("/{participant_id}")
def delete_participant(
    participant_id: int, user: dict = Depends(get_current_user)
) -> dict:
    conn = db.get_conn()
    try:
        protected = conn.execute(
            "SELECT source_user_id FROM participants WHERE id = ? AND user_id = ?",
            (participant_id, user["id"]),
        ).fetchone()
        if protected is not None and protected["source_user_id"] is not None:
            raise HTTPException(status_code=400, detail="사용자 계정에서 동기화된 참석자는 삭제할 수 없습니다")
        with conn:
            cur = conn.execute(
                "DELETE FROM participants WHERE id = ? AND user_id = ?",
                (participant_id, user["id"]),
            )
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="참석자를 찾을 수 없습니다")
    finally:
        conn.close()
    return {"ok": True}
