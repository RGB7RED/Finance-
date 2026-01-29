from __future__ import annotations

from datetime import date
from typing import Any

from fastapi import HTTPException, status

from app.integrations.supabase_client import get_supabase_client


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


def list_accounts(
    user_id: str, budget_id: str, as_of: date | None = None
) -> list[dict[str, Any]]:
    _ensure_budget_access(user_id, budget_id)
    client = get_supabase_client()
    query = (
        client.table("accounts")
        .select("id, budget_id, name, kind, currency, active_from, created_at")
        .eq("budget_id", budget_id)
    )
    if as_of is not None:
        query = query.lte("active_from", as_of.isoformat())
    response = query.order("created_at").execute()
    return response.data or []


def create_account(
    user_id: str,
    budget_id: str,
    name: str,
    kind: str,
    active_from: date,
    initial_amount: int,
) -> dict[str, Any]:
    _ensure_budget_access(user_id, budget_id)
    client = get_supabase_client()
    from app.repositories.transactions import create_transaction
    response = (
        client.table("accounts")
        .insert(
            {
                "budget_id": budget_id,
                "name": name,
                "kind": kind,
                "active_from": active_from.isoformat(),
            }
        )
        .execute()
    )
    data = response.data or []
    if data:
        account = data[0]
        if initial_amount > 0:
            create_transaction(
                user_id,
                {
                    "budget_id": budget_id,
                    "type": "income",
                    "kind": "normal",
                    "amount": initial_amount,
                    "date": active_from,
                    "account_id": account["id"],
                    "tag": "one_time",
                    "note": "Начальный остаток",
                },
            )
        return account

    fallback = (
        client.table("accounts")
        .select("id, budget_id, name, kind, currency, active_from, created_at")
        .eq("budget_id", budget_id)
        .eq("name", name)
        .eq("kind", kind)
        .order("created_at", desc=True)
        .limit(1)
        .execute()
    )
    fallback_data = fallback.data or []
    if not fallback_data:
        raise RuntimeError("Failed to create account in Supabase")
    account = fallback_data[0]
    if initial_amount > 0:
        create_transaction(
            user_id,
            {
                "budget_id": budget_id,
                "type": "income",
                "kind": "normal",
                "amount": initial_amount,
                "date": active_from,
                "account_id": account["id"],
                "tag": "one_time",
                "note": "Начальный остаток",
            },
        )
    return account
