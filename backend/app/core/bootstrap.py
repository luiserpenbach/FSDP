import logging

from sqlalchemy import select

from app.core.config import INSECURE_DEFAULT_SECRET_KEY, settings
from app.core.security import hash_password
from app.db import SessionLocal
from app.models import User

logger = logging.getLogger(__name__)


def check_secret_key() -> None:
    """Refuse to start with the default (or an empty) session-signing secret.

    Local development can opt out with FSDP_ALLOW_INSECURE_SECRET=true.
    """
    if settings.secret_key.strip() and settings.secret_key != INSECURE_DEFAULT_SECRET_KEY:
        return
    if settings.allow_insecure_secret:
        logger.warning(
            "FSDP_SECRET_KEY is the insecure development default; "
            "set a strong secret before exposing this service."
        )
        return
    raise RuntimeError(
        "FSDP_SECRET_KEY is unset or the insecure development default, so session tokens "
        "could be forged. Set a strong secret (python -c \"import secrets; "
        "print(secrets.token_urlsafe(48))\"), or set FSDP_ALLOW_INSECURE_SECRET=true "
        "for local development only."
    )


def ensure_bootstrap_admin() -> None:
    """Create the initial admin user from FSDP_ADMIN_EMAIL/FSDP_ADMIN_PASSWORD."""
    if not settings.admin_email or not settings.admin_password:
        return
    email = settings.admin_email.strip().lower()
    with SessionLocal() as db:
        existing = db.scalar(select(User).where(User.email == email))
        if existing is not None:
            return
        db.add(
            User(
                email=email,
                name=settings.admin_name,
                password_hash=hash_password(settings.admin_password),
                role="admin",
            )
        )
        db.commit()
        logger.info("Created bootstrap admin user %s", email)
