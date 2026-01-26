import logging
from datetime import date, datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.auth.jwt import create_access_token, get_current_user
from app.auth.telegram import verify_init_data
from app.core.config import get_telegram_bot_token, settings
from app.repositories.accounts import create_account, list_accounts
from app.repositories.budgets import ensure_default_budgets, list_budgets
from app.repositories.categories import create_category, list_categories
from app.repositories.daily_state import get_delta, get_or_create, upsert
from app.repositories.debts_other import (
    create_debt_other,
    delete_debt_other,
    list_debts_other,
)
from app.repositories.transactions import (
    create_transaction,
    delete_transaction,
    list_transactions,
)
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


class TransactionCreate(BaseModel):
    budget_id: str
    type: Literal["income", "expense", "transfer"]
    amount: int = Field(gt=0)
    date: date
    account_id: str | None = None
    to_account_id: str | None = None
    category_id: str | None = None
    tag: Literal["one_time", "subscription"]
    note: str | None = None


class TransactionOut(BaseModel):
    id: str
    budget_id: str
    user_id: str
    date: date
    type: Literal["income", "expense", "transfer"]
    amount: int
    account_id: str | None = None
    to_account_id: str | None = None
    category_id: str | None = None
    tag: Literal["one_time", "subscription"]
    note: str | None = None
    created_at: str


class DailyStateUpdate(BaseModel):
    budget_id: str
    date: date
    cash_total: int | None = Field(default=None, ge=0)
    bank_total: int | None = Field(default=None, ge=0)
    debt_cards_total: int | None = Field(default=None, ge=0)
    debt_other_total: int | None = Field(default=None, ge=0)


class DailyStateOut(BaseModel):
    budget_id: str
    user_id: str
    date: date
    cash_total: int
    bank_total: int
    debt_cards_total: int
    debt_other_total: int
    assets_total: int
    debts_total: int
    balance: int


class DebtOtherCreateRequest(BaseModel):
    budget_id: str
    name: str
    amount: int = Field(ge=0)
    note: str | None = None


class DebtOtherOut(BaseModel):
    id: str
    budget_id: str
    user_id: str
    name: str
    amount: int
    note: str | None = None
    created_at: str


def _utc_today() -> date:
    return datetime.now(timezone.utc).date()


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


@router.get("/transactions")
def get_transactions(
    budget_id: str,
    date: date,
    current_user: dict = Depends(get_current_user),
) -> list[TransactionOut]:
    return list_transactions(current_user["sub"], budget_id, date.isoformat())


@router.post("/transactions")
def post_transactions(
    payload: TransactionCreate, current_user: dict = Depends(get_current_user)
) -> TransactionOut:
    return create_transaction(current_user["sub"], payload.model_dump(mode="json"))


@router.delete("/transactions/{tx_id}")
def delete_transactions(
    tx_id: str, current_user: dict = Depends(get_current_user)
) -> dict[str, str]:
    delete_transaction(current_user["sub"], tx_id)
    return {"status": "deleted"}


@router.get("/debts/other")
def get_debts_other(
    budget_id: str, current_user: dict = Depends(get_current_user)
) -> list[DebtOtherOut]:
    return list_debts_other(current_user["sub"], budget_id)


@router.post("/debts/other")
def post_debts_other(
    payload: DebtOtherCreateRequest, current_user: dict = Depends(get_current_user)
) -> DebtOtherOut:
    record = create_debt_other(
        current_user["sub"],
        payload.budget_id,
        payload.name,
        payload.amount,
        payload.note,
    )
    get_or_create(current_user["sub"], payload.budget_id, _utc_today())
    return record


@router.delete("/debts/other/{debt_id}")
def delete_debts_other(
    debt_id: str, current_user: dict = Depends(get_current_user)
) -> dict[str, str]:
    record = delete_debt_other(current_user["sub"], debt_id)
    get_or_create(current_user["sub"], record["budget_id"], _utc_today())
    return {"status": "deleted"}


@router.get("/daily-state")
def get_daily_state(
    budget_id: str,
    date: date,
    current_user: dict = Depends(get_current_user),
) -> DailyStateOut:
    record = get_or_create(current_user["sub"], budget_id, date)
    return DailyStateOut(**record)


@router.put("/daily-state")
def put_daily_state(
    payload: DailyStateUpdate, current_user: dict = Depends(get_current_user)
) -> DailyStateOut:
    fields = payload.model_dump(
        mode="json", exclude={"budget_id", "date"}, exclude_none=True
    )
    record = upsert(
        current_user["sub"],
        payload.budget_id,
        payload.date,
        fields,
    )
    return DailyStateOut(**record)


@router.get("/daily-state/delta")
def get_daily_delta(
    budget_id: str,
    date: date,
    current_user: dict = Depends(get_current_user),
) -> dict[str, int]:
    delta = get_delta(current_user["sub"], budget_id, date)
    return {"top_day_total": delta}
