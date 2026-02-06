from __future__ import annotations

import logging
from datetime import date
from typing import Any

from fastapi import HTTPException, status

from app.integrations.supabase_client import get_supabase_client

logger = logging.getLogger(__name__)


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


def create_statement_draft(
    user_id: str,
    budget_id: str,
    source_filename: str | None,
    source_mime: str | None,
    source_text: str,
    model: str,
    draft_payload: dict[str, Any],
) -> dict[str, Any]:
    _ensure_budget_access(user_id, budget_id)
    client = get_supabase_client()
    response = (
        client.table("statement_drafts")
        .insert(
            {
                "budget_id": budget_id,
                "user_id": user_id,
                "status": "draft",
                "source_filename": source_filename,
                "source_mime": source_mime,
                "source_text": source_text,
                "model": model,
                "draft_payload": draft_payload,
            }
        )
        .execute()
    )
    data = response.data or []
    if not data:
        raise RuntimeError("Failed to store statement draft")
    return data[0]


def update_statement_draft(
    user_id: str,
    draft_id: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    client = get_supabase_client()
    response = (
        client.table("statement_drafts")
        .update(payload)
        .eq("id", draft_id)
        .eq("user_id", user_id)
        .execute()
    )
    data = response.data or []
    if not data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Draft not found",
        )
    return data[0]


def get_statement_draft(user_id: str, draft_id: str) -> dict[str, Any]:
    client = get_supabase_client()
    response = (
        client.table("statement_drafts")
        .select(
            "id, budget_id, user_id, status, source_filename, source_mime, "
            "source_text, draft_payload, feedback, model, created_at, updated_at"
        )
        .eq("id", draft_id)
        .eq("user_id", user_id)
        .execute()
    )
    data = response.data or []
    if not data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Draft not found",
        )
    return data[0]
