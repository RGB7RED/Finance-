import datetime as dt
import logging
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, StrictInt

from app.auth.jwt import create_access_token, get_current_user
from app.auth.telegram import verify_init_data
from app.core.config import get_telegram_bot_token, settings
from app.repositories.accounts import create_account, list_accounts
from app.repositories.budgets import (
    ensure_default_budgets,
    list_budgets,
    reset_budget_data,
)
from app.repositories.categories import create_category, list_categories
from app.repositories.account_balance_events import (
    RECONCILE_ADJUST_REASON,
    calculate_totals,
    create_balance_event,
    get_accounts_with_balances,
    get_balances_as_of,
    upsert_manual_adjust_event,
)
from app.repositories.daily_state import (
    get_balance_for_date,
    get_debts,
    get_debts_as_of,
    get_delta,
    upsert_debts,
)
from app.repositories.debts_other import (
    delete_debt_other,
    list_debts_other,
)
from app.repositories.rules import (
    create_rule,
    delete_rule,
    feedback as record_feedback,
    list_rules,
    suggest as suggest_rule,
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
    date: dt.date
    account_id: str | None = None
    to_account_id: str | None = None
    category_id: str | None = None
    tag: Literal["one_time", "subscription"]
    note: str | None = None


class TransactionOut(BaseModel):
    id: str
    budget_id: str
    user_id: str
    date: dt.date
    type: Literal["income", "expense", "transfer"]
    amount: int
    account_id: str | None = None
    to_account_id: str | None = None
    category_id: str | None = None
    tag: Literal["one_time", "subscription"]
    note: str | None = None
    created_at: str


class DailyStateAccount(BaseModel):
    account_id: str
    name: str
    kind: Literal["cash", "bank"]
    amount: int = Field(ge=0)


class DailyStateAccountUpdate(BaseModel):
    account_id: str
    amount: StrictInt = Field(ge=0)


class DailyStateDebts(BaseModel):
    credit_cards: int = Field(ge=0, default=0)
    people_debts: int = Field(ge=0, default=0)


class DailyStateTotals(BaseModel):
    cash_total: int
    noncash_total: int
    assets_total: int
    debts_total: int
    balance_total: int


class DailyStateUpdate(BaseModel):
    budget_id: str
    date: dt.date
    accounts: list[DailyStateAccountUpdate]
    debts: DailyStateDebts | None = None


class DailyStateOut(BaseModel):
    accounts: list[DailyStateAccount]
    debts: DailyStateDebts
    totals: DailyStateTotals
    top_total: int


class DebtOtherCreateRequest(BaseModel):
    budget_id: str
    amount: int = Field(gt=0)
    direction: Literal["borrowed", "repaid"]
    asset_side: Literal["cash", "bank"]
    date: Optional[dt.date] = None


class DebtOtherOut(BaseModel):
    id: str
    budget_id: str
    user_id: str
    name: str
    amount: int
    note: str | None = None
    created_at: str


class RuleCreateRequest(BaseModel):
    budget_id: str
    pattern: str
    match_type: Literal["contains"] = "contains"
    account_id: str | None = None
    category_id: str | None = None
    tag: Literal["one_time", "subscription"] | None = None


class RuleOut(BaseModel):
    id: str
    budget_id: str
    user_id: str
    pattern: str
    match_type: Literal["contains"]
    account_id: str | None = None
    category_id: str | None = None
    tag: Literal["one_time", "subscription"] | None = None
    hits: int
    accepts: int
    confidence: float
    created_at: str


class SuggestRequest(BaseModel):
    budget_id: str
    note: str


class SuggestResponse(BaseModel):
    account_id: str | None = None
    category_id: str | None = None
    tag: Literal["one_time", "subscription"] | None = None
    confidence: float
    pattern: str | None = None


class FeedbackRequest(BaseModel):
    budget_id: str
    note: str
    accepted: bool
    account_id: str | None = None
    category_id: str | None = None
    tag: Literal["one_time", "subscription"] | None = None


def _utc_today() -> dt.date:
    return dt.datetime.now(dt.timezone.utc).date()


def _build_daily_state_response(
    user_id: str, budget_id: str, target_date: dt.date
) -> DailyStateOut:
    accounts = list_accounts(user_id, budget_id)
    balances_as_of = get_balances_as_of(user_id, budget_id, target_date)
    debts_record = get_debts_as_of(user_id, budget_id, target_date)
    accounts_with_amounts = [
        {
            "account_id": account["id"],
            "name": account.get("name"),
            "kind": account.get("kind"),
            "amount": balances_as_of.get(account["id"], 0),
        }
        for account in accounts
    ]
    totals = calculate_totals(accounts_with_amounts)
    debts_total = int(debts_record.get("debt_cards_total", 0)) + int(
        debts_record.get("debt_other_total", 0)
    )
    balance_total = totals["assets_total"] - debts_total
    balance_today, has_today = get_balance_for_date(
        user_id, budget_id, target_date
    )
    balance_prev, has_prev = get_balance_for_date(
        user_id, budget_id, target_date - dt.timedelta(days=1)
    )
    top_total = balance_today - balance_prev if has_today and has_prev else 0
    return DailyStateOut(
        accounts=accounts_with_amounts,
        debts=DailyStateDebts(
            credit_cards=int(debts_record.get("debt_cards_total", 0)),
            people_debts=int(debts_record.get("debt_other_total", 0)),
        ),
        totals=DailyStateTotals(
            cash_total=totals["cash_total"],
            noncash_total=totals["noncash_total"],
            assets_total=totals["assets_total"],
            debts_total=debts_total,
            balance_total=balance_total,
        ),
        top_total=top_total,
    )


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


@router.post("/budgets/{budget_id}/reset")
def post_budgets_reset(
    budget_id: str, current_user: dict = Depends(get_current_user)
) -> dict[str, str]:
    reset_budget_data(current_user["sub"], budget_id)
    return {"status": "ok"}


@router.get("/accounts")
def get_accounts(
    budget_id: str, current_user: dict = Depends(get_current_user)
) -> list[dict]:
    return list_accounts(current_user["sub"], budget_id)


@router.get("/accounts/exists")
def get_accounts_exists(
    budget_id: str, current_user: dict = Depends(get_current_user)
) -> dict[str, bool]:
    accounts = list_accounts(current_user["sub"], budget_id)
    return {"has_accounts": len(accounts) > 0}


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
    date: dt.date,
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
) -> DailyStateOut:
    target_date = payload.date or _utc_today()
    accounts_with_amounts = get_accounts_with_balances(
        current_user["sub"], payload.budget_id, target_date
    )
    target_account = next(
        (
            account
            for account in accounts_with_amounts
            if account.get("kind") == payload.asset_side
        ),
        None,
    )
    if not target_account:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Нет подходящего счета для операции",
        )
    current_amount = int(target_account.get("amount", 0))
    delta = payload.amount if payload.direction == "borrowed" else -payload.amount
    next_amount = current_amount + delta
    if next_amount < 0:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Недостаточно средств для операции",
        )

    debts_record = get_debts(current_user["sub"], payload.budget_id, target_date)
    debt_other_total = int(debts_record.get("debt_other_total", 0)) + (
        payload.amount if payload.direction == "borrowed" else -payload.amount
    )
    if debt_other_total < 0:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Нельзя уменьшить долг ниже 0",
        )

    upsert_debts(
        current_user["sub"],
        payload.budget_id,
        target_date,
        credit_cards=int(debts_record.get("debt_cards_total", 0)),
        people_debts=debt_other_total,
    )
    create_balance_event(
        current_user["sub"],
        payload.budget_id,
        target_date,
        target_account["account_id"],
        delta,
        RECONCILE_ADJUST_REASON,
    )
    return _build_daily_state_response(
        current_user["sub"], payload.budget_id, target_date
    )


