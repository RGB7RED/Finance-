from __future__ import annotations

from datetime import date, timedelta
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


def _calculate_totals(payload: dict[str, Any]) -> dict[str, int]:
    cash_total = int(payload.get("cash_total", 0))
    bank_total = int(payload.get("bank_total", 0))
    debt_cards_total = int(payload.get("debt_cards_total", 0))
    debt_other_total = int(payload.get("debt_other_total", 0))
    assets_total = cash_total + bank_total
    debts_total = debt_cards_total + debt_other_total
    balance = assets_total - debts_total
    return {
        "cash_total": cash_total,
        "bank_total": bank_total,
        "debt_cards_total": debt_cards_total,
        "debt_other_total": debt_other_total,
        "assets_total": assets_total,
        "debts_total": debts_total,
        "balance": balance,
    }


def _is_missing_row_error(exc: APIError) -> bool:
    return getattr(exc, "code", None) == "PGRST116"


def _raise_postgrest_http_error(exc: APIError) -> None:
    detail = getattr(exc, "message", None) or str(exc)
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail=detail,
    ) from exc


def get_or_create(
    user_id: str, budget_id: str, target_date: date
) -> dict[str, Any]:
    _ensure_budget_access(user_id, budget_id)
    client = get_supabase_client()
    query = (
        client.table("daily_state")
        .select(
            "id, budget_id, user_id, date, cash_total, bank_total, "
            "debt_cards_total, debt_other_total"
        )
        .eq("budget_id", budget_id)
        .eq("date", target_date.isoformat())
    )
    if hasattr(query, "maybe_single"):
        query = query.maybe_single()
    else:
        query = query.single()
    try:
        response = query.execute()
    except APIError as exc:
        if _is_missing_row_error(exc):
            response = None
        else:
            _raise_postgrest_http_error(exc)
    if response and response.data:
        return {**response.data, **_calculate_totals(response.data)}

    insert_payload = {
        "budget_id": budget_id,
        "user_id": user_id,
        "date": target_date.isoformat(),
        "cash_total": 0,
        "bank_total": 0,
        "debt_cards_total": 0,
        "debt_other_total": 0,
    }
    try:
        inserted = (
            client.table("daily_state")
            .upsert(insert_payload, on_conflict="budget_id,date")
            .execute()
        )
    except APIError as exc:
        _raise_postgrest_http_error(exc)
    data = inserted.data or []
    if data:
        record = data[0]
        return {**record, **_calculate_totals(record)}
    try:
        existing = query.execute()
    except APIError as exc:
        if _is_missing_row_error(exc):
            raise RuntimeError("Failed to create daily state") from exc
        _raise_postgrest_http_error(exc)
    if not existing.data:
        raise RuntimeError("Failed to create daily state")
    record = existing.data
    return {**record, **_calculate_totals(record)}


def upsert(
    user_id: str,
    budget_id: str,
    target_date: date,
    fields: dict[str, int],
) -> dict[str, Any]:
    _ensure_budget_access(user_id, budget_id)
    payload = {
        "budget_id": budget_id,
        "user_id": user_id,
        "date": target_date.isoformat(),
        **fields,
    }
    client = get_supabase_client()
    try:
        response = (
            client.table("daily_state")
            .upsert(payload, on_conflict="budget_id,date")
            .execute()
        )
    except APIError as exc:
        _raise_postgrest_http_error(exc)
    data = response.data or []
    if not data:
        raise RuntimeError("Failed to update daily state")
    record = data[0]
    return {**record, **_calculate_totals(record)}


def get_balance(user_id: str, budget_id: str, target_date: date) -> int:
    record = get_or_create(user_id, budget_id, target_date)
    return int(record["balance"])


def get_delta(user_id: str, budget_id: str, target_date: date) -> int:
    current_balance = get_balance(user_id, budget_id, target_date)
    previous_date = target_date - timedelta(days=1)
    previous_balance = get_balance(user_id, budget_id, previous_date)
    return current_balance - previous_balance
