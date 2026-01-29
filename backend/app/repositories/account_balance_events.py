from __future__ import annotations

from datetime import date
from typing import Any

from fastapi import HTTPException, status
from postgrest.exceptions import APIError

from app.integrations.supabase_client import get_supabase_client
from app.repositories.accounts import list_accounts


MANUAL_ADJUST_REASON = "manual_adjust"
TRANSFER_REASON = "transfer"
RECONCILE_ADJUST_REASON = "reconcile_adjust"
GOAL_TRANSFER_REASON = "goal_transfer"


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


def _is_missing_row_error(exc: APIError) -> bool:
    return getattr(exc, "code", None) == "PGRST116"


def _raise_postgrest_http_error(exc: APIError) -> None:
    detail = getattr(exc, "message", None) or str(exc)
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail=detail,
    ) from exc


def list_balance_events(
    user_id: str,
    budget_id: str,
    date_from: date | None = None,
    date_to: date | None = None,
) -> list[dict[str, Any]]:
    _ensure_budget_access(user_id, budget_id)
    client = get_supabase_client()
    query = (
        client.table("account_balance_events")
        .select("date, account_id, delta, reason")
        .eq("budget_id", budget_id)
        .eq("user_id", user_id)
    )
    if date_from is not None:
        query = query.gte("date", date_from.isoformat())
    if date_to is not None:
        query = query.lte("date", date_to.isoformat())
    response = query.order("date").execute()
    return response.data or []


def get_account_balance_as_of(
    user_id: str, budget_id: str, target_date: date, account_id: str
) -> int:
    _ensure_budget_access(user_id, budget_id)
    client = get_supabase_client()
    response = (
        client.table("account_balance_events")
        .select("delta")
        .eq("budget_id", budget_id)
        .eq("user_id", user_id)
        .eq("account_id", account_id)
        .lte("date", target_date.isoformat())
        .execute()
    )
    return sum(int(item.get("delta", 0)) for item in (response.data or []))


def get_balances_as_of(
    user_id: str, budget_id: str, target_date: date
) -> dict[str, int]:
    _ensure_budget_access(user_id, budget_id)
    accounts = list_accounts(user_id, budget_id)
    events = list_balance_events(user_id, budget_id, date_to=target_date)
    balances: dict[str, int] = {account["id"]: 0 for account in accounts}
    for event in events:
        account_id = event.get("account_id")
        if account_id in balances:
            balances[account_id] += int(event.get("delta", 0))
    return balances


def has_balance_events_as_of(
    user_id: str, budget_id: str, target_date: date
) -> bool:
    _ensure_budget_access(user_id, budget_id)
    client = get_supabase_client()
    response = (
        client.table("account_balance_events")
        .select("id")
        .eq("budget_id", budget_id)
        .eq("user_id", user_id)
        .lte("date", target_date.isoformat())
        .limit(1)
        .execute()
    )
    return bool(response.data)


def get_accounts_with_balances(
    user_id: str, budget_id: str, target_date: date
) -> list[dict[str, Any]]:
    accounts = list_accounts(user_id, budget_id)
    balances = get_balances_as_of(user_id, budget_id, target_date)
    return [
        {
            "account_id": account["id"],
            "name": account.get("name"),
            "kind": account.get("kind"),
            "amount": balances.get(account["id"], 0),
        }
        for account in accounts
    ]


def calculate_totals(
    accounts_with_amounts: list[dict[str, Any]],
) -> dict[str, int]:
    cash_total = 0
    noncash_total = 0
    for account in accounts_with_amounts:
        amount = int(account.get("amount", 0))
        if account.get("kind") == "cash":
            cash_total += amount
        else:
            noncash_total += amount
    return {
        "cash_total": cash_total,
        "noncash_total": noncash_total,
        "assets_total": cash_total + noncash_total,
    }


def get_manual_adjust_event(
    user_id: str, budget_id: str, target_date: date, account_id: str
) -> dict[str, Any] | None:
    _ensure_budget_access(user_id, budget_id)
    client = get_supabase_client()
    query = (
        client.table("account_balance_events")
        .select("id, delta")
        .eq("budget_id", budget_id)
        .eq("user_id", user_id)
        .eq("date", target_date.isoformat())
        .eq("account_id", account_id)
        .eq("reason", MANUAL_ADJUST_REASON)
    )
    if hasattr(query, "maybe_single"):
        query = query.maybe_single()
    else:
        query = query.single()
    try:
        response = query.execute()
    except APIError as exc:
        if _is_missing_row_error(exc):
            return None
        _raise_postgrest_http_error(exc)
    if response and response.data:
        return response.data
    return None


def upsert_manual_adjust_event(
    user_id: str,
    budget_id: str,
    target_date: date,
    account_id: str,
    desired_amount: int,
) -> dict[str, Any]:
    existing = get_manual_adjust_event(
        user_id, budget_id, target_date, account_id
    )
    current_balance = get_account_balance_as_of(
        user_id, budget_id, target_date, account_id
    )
    if existing is not None:
        current_balance -= int(existing.get("delta", 0))
    delta = int(desired_amount) - current_balance
    payload = {
        "budget_id": budget_id,
        "user_id": user_id,
        "date": target_date.isoformat(),
        "account_id": account_id,
        "delta": int(delta),
        "reason": MANUAL_ADJUST_REASON,
    }
    client = get_supabase_client()
    try:
        response = (
            client.table("account_balance_events")
            .upsert(
                payload,
                on_conflict="budget_id,user_id,date,account_id,reason",
            )
            .execute()
        )
    except APIError as exc:
        _raise_postgrest_http_error(exc)
    data = response.data or []
    if not data:
        raise RuntimeError("Failed to upsert manual adjust event")
    return data[0]


def create_balance_event(
    user_id: str,
    budget_id: str,
    target_date: date,
    account_id: str,
    delta: int,
    reason: str,
) -> dict[str, Any]:
    payload = {
        "budget_id": budget_id,
        "user_id": user_id,
        "date": target_date.isoformat(),
        "account_id": account_id,
        "delta": int(delta),
        "reason": reason,
    }
    client = get_supabase_client()
    try:
        response = (
            client.table("account_balance_events")
            .insert(payload)
            .execute()
        )
    except APIError as exc:
        _raise_postgrest_http_error(exc)
    data = response.data or []
    if not data:
        raise RuntimeError("Failed to insert balance event")
    return data[0]