@router.delete("/debts/other/{debt_id}")
def delete_debts_other(
    debt_id: str, current_user: dict = Depends(get_current_user)
) -> dict[str, str]:
    delete_debt_other(current_user["sub"], debt_id)
    return {"status": "deleted"}


@router.get("/daily-state")
def get_daily_state(
    budget_id: str,
    date: dt.date,
    current_user: dict = Depends(get_current_user),
) -> DailyStateOut:
    return _build_daily_state_response(current_user["sub"], budget_id, date)


@router.post("/daily-state")
def put_daily_state(
    payload: DailyStateUpdate, current_user: dict = Depends(get_current_user)
) -> DailyStateOut:
    user_id = current_user["sub"]
    logger.info(
        "daily_state_update request user_id=%s budget_id=%s date=%s",
        user_id,
        payload.budget_id,
        payload.date,
    )
    if not payload.accounts:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Список счетов не должен быть пустым",
        )
    account_ids = [item.account_id for item in payload.accounts]
    logger.info(
        "daily_state_update accounts_count=%s account_ids=%s",
        len(account_ids),
        account_ids,
    )
    allowed_accounts = list_accounts(user_id, payload.budget_id)
    allowed_account_ids = {account["id"] for account in allowed_accounts}
    invalid_accounts = [
        account_id
        for account_id in account_ids
        if account_id not in allowed_account_ids
    ]
    if invalid_accounts:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "Счет(а) не принадлежат пользователю или бюджету: "
                + ", ".join(invalid_accounts)
            ),
        )
    try:
        result = []
        for item in payload.accounts:
            result.append(
                upsert_manual_adjust_event(
                    user_id,
                    payload.budget_id,
                    payload.date,
                    item.account_id,
                    item.amount,
                )
            )
        logger.info(
            "daily_state_update balances_updated=%s",
            len(result),
        )
        if payload.debts is not None:
            upsert_debts(
                user_id,
                payload.budget_id,
                payload.date,
                credit_cards=payload.debts.credit_cards,
                people_debts=payload.debts.people_debts,
            )
        logger.info("daily_state_update success")
    except HTTPException as exc:
        logger.error(
            "daily_state_update error status=%s detail=%s",
            exc.status_code,
            exc.detail,
        )
        raise
    return _build_daily_state_response(user_id, payload.budget_id, payload.date)


