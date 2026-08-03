from pydantic_settings import BaseSettings, SettingsConfigDict

INSECURE_DEFAULT_SECRET_KEY = "dev-insecure-secret-key-change-me"


class Settings(BaseSettings):
    app_name: str = "FSDP API"
    database_url: str = "postgresql+psycopg://fsdp:fsdp@localhost:5432/fsdp"
    cors_origins: list[str] = ["http://localhost:5173"]

    secret_key: str = INSECURE_DEFAULT_SECRET_KEY
    session_ttl_hours: int = 12
    session_cookie_name: str = "fsdp_session"
    session_cookie_secure: bool = False

    admin_email: str | None = None
    admin_password: str | None = None
    admin_name: str = "FSDP Admin"

    expose_docs: bool = True

    model_config = SettingsConfigDict(env_file=".env", env_prefix="FSDP_")


settings = Settings()
