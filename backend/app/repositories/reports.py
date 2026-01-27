from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException, status

from app.integrations.supabase_client import get_supabase_client
from app.repositories.accounts import list_accounts
from app.repositories.daily_state import (
    get_balance_for_date,
    get_state_or_default,
)


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
    debts_response = (
        client.table("daily_state")
        .select("date, debt_cards_total, debt_other_total")
        .eq("budget_id", budget_id)
        .eq("user_id", user_id)
        .gte("date", date_from.isoformat())
        .lte("date", date_to.isoformat())
        .order("date")
        .execute()
    )
    debts_records = {item.get("date"): item for item in debts_response.data or []}
    accounts = list_accounts(user_id, budget_id)
    account_kind = {
        account["id"]: account.get("kind") for account in accounts
    }
    balances_response = (
        client.table("daily_account_balances")
        .select("date, account_id, amount")
        .eq("budget_id", budget_id)
        .eq("user_id", user_id)
        .lte("date", date_to.isoformat())
        .order("date")
        .execute()
    )
    balances_records = balances_response.data or []
    last_balances = {account["id"]: 0 for account in accounts}
    balance_index = 0
    last_state: dict[str, int] | None = None
    last_balance = 0
    result = []
    for day in _date_range(date_from, date_to):
        key = day.isoformat()
        while balance_index < len(balances_records):
            record = balances_records[balance_index]
            record_date = record.get("date")
            if not record_date or record_date > key:
                break
            account_id = record.get("account_id")
            if account_id in last_balances:
                last_balances[account_id] = int(record.get("amount", 0))
            balance_index += 1
        record = debts_records.get(key)
        if record:
            debt_cards_total = int(record.get("debt_cards_total", 0))
            debt_other_total = int(record.get("debt_other_total", 0))
            last_state = {
                "debt_cards_total": debt_cards_total,
                "debt_other_total": debt_other_total,
            }
        elif last_state is not None:
            debt_cards_total = last_state["debt_cards_total"]
            debt_other_total = last_state["debt_other_total"]
        else:
            debt_cards_total = 0
            debt_other_total = 0
        cash_total = 0
        noncash_total = 0
        for account_id, amount in last_balances.items():
            if account_kind.get(account_id) == "cash":
                cash_total += amount
            else:
                noncash_total += amount
        assets_total = cash_total + noncash_total
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
    balance, _ = get_balance_for_date(user_id, budget_id, target_date)
    return balance


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
    balance_today, has_today = get_balance_for_date(
        user_id, budget_id, target_date
    )
    balance_prev, has_prev = get_balance_for_date(
        user_id, budget_id, target_date - timedelta(days=1)
    )
    top_total = balance_today - balance_prev if has_today and has_prev else 0
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
    accounts = list_accounts(user_id, budget_id)
    account_kind = {
        account["id"]: account.get("kind") for account in accounts
    }
    balance_response = (
        client.table("daily_account_balances")
        .select("date, account_id, amount")
        .eq("budget_id", budget_id)
        .eq("user_id", user_id)
        .gte("date", start_day.isoformat())
        .lt("date", date_to.isoformat())
        .execute()
    )
    debts_response = (
        client.table("daily_state")
        .select("date, debt_cards_total, debt_other_total")
        .eq("budget_id", budget_id)
        .eq("user_id", user_id)
        .gte("date", start_day.isoformat())
        .lt("date", date_to.isoformat())
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

    balance_records: dict[str, dict[str, int]] = {}
    for item in balance_response.data or []:
        record_date = item.get("date")
        account_id = item.get("account_id")
        if not record_date:
            continue
        entry = balance_records.setdefault(
            record_date, {"cash_total": 0, "noncash_total": 0}
        )
        kind = account_kind.get(account_id)
        amount = int(item.get("amount", 0))
        if kind == "cash":
            entry["cash_total"] += amount
        else:
            entry["noncash_total"] += amount
    debt_records = {
        item.get("date"): item for item in debts_response.data or []
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
        today_debts = debt_records.get(key, {})
        prev_debts = debt_records.get(
            (day - timedelta(days=1)).isoformat(),
            {},
        )
        if today_state and prev_state:
            today_balance = (
                int(today_state.get("cash_total", 0))
                + int(today_state.get("noncash_total", 0))
                - int(today_debts.get("debt_cards_total", 0))
                - int(today_debts.get("debt_other_total", 0))
            )
            prev_balance = (
                int(prev_state.get("cash_total", 0))
                + int(prev_state.get("noncash_total", 0))
                - int(prev_debts.get("debt_cards_total", 0))
                - int(prev_debts.get("debt_other_total", 0))
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


def expenses_by_category(
    user_id: str,
    budget_id: str,
    date_from: date,
    date_to: date,
    limit: int,
) -> dict[str, Any]:
    _ensure_budget_access(user_id, budget_id)
    client = get_supabase_client()
    transactions_response = (
        client.table("transactions")
        .select("amount, category_id")
        .eq("type", "expense")
        .eq("budget_id", budget_id)
        .eq("user_id", user_id)
        .gte("date", date_from.isoformat())
        .lte("date", date_to.isoformat())
        .execute()
    )
    categories_response = (
        client.table("categories")
        .select("id, name, parent_id")
        .eq("budget_id", budget_id)
        .execute()
    )
    categories = {
        item.get("id"): {
            "name": item.get("name"),
            "parent_id": item.get("parent_id"),
        }
        for item in (categories_response.data or [])
        if item.get("id")
    }
    totals: dict[str, int] = {}
    total_expense = 0
    for item in transactions_response.data or []:
        category_id = item.get("category_id")
        if not category_id or category_id not in categories:
            continue
        amount = int(item.get("amount", 0))
        totals[category_id] = totals.get(category_id, 0) + amount
        total_expense += amount

    children_map: dict[str, list[str]] = {}
    for category_id, category in categories.items():
        parent_id = category.get("parent_id")
        if parent_id:
            children_map.setdefault(parent_id, []).append(category_id)

    parent_category_ids = [
        category_id
        for category_id, category in categories.items()
        if not category.get("parent_id")
        or category.get("parent_id") not in categories
    ]

    items: list[dict[str, Any]] = []
    for category_id in parent_category_ids:
        own_total = totals.get(category_id, 0)
        children_items = []
        children_total = 0
        for child_id in children_map.get(category_id, []):
            child_amount = totals.get(child_id, 0)
            if child_amount <= 0:
                continue
            children_total += child_amount
            children_items.append(
                {
                    "category_id": child_id,
                    "category_name": categories[child_id]["name"],
                    "amount": child_amount,
                }
            )
        parent_total = own_total + children_total
        if parent_total <= 0:
            continue
        items.append(
            {
                "category_id": category_id,
                "category_name": categories[category_id]["name"],
                "amount": parent_total,
                "children": children_items,
            }
        )

    items.sort(key=lambda item: item["amount"], reverse=True)
    limited_items = items[: max(limit, 0)]
    if total_expense > 0:
        for item in limited_items:
            item["share"] = item["amount"] / total_expense
            for child in item["children"]:
                child["share"] = child["amount"] / total_expense
    else:
        for item in limited_items:
            item["share"] = 0
            for child in item["children"]:
                child["share"] = 0

    return {"total_expense": total_expense, "items": limited_items}
