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


def get_state(
    user_id: str, budget_id: str, target_date: date
) -> dict[str, Any] | None:
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
            return None
        else:
            _raise_postgrest_http_error(exc)
    if response and response.data:
        return response.data
    return None


def get_state_or_default(
    user_id: str, budget_id: str, target_date: date
) -> dict[str, Any]:
    record = get_state(user_id, budget_id, target_date)
    if record is None:
        record = {
            "budget_id": budget_id,
            "user_id": user_id,
            "date": target_date.isoformat(),
            "cash_total": 0,
            "bank_total": 0,
            "debt_cards_total": 0,
            "debt_other_total": 0,
        }
    return {**record, **_calculate_totals(record)}


def _totals_from_record(record: dict[str, Any]) -> dict[str, int]:
    return {
        "cash_total": int(record.get("cash_total", 0)),
        "bank_total": int(record.get("bank_total", 0)),
        "debt_cards_total": int(record.get("debt_cards_total", 0)),
        "debt_other_total": int(record.get("debt_other_total", 0)),
    }


def get_state_as_of(
    user_id: str, budget_id: str, target_date: date
) -> dict[str, Any]:
    record = get_state(user_id, budget_id, target_date)
    if record is not None:
        return {
            **record,
            **_calculate_totals(record),
            "as_of_date": target_date.isoformat(),
            "is_carried": False,
        }
    _ensure_budget_access(user_id, budget_id)
    client = get_supabase_client()
    response = (
        client.table("daily_state")
        .select(
            "budget_id, user_id, date, cash_total, bank_total, "
            "debt_cards_total, debt_other_total"
        )
        .eq("budget_id", budget_id)
        .lt("date", target_date.isoformat())
        .order("date", desc=True)
        .limit(1)
        .execute()
    )
    data = response.data or []
    if data:
        record = data[0]
        carried = {
            "budget_id": budget_id,
            "user_id": user_id,
            "date": target_date.isoformat(),
            **_totals_from_record(record),
        }
        return {
            **carried,
            **_calculate_totals(carried),
            "as_of_date": record.get("date", target_date.isoformat()),
            "is_carried": True,
        }
    record = {
        "budget_id": budget_id,
        "user_id": user_id,
        "date": target_date.isoformat(),
        "cash_total": 0,
        "bank_total": 0,
        "debt_cards_total": 0,
        "debt_other_total": 0,
    }
    return {
        **record,
        **_calculate_totals(record),
        "as_of_date": target_date.isoformat(),
        "is_carried": False,
    }


def upsert(
    user_id: str,
    budget_id: str,
    target_date: date,
    fields: dict[str, int],
) -> dict[str, Any]:
    _ensure_budget_access(user_id, budget_id)
    existing = get_state(user_id, budget_id, target_date)
    base = {
        "cash_total": int((existing or {}).get("cash_total", 0)),
        "bank_total": int((existing or {}).get("bank_total", 0)),
        "debt_cards_total": int((existing or {}).get("debt_cards_total", 0)),
        "debt_other_total": int((existing or {}).get("debt_other_total", 0)),
    }
    merged = {**base, **fields}
    payload = {
        "budget_id": budget_id,
        "user_id": user_id,
        "date": target_date.isoformat(),
        **merged,
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


def upsert_with_base(
    user_id: str,
    budget_id: str,
    target_date: date,
    fields: dict[str, int],
) -> dict[str, Any]:
    base = get_state_as_of(user_id, budget_id, target_date)
    merged = {
        **_totals_from_record(base),
        **{key: int(value) for key, value in fields.items()},
    }
    payload = {
        "budget_id": budget_id,
        "user_id": user_id,
        "date": target_date.isoformat(),
        **merged,
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


def apply_forward_delta(
    user_id: str,
    budget_id: str,
    target_date: date,
    delta_cash: int,
    delta_bank: int,
) -> None:
    if delta_cash == 0 and delta_bank == 0:
        return
    _ensure_budget_access(user_id, budget_id)
    client = get_supabase_client()
    response = (
        client.table("daily_state")
        .select("id, date, cash_total, bank_total")
        .eq("budget_id", budget_id)
        .eq("user_id", user_id)
        .gt("date", target_date.isoformat())
        .order("date")
        .execute()
    )
    records = response.data or []
    if not records:
        return
    for record in records:
        next_cash = int(record.get("cash_total", 0)) + delta_cash
        next_bank = int(record.get("bank_total", 0)) + delta_bank
        if next_cash < 0 or next_bank < 0:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Нельзя уменьшить остатки ниже 0",
            )
    for record in records:
        update_fields: dict[str, int] = {}
        if delta_cash != 0:
            update_fields["cash_total"] = (
                int(record.get("cash_total", 0)) + delta_cash
            )
        if delta_bank != 0:
            update_fields["bank_total"] = (
                int(record.get("bank_total", 0)) + delta_bank
            )
        if not update_fields:
            continue
        try:
            client.table("daily_state").update(update_fields).eq(
                "id", record.get("id")
            ).execute()
        except APIError as exc:
            _raise_postgrest_http_error(exc)


def update_with_propagation(
    user_id: str,
    budget_id: str,
    target_date: date,
    fields: dict[str, int],
) -> dict[str, Any]:
    existing = get_state(user_id, budget_id, target_date)
    if existing is not None:
        old_totals = _totals_from_record(existing)
    else:
        old_totals = _totals_from_record(
            get_state_as_of(user_id, budget_id, target_date)
        )
    next_totals = {
        **old_totals,
        **{key: int(value) for key, value in fields.items()},
    }
    for key in (
        "cash_total",
        "bank_total",
        "debt_cards_total",
        "debt_other_total",
    ):
        if next_totals[key] < 0:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Значение не может быть меньше 0",
            )
    payload = {
        "budget_id": budget_id,
        "user_id": user_id,
        "date": target_date.isoformat(),
        **next_totals,
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
    delta_cash = next_totals["cash_total"] - old_totals["cash_total"]
    delta_bank = next_totals["bank_total"] - old_totals["bank_total"]
    if delta_cash != 0 or delta_bank != 0:
        apply_forward_delta(
            user_id, budget_id, target_date, delta_cash, delta_bank
        )
    return {**record, **_calculate_totals(record)}


def get_balance(user_id: str, budget_id: str, target_date: date) -> int:
    record = get_state_or_default(user_id, budget_id, target_date)
    return int(record["balance"])


def get_delta(user_id: str, budget_id: str, target_date: date) -> int:
    current = get_state_or_default(user_id, budget_id, target_date)
    previous_date = target_date - timedelta(days=1)
    previous = get_state_or_default(user_id, budget_id, previous_date)
    return int(current["balance"]) - int(previous["balance"])
