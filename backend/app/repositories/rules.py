from __future__ import annotations

from typing import Any

from fastapi import HTTPException, status
from fastapi.encoders import jsonable_encoder
from postgrest.exceptions import APIError

from app.integrations.supabase_client import get_supabase_client

MATCH_TYPE_CONTAINS = "contains"
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


def _ensure_target_present(
    account_id: str | None, category_id: str | None, tag: str | None
) -> None:
    if not any([account_id, category_id, tag]):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="At least one target must be provided",
        )


def _normalize_tag(tag: str | None) -> str | None:
    if tag is None:
        return None
    if tag not in ALLOWED_TAGS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid tag",
        )
    return tag


def _extract_pattern(note: str) -> str | None:
    cleaned_note = note.strip().lower()
    if not cleaned_note:
        return None
    for raw_word in cleaned_note.split():
        word = raw_word.strip(".,!?;:\"'()[]{}")
        if len(word) >= 4:
            return word
    return None


def _recalculate_confidence(hits: int, accepts: int) -> float:
    safe_hits = max(hits, 1)
    return float(accepts) / float(safe_hits)


def list_rules(user_id: str, budget_id: str) -> list[dict[str, Any]]:
    _ensure_budget_access(user_id, budget_id)
    client = get_supabase_client()
    response = (
        client.table("rules")
        .select(
            "id, budget_id, user_id, pattern, match_type, account_id, "
            "category_id, tag, hits, accepts, confidence, created_at"
        )
        .eq("budget_id", budget_id)
        .eq("user_id", user_id)
        .order("created_at", desc=True)
        .execute()
    )
    return response.data or []


def create_rule(user_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    budget_id = payload.get("budget_id")
    if not budget_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="budget_id is required",
        )

    _ensure_budget_access(user_id, budget_id)

    pattern = payload.get("pattern")
    if not pattern or not str(pattern).strip():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="pattern is required",
        )

    match_type = payload.get("match_type", MATCH_TYPE_CONTAINS)
    if match_type != MATCH_TYPE_CONTAINS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only contains match_type is supported",
        )

    account_id = payload.get("account_id")
    category_id = payload.get("category_id")
    tag = _normalize_tag(payload.get("tag"))

    _ensure_target_present(account_id, category_id, tag)

    if account_id:
        _ensure_account_in_budget(budget_id, account_id)
    if category_id:
        _ensure_category_in_budget(budget_id, category_id)

    data = jsonable_encoder(
        {
            "budget_id": budget_id,
            "pattern": str(pattern).strip().lower(),
            "match_type": match_type,
            "account_id": account_id,
            "category_id": category_id,
            "tag": tag,
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


def delete_rule(user_id: str, rule_id: str) -> None:
    client = get_supabase_client()
    existing = (
        client.table("rules")
        .select("id, user_id")
        .eq("id", rule_id)
        .execute()
    )
    data = existing.data or []
    if not data:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    if data[0]["user_id"] != user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Rule does not belong to user",
        )

    client.table("rules").delete().eq("id", rule_id).execute()


def suggest(user_id: str, budget_id: str, note: str) -> dict[str, Any]:
    _ensure_budget_access(user_id, budget_id)

    if not note or not note.strip():
        return {
            "account_id": None,
            "category_id": None,
            "tag": None,
            "confidence": 0.0,
            "pattern": None,
        }

    note_lower = note.lower()
    client = get_supabase_client()
    response = (
        client.table("rules")
        .select(
            "id, pattern, match_type, account_id, category_id, tag, hits, "
            "accepts, confidence"
        )
        .eq("budget_id", budget_id)
        .eq("user_id", user_id)
        .execute()
    )
    rules = response.data or []
    best_rule: dict[str, Any] | None = None
    best_confidence = 0.0

    for rule in rules:
        pattern = (rule.get("pattern") or "").lower()
        if not pattern:
            continue
        if pattern not in note_lower:
            continue
        hits = int(rule.get("hits") or 0)
        accepts = int(rule.get("accepts") or 0)
        confidence = _recalculate_confidence(hits, accepts)
        if confidence > best_confidence:
            best_confidence = confidence
            best_rule = rule

    if not best_rule:
        return {
            "account_id": None,
            "category_id": None,
            "tag": None,
            "confidence": 0.0,
            "pattern": None,
        }

    return {
        "account_id": best_rule.get("account_id"),
        "category_id": best_rule.get("category_id"),
        "tag": best_rule.get("tag"),
        "confidence": best_confidence,
        "pattern": best_rule.get("pattern"),
    }


def feedback(
    user_id: str,
    budget_id: str,
    note: str,
    accepted: bool,
    account_id: str | None,
    category_id: str | None,
    tag: str | None,
) -> dict[str, Any]:
    _ensure_budget_access(user_id, budget_id)

    pattern = _extract_pattern(note)
    if not pattern:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Unable to derive pattern from note",
        )

    tag = _normalize_tag(tag)
    _ensure_target_present(account_id, category_id, tag)

    if account_id:
        _ensure_account_in_budget(budget_id, account_id)
    if category_id:
        _ensure_category_in_budget(budget_id, category_id)

    client = get_supabase_client()
    query = (
        client.table("rules")
        .select(
            "id, hits, accepts, account_id, category_id, tag, pattern, match_type"
        )
        .eq("budget_id", budget_id)
        .eq("user_id", user_id)
        .eq("pattern", pattern)
        .eq("match_type", MATCH_TYPE_CONTAINS)
    )
    if account_id:
        query = query.eq("account_id", account_id)
    else:
        query = query.is_("account_id", "null")
    if category_id:
        query = query.eq("category_id", category_id)
    else:
        query = query.is_("category_id", "null")
    if tag:
        query = query.eq("tag", tag)
    else:
        query = query.is_("tag", "null")
    existing = query.execute().data or []

    rule: dict[str, Any]
    if existing:
        rule = existing[0]
    else:
        insert_payload = jsonable_encoder(
            {
                "budget_id": budget_id,
                "pattern": pattern,
                "match_type": MATCH_TYPE_CONTAINS,
                "account_id": account_id,
                "category_id": category_id,
                "tag": tag,
            }
        )
        created = (
            client.table("rules")
            .insert({**insert_payload, "user_id": user_id})
            .execute()
        )
        data = created.data or []
        if not data:
            raise RuntimeError("Failed to create rule from feedback")
        rule = data[0]

    hits = int(rule.get("hits") or 0) + 1
    accepts = int(rule.get("accepts") or 0) + (1 if accepted else 0)
    confidence = _recalculate_confidence(hits, accepts)

    updated = (
        client.table("rules")
        .update({"hits": hits, "accepts": accepts, "confidence": confidence})
        .eq("id", rule["id"])
        .execute()
    )
    data = updated.data or []
    if data:
        return data[0]
    raise RuntimeError("Failed to update rule feedback")
