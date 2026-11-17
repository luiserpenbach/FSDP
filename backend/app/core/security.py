import datetime as dt
import hashlib
import secrets

import bcrypt
import jwt
from fastapi import Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db import get_db
from app.models import ApiToken, User


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))
    except ValueError:
        return False


def create_session_token(user_id: str) -> str:
    now = dt.datetime.now(dt.UTC)
    payload = {
        "sub": user_id,
        "iat": now,
        "exp": now + dt.timedelta(hours=settings.session_ttl_hours),
    }
    return jwt.encode(payload, settings.secret_key, algorithm="HS256")


def decode_session_token(token: str) -> str | None:
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=["HS256"])
    except jwt.PyJWTError:
        return None
    subject = payload.get("sub")
    return subject if isinstance(subject, str) else None


API_TOKEN_PREFIX = "fsdp_pat_"
# How stale last_used_at may get, so a busy integration is not one write per request.
_LAST_USED_RESOLUTION = dt.timedelta(minutes=1)


def as_utc(value: dt.datetime) -> dt.datetime:
    """SQLite returns naive datetimes; they are stored as UTC."""
    return value if value.tzinfo else value.replace(tzinfo=dt.UTC)


def new_api_token() -> str:
    return API_TOKEN_PREFIX + secrets.token_urlsafe(32)


def hash_api_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _bearer_token(request: Request) -> str | None:
    scheme, _, value = request.headers.get("Authorization", "").partition(" ")
    value = value.strip()
    if scheme.lower() != "bearer" or not value.startswith(API_TOKEN_PREFIX):
        return None
    return value


def _user_for_api_token(db: Session, secret: str) -> User | None:
    token = db.scalar(select(ApiToken).where(ApiToken.token_hash == hash_api_token(secret)))
    if token is None:
        return None
    now = dt.datetime.now(dt.UTC)
    if token.expires_at is not None and as_utc(token.expires_at) <= now:
        return None
    user = db.get(User, token.user_id)
    if user is None or not user.is_active:
        return None
    if token.last_used_at is None or now - as_utc(token.last_used_at) > _LAST_USED_RESOLUTION:
        token.last_used_at = now
        db.commit()
    return user


def get_current_user(request: Request, db: Session = Depends(get_db)) -> User:
    """The signed-in user: an API token (Authorization: Bearer) or the session cookie."""
    bearer = _bearer_token(request)
    if bearer is not None:
        user = _user_for_api_token(db, bearer)
        if user is None:
            raise HTTPException(status_code=401, detail="Invalid or expired API token")
        return user
    token = request.cookies.get(settings.session_cookie_name)
    user_id = decode_session_token(token) if token else None
    user = db.get(User, user_id) if user_id else None
    if user is None or not user.is_active:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user


def require_admin(user: User = Depends(get_current_user)) -> User:
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="Administrator access required")
    return user


WRITER_ROLES = {"admin", "engineer"}


def require_writer(user: User = Depends(get_current_user)) -> User:
    if user.role not in WRITER_ROLES:
        detail = "This account is read-only; an engineer or admin role is required to make changes."
        raise HTTPException(status_code=403, detail=detail)
    return user
