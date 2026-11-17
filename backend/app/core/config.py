from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

INSECURE_DEFAULT_SECRET_KEY = "dev-insecure-secret-key-change-me"


class Settings(BaseSettings):
    app_name: str = "FSDP API"
    database_url: str = "postgresql+psycopg://fsdp:fsdp@localhost:5432/fsdp"
    cors_origins: list[str] = ["http://localhost:5173"]

    secret_key: str = INSECURE_DEFAULT_SECRET_KEY
    # Development only: start even though secret_key is the insecure default.
    allow_insecure_secret: bool = False
    session_ttl_hours: int = 12
    session_cookie_name: str = "fsdp_session"
    session_cookie_secure: bool = False
    # Consecutive failed sign-ins before an account is locked, and for how long.
    login_max_failures: int = 5
    login_lock_minutes: int = 5

    admin_email: str | None = None
    admin_password: str | None = None
    admin_name: str = "FSDP Admin"

    expose_docs: bool = True
    catalog_files_dir: str = "var/catalog-files"

    # Server-side sheet index and DRC: path to the bundled engine CLI
    # (frontend: npm run build:engine -> dist-engine/engine-cli.mjs), run under Node.
    # Empty turns the feature off: sheets are then indexed by the browser only.
    engine_cli: str = ""
    engine_node: str = "node"
    engine_timeout_seconds: float = 60.0

    model_config = SettingsConfigDict(env_file=".env", env_prefix="FSDP_")

    @field_validator("database_url")
    @classmethod
    def _psycopg_driver(cls, value: str) -> str:
        # Hosted Postgres (Neon, Render, Heroku-style) hands out postgres:// or
        # postgresql:// URLs; SQLAlchemy needs the installed psycopg 3 driver named.
        for prefix in ("postgres://", "postgresql://"):
            if value.startswith(prefix):
                return "postgresql+psycopg://" + value[len(prefix):]
        return value


settings = Settings()
