import logging

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from app.auth.jwt import create_access_token, get_current_user
from app.auth.telegram import verify_init_data
from app.core.config import settings
from app.repositories.users import get_user_by_id, upsert_user

logger = logging.getLogger(__name__)

router = APIRouter()


class TelegramAuthRequest(BaseModel):
    initData: str


@router.post("/auth/telegram")
def auth_telegram(payload: TelegramAuthRequest) -> dict[str, str]:
    if not settings.TELEGRAM_BOT_TOKEN:
        logger.error("TELEGRAM_BOT_TOKEN is not configured")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Telegram authentication is not configured",
        )

    try:
        telegram_user = verify_init_data(payload.initData, settings.TELEGRAM_BOT_TOKEN)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid initData signature",
        ) from exc

    user_id = upsert_user(
        telegram_id=telegram_user["id"],
        username=telegram_user.get("username"),
        first_name=telegram_user.get("first_name"),
        last_name=telegram_user.get("last_name"),
    )
    access_token = create_access_token(user_id=user_id, telegram_id=telegram_user["id"])

    return {"access_token": access_token, "token_type": "bearer"}


@router.get("/me")
def get_me(current_user: dict = Depends(get_current_user)) -> dict[str, str | int]:
    user = get_user_by_id(current_user["sub"])
    return {
        "user_id": user["id"],
        "telegram_id": user["telegram_id"],
        "username": user.get("username"),
        "first_name": user.get("first_name"),
    }
