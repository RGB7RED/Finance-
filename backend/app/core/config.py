import os

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    APP_ENV: str
    JWT_SECRET: str
    TELEGRAM_BOT_TOKEN: str | None = None
    SUPABASE_URL: str | None = None
    SUPABASE_ANON_KEY: str | None = None
    SUPABASE_SERVICE_ROLE_KEY: str | None = None
    CORS_ORIGINS: str
    LOG_LEVEL: str

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


settings = Settings()

TELEGRAM_BOT_TOKEN_KEYS = ("TELEGRAM_BOT_TOKEN", "MF_TELEGRAM_BOT_TOKEN")


def get_telegram_bot_token() -> str | None:
    for key in TELEGRAM_BOT_TOKEN_KEYS:
        value = os.getenv(key)
        if value:
            return value
    return None


def get_telegram_bot_token_source() -> str:
    for key in TELEGRAM_BOT_TOKEN_KEYS:
        value = os.getenv(key)
        if value:
            return key
    return "none"