@router.get("/daily-state/delta")
def get_daily_delta(
    budget_id: str,
    date: dt.date,
    current_user: dict = Depends(get_current_user),
) -> dict[str, int]:
    delta = get_delta(current_user["sub"], budget_id, date)
    return {"top_day_total": delta}


@router.get("/rules")
def get_rules(
    budget_id: str, current_user: dict = Depends(get_current_user)
) -> list[RuleOut]:
    return list_rules(current_user["sub"], budget_id)


@router.post("/rules")
def post_rules(
    payload: RuleCreateRequest, current_user: dict = Depends(get_current_user)
) -> RuleOut:
    return create_rule(current_user["sub"], payload.model_dump(mode="json"))


@router.delete("/rules/{rule_id}")
def delete_rules(
    rule_id: str, current_user: dict = Depends(get_current_user)
) -> dict[str, str]:
    delete_rule(current_user["sub"], rule_id)
    return {"status": "deleted"}


@router.post("/suggest")
def post_suggest(
    payload: SuggestRequest, current_user: dict = Depends(get_current_user)
) -> SuggestResponse:
    return suggest_rule(current_user["sub"], payload.budget_id, payload.note)


@router.post("/feedback")
def post_feedback(
    payload: FeedbackRequest, current_user: dict = Depends(get_current_user)
) -> RuleOut:
    return record_feedback(
        current_user["sub"],
        payload.budget_id,
        payload.note,
        payload.accepted,
        payload.account_id,
        payload.category_id,
        payload.tag,
    )
