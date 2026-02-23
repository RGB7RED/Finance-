from __future__ import annotations

import json
from datetime import date
from typing import Any

from fastapi import HTTPException, status
from fastapi.encoders import jsonable_encoder
from postgrest.exceptions import APIError

from app.integrations.supabase_client import get_supabase_client
from app.repositories.account_balance_events import (
    GOAL_TRANSFER_REASON,
    TRANSFER_REASON,
    TRANSACTION_REASON,
    create_balance_event,
)
from app.repositories.daily_state import get_debts_as_of, upsert_debts


def _ensure_budget_access(user_id: str, budget_id: str) -> None:
    client = get_supabase_client()
    response = (
        client.table("budgets")
        .select("id")
        .eq("id", budget_id)
        .eq("user_id", user_id)
        .execute()
    )
    if not response.data:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Budget not found for user",
        )


def _ensure_account_in_budget(budget_id: str, account_id: str, label: str) -> None:
    client = get_supabase_client()
    response = (
        client.table("accounts")
        .select("id")
        .eq("id", account_id)
        .eq("budget_id", budget_id)
        .execute()
    )
    if not response.data:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"{label} not found for budget",
        )


def _get_category_by_id(category_id: str) -> dict[str, Any] | None:
    client = get_supabase_client()
    response = (
        client.table("categories")
        .select("id, budget_id, type")
        .eq("id", category_id)
        .limit(1)
        .execute()
    )
    data = response.data or []
    if not data:
        return None
    return data[0]


def _ensure_category_matches_transaction(
    budget_id: str, category_id: str | None, tx_type: str
) -> None:
    if not category_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Category is required",
        )

    category = _get_category_by_id(category_id)
    if not category:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Category not found",
        )

    if category.get("budget_id") != budget_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Category not found for budget",
        )

    expected_type = "expense" if tx_type == "fee" else tx_type
    if category.get("type") != expected_type:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Category type must match transaction type",
        )


def list_transactions(
    user_id: str, budget_id: str, date: str
) -> list[dict[str, Any]]:
    _ensure_budget_access(user_id, budget_id)
    client = get_supabase_client()
    response = (
        client.table("transactions")
        .select(
            "id, budget_id, user_id, date, type, kind, amount, account_id, "
            "to_account_id, category_id, goal_id, tag, note, created_at"
        )
        .eq("budget_id", budget_id)
        .eq("date", date)
        .order("created_at")
        .execute()
    )
    return response.data or []


def _resolve_debt_creditor(note: str | None) -> str:
    metadata = _parse_debt_metadata(note)
    if metadata and isinstance(metadata.get("note"), str):
        creditor = metadata["note"].strip()
        if creditor:
            return creditor
    if metadata and isinstance(metadata.get("creditor"), str):
        creditor = metadata["creditor"].strip()
        if creditor:
            return creditor
    if note and note.strip():
        return note.strip()
    return "—"


def list_active_debts_as_of(
    user_id: str, budget_id: str, target_date: date
) -> list[dict[str, Any]]:
    _ensure_budget_access(user_id, budget_id)
    client = get_supabase_client()
    response = (
        client.table("transactions")
        .select("id, date, type, amount, note, created_at")
        .eq("budget_id", budget_id)
        .eq("user_id", user_id)
        .eq("kind", "debt")
        .lte("date", target_date.isoformat())
        .order("date")
        .order("created_at")
        .execute()
    )

    states: dict[str, dict[str, Any]] = {}
    for tx in response.data or []:
        creditor = _resolve_debt_creditor(tx.get("note"))
        state = states.setdefault(
            creditor,
            {
                "creditor": creditor,
                "amount": 0,
                "debt_date": None,
                "closed_at": None,
            },
        )
        delta = int(tx.get("amount", 0))
        if tx.get("type") == "expense":
            delta = -delta

        previous = int(state["amount"])
        next_amount = previous + delta

        tx_date = tx.get("date")
        if previous <= 0 and next_amount > 0:
            state["debt_date"] = tx_date
            state["closed_at"] = None
        if previous > 0 and next_amount <= 0:
            state["closed_at"] = tx_date

        state["amount"] = max(next_amount, 0)

    active_debts = []
    for state in states.values():
        debt_date = state.get("debt_date")
        if not debt_date:
            continue
        closed_at = state.get("closed_at")
        if debt_date <= target_date.isoformat() and (
            closed_at is None or closed_at > target_date.isoformat()
        ):
            creditor_name = state["creditor"]
            active_debts.append(
                {
                    "creditor": creditor_name,
                    "creditor_name": creditor_name,
                    "amount": int(state["amount"]),
                    "debt_date": debt_date,
                    "closed_at": closed_at,
                }
            )

    active_debts.sort(key=lambda item: (item["debt_date"], item["creditor"]))
    return active_debts


