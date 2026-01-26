from __future__ import annotations

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


def _get_goal_for_update(user_id: str, goal_id: str) -> dict[str, Any]:
    client = get_supabase_client()
    response = (
        client.table("goals")
        .select("id, budget_id, user_id, target_amount, current_amount")
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
