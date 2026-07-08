"""Authentication routes."""

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from .. import db
from ..auth_utils import (
    INACTIVE_ACCOUNT_MESSAGE,
    create_session,
    extract_token,
    get_current_user,
    serialize_user,
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
    raise HTTPException(status_code=403, detail="회원가입은 관리자에게 계정 발급을 요청해주세요")


@router.post("/login")
def login(body: LoginRequest) -> dict:
    identifier = body.email.strip().lower()
    conn = db.get_conn()
    try:
        row = conn.execute(
            """
            SELECT
              id, username, email, name, team, organization, department,
              position, phone, role, active, password_hash
            FROM users
            WHERE lower(username) = ? OR lower(email) = ?
            """,
            (identifier, identifier),
        ).fetchone()
        if row is None or not verify_password(body.password, row["password_hash"]):
            raise HTTPException(status_code=401, detail="아이디 또는 비밀번호가 올바르지 않습니다")
        if not row["active"]:
            raise HTTPException(status_code=403, detail=INACTIVE_ACCOUNT_MESSAGE)
        with conn:
            token = create_session(conn, row["id"])
    finally:
        conn.close()

    return {"token": token, "user": serialize_user(row)}


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
