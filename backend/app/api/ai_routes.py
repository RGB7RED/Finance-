from __future__ import annotations

import datetime as dt
import json
import logging
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status

from app.auth.jwt import get_current_user
from app.core.config import settings
from app.integrations.llm_client import LLMError, generate_statement_draft
from app.repositories.account_balance_events import (
    RECONCILE_ADJUST_REASON,
    create_balance_event,
    get_accounts_with_balances,
)
from app.repositories.accounts import list_accounts
from app.repositories.categories import list_categories
from app.repositories.daily_state import get_debts_as_of, upsert_debts
from app.repositories.rules import list_rules
from app.repositories.statement_drafts import (
    create_statement_draft,
    get_statement_draft,
    update_statement_draft,
)
from app.repositories.transactions import create_transaction

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/ai")


def _ensure_csv(file: UploadFile) -> None:
    content_type = (file.content_type or "").lower()
    filename = (file.filename or "").lower()
    is_csv = "csv" in content_type or filename.endswith(".csv")
    is_text = content_type.startswith("text/")
    if not (is_csv or is_text):
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="Поддерживаются только CSV/текстовые выписки. "
            "Сохраните файл в CSV и попробуйте снова.",
        )


def _decode_statement(raw_bytes: bytes) -> str:
    return raw_bytes.decode("utf-8", errors="replace")


def _account_name_map(accounts: list[dict[str, Any]]) -> dict[str, str]:
    return {account["name"].lower(): account["id"] for account in accounts}


def _category_name_map(categories: list[dict[str, Any]]) -> dict[str, str]:
    return {category["name"].lower(): category["id"] for category in categories}


def _build_context(
    user_id: str,
    budget_id: str,
    as_of: dt.date,
) -> dict[str, Any]:
    accounts = get_accounts_with_balances(user_id, budget_id, as_of)
    categories = list_categories(user_id, budget_id)
    debts = get_debts_as_of(user_id, budget_id, as_of)
    rules = list_rules(user_id, budget_id)
    return {
        "as_of": as_of.isoformat(),
        "accounts": accounts,
        "categories": categories,
        "debts": debts,
        "rules": rules,
    }


def _normalize_transactions(
    draft_payload: dict[str, Any],
    accounts: list[dict[str, Any]],
    categories: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[str]]:
    warnings: list[str] = []
    account_map = _account_name_map(accounts)
    category_map = _category_name_map(categories)
    normalized: list[dict[str, Any]] = []
    for item in draft_payload.get("transactions") or []:
        account_name = (item.get("account_name") or "").strip().lower()
        to_account_name = (item.get("to_account_name") or "").strip().lower()
        category_name = (item.get("category_name") or "").strip().lower()
        account_id = account_map.get(account_name) if account_name else None
        to_account_id = account_map.get(to_account_name) if to_account_name else None
        category_id = category_map.get(category_name) if category_name else None
        if account_name and not account_id:
            warnings.append(f"Счет не найден: {item.get('account_name')}")
        if to_account_name and not to_account_id:
            warnings.append(
                f"Счет назначения не найден: {item.get('to_account_name')}"
            )
        if category_name and not category_id:
            warnings.append(
                f"Категория не найдена: {item.get('category_name')}"
            )
        normalized.append(
            {
                "date": item.get("date"),
                "type": item.get("type"),
                "kind": item.get("kind"),
                "amount": item.get("amount"),
                "account_id": account_id,
                "to_account_id": to_account_id,
                "category_id": category_id,
                "tag": item.get("tag"),
                "note": item.get("note"),
                "debt": item.get("debt"),
                "account_name": item.get("account_name"),
                "to_account_name": item.get("to_account_name"),
                "category_name": item.get("category_name"),
            }
        )
    return normalized, warnings


@router.post("/statement-drafts")
async def post_statement_draft(
    budget_id: str = Form(...),
    file: UploadFile | None = File(None),
    statement_text: str | None = Form(None),
    source: str | None = Form(None),
    statement_date: dt.date | None = Form(None),
    current_user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    if statement_text is not None:
        statement_text = statement_text.strip()
    if statement_text:
        source_filename = None
        source_mime = source or "text/plain"
        source_value = source
        statement_text_value = statement_text
    else:
        if not file:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Statement file or text is required",
            )
        _ensure_csv(file)
        raw = await file.read()
        source_filename = file.filename
        source_mime = file.content_type
        source_value = None
        statement_text_value = _decode_statement(raw)
    as_of = statement_date or dt.date.today()
    context = _build_context(current_user["sub"], budget_id, as_of)
    if source_value:
        context["source"] = source_value
    try:
        draft_payload = generate_statement_draft(statement_text_value, context)
    except LLMError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)
        ) from exc
    accounts = list_accounts(current_user["sub"], budget_id, as_of)
    categories = list_categories(current_user["sub"], budget_id)
    draft_payload["context"] = context
    normalized_transactions, warnings = _normalize_transactions(
        draft_payload, accounts, categories
    )
    draft_payload["normalized_transactions"] = normalized_transactions
    if source_value:
        draft_payload["source"] = source_value
    if warnings:
        draft_payload["warnings"] = warnings
    draft = create_statement_draft(
        current_user["sub"],
        budget_id,
        source_filename,
        source_mime,
        statement_text_value,
        settings.LLM_MODEL,
        draft_payload,
    )
    return {"draft": draft, "payload": draft_payload}


