import os
import logging

from fastapi import APIRouter, Request
from telegram import Update

router = APIRouter()
logger = logging.getLogger(__name__)


@router.post("/telegram/webhook")
async def telegram_webhook(request: Request) -> dict[str, bool]:
    try:
        telegram_application = getattr(
            request.app.state,
            "telegram_application",
            None,
        )
        if not telegram_application:
            logger.error("Telegram app not found in app.state")
            return {"ok": True}

        data = await request.json()

        expected_secret = os.environ.get("TELEGRAM_SECRET")
        secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token")
        if expected_secret and secret != expected_secret:
            logger.warning(
                "Telegram webhook secret mismatch: header_present=%s expected_length=%s",
                bool(secret),
                len(expected_secret),
            )
            return {"ok": True}

        update = Update.de_json(data, telegram_application.bot)

        logger.info(
            "Telegram update received: update_id=%s has_message=%s has_callback=%s",
            getattr(update, "update_id", None),
            bool(getattr(update, "message", None)),
            bool(getattr(update, "callback_query", None)),
        )

        await telegram_application.process_update(update)

        return {"ok": True}
    except Exception:
        logger.exception("Telegram webhook processing failed")
        return {"ok": True}
