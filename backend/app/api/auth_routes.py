from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.security import (
    create_session_token,
    get_current_user,
    hash_password,
    require_admin,
    verify_password,
)
from app.db import get_db
from app.models import User
from app.schemas import LoginRequest, UserCreate, UserRead, UserUpdate

auth_router = APIRouter(prefix="/auth", tags=["auth"])


def _active_admin_count(db: Session) -> int:
    return int(
        db.scalar(
            select(func.count())
            .select_from(User)
            .where(User.role == "admin", User.is_active.is_(True))
        )
        or 0
    )


@auth_router.post("/login", response_model=UserRead)
def login(payload: LoginRequest, response: Response, db: Session = Depends(get_db)) -> User:
    email = payload.email.strip().lower()
    user = db.scalar(select(User).where(User.email == email))
    valid = (
        user is not None
        and user.is_active
        and verify_password(payload.password, user.password_hash)
    )
    if not valid:
        raise HTTPException(status_code=401, detail="Invalid email or password")
    response.set_cookie(
        key=settings.session_cookie_name,
        value=create_session_token(user.id),
        max_age=settings.session_ttl_hours * 3600,
        httponly=True,
        samesite="lax",
        secure=settings.session_cookie_secure,
        path="/",
    )
    return user


@auth_router.post("/logout", status_code=204)
def logout() -> Response:
    response = Response(status_code=204)
    # Cookie attribute flags must match the login Set-Cookie. Browsers will not
    # clear a Secure cookie unless the deletion response also carries Secure.
    response.delete_cookie(
        settings.session_cookie_name,
        path="/",
        httponly=True,
        samesite="lax",
        secure=settings.session_cookie_secure,
    )
    return response


@auth_router.get("/me", response_model=UserRead)
def me(user: User = Depends(get_current_user)) -> User:
    return user


@auth_router.get("/users", response_model=list[UserRead])
def list_users(
    _admin: User = Depends(require_admin), db: Session = Depends(get_db)
) -> list[User]:
    return list(db.scalars(select(User).order_by(User.created_at)))


@auth_router.post("/users", response_model=UserRead, status_code=201)
def create_user(
    payload: UserCreate,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> User:
    existing = db.scalar(select(User).where(User.email == payload.email))
    if existing:
        raise HTTPException(status_code=409, detail="A user with this email already exists")

    user = User(
        email=payload.email,
        name=payload.name,
        password_hash=hash_password(payload.password),
        role=payload.role,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@auth_router.put("/users/{user_id}", response_model=UserRead)
def update_user(
    user_id: str,
    payload: UserUpdate,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> User:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    if payload.is_active is False and user.id == admin.id:
        raise HTTPException(status_code=400, detail="You cannot deactivate your own account")
    if (
        payload.role is not None
        and payload.role != "admin"
        and user.id == admin.id
        and user.role == "admin"
    ):
        raise HTTPException(status_code=400, detail="You cannot demote your own admin role")

    data = payload.model_dump(exclude_unset=True)
    password = data.pop("password", None)
    if password:
        user.password_hash = hash_password(password)
    for field, value in data.items():
        setattr(user, field, value)
    # Reject any update that would leave the deployment with zero active admins
    # (self-demotion, or demoting/deactivating the last other admin).
    db.flush()
    if _active_admin_count(db) < 1:
        raise HTTPException(
            status_code=400,
            detail="Cannot remove the last active administrator",
        )
    db.commit()
    db.refresh(user)
    return user
