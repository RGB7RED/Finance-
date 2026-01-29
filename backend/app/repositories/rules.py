from __future__ import annotations

from typing import Any

from fastapi import HTTPException, status
from fastapi.encoders import jsonable_encoder
from postgrest.exceptions import APIError

from app.integrations.supabase_client import get_supabase_client

ALLOWED_TAGS = {"one_time", "subscription"}


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


def _ensure_category_in_budget(budget_id: str, category_id: str) -> None:
    client = get_supabase_client()
    response = (
        client.table("categories")
        .select("id")
        .eq("id", category_id)
        .eq("budget_id", budget_id)
        .execute()
    )
    if not response.data:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Category not found for budget",
        )


def _normalize_tag(tag: str | None) -> str:
    if not tag:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="tag is required",
        )
    if tag not in ALLOWED_TAGS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid tag",
        )
    return tag


def list_rules(user_id: str, budget_id: str) -> list[dict[str, Any]]:
    _ensure_budget_access(user_id, budget_id)
    client = get_supabase_client()
    response = (
        client.table("rules")
        .select(
            "id, budget_id, user_id, pattern, account_id, category_id, tag, "
            "created_at, updated_at"
        )
        .eq("budget_id", budget_id)
        .eq("user_id", user_id)
        .order("created_at", desc=True)
        .execute()
    )
    return response.data or []


def create_rule(
    user_id: str,
    budget_id: str,
    pattern: str,
    account_id: str | None,
    category_id: str | None,
    tag: str,
) -> dict[str, Any]:
    _ensure_budget_access(user_id, budget_id)

    if not pattern or not str(pattern).strip():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="pattern is required",
        )

    normalized_tag = _normalize_tag(tag)

    if account_id:
        _ensure_account_in_budget(budget_id, account_id)
    if category_id:
        _ensure_category_in_budget(budget_id, category_id)

    data = jsonable_encoder(
        {
            "budget_id": budget_id,
            "pattern": str(pattern).strip().lower(),
            "account_id": account_id,
            "category_id": category_id,
            "tag": normalized_tag,
        }
    )

    client = get_supabase_client()
    try:
        response = (
            client.table("rules").insert({**data, "user_id": user_id}).execute()
        )
    except APIError as exc:
        detail = getattr(exc, "message", None) or str(exc)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=detail,
        ) from exc

    created = response.data or []
    if created:
        return created[0]
    raise RuntimeError("Failed to create rule in Supabase")


def delete_rule(user_id: str, budget_id: str, rule_id: str) -> None:
    _ensure_budget_access(user_id, budget_id)
    client = get_supabase_client()
    existing = (
        client.table("rules")
        .select("id, user_id, budget_id")
        .eq("id", rule_id)
        .execute()
    )
    data = existing.data or []
    if not data:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    if data[0]["user_id"] != user_id or data[0]["budget_id"] != budget_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Rule does not belong to user",
        )

    client.table("rules").delete().eq("id", rule_id).execute()


def apply_rules(user_id: str, budget_id: str, text: str) -> dict[str, Any]:
    _ensure_budget_access(user_id, budget_id)

    if not text or not text.strip():
        return {"account_id": None, "category_id": None, "tag": None}

    note_lower = text.lower()
    client = get_supabase_client()
    response = (
        client.table("rules")
        .select("id, pattern, account_id, category_id, tag")
        .eq("budget_id", budget_id)
        .eq("user_id", user_id)
        .execute()
    )
    rules = response.data or []

    best_rule: dict[str, Any] | None = None
    best_length = -1

    for rule in rules:
        pattern = (rule.get("pattern") or "").lower()
        if not pattern:
            continue
        if pattern not in note_lower:
            continue
        pattern_length = len(pattern)
        if pattern_length > best_length:
            best_length = pattern_length
            best_rule = rule

    if not best_rule:
        return {"account_id": None, "category_id": None, "tag": None}

    return {
        "account_id": best_rule.get("account_id"),
        "category_id": best_rule.get("category_id"),
        "tag": best_rule.get("tag"),
    }
