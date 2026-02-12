import os
import logging

from fastapi import APIRouter, Request
from telegram import Update

from app.integrations import telegram_bot

router = APIRouter()
logger = logging.getLogger(__name__)


@router.post("/telegram/webhook")
async def telegram_webhook(request: Request) -> dict[str, bool]:
    try:
        if not telegram_bot.telegram_application:
            logger.error("Telegram application not initialized")
            return {"ok": True}

        secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token")
        if secret != os.environ.get("TELEGRAM_SECRET"):
            logger.error("Invalid Telegram secret token")
            return {"ok": True}

        data = await request.json()
        update = Update.de_json(data, telegram_bot.telegram_application.bot)

        await telegram_bot.telegram_application.process_update(update)

        return {"ok": True}
    except Exception:
        logger.exception("Telegram webhook processing failed")
        return {"ok": True}