def _serialize_payload(payload: dict[str, Any]) -> dict[str, Any]:
    return jsonable_encoder(payload)


def _parse_payload_date(value: Any) -> date:
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        return date.fromisoformat(value)
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail="Invalid date for transaction",
    )


def _parse_debt_metadata(note: str | None) -> dict[str, Any] | None:
    if not note:
        return None
    try:
        data = json.loads(note)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    debt_type = data.get("debt_type")
    direction = data.get("direction")
    if debt_type not in ("people", "cards"):
        return None
    if direction not in ("borrowed", "repaid"):
        return None
    creditor = data.get("creditor")
    note_value = data.get("note")
    return {
        "debt_type": debt_type,
        "direction": direction,
        "note": note_value if isinstance(note_value, str) else None,
        "creditor": creditor if isinstance(creditor, str) else None,
    }


def create_transaction(user_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    budget_id = payload.get("budget_id")
    if not budget_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="budget_id is required",
        )

    _ensure_budget_access(user_id, budget_id)

    tx_type = payload.get("type")
    kind = payload.get("kind")
    account_id = payload.get("account_id")
    to_account_id = payload.get("to_account_id")
    category_id = payload.get("category_id")
    goal_id = payload.get("goal_id")

    if kind is None:
        kind = "transfer" if tx_type == "transfer" else "normal"
        payload["kind"] = kind

    if kind not in ("normal", "transfer", "goal_transfer", "debt"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid transaction kind",
        )

    if tx_type == "transfer" and kind != "transfer":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Transfers must have kind=transfer",
        )
    if tx_type in ("income", "expense", "fee") and kind == "transfer":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Income/expense cannot have kind=transfer",
        )

    if tx_type == "transfer":
        if not account_id or not to_account_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="account_id and to_account_id are required for transfers",
            )
        if account_id == to_account_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Transfer accounts must be different",
            )
        _ensure_account_in_budget(budget_id, account_id, "account")
        _ensure_account_in_budget(budget_id, to_account_id, "to_account")
        if category_id is not None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Transfers cannot have a category",
            )
    elif tx_type in ("income", "expense", "fee"):
        if not account_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="account_id is required for income/expense/fee",
            )
        if to_account_id is not None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="to_account_id must be null for income/expense/fee",
            )
        _ensure_account_in_budget(budget_id, account_id, "account")
        if tx_type in ("income", "expense", "fee"):
            _ensure_category_matches_transaction(
                budget_id, category_id, tx_type
            )
    else:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid transaction type",
        )

    if kind == "goal_transfer":
        if not goal_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="goal_id is required for goal transfers",
            )
        if category_id is not None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Goal transfers cannot have a category",
            )
    if kind == "debt" and goal_id is not None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Debt operations cannot have a goal",
        )

    serialized_payload = _serialize_payload(payload)
    if kind == "goal_transfer":
        client = get_supabase_client()
        try:
            response = (
                client.table("transactions")
                .insert({**serialized_payload, "user_id": user_id})
                .execute()
            )
        except APIError as exc:
            detail = getattr(exc, "message", None) or str(exc)
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=detail,
            ) from exc
        data = response.data or []
        if not data:
            raise RuntimeError("Failed to create transaction in Supabase")
        transaction = data[0]
        target_date = _parse_payload_date(payload.get("date"))
        amount = int(payload.get("amount", 0))
        delta = amount if tx_type == "income" else -amount
        try:
            create_balance_event(
                user_id,
                budget_id,
                target_date,
                account_id,
                delta,
                GOAL_TRANSFER_REASON,
                transaction_id=transaction.get("id"),
            )
        except HTTPException:
            try:
                client.table("transactions").delete().eq(
                    "id", transaction.get("id")
                ).execute()
            except Exception:
                pass
            raise
        return transaction

    if tx_type == "transfer":
        client = get_supabase_client()
        try:
            response = (
                client.table("transactions")
                .insert({**serialized_payload, "user_id": user_id})
                .execute()
            )
        except APIError as exc:
            detail = getattr(exc, "message", None) or str(exc)
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=detail,
            ) from exc
        data = response.data or []
        if not data:
            raise RuntimeError("Failed to create transaction in Supabase")
        transaction = data[0]
        target_date = _parse_payload_date(payload.get("date"))
        amount = int(payload.get("amount", 0))
        try:
            create_balance_event(
                user_id,
                budget_id,
                target_date,
                account_id,
                -amount,
                TRANSFER_REASON,
                transaction_id=transaction.get("id"),
            )
            create_balance_event(
                user_id,
                budget_id,
                target_date,
                to_account_id,
                amount,
                TRANSFER_REASON,
                transaction_id=transaction.get("id"),
            )
        except HTTPException:
            try:
                client.table("account_balance_events").delete().eq(
                    "transaction_id", transaction.get("id")
                ).execute()
                client.table("transactions").delete().eq(
                    "id", transaction.get("id")
                ).execute()
            except Exception:
                pass
            raise
        return transaction

    client = get_supabase_client()
    try:
        response = (
            client.table("transactions")
            .insert({**serialized_payload, "user_id": user_id})
            .execute()
        )
    except APIError as exc:
        detail = getattr(exc, "message", None) or str(exc)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=detail,
        ) from exc
    data = response.data or []
    if not data:
        raise RuntimeError("Failed to create transaction in Supabase")
    transaction = data[0]
    if tx_type in ("income", "expense", "fee"):
        target_date = _parse_payload_date(payload.get("date"))
        amount = int(payload.get("amount", 0))
        delta = amount if tx_type == "income" else -amount
        try:
            create_balance_event(
                user_id,
                budget_id,
                target_date,
                account_id,
                delta,
                TRANSACTION_REASON,
                transaction_id=transaction.get("id"),
            )
        except HTTPException:
            try:
                client.table("transactions").delete().eq(
                    "id", transaction.get("id")
                ).execute()
            except Exception:
                pass
            raise
    return transaction


