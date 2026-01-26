from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException, status

from app.integrations.supabase_client import get_supabase_client
from app.repositories.daily_state import get_state_or_default
from app.repositories.debts_other import sum_debts_other_as_of


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


def _date_range(start: date, end: date) -> list[date]:
    if end < start:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid date range",
        )
    days: list[date] = []
    current = start
    while current <= end:
        days.append(current)
        current += timedelta(days=1)
    return days


def cashflow_by_day(
    user_id: str, budget_id: str, date_from: date, date_to: date
) -> list[dict[str, Any]]:
    _ensure_budget_access(user_id, budget_id)
    client = get_supabase_client()
    response = (
        client.table("transactions")
        .select("date, type, amount")
        .eq("budget_id", budget_id)
        .eq("user_id", user_id)
        .gte("date", date_from.isoformat())
        .lte("date", date_to.isoformat())
        .order("date")
        .execute()
    )
    totals: dict[str, dict[str, int]] = {
        day.isoformat(): {"income_total": 0, "expense_total": 0}
        for day in _date_range(date_from, date_to)
    }
    for item in response.data or []:
        tx_date = item.get("date")
        if not tx_date or tx_date not in totals:
            continue
        tx_type = item.get("type")
        amount = int(item.get("amount", 0))
        if tx_type == "income":
            totals[tx_date]["income_total"] += amount
        elif tx_type == "expense":
            totals[tx_date]["expense_total"] += amount
    result = []
    for day in _date_range(date_from, date_to):
        key = day.isoformat()
        income_total = totals[key]["income_total"]
        expense_total = totals[key]["expense_total"]
        result.append(
            {
                "date": key,
                "income_total": income_total,
                "expense_total": expense_total,
                "net_total": income_total - expense_total,
            }
        )
    return result


def balance_by_day(
    user_id: str, budget_id: str, date_from: date, date_to: date
) -> list[dict[str, Any]]:
    _ensure_budget_access(user_id, budget_id)
    client = get_supabase_client()
    response = (
        client.table("daily_state")
        .select(
            "date, cash_total, bank_total, debt_cards_total, debt_other_total"
        )
        .eq("budget_id", budget_id)
        .eq("user_id", user_id)
        .gte("date", date_from.isoformat())
        .lte("date", date_to.isoformat())
        .order("date")
        .execute()
    )
    records = {item.get("date"): item for item in response.data or []}
    result = []
    last_state: dict[str, int] | None = None
    last_balance = 0
    for day in _date_range(date_from, date_to):
        key = day.isoformat()
        record = records.get(key)
        if record:
            cash_total = int(record.get("cash_total", 0))
            bank_total = int(record.get("bank_total", 0))
            debt_cards_total = int(record.get("debt_cards_total", 0))
            debt_other_total = int(record.get("debt_other_total", 0))
            last_state = {
                "cash_total": cash_total,
                "bank_total": bank_total,
                "debt_cards_total": debt_cards_total,
                "debt_other_total": debt_other_total,
            }
        elif last_state is not None:
            cash_total = last_state["cash_total"]
            bank_total = last_state["bank_total"]
            debt_cards_total = last_state["debt_cards_total"]
            debt_other_total = last_state["debt_other_total"]
        else:
            cash_total = 0
            bank_total = 0
            debt_cards_total = 0
            debt_other_total = 0
        assets_total = cash_total + bank_total
        debts_total = debt_cards_total + debt_other_total
        balance = assets_total - debts_total
        delta_balance = balance - last_balance
        last_balance = balance
        result.append(
            {
                "date": key,
                "assets_total": assets_total,
                "debts_total": debts_total,
                "balance": balance,
                "delta_balance": delta_balance,
            }
        )
    return result


def summary(user_id: str, budget_id: str) -> dict[str, Any]:
    today = datetime.now(timezone.utc).date()
    daily_state = get_state_or_default(user_id, budget_id, today)
    debt_other_total = sum_debts_other_as_of(user_id, budget_id, today)
    client = get_supabase_client()
    response = (
        client.table("goals")
        .select("title, target_amount, current_amount, deadline")
        .eq("budget_id", budget_id)
        .eq("user_id", user_id)
        .eq("status", "active")
        .order("created_at")
        .execute()
    )
    goals_active = [
        {
            "title": goal.get("title"),
            "target": int(goal.get("target_amount", 0)),
            "current": int(goal.get("current_amount", 0)),
            "deadline": goal.get("deadline"),
        }
        for goal in (response.data or [])
    ]
    return {
        "debt_cards_total": int(daily_state.get("debt_cards_total", 0)),
        "debt_other_total": debt_other_total,
        "goals_active": goals_active,
    }
