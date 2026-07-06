"""org 라우터 — 태그(프로젝트) 사전 + 소속/직책(org-options) 사전 CRUD.

main.py에서 prefix="/api"로 include된다 → 실제 경로는
/api/tags, /api/tags/{tag_id}, /api/org-options, /api/org-options/{option_id}.
모든 조회/변경은 현재 로그인 user_id로 스코프한다.
"""

import sqlite3
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import db
from ..auth_utils import get_current_user

router = APIRouter()

# 태그 색 팔레트 — color 미지정 시 순환 자동 배정 (SPEC.md 고정 값)
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

ORG_KINDS = ("department", "role")


class TagCreate(BaseModel):
    name: str = Field(min_length=1)
    color: str | None = None


class TagUpdate(BaseModel):
    name: str | None = None
    color: str | None = None


class OrgOptionCreate(BaseModel):
    kind: Literal["department", "role"]
    name: str = Field(min_length=1)


def _to_tag(row: sqlite3.Row) -> dict:
    return {"id": row["id"], "name": row["name"], "color": row["color"]}


def _to_org_option(row: sqlite3.Row) -> dict:
    return {"id": row["id"], "kind": row["kind"], "name": row["name"]}


# ---------------------------------------------------------------- tags


@router.get("/tags")
def list_tags(user: dict = Depends(get_current_user)) -> list[dict]:
    conn = db.get_conn()
    try:
        rows = conn.execute(
            "SELECT id, name, color FROM tags WHERE user_id = ? ORDER BY name ASC",
            (user["id"],),
        ).fetchall()
    finally:
        conn.close()
    return [_to_tag(r) for r in rows]


@router.post("/tags")
def create_tag(body: TagCreate, user: dict = Depends(get_current_user)) -> dict:
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="태그 이름을 입력해주세요")
    color = body.color.strip() if body.color and body.color.strip() else None

    conn = db.get_conn()
    try:
        with conn:
            if color is None:
                count = conn.execute(
                    "SELECT COUNT(*) FROM tags WHERE user_id = ?",
                    (user["id"],),
                ).fetchone()[0]
                color = TAG_COLOR_PALETTE[count % len(TAG_COLOR_PALETTE)]
            try:
                cur = conn.execute(
                    "INSERT INTO tags (user_id, name, color) VALUES (?, ?, ?)",
                    (user["id"], name, color),
                )
            except sqlite3.IntegrityError:
                raise HTTPException(status_code=400, detail="이미 있는 태그예요")
            tag_id = cur.lastrowid
    finally:
        conn.close()

    return {"id": tag_id, "name": name, "color": color}


@router.patch("/tags/{tag_id}")
def update_tag(
    tag_id: int, body: TagUpdate, user: dict = Depends(get_current_user)
) -> dict:
    updates = body.model_dump(exclude_unset=True)
    conn = db.get_conn()
    try:
        row = conn.execute(
            "SELECT id, name, color FROM tags WHERE id = ? AND user_id = ?",
            (tag_id, user["id"]),
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="태그를 찾을 수 없습니다")
        old_name = row["name"]

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
            if value:  # color는 NOT NULL — 빈 값은 무시
                fields.append("color = ?")
                values.append(value)

        if fields:
            try:
                with conn:
                    conn.execute(
                        f"UPDATE tags SET {', '.join(fields)} WHERE id = ? AND user_id = ?",
                        (*values, tag_id, user["id"]),
                    )
                    # name 변경 시 해당 태그명을 쓰는 내 meetings.tag도 함께 변경
                    if new_name is not None and new_name != old_name:
                        conn.execute(
                            "UPDATE meetings SET tag = ? WHERE user_id = ? AND tag = ?",
                            (new_name, user["id"], old_name),
                        )
            except sqlite3.IntegrityError:
                raise HTTPException(status_code=400, detail="이미 있는 태그예요")

        row = conn.execute(
            "SELECT id, name, color FROM tags WHERE id = ?", (tag_id,)
        ).fetchone()
    finally:
        conn.close()
    return _to_tag(row)


@router.delete("/tags/{tag_id}")
def delete_tag(tag_id: int, user: dict = Depends(get_current_user)) -> dict:
    """태그 사전에서만 제거한다 — 회의의 tag 문자열은 남겨둠."""
    conn = db.get_conn()
    try:
        with conn:
            cur = conn.execute(
                "DELETE FROM tags WHERE id = ? AND user_id = ?",
                (tag_id, user["id"]),
            )
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="태그를 찾을 수 없습니다")
    finally:
        conn.close()
    return {"ok": True}


# ---------------------------------------------------------------- org-options


@router.get("/org-options")
def list_org_options(
    kind: str | None = None, user: dict = Depends(get_current_user)
) -> list[dict]:
    if kind is not None and kind not in ORG_KINDS:
        raise HTTPException(
            status_code=400, detail="kind는 department 또는 role이어야 합니다"
        )
    conn = db.get_conn()
    try:
        if kind:
            rows = conn.execute(
                "SELECT id, kind, name FROM org_options WHERE user_id = ? AND kind = ? ORDER BY name ASC",
                (user["id"], kind),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT id, kind, name FROM org_options WHERE user_id = ? ORDER BY kind ASC, name ASC",
                (user["id"],),
            ).fetchall()
    finally:
        conn.close()
    return [_to_org_option(r) for r in rows]


@router.post("/org-options")
def create_org_option(
    body: OrgOptionCreate, user: dict = Depends(get_current_user)
) -> dict:
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="이름을 입력해주세요")

    conn = db.get_conn()
    try:
        with conn:
            try:
                cur = conn.execute(
                    "INSERT INTO org_options (user_id, kind, name) VALUES (?, ?, ?)",
                    (user["id"], body.kind, name),
                )
            except sqlite3.IntegrityError:
                raise HTTPException(status_code=400, detail="이미 등록돼 있어요")
            option_id = cur.lastrowid
    finally:
        conn.close()

    return {"id": option_id, "kind": body.kind, "name": name}


@router.delete("/org-options/{option_id}")
def delete_org_option(
    option_id: int, user: dict = Depends(get_current_user)
) -> dict:
    conn = db.get_conn()
    try:
        with conn:
            cur = conn.execute(
                "DELETE FROM org_options WHERE id = ? AND user_id = ?",
                (option_id, user["id"]),
            )
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="항목을 찾을 수 없습니다")
    finally:
        conn.close()
    return {"ok": True}
