from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    app_name: str = "FSDP API"
    database_url: str = "postgresql+psycopg://fsdp:fsdp@localhost:5432/fsdp"
    cors_origins: list[str] = ["http://localhost:5173"]

    model_config = SettingsConfigDict(env_file=".env", env_prefix="FSDP_")


settings = Settings()
