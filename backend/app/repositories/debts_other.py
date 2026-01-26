from __future__ import annotations

from typing import Any

from fastapi import HTTPException, status
from postgrest.exceptions import APIError

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


def list_debts_other(user_id: str, budget_id: str) -> list[dict[str, Any]]:
    _ensure_budget_access(user_id, budget_id)
    client = get_supabase_client()
    response = (
        client.table("debts_other")
        .select("id, budget_id, user_id, name, amount, note, created_at")
        .eq("budget_id", budget_id)
        .eq("user_id", user_id)
        .order("created_at")
        .execute()
    )
    return response.data or []


def sum_debts_other(user_id: str, budget_id: str) -> int:
    _ensure_budget_access(user_id, budget_id)
    client = get_supabase_client()
    response = (
        client.table("debts_other")
        .select("amount")
        .eq("budget_id", budget_id)
        .eq("user_id", user_id)
        .execute()
    )
    data = response.data or []
    return sum(int(item.get("amount", 0)) for item in data)


def create_debt_other(
    user_id: str,
    budget_id: str,
    name: str,
    amount: int,
    note: str | None,
) -> dict[str, Any]:
    _ensure_budget_access(user_id, budget_id)
    if amount < 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="amount must be >= 0",
        )
    client = get_supabase_client()
    try:
        response = (
            client.table("debts_other")
            .insert(
                {
                    "budget_id": budget_id,
                    "user_id": user_id,
                    "name": name,
                    "amount": amount,
                    "note": note,
                }
            )
            .execute()
        )
    except APIError as exc:
        detail = getattr(exc, "message", None) or str(exc)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=detail,
        ) from exc
    data = response.data or []
    if data:
        return data[0]
    raise RuntimeError("Failed to create debt in Supabase")


def delete_debt_other(user_id: str, debt_id: str) -> dict[str, Any]:
    client = get_supabase_client()
    existing = (
        client.table("debts_other")
        .select("id, user_id, budget_id")
        .eq("id", debt_id)
        .execute()
    )
    data = existing.data or []
    if not data:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    record = data[0]
    if record["user_id"] != user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Debt does not belong to user",
        )
    _ensure_budget_access(user_id, record["budget_id"])
    client.table("debts_other").delete().eq("id", debt_id).execute()
    return record
