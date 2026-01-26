import logging
from urllib.parse import urlparse

from fastapi import FastAPI, Response
from fastapi.middleware.cors import CORSMiddleware
from postgrest.exceptions import APIError

from app.api.goals_routes import router as goals_router
from app.api.reports_routes import router as reports_router
from app.api.routes import router
from app.core.config import (
    get_telegram_bot_token,
    get_telegram_bot_token_source,
    settings,
)
from app.integrations.supabase_client import get_supabase_client

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


def _supabase_project_ref(url: str | None) -> str:
    if not url:
        return "missing"
    parsed = urlparse(url)
    hostname = parsed.hostname or ""
    if not hostname:
        return "unknown"
    return hostname.split(".")[0]


def _log_supabase_startup_checks() -> None:
    project_ref = _supabase_project_ref(settings.SUPABASE_URL)
    logger.info("APP_ENV=%s supabase_project_ref=%s", settings.APP_ENV, project_ref)

    try:
        client = get_supabase_client()
        response = client.table("transactions").select("id").limit(1).execute()
        row_count = len(response.data or [])
        logger.info("supabase_schema_check=ok rows=%s", row_count)
    except APIError as exc:
        code = getattr(exc, "code", None)
        message = getattr(exc, "message", None) or str(exc)
        logger.error(
            "supabase_schema_check=error code=%s message=%s",
            code,
            message,
        )
    except Exception:
        logger.exception("supabase_schema_check=error unexpected")


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
    _log_supabase_startup_checks()


@app.options("/{path:path}")
def options_handler(path: str) -> Response:
    return Response(status_code=204)


app.include_router(router)
app.include_router(goals_router)
app.include_router(reports_router)


@app.get("/health")
def health_check() -> dict[str, str]:
    return {"status": "ok"}