@router.post("/statement-drafts/{draft_id}/revise")
def revise_statement_draft(
    draft_id: str,
    feedback: str = Form(...),
    current_user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    draft = get_statement_draft(current_user["sub"], draft_id)
    context = _build_context(
        current_user["sub"], draft["budget_id"], dt.date.today()
    )
    base_payload = {
        "statement_text": draft.get("source_text"),
        "previous_draft": draft.get("draft_payload"),
        "feedback": feedback,
    }
    try:
        revised_payload = generate_statement_draft(
            json.dumps(base_payload, ensure_ascii=False),
            {"context": context},
        )
    except LLMError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)
        ) from exc
    revised_payload["context"] = context
    accounts = list_accounts(current_user["sub"], draft["budget_id"])
    categories = list_categories(current_user["sub"], draft["budget_id"])
    normalized_transactions, warnings = _normalize_transactions(
        revised_payload, accounts, categories
    )
    revised_payload["normalized_transactions"] = normalized_transactions
    if warnings:
        revised_payload["warnings"] = warnings
    updated = update_statement_draft(
        current_user["sub"],
        draft_id,
        {
            "draft_payload": revised_payload,
            "feedback": feedback,
            "status": "revised",
            "updated_at": dt.datetime.utcnow().isoformat(),
        },
    )
    return {"draft": updated, "payload": revised_payload}


@router.post("/statement-drafts/{draft_id}/apply")
def apply_statement_draft(
    draft_id: str,
    confirm: bool = Form(...),
    current_user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    if not confirm:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Confirmation required",
        )
    draft = get_statement_draft(current_user["sub"], draft_id)
    payload = draft.get("draft_payload") or {}
    transactions = payload.get("normalized_transactions") or []
    errors: list[str] = []
    created: list[dict[str, Any]] = []
    for item in transactions:
        if not item.get("account_id"):
            errors.append(
                f"Не найден счет для транзакции: {item.get('account_name')}"
            )
            continue
        if item.get("type") == "transfer" and not item.get("to_account_id"):
            errors.append(
                "Не найден счет назначения для перевода: "
                f"{item.get('to_account_name')}"
            )
            continue
        tx_payload = {
            "budget_id": draft["budget_id"],
            "type": item.get("type"),
            "kind": item.get("kind") or "normal",
            "amount": item.get("amount"),
            "date": item.get("date"),
            "account_id": item.get("account_id"),
            "to_account_id": item.get("to_account_id"),
            "category_id": item.get("category_id"),
            "tag": item.get("tag") or "one_time",
            "note": item.get("note"),
        }
        debt = item.get("debt")
        if debt:
            tx_payload["kind"] = "debt"
            tx_payload["note"] = json.dumps(debt, ensure_ascii=False)
        created.append(create_transaction(current_user["sub"], tx_payload))
    for adjust in payload.get("balance_adjustments") or []:
        account_name = (adjust.get("account_name") or "").strip().lower()
        account_map = _account_name_map(
            list_accounts(current_user["sub"], draft["budget_id"])
        )
        account_id = account_map.get(account_name)
        if not account_id:
            errors.append(f"Не найден счет для корректировки: {account_name}")
            continue
        create_balance_event(
            current_user["sub"],
            draft["budget_id"],
            dt.date.fromisoformat(adjust.get("date")),
            account_id,
            int(adjust.get("delta", 0)),
            RECONCILE_ADJUST_REASON,
        )
    debts = payload.get("debts")
    if debts:
        target_date = dt.date.fromisoformat(debts.get("date"))
        upsert_debts(
            current_user["sub"],
            draft["budget_id"],
            target_date,
            credit_cards=int(debts.get("credit_cards_total", 0)),
            people_debts=int(debts.get("people_debts_total", 0)),
        )
    updated = update_statement_draft(
        current_user["sub"],
        draft_id,
        {"status": "applied", "updated_at": dt.datetime.utcnow().isoformat()},
    )
    return {
        "draft": updated,
        "created_transactions": created,
        "errors": errors,
    }
