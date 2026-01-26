from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException, status

from app.integrations.supabase_client import get_supabase_client
from app.repositories.daily_state import get_state_as_of, get_state_or_default


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
        "debt_other_total": int(daily_state.get("debt_other_total", 0)),
        "goals_active": goals_active,
    }


def balance_as_of_date(user_id: str, budget_id: str, target_date: date) -> int:
    state = get_state_as_of(user_id, budget_id, target_date)
    return int(state.get("balance", 0))


def reconcile_by_date(
    user_id: str, budget_id: str, target_date: date
) -> dict[str, Any]:
    _ensure_budget_access(user_id, budget_id)
    client = get_supabase_client()
    response = (
        client.table("transactions")
        .select("type, amount")
        .eq("budget_id", budget_id)
        .eq("user_id", user_id)
        .eq("date", target_date.isoformat())
        .execute()
    )
    bottom_total = 0
    for item in response.data or []:
        tx_type = item.get("type")
        amount = int(item.get("amount", 0))
        if tx_type == "income":
            bottom_total += amount
        elif tx_type == "expense":
            bottom_total -= amount
    balance_today = balance_as_of_date(user_id, budget_id, target_date)
    balance_prev = balance_as_of_date(
        user_id, budget_id, target_date - timedelta(days=1)
    )
    top_total = balance_today - balance_prev
    diff = top_total - bottom_total
    return {
        "date": target_date.isoformat(),
        "bottom_total": bottom_total,
        "top_total": top_total,
        "diff": diff,
        "is_ok": abs(diff) <= 1,
    }


def month_report(user_id: str, budget_id: str, month: str) -> dict[str, Any]:
    try:
        parsed_month = datetime.strptime(month, "%Y-%m")
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid month format",
        ) from exc

    date_from = date(parsed_month.year, parsed_month.month, 1)
    if parsed_month.month == 12:
        date_to = date(parsed_month.year + 1, 1, 1)
    else:
        date_to = date(parsed_month.year, parsed_month.month + 1, 1)

    _ensure_budget_access(user_id, budget_id)
    client = get_supabase_client()

    cashflow_response = (
        client.table("transactions")
        .select("date, type, amount")
        .eq("budget_id", budget_id)
        .eq("user_id", user_id)
        .gte("date", date_from.isoformat())
        .lt("date", date_to.isoformat())
        .order("date")
        .execute()
    )

    start_day = date_from - timedelta(days=1)
    balance_response = (
        client.table("daily_state")
        .select(
            "date, cash_total, bank_total, debt_cards_total, debt_other_total"
        )
        .eq("budget_id", budget_id)
        .eq("user_id", user_id)
        .gte("date", start_day.isoformat())
        .lt("date", date_to.isoformat())
        .order("date")
        .execute()
    )

    end_day = date_to - timedelta(days=1)
    days = _date_range(date_from, end_day)
    cashflow_totals = {
        day.isoformat(): {"income_total": 0, "expense_total": 0}
        for day in days
    }
    for item in cashflow_response.data or []:
        tx_date = item.get("date")
        if tx_date not in cashflow_totals:
            continue
        tx_type = item.get("type")
        amount = int(item.get("amount", 0))
        if tx_type == "income":
            cashflow_totals[tx_date]["income_total"] += amount
        elif tx_type == "expense":
            cashflow_totals[tx_date]["expense_total"] += amount

    balance_records = {
        item.get("date"): item for item in balance_response.data or []
    }

    month_income = 0
    month_expense = 0
    report_days = []
    for day in days:
        key = day.isoformat()
        income_total = cashflow_totals[key]["income_total"]
        expense_total = cashflow_totals[key]["expense_total"]
        bottom_total = income_total - expense_total
        month_income += income_total
        month_expense += expense_total

        today_state = balance_records.get(key)
        prev_state = balance_records.get(
            (day - timedelta(days=1)).isoformat()
        )
        if today_state and prev_state:
            today_balance = (
                int(today_state.get("cash_total", 0))
                + int(today_state.get("bank_total", 0))
                - int(today_state.get("debt_cards_total", 0))
                - int(today_state.get("debt_other_total", 0))
            )
            prev_balance = (
                int(prev_state.get("cash_total", 0))
                + int(prev_state.get("bank_total", 0))
                - int(prev_state.get("debt_cards_total", 0))
                - int(prev_state.get("debt_other_total", 0))
            )
            top_total = today_balance - prev_balance
        else:
            top_total = 0

        diff = top_total - bottom_total
        report_days.append(
            {
                "date": key,
                "top_total": top_total,
                "bottom_total": bottom_total,
                "diff": diff,
            }
        )

    month_net = month_income - month_expense
    avg_net_per_day = (
        round(month_net / len(days)) if days else 0
    )

    return {
        "month": month,
        "days": report_days,
        "month_income": month_income,
        "month_expense": month_expense,
        "month_net": month_net,
        "avg_net_per_day": avg_net_per_day,
    }
