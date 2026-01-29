from __future__ import annotations

from datetime import date
from typing import Any

from fastapi import HTTPException, status
from postgrest.exceptions import APIError

from app.integrations.supabase_client import get_supabase_client
from app.repositories.transactions import create_transaction


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


def _get_goal_for_update(user_id: str, goal_id: str) -> dict[str, Any]:
    client = get_supabase_client()
    response = (
        client.table("goals")
        .select(
            "id, budget_id, user_id, title, target_amount, current_amount,"
            " deadline, status, created_at"
        )
        .eq("id", goal_id)
        .execute()
    )
    data = response.data or []
    if not data:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    record = data[0]
    if record["user_id"] != user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Goal does not belong to user",
        )
    _ensure_budget_access(user_id, record["budget_id"])
    return record


def _ensure_account_in_budget(budget_id: str, account_id: str) -> None:
    client = get_supabase_client()
    response = (
        client.table("accounts")
        .select("id")
        .eq("id", account_id)
        .eq("budget_id", budget_id)
        .execute()
    )
    if not response.data:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Account not found for budget",
        )


def _parse_payload_date(value: Any) -> date:
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        return date.fromisoformat(value)
    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail="Invalid date for goal adjust",
    )


def list_goals(user_id: str, budget_id: str) -> list[dict[str, Any]]:
    _ensure_budget_access(user_id, budget_id)
    client = get_supabase_client()
    response = (
        client.table("goals")
        .select(
            "id, budget_id, user_id, title, target_amount, current_amount,"
            " deadline, status, created_at"
        )
        .eq("budget_id", budget_id)
        .eq("user_id", user_id)
        .order("created_at")
        .execute()
    )
    return response.data or []


def create_goal(
    user_id: str,
    budget_id: str,
    title: str,
    target_amount: int,
    deadline: str | None,
) -> dict[str, Any]:
    _ensure_budget_access(user_id, budget_id)
    if target_amount <= 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="target_amount must be > 0",
        )
    client = get_supabase_client()
    try:
        response = (
            client.table("goals")
            .insert(
                {
                    "budget_id": budget_id,
                    "user_id": user_id,
                    "title": title,
                    "target_amount": target_amount,
                    "deadline": deadline,
                }
            )
            .execute()
        )
    except APIError as exc:
        detail = getattr(exc, "message", None) or str(exc)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=detail,
        ) from exc
    data = response.data or []
    if data:
        return data[0]
    raise RuntimeError("Failed to create goal in Supabase")


def update_goal(
    user_id: str,
    goal_id: str,
    fields: dict[str, Any],
) -> dict[str, Any]:
    record = _get_goal_for_update(user_id, goal_id)
    update_fields: dict[str, Any] = {}
    for key in ("title", "target_amount", "deadline", "status", "current_amount"):
        if key in fields:
            update_fields[key] = fields[key]

    if not update_fields:
        return record

    next_target = update_fields.get("target_amount", record["target_amount"])
    next_current = update_fields.get("current_amount", record["current_amount"])
    if next_current > next_target:
        next_current = next_target
        update_fields["current_amount"] = next_current

    client = get_supabase_client()
    try:
        response = (
            client.table("goals")
            .update(update_fields)
            .eq("id", goal_id)
            .execute()
        )
    except APIError as exc:
        detail = getattr(exc, "message", None) or str(exc)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=detail,
        ) from exc
    data = response.data or []
    if data:
        return data[0]
    raise RuntimeError("Failed to update goal in Supabase")


def delete_goal(user_id: str, goal_id: str) -> dict[str, Any]:
    record = _get_goal_for_update(user_id, goal_id)
    client = get_supabase_client()
    client.table("goals").delete().eq("id", goal_id).execute()
    return record


def adjust_goal_amount(
    user_id: str,
    goal_id: str,
    budget_id: str,
    account_id: str,
    delta: int,
    note: str | None = None,
    target_date: date | str | None = None,
) -> dict[str, Any]:
    if delta == 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Delta must be non-zero",
        )
    record = _get_goal_for_update(user_id, goal_id)
    if record["budget_id"] != budget_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Goal not found for budget",
        )
    _ensure_account_in_budget(budget_id, account_id)
    current_amount = int(record.get("current_amount", 0))
    target_amount = int(record.get("target_amount", 0))

    if delta < 0 and abs(delta) > current_amount:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Недостаточно средств для снятия",
        )

    next_amount = max(0, min(target_amount, current_amount + delta))
    applied_delta = next_amount - current_amount
    if applied_delta == 0:
        return {
            "status": "noop",
            "detail": "goal_limit_reached",
            "applied_delta": 0,
            "goal": record,
        }

    target_date_value = (
        _parse_payload_date(target_date) if target_date else date.today()
    )
    direction = "expense" if applied_delta > 0 else "income"
    amount = abs(applied_delta)
    sign = "+" if applied_delta > 0 else "-"
    note_prefix = f"Goal: {record.get('title')} ({sign}{amount})"
    tx_note = f"{note_prefix} — {note}" if note else note_prefix

    transaction = create_transaction(
        user_id,
        {
            "budget_id": budget_id,
            "type": direction,
            "kind": "goal_transfer",
            "amount": amount,
            "date": target_date_value.isoformat(),
            "account_id": account_id,
            "category_id": None,
            "goal_id": goal_id,
            "tag": "one_time",
            "note": tx_note,
        },
    )

    client = get_supabase_client()
    try:
        goal_response = (
            client.table("goals")
            .update({"current_amount": next_amount})
            .eq("id", goal_id)
            .execute()
        )
    except APIError as exc:
        try:
            client.table("transactions").delete().eq(
                "id", transaction.get("id")
            ).execute()
        except Exception:
            pass
        detail = getattr(exc, "message", None) or str(exc)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=detail,
        ) from exc

    goal_data = goal_response.data or []
    if not goal_data:
        raise RuntimeError("Failed to update goal in Supabase")
    return {
        "status": "ok",
        "detail": "applied",
        "applied_delta": applied_delta,
        "goal": goal_data[0],
    }
