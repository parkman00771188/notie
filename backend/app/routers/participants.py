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
    color: str | None = None


class ParticipantUpdate(BaseModel):
    name: str | None = None
    role: str | None = None
    color: str | None = None


def _to_participant(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "role": row["role"],
        "color": row["color"],
    }


@router.get("")
def list_participants(user: dict = Depends(get_current_user)) -> list[dict]:
    conn = db.get_conn()
    try:
        rows = conn.execute(
            "SELECT id, name, role, color FROM participants WHERE user_id = ? ORDER BY id",
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
                "INSERT INTO participants (user_id, name, role, color) VALUES (?, ?, ?, ?)",
                (user["id"], name, role, color),
            )
            participant_id = cur.lastrowid
    finally:
        conn.close()

    return {"id": participant_id, "name": name, "role": role, "color": color}


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
            "SELECT id FROM participants WHERE id = ? AND user_id = ?",
            (participant_id, user["id"]),
        ).fetchone()
        if owned is None:
            raise HTTPException(status_code=404, detail="참석자를 찾을 수 없습니다")

        fields: list[str] = []
        values: list = []
        for key in ("name", "role", "color"):
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
            elif key == "role":
                value = value or None  # 빈 문자열은 NULL로 저장
            elif key == "color":
                if not value:
                    continue  # color는 NOT NULL — 빈 값은 무시
            fields.append(f"{key} = ?")
            values.append(value)

        if fields:
            with conn:
                conn.execute(
                    f"UPDATE participants SET {', '.join(fields)} WHERE id = ? AND user_id = ?",
                    (*values, participant_id, user["id"]),
                )

        row = conn.execute(
            "SELECT id, name, role, color FROM participants WHERE id = ?",
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
