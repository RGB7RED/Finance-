import logging

from fastapi import FastAPI, Response
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import router
from app.core.config import (
    get_telegram_bot_token,
    get_telegram_bot_token_source,
    settings,
)

app = FastAPI()
logger = logging.getLogger(__name__)

def parse_cors_origins(value: str) -> list[str]:
    if value == "":
        return []
    if value == "*":
        return ["*"]
    return [item.strip() for item in value.split(",") if item.strip()]


cors_origins = parse_cors_origins(settings.CORS_ORIGINS)

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins if cors_origins != ["*"] else ["*"],
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
    allow_credentials=False,
)

@app.on_event("startup")
def log_cors_settings() -> None:
    logger.info(
        "CORS origins configured: %s (raw CORS_ORIGINS=%s)",
        cors_origins,
        settings.CORS_ORIGINS,
    )
    telegram_token = get_telegram_bot_token()
    telegram_token_source = get_telegram_bot_token_source()
    telegram_token_length = len(telegram_token) if telegram_token else 0
    logger.info(
        "telegram_token_configured=%s telegram_token_source=%s telegram_token_length=%s",
        bool(telegram_token),
        telegram_token_source,
        telegram_token_length,
    )


@app.options("/{path:path}")
def options_handler(path: str) -> Response:
    return Response(status_code=204)


app.include_router(router)


@app.get("/health")
def health_check() -> dict[str, str]:
    return {"status": "ok"}
