"""auth 라우터 — 회원가입 / 로그인 / 내 정보 / 로그아웃.

main.py에서 prefix="/api/auth"로 include된다.
"""

import sqlite3

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from .. import db
from ..auth_utils import (
    create_session,
    extract_token,
    get_current_user,
    hash_password,
    verify_password,
)

router = APIRouter()


class SignupRequest(BaseModel):
    email: str = Field(min_length=3)
    password: str = Field(min_length=1)
    name: str = Field(min_length=1)
    team: str | None = None


class LoginRequest(BaseModel):
    email: str
    password: str


@router.post("/signup")
def signup(body: SignupRequest) -> dict:
    email = body.email.strip().lower()
    name = body.name.strip()
    team = body.team.strip() if body.team and body.team.strip() else None
    if not email or not name:
        raise HTTPException(status_code=400, detail="이메일과 이름을 입력해주세요")

    conn = db.get_conn()
    try:
        with conn:
            try:
                cur = conn.execute(
                    "INSERT INTO users (email, password_hash, name, team) VALUES (?, ?, ?, ?)",
                    (email, hash_password(body.password), name, team),
                )
            except sqlite3.IntegrityError:
                raise HTTPException(status_code=400, detail="이미 가입된 이메일입니다")
            user_id = cur.lastrowid
            token = create_session(conn, user_id)
    finally:
        conn.close()

    return {
        "token": token,
        "user": {"id": user_id, "email": email, "name": name, "team": team},
    }


@router.post("/login")
def login(body: LoginRequest) -> dict:
    email = body.email.strip().lower()
    conn = db.get_conn()
    try:
        row = conn.execute(
            "SELECT id, email, name, team, password_hash FROM users WHERE email = ?",
            (email,),
        ).fetchone()
        if row is None or not verify_password(body.password, row["password_hash"]):
            raise HTTPException(
                status_code=401, detail="이메일 또는 비밀번호가 올바르지 않습니다"
            )
        with conn:
            token = create_session(conn, row["id"])
    finally:
        conn.close()

    return {
        "token": token,
        "user": {
            "id": row["id"],
            "email": row["email"],
            "name": row["name"],
            "team": row["team"],
        },
    }


@router.get("/me")
def me(user: dict = Depends(get_current_user)) -> dict:
    return user


@router.post("/logout")
def logout(request: Request, user: dict = Depends(get_current_user)) -> dict:
    token = extract_token(request)
    conn = db.get_conn()
    try:
        with conn:
            conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
    finally:
        conn.close()
    return {"ok": True}
