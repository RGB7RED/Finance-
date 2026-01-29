from __future__ import annotations

from datetime import date
from typing import Any

from fastapi import HTTPException, status
from fastapi.encoders import jsonable_encoder
from postgrest.exceptions import APIError

from app.integrations.supabase_client import get_supabase_client
from app.repositories.account_balance_events import (
    GOAL_TRANSFER_REASON,
    TRANSFER_REASON,
    create_balance_event,
)


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


def _ensure_category_in_budget(budget_id: str, category_id: str) -> None:
    client = get_supabase_client()
    response = (
        client.table("categories")
        .select("id")
        .eq("id", category_id)
        .eq("budget_id", budget_id)
        .execute()
    )
    if not response.data:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Category not found for budget",
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

    if kind not in ("normal", "transfer", "goal_transfer"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid transaction kind",
        )

    if tx_type == "transfer" and kind != "transfer":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Transfers must have kind=transfer",
        )
    if tx_type in ("income", "expense") and kind == "transfer":
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
    elif tx_type in ("income", "expense"):
        if not account_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="account_id is required for income/expense",
            )
        if to_account_id is not None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="to_account_id must be null for income/expense",
            )
        _ensure_account_in_budget(budget_id, account_id, "account")
        if tx_type == "income" and category_id is not None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Income cannot have a category",
            )
        if tx_type == "expense" and category_id is not None:
            _ensure_category_in_budget(budget_id, category_id)
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

    serialized_payload = _serialize_payload(payload)
    rollback_event_ids: list[str] | None = None

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
        target_date = _parse_payload_date(payload.get("date"))
        amount = int(payload.get("amount", 0))
        from_event = create_balance_event(
            user_id,
            budget_id,
            target_date,
            account_id,
            -amount,
            TRANSFER_REASON,
        )
        to_event = create_balance_event(
            user_id,
            budget_id,
            target_date,
            to_account_id,
            amount,
            TRANSFER_REASON,
        )
        rollback_event_ids = [
            event_id
            for event_id in (from_event.get("id"), to_event.get("id"))
            if event_id
        ]

    client = get_supabase_client()
    try:
        response = (
            client.table("transactions")
            .insert({**serialized_payload, "user_id": user_id})
            .execute()
        )
    except APIError as exc:
        if rollback_event_ids is not None:
            try:
                client.table("account_balance_events").delete().in_(
                    "id", rollback_event_ids
                ).execute()
            except Exception:
                pass
        detail = getattr(exc, "message", None) or str(exc)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=detail,
        ) from exc
    data = response.data or []
    if data:
        return data[0]
    raise RuntimeError("Failed to create transaction in Supabase")


def delete_transaction(user_id: str, tx_id: str) -> None:
    client = get_supabase_client()
    existing = (
        client.table("transactions")
        .select("id, user_id")
        .eq("id", tx_id)
        .execute()
    )
    data = existing.data or []
    if not data:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    if data[0]["user_id"] != user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Transaction does not belong to user",
        )

    client.table("transactions").delete().eq("id", tx_id).execute()
