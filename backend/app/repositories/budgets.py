from __future__ import annotations

from typing import Any

from app.integrations.supabase_client import get_supabase_client


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
