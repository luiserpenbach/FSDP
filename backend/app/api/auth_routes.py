import datetime as dt
import secrets
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.oidc import (
    STATE_COOKIE,
    STATE_TTL_SECONDS,
    SsoError,
    begin_login,
    complete_login,
    sso_enabled,
)
from app.core.security import (
    as_utc,
    create_session_token,
    get_current_user,
    hash_api_token,
    hash_password,
    new_api_token,
    require_admin,
    verify_password,
)
from app.db import get_db
from app.models import ApiToken, User
from app.schemas import (
    ApiTokenCreate,
    ApiTokenCreated,
    ApiTokenRead,
    AuthConfigRead,
    LoginRequest,
    UserCreate,
    UserRead,
    UserUpdate,
)

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


def _set_session_cookie(response: Response, user: User) -> None:
    response.set_cookie(
        key=settings.session_cookie_name,
        value=create_session_token(user.id),
        max_age=settings.session_ttl_hours * 3600,
        httponly=True,
        samesite="lax",
        secure=settings.session_cookie_secure,
        path="/",
    )


@auth_router.get("/config", response_model=AuthConfigRead)
def auth_config() -> dict:
    """What the sign-in page offers (public)."""
    return {
        "sso_enabled": sso_enabled(),
        "sso_label": settings.oidc_label,
        "password_login_enabled": settings.password_login_enabled,
    }


def _sso_failure(message: str) -> RedirectResponse:
    target = settings.oidc_post_login_url
    separator = "&" if "?" in target else "?"
    response = RedirectResponse(f"{target}{separator}{urlencode({'sso_error': message})}", 303)
    response.delete_cookie(STATE_COOKIE, path="/")
    return response


@auth_router.get("/sso/login")
def sso_login() -> Response:
    """Send the browser to the identity provider."""
    if not sso_enabled():
        raise HTTPException(status_code=404, detail="Single sign-on is not configured")
    try:
        url, state_cookie = begin_login()
    except SsoError as error:
        return _sso_failure(str(error))
    response = RedirectResponse(url, 303)
    response.set_cookie(
        key=STATE_COOKIE,
        value=state_cookie,
        max_age=STATE_TTL_SECONDS,
        httponly=True,
        # Lax: the provider returns with a top-level navigation, which still sends it.
        samesite="lax",
        secure=settings.session_cookie_secure,
        path="/",
    )
    return response


@auth_router.get("/sso/callback")
def sso_callback(
    request: Request,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    db: Session = Depends(get_db),
) -> Response:
    """Finish an SSO sign-in: verify the provider's answer, then start a session."""
    if not sso_enabled():
        raise HTTPException(status_code=404, detail="Single sign-on is not configured")
    if error or not code or not state:
        return _sso_failure("The identity provider did not complete the sign-in.")
    try:
        identity = complete_login(code, state, request.cookies.get(STATE_COOKIE))
    except SsoError as failure:
        return _sso_failure(str(failure))

    user = db.scalar(select(User).where(User.email == identity.email))
    if user is None:
        user = User(
            email=identity.email,
            name=identity.name,
            # No usable password: the account signs in through the provider only,
            # until an administrator sets one.
            password_hash=hash_password(secrets.token_urlsafe(32)),
            role=settings.oidc_default_role,
        )
        db.add(user)
        db.commit()
        db.refresh(user)
    elif not user.is_active:
        return _sso_failure("This account is deactivated. Ask an administrator.")
    response = RedirectResponse(settings.oidc_post_login_url, 303)
    response.delete_cookie(STATE_COOKIE, path="/")
    _set_session_cookie(response, user)
    return response


@auth_router.post("/login", response_model=UserRead)
def login(payload: LoginRequest, response: Response, db: Session = Depends(get_db)) -> User:
    email = payload.email.strip().lower()
    user = db.scalar(select(User).where(User.email == email))
    now = dt.datetime.now(dt.UTC)
    if user is not None and user.locked_until is not None and as_utc(user.locked_until) > now:
        # Checked before the password, so a locked account cannot be guessed at all.
        minutes = max(1, round((as_utc(user.locked_until) - now).total_seconds() / 60))
        raise HTTPException(
            status_code=429,
            detail=f"Too many failed sign-ins. Try again in {minutes} minute(s).",
        )
    valid = (
        user is not None
        and user.is_active
        and verify_password(payload.password, user.password_hash)
    )
    if not valid:
        if user is not None and user.is_active:
            user.failed_logins += 1
            if user.failed_logins >= settings.login_max_failures:
                user.failed_logins = 0
                user.locked_until = now + dt.timedelta(minutes=settings.login_lock_minutes)
            db.commit()
        raise HTTPException(status_code=401, detail="Invalid email or password")
    if not settings.password_login_enabled and user.role != "admin":
        raise HTTPException(
            status_code=403, detail="Password sign-in is turned off. Use single sign-on."
        )
    if user.failed_logins or user.locked_until is not None:
        user.failed_logins = 0
        user.locked_until = None
        db.commit()
    _set_session_cookie(response, user)
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
    if password or data.get("is_active"):
        # An admin reset or reactivation also lifts a sign-in lock.
        user.failed_logins = 0
        user.locked_until = None
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


MAX_TOKENS_PER_USER = 20


@auth_router.get("/tokens", response_model=list[ApiTokenRead])
def list_api_tokens(
    user: User = Depends(get_current_user), db: Session = Depends(get_db)
) -> list[ApiToken]:
    return list(
        db.scalars(
            select(ApiToken).where(ApiToken.user_id == user.id).order_by(ApiToken.created_at)
        )
    )


@auth_router.post("/tokens", response_model=ApiTokenCreated, status_code=201)
def create_api_token(
    payload: ApiTokenCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """Create a personal access token; the secret is in this response only."""
    count = db.scalar(
        select(func.count()).select_from(ApiToken).where(ApiToken.user_id == user.id)
    )
    if (count or 0) >= MAX_TOKENS_PER_USER:
        raise HTTPException(
            status_code=409,
            detail=f"Token limit reached ({MAX_TOKENS_PER_USER}); revoke one you no longer use.",
        )
    secret = new_api_token()
    expires_at = (
        dt.datetime.now(dt.UTC) + dt.timedelta(days=payload.expires_in_days)
        if payload.expires_in_days
        else None
    )
    token = ApiToken(
        user_id=user.id,
        name=payload.name,
        prefix=secret[:14],
        token_hash=hash_api_token(secret),
        expires_at=expires_at,
    )
    db.add(token)
    db.commit()
    db.refresh(token)
    return {**ApiTokenRead.model_validate(token).model_dump(), "token": secret}


@auth_router.delete("/tokens/{token_id}", status_code=204)
def revoke_api_token(
    token_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    token = db.get(ApiToken, token_id)
    if token is None or token.user_id != user.id:
        raise HTTPException(status_code=404, detail="Token not found")
    db.delete(token)
    db.commit()
    return Response(status_code=204)
