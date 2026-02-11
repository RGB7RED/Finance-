import os

from fastapi import APIRouter, HTTPException, Request
from telegram import Update

from app.integrations import telegram_bot

router = APIRouter()


@router.post("/telegram/webhook")
async def telegram_webhook(request: Request) -> dict[str, bool]:
    if not telegram_bot.telegram_application:
        raise HTTPException(status_code=500, detail="Bot not initialized")

    if (
        request.headers.get("X-Telegram-Bot-Api-Secret-Token")
        != os.environ["TELEGRAM_SECRET"]
    ):
        raise HTTPException(status_code=403, detail="Forbidden")

    data = await request.json()
    update = Update.de_json(data, telegram_bot.telegram_application.bot)

    await telegram_bot.telegram_application.process_update(update)

    return {"ok": True}