def delete_transaction(user_id: str, tx_id: str) -> None:
    client = get_supabase_client()
    existing = (
        client.table("transactions")
        .select("id, user_id, budget_id, date, type, kind, amount, note")
        .eq("id", tx_id)
        .execute()
    )
    data = existing.data or []
    if not data:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    record = data[0]
    if record["user_id"] != user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Transaction does not belong to user",
        )
    if record.get("kind") == "debt":
        metadata = _parse_debt_metadata(record.get("note"))
        if metadata:
            target_date = _parse_payload_date(record.get("date"))
            amount = int(record.get("amount", 0))
            debt_delta = (
                amount
                if metadata["direction"] == "borrowed"
                else -amount
            )
            debts_record = get_debts_as_of(
                user_id, record.get("budget_id"), target_date
            )
            debt_cards_total = int(debts_record.get("debt_cards_total", 0))
            debt_other_total = int(debts_record.get("debt_other_total", 0))
            if metadata["debt_type"] == "cards":
                debt_cards_total -= debt_delta
            else:
                debt_other_total -= debt_delta
            upsert_debts(
                user_id,
                record.get("budget_id"),
                target_date,
                credit_cards=debt_cards_total,
                people_debts=debt_other_total,
            )

    client.table("transactions").delete().eq("id", tx_id).execute()
