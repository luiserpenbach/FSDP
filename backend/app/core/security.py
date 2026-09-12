import datetime as dt

import bcrypt
import jwt
from fastapi import Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db import get_db
from app.models import User


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


def get_current_user(request: Request, db: Session = Depends(get_db)) -> User:
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


def require_safety_approver(
    user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> User:
    """Admins always; engineers only when they are on the project's approver list
    (or when no approver list is configured anywhere, so small teams are not
    locked out). Project scope is checked by the route when it knows the project."""
    if user.role == "admin":
        return user
    if user.role not in WRITER_ROLES:
        raise HTTPException(status_code=403, detail="Engineer or admin role required.")
    from app.models import SafetySettings  # local import: avoid a cycle at module load

    configured = [
        row
        for row in db.scalars(select(SafetySettings))
        if (row.settings or {}).get("approvers")
    ]
    if not configured:
        return user
    if any(user.id in (row.settings or {}).get("approvers", []) or
           user.email in (row.settings or {}).get("approvers", []) for row in configured):
        return user
    raise HTTPException(
        status_code=403,
        detail="Only a safety approver can accept hazards or release worksheets.",
    )
