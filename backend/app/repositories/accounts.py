from __future__ import annotations

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


def list_accounts(user_id: str, budget_id: str) -> list[dict[str, Any]]:
    _ensure_budget_access(user_id, budget_id)
    client = get_supabase_client()
    response = (
        client.table("accounts")
        .select("id, budget_id, name, kind, currency, created_at")
        .eq("budget_id", budget_id)
        .order("created_at")
        .execute()
    )
    return response.data or []


def create_account(
    user_id: str, budget_id: str, name: str, kind: str
) -> dict[str, Any]:
    _ensure_budget_access(user_id, budget_id)
    client = get_supabase_client()
    response = (
        client.table("accounts")
        .insert(
            {
                "budget_id": budget_id,
                "name": name,
                "kind": kind,
            }
        )
        .select("id, budget_id, name, kind, currency, created_at")
        .single()
        .execute()
    )
    if not response.data:
        raise RuntimeError("Failed to create account in Supabase")
    return response.data
