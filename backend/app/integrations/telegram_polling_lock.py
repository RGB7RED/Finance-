from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Optional

import psycopg

from app.core.config import settings

logger = logging.getLogger(__name__)

TELEGRAM_POLLING_LOCK_KEY = 123456


@dataclass
class TelegramPollingLockResult:
    mode: str
    connection: psycopg.Connection | None = None


def _get_database_url() -> str | None:
    return settings.DATABASE_URL or settings.SUPABASE_DB_URL


def acquire_telegram_polling_lock() -> TelegramPollingLockResult:
    database_url = _get_database_url()
    if not database_url:
        logger.warning(
            "telegram_bot_lock=disabled reason=missing_database_url"
        )
        return TelegramPollingLockResult(mode="disabled")
    try:
        connection = psycopg.connect(database_url, autocommit=True)
    except Exception:
        logger.exception("telegram_bot_lock=failed reason=connection_error")
        return TelegramPollingLockResult(mode="error")
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT pg_try_advisory_lock(%s);",
                (TELEGRAM_POLLING_LOCK_KEY,),
            )
            acquired = cursor.fetchone()[0]
    except Exception:
        logger.exception("telegram_bot_lock=failed reason=lock_query_error")
        connection.close()
        return TelegramPollingLockResult(mode="error")
    if not acquired:
        connection.close()
        logger.info("telegram_bot_lock=skipped reason=lock_not_acquired")
        return TelegramPollingLockResult(mode="skipped")
    logger.info("telegram_bot_lock=acquired key=%s", TELEGRAM_POLLING_LOCK_KEY)
    return TelegramPollingLockResult(mode="acquired", connection=connection)


def release_telegram_polling_lock(
    connection: Optional[psycopg.Connection],
) -> None:
    if not connection:
        return
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT pg_advisory_unlock(%s);",
                (TELEGRAM_POLLING_LOCK_KEY,),
            )
    except Exception:
        logger.exception("telegram_bot_lock=release_failed")
    finally:
        connection.close()
