import logging

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from app.auth.jwt import create_access_token, get_current_user
from app.auth.telegram import verify_init_data
from app.core.config import get_telegram_bot_token, settings
from app.repositories.accounts import create_account, list_accounts
from app.repositories.budgets import ensure_default_budgets, list_budgets
from app.repositories.categories import create_category, list_categories
from app.repositories.users import get_user_by_id, upsert_user

logger = logging.getLogger(__name__)

router = APIRouter()


class TelegramAuthRequest(BaseModel):
    initData: str


class AccountCreateRequest(BaseModel):
    budget_id: str
    name: str
    kind: str


class CategoryCreateRequest(BaseModel):
    budget_id: str
    name: str
    parent_id: str | None = None


@router.post("/auth/telegram")
def auth_telegram(payload: TelegramAuthRequest) -> dict[str, str]:
    telegram_token = get_telegram_bot_token()
    if not telegram_token:
        logger.error("TELEGRAM_BOT_TOKEN is not configured")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Telegram authentication is not configured",
        )

    try:
        telegram_user = verify_init_data(payload.initData, telegram_token)
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


@router.get("/budgets")
def get_budgets(current_user: dict = Depends(get_current_user)) -> list[dict]:
    return list_budgets(current_user["sub"])


@router.post("/budgets/ensure-defaults")
def post_budgets_defaults(
    current_user: dict = Depends(get_current_user),
) -> list[dict]:
    return ensure_default_budgets(current_user["sub"])


@router.get("/accounts")
def get_accounts(
    budget_id: str, current_user: dict = Depends(get_current_user)
) -> list[dict]:
    return list_accounts(current_user["sub"], budget_id)


@router.post("/accounts")
def post_accounts(
    payload: AccountCreateRequest, current_user: dict = Depends(get_current_user)
) -> dict:
    return create_account(
        current_user["sub"], payload.budget_id, payload.name, payload.kind
    )


@router.get("/categories")
def get_categories(
    budget_id: str, current_user: dict = Depends(get_current_user)
) -> list[dict]:
    return list_categories(current_user["sub"], budget_id)


@router.post("/categories")
def post_categories(
    payload: CategoryCreateRequest, current_user: dict = Depends(get_current_user)
) -> dict:
    return create_category(
        current_user["sub"], payload.budget_id, payload.name, payload.parent_id
    )
