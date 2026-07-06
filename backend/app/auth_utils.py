"""인증 유틸리티 — 비밀번호 해싱(PBKDF2), 세션 토큰 생성, 현재 사용자 조회."""

import hashlib
import hmac
import secrets
import sqlite3

from fastapi import HTTPException, Request

from . import db

PBKDF2_ITERATIONS = 100_000


def hash_password(pw: str) -> str:
    """비밀번호를 PBKDF2-HMAC-SHA256으로 해싱한다.

    포맷: ``pbkdf2$<iter>$<salt_hex>$<hash_hex>``
    """
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", pw.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    return f"pbkdf2${PBKDF2_ITERATIONS}${salt.hex()}${digest.hex()}"


def verify_password(pw: str, h: str) -> bool:
    """저장된 해시 문자열과 비밀번호를 비교한다."""
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
    """세션 토큰을 생성해 sessions 테이블에 삽입하고 토큰을 반환한다."""
    token = secrets.token_hex(24)
    conn.execute(
        "INSERT INTO sessions (token, user_id) VALUES (?, ?)",
        (token, user_id),
    )
    return token


def extract_token(request: Request) -> str | None:
    """요청에서 인증 토큰 추출 — Bearer 헤더 우선, 없으면 ``token`` 쿼리 파라미터."""
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        token = auth[len("Bearer "):].strip()
        if token:
            return token
    token = request.query_params.get("token")
    return token or None


def get_current_user(request: Request) -> dict:
    """FastAPI Depends용 — 세션 토큰으로 현재 사용자 조회.

    반환: ``{id, email, name, team}``. 실패 시 401 HTTPException.
    """
    token = extract_token(request)
    if not token:
        raise HTTPException(status_code=401, detail="로그인이 필요합니다")
    conn = db.get_conn()
    try:
        row = conn.execute(
            """
            SELECT u.id, u.email, u.name, u.team
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
    return {
        "id": row["id"],
        "email": row["email"],
        "name": row["name"],
        "team": row["team"],
    }
