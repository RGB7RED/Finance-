from __future__ import annotations

from datetime import date
from typing import Any

from fastapi import HTTPException, status
from postgrest.exceptions import APIError

from app.integrations.supabase_client import get_supabase_client
from app.repositories.accounts import list_accounts


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


def list_balances(
    user_id: str, budget_id: str, target_date: date
) -> list[dict[str, Any]]:
    _ensure_budget_access(user_id, budget_id)
    client = get_supabase_client()
    response = (
        client.table("daily_account_balances")
        .select("account_id, amount")
        .eq("budget_id", budget_id)
        .eq("user_id", user_id)
        .eq("date", target_date.isoformat())
        .execute()
    )
    return response.data or []


def upsert_balances(
    user_id: str,
    budget_id: str,
    target_date: date,
    balances: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    if not balances:
        return []
    _ensure_budget_access(user_id, budget_id)
    payload = [
        {
            "budget_id": budget_id,
            "user_id": user_id,
            "date": target_date.isoformat(),
            "account_id": item["account_id"],
            "amount": int(item.get("amount", 0)),
        }
        for item in balances
    ]
    client = get_supabase_client()
    try:
        response = (
            client.table("daily_account_balances")
            .upsert(payload, on_conflict="budget_id,user_id,date,account_id")
            .execute()
        )
    except APIError as exc:
        detail = getattr(exc, "message", None) or str(exc)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=detail,
        ) from exc
    return response.data or []


def get_accounts_with_balances(
    user_id: str, budget_id: str, target_date: date
) -> list[dict[str, Any]]:
    accounts = list_accounts(user_id, budget_id)
    balances = list_balances(user_id, budget_id, target_date)
    amount_map = {
        item.get("account_id"): int(item.get("amount", 0))
        for item in balances
        if item.get("account_id")
    }
    return [
        {
            "account_id": account["id"],
            "name": account.get("name"),
            "kind": account.get("kind"),
            "amount": amount_map.get(account["id"], 0),
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


def totals_for_date(
    user_id: str, budget_id: str, target_date: date
) -> tuple[dict[str, int], bool]:
    balances = list_balances(user_id, budget_id, target_date)
    accounts = get_accounts_with_balances(user_id, budget_id, target_date)
    totals = calculate_totals(accounts)
    has_data = bool(balances)
    return totals, has_data
