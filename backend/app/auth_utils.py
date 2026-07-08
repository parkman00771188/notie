"""Authentication helpers: password hashing, sessions, and role checks."""

import hashlib
import hmac
import secrets
import sqlite3

from fastapi import HTTPException, Request

from . import db

PBKDF2_ITERATIONS = 100_000
INACTIVE_ACCOUNT_MESSAGE = "비활성화 되었습니다. 관리자에게 문의하세요"


def hash_password(pw: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", pw.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    return f"pbkdf2${PBKDF2_ITERATIONS}${salt.hex()}${digest.hex()}"


def verify_password(pw: str, h: str) -> bool:
    try:
        scheme, iter_str, salt_hex, hash_hex = h.split("$")
        if scheme != "pbkdf2":
            return False
        iterations = int(iter_str)
        digest = hashlib.pbkdf2_hmac(
            "sha256", pw.encode("utf-8"), bytes.fromhex(salt_hex), iterations
        )
        return hmac.compare_digest(digest.hex(), hash_hex)
    except (ValueError, TypeError):
        return False


def create_session(conn: sqlite3.Connection, user_id: int) -> str:
    token = secrets.token_hex(24)
    conn.execute("INSERT INTO sessions (token, user_id) VALUES (?, ?)", (token, user_id))
    return token


def extract_token(request: Request) -> str | None:
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        token = auth[len("Bearer "):].strip()
        if token:
            return token
    token = request.query_params.get("token")
    return token or None


def serialize_user(row: sqlite3.Row) -> dict:
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
    }


def get_current_user(request: Request) -> dict:
    token = extract_token(request)
    if not token:
        raise HTTPException(status_code=401, detail="로그인이 필요합니다")
    conn = db.get_conn()
    try:
        row = conn.execute(
            """
            SELECT
              u.id, u.username, u.email, u.name, u.team, u.organization,
              u.department, u.position, u.phone, u.role, u.active
            FROM sessions s
            JOIN users u ON u.id = s.user_id
            WHERE s.token = ?
            """,
            (token,),
        ).fetchone()
    finally:
        conn.close()
    if row is None:
        raise HTTPException(status_code=401, detail="세션이 만료되었거나 유효하지 않습니다")
    if not row["active"]:
        raise HTTPException(status_code=403, detail=INACTIVE_ACCOUNT_MESSAGE)
    return serialize_user(row)


def require_admin(user: dict) -> dict:
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="관리자 권한이 필요합니다")
    return user
