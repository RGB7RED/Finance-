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


def list_budgets(user_id: str) -> list[dict[str, Any]]:
    client = get_supabase_client()
    response = (
        client.table("budgets")
        .select("id, user_id, type, name, created_at")
        .eq("user_id", user_id)
        .order("created_at")
        .execute()
    )
    return response.data or []


def ensure_default_budgets(user_id: str) -> list[dict[str, Any]]:
    client = get_supabase_client()
    response = (
        client.table("budgets")
        .select("id, type")
        .eq("user_id", user_id)
        .execute()
    )
    existing = {row["type"] for row in (response.data or [])}
    payload: list[dict[str, str]] = []
    if "personal" not in existing:
        payload.append({"user_id": user_id, "type": "personal", "name": "Личный"})
    if "business" not in existing:
        payload.append({"user_id": user_id, "type": "business", "name": "Бизнес"})

    if payload:
        client.table("budgets").insert(payload).execute()

    return list_budgets(user_id)


def reset_budget_data(user_id: str, budget_id: str) -> None:
    _ensure_budget_access(user_id, budget_id)
    client = get_supabase_client()
    tables = [
        "transactions",
        "goals",
        "debts_other",
        "daily_state",
        "accounts",
        "categories",
    ]
    for table in tables:
        client.table(table).delete().eq("budget_id", budget_id).execute()


def reset_all_user_data(user_id: str) -> None:
    client = get_supabase_client()
    client.rpc("reset_all_user_data", {"p_user_id": user_id}).execute()
