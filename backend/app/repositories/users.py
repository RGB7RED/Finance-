from __future__ import annotations

import logging
from typing import Any

from app.integrations.supabase_client import get_supabase_client

logger = logging.getLogger(__name__)


def upsert_user(
    telegram_id: int,
    username: str | None,
    first_name: str | None,
    last_name: str | None,
) -> str:
    client = get_supabase_client()
    payload = {
        "telegram_id": telegram_id,
        "username": username,
        "first_name": first_name,
        "last_name": last_name,
    }
    response = client.table("users").upsert(
        payload, on_conflict="telegram_id"
    ).execute()

    data = response.data or []
    if data:
        return str(data[0]["id"])

    logger.warning(
        "Supabase upsert for users returned no data; falling back to select."
    )
    fallback = (
        client.table("users")
        .select("id")
        .eq("telegram_id", telegram_id)
        .single()
        .execute()
    )
    if not fallback.data:
        raise RuntimeError("Failed to upsert user in Supabase")

    return str(fallback.data["id"])


def ensure_user(user_id: str, email: str | None) -> None:
    client = get_supabase_client()
    username = None
    if email and "@" in email:
        username = email.split("@", 1)[0]

    payload = {"id": user_id, "username": username}
    response = (
        client.table("users")
        .upsert(payload, on_conflict="id")
        .select("id")
        .execute()
    )

    if not response.data:
        raise RuntimeError("Failed to upsert user in Supabase")


def get_user_by_id(user_id: str) -> dict[str, Any]:
    client = get_supabase_client()
    response = (
        client.table("users")
        .select("id, telegram_id, username, first_name")
        .eq("id", user_id)
        .single()
        .execute()
    )

    if not response.data:
        raise RuntimeError("User not found in Supabase")

    return response.data
