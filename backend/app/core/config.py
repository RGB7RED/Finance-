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
