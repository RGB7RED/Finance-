import os
import logging

from fastapi import APIRouter, Request
from telegram import Update

router = APIRouter()
logger = logging.getLogger(__name__)


@router.post("/telegram/webhook")
async def telegram_webhook(request: Request) -> dict[str, bool]:
    try:
        telegram_application = request.app.state.telegram_application

        data = await request.json()

        secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token")
        if secret != os.environ.get("TELEGRAM_SECRET"):
            return {"ok": True}

        update = Update.de_json(data, telegram_application.bot)

        await telegram_application.process_update(update)

        return {"ok": True}
    except Exception:
        logger.exception("Telegram webhook processing failed")
        return {"ok": True}
