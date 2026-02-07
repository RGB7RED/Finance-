from __future__ import annotations

import datetime as dt
import csv
import io
import json
import logging
from typing import Any

import pdfplumber
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.responses import JSONResponse

from app.auth.jwt import get_current_user
from app.core.config import settings
from app.integrations.llm_client import LLMError, generate_statement_draft
from app.integrations.supabase_client import get_supabase_client
from app.repositories.account_balance_events import (
    RECONCILE_ADJUST_REASON,
    create_balance_event,
    get_accounts_with_balances,
)
from app.repositories.accounts import list_accounts
from app.repositories.categories import list_categories
from app.repositories.daily_state import get_debts_as_of, upsert_debts
from app.repositories.rules import list_rules
from app.repositories.statement_drafts import (
    create_statement_draft,
    get_statement_draft,
    update_statement_draft,
)
from app.repositories.transactions import create_transaction

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/ai")


def _ensure_supported_statement(file: UploadFile) -> None:
    content_type = (file.content_type or "").lower()
    filename = (file.filename or "").lower()
    is_csv = "csv" in content_type or filename.endswith(".csv")
    is_text = content_type.startswith("text/")
    is_pdf = "pdf" in content_type or filename.endswith(".pdf")
    if not (is_csv or is_text or is_pdf):
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="Поддерживаются только PDF, CSV или TXT выписки. "
            "Сохраните файл в поддерживаемом формате и попробуйте снова.",
        )


def _clean_pdf_text(raw_text: str) -> str:
    lines = []
    for line in raw_text.splitlines():
        cleaned = " ".join(line.split()).strip()
        if cleaned:
            lines.append(cleaned)
    return "\n".join(lines)


def _extract_pdf_text(raw_bytes: bytes) -> str | None:
    with pdfplumber.open(io.BytesIO(raw_bytes)) as pdf:
        pages_text = []
        for page in pdf.pages:
            page_text = page.extract_text() or ""
            if page_text:
                pages_text.append(page_text)
            tables = page.extract_tables() or []
            for table in tables:
                rows = []
                for row in table:
                    rows.append(
                        " | ".join((cell or "").strip() for cell in row)
                    )
                if rows:
                    pages_text.append("\n".join(rows))
    cleaned = _clean_pdf_text("\n".join(pages_text))
    return cleaned or None


def _coerce_number(value: str | None) -> float | None:
    if value is None:
        return None
    cleaned = value.replace("\u00a0", " ").strip()
    if not cleaned:
        return None
    normalized = cleaned.replace(" ", "").replace(",", ".")
    try:
        return float(normalized)
    except ValueError:
        return None


def _parse_csv_rows(raw_bytes: bytes) -> list[dict[str, str]]:
    decoded = raw_bytes.decode("utf-8", errors="replace")
    sample = decoded[:4096]
    try:
        dialect = csv.Sniffer().sniff(sample)
    except csv.Error:
        dialect = csv.excel
    try:
        has_header = csv.Sniffer().has_header(sample)
    except csv.Error:
        has_header = True
    buffer = io.StringIO(decoded)
    if has_header:
        reader = csv.DictReader(buffer, dialect=dialect)
        rows: list[dict[str, str]] = []
        for row in reader:
            normalized = {
                (key or "").strip(): (value or "").strip()
                for key, value in row.items()
            }
            rows.append(normalized)
        return rows
    reader = csv.reader(buffer, dialect=dialect)
    rows = []
    for row in reader:
        normalized_row = {
            f"column_{index + 1}": (value or "").strip()
            for index, value in enumerate(row)
        }
        rows.append(normalized_row)
    return rows


def _normalize_csv_rows(rows: list[dict[str, str]]) -> list[dict[str, Any]]:
    date_keys = {"date", "дата", "operation date", "transaction date"}
    amount_keys = {"amount", "сумма", "sum", "amount_rub"}
    balance_keys = {"balance", "остаток", "баланс", "saldo"}
    description_keys = {
        "description",
        "описание",
        "назначение",
        "details",
        "comment",
        "memo",
    }
    debit_keys = {"debit", "дебет", "расход"}
    credit_keys = {"credit", "кредит", "приход"}
    normalized_rows: list[dict[str, Any]] = []
    for row in rows:
        lowered = {key.lower(): value for key, value in row.items()}
        date_value = next(
            (lowered[key] for key in date_keys if key in lowered), None
        )
        amount_value = next(
            (lowered[key] for key in amount_keys if key in lowered), None
        )
        description_value = next(
            (lowered[key] for key in description_keys if key in lowered), None
        )
        balance_value = next(
            (lowered[key] for key in balance_keys if key in lowered), None
        )
        debit_value = next(
            (lowered[key] for key in debit_keys if key in lowered), None
        )
        credit_value = next(
            (lowered[key] for key in credit_keys if key in lowered), None
        )
        amount_number = _coerce_number(amount_value)
        if amount_number is None:
            debit_number = _coerce_number(debit_value)
            credit_number = _coerce_number(credit_value)
            if debit_number is not None:
                amount_number = -abs(debit_number)
            elif credit_number is not None:
                amount_number = abs(credit_number)
        normalized_rows.append(
            {
                "date": date_value,
                "amount": amount_number,
                "description": description_value,
                "balance": _coerce_number(balance_value),
                "raw": row,
            }
        )
    return normalized_rows


def _pdf_text_to_rows(statement_text: str) -> list[dict[str, Any]]:
    rows = []
    for line in statement_text.splitlines():
        cleaned = " ".join(line.split()).strip()
        if cleaned:
            rows.append({"raw": cleaned})
    return rows


def _decode_statement(file: UploadFile, raw_bytes: bytes) -> str:
    content_type = (file.content_type or "").lower()
    filename = (file.filename or "").lower()
    if "pdf" in content_type or filename.endswith(".pdf"):
        extracted = _extract_pdf_text(raw_bytes)
        if not extracted:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="⚠️ Не удалось корректно извлечь данные из PDF. "
                "Проверь, что файл — текстовый, а не скан.",
            )
        return extracted
    return raw_bytes.decode("utf-8", errors="replace")


def _account_name_map(accounts: list[dict[str, Any]]) -> dict[str, str]:
    return {account["name"].lower(): account["id"] for account in accounts}


def _category_name_map(categories: list[dict[str, Any]]) -> dict[str, str]:
    return {category["name"].lower(): category["id"] for category in categories}


def _normalize_amount(raw_amount: Any) -> float:
    if isinstance(raw_amount, bool) or not isinstance(raw_amount, (int, float)):
        raise ValueError("Invalid amount")
    return round(float(raw_amount), 2)


def _normalize_statement_transactions(
    transactions: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for item in transactions:
        item["amount"] = _normalize_amount(item.get("amount"))
        normalized.append(item)
    return normalized


def _statement_apply_error_response(
    reason: str, details: dict[str, Any], status_code: int = 400
) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={
            "error": "statement_apply_failed",
            "reason": reason,
            "details": details,
        },
    )


def _validate_apply_operations(
    transactions: list[dict[str, Any]],
    account_map: dict[str, str],
    category_map: dict[str, str],
    missing_accounts: list[dict[str, Any]],
    missing_categories: list[dict[str, Any]],
) -> dict[str, Any] | None:
    if not transactions:
        return {
            "reason": "empty_operations",
            "details": {"message": "Draft has no operations"},
        }
    missing_account_names = {
        (item.get("name") or "").strip().lower()
        for item in missing_accounts
        if (item.get("name") or "").strip()
    }
    missing_category_names = {
        (item.get("name") or "").strip().lower()
        for item in missing_categories
        if (item.get("name") or "").strip()
    }
    account_ids = set(account_map.values())
    category_ids = set(category_map.values())
    for index, item in enumerate(transactions, start=1):
        if not isinstance(item, dict):
            return {
                "reason": "invalid_operation_payload",
                "details": {
                    "operation_index": index,
                    "field": "operation",
                    "value": item,
                    "expected": "object",
                },
            }
        date_value = item.get("date")
        if not date_value:
            return {
                "reason": "invalid_operation_payload",
                "details": {
                    "operation_index": index,
                    "field": "date",
                    "value": date_value,
                    "expected": "YYYY-MM-DD",
                },
            }
        try:
            if isinstance(date_value, str):
                dt.date.fromisoformat(date_value)
            else:
                raise ValueError("Date must be string")
        except ValueError:
            return {
                "reason": "invalid_operation_payload",
                "details": {
                    "operation_index": index,
                    "field": "date",
                    "value": date_value,
                    "expected": "YYYY-MM-DD",
                },
            }
        amount_value = item.get("amount")
        if isinstance(amount_value, str) or isinstance(amount_value, bool):
            return {
                "reason": "invalid_operation_payload",
                "details": {
                    "operation_index": index,
                    "field": "amount",
                    "value": amount_value,
                    "expected": "number",
                },
            }
        if not isinstance(amount_value, (int, float)):
            return {
                "reason": "invalid_operation_payload",
                "details": {
                    "operation_index": index,
                    "field": "amount",
                    "value": amount_value,
                    "expected": "number",
                },
            }
        op_type = item.get("type")
        if not op_type:
            return {
                "reason": "invalid_operation_payload",
                "details": {
                    "operation_index": index,
                    "field": "type",
                    "value": op_type,
                    "expected": "string",
                },
            }
        if op_type not in {"income", "expense", "transfer", "fee"}:
            return {
                "reason": "invalid_operation_payload",
                "details": {
                    "operation_index": index,
                    "field": "type",
                    "value": op_type,
                    "expected": "income|expense|transfer|fee",
                },
            }
        account_id = item.get("account_id")
        account_name = (item.get("account_name") or "").strip().lower()
        if account_id:
            if account_id not in account_ids:
                return {
                    "reason": "invalid_operation_payload",
                    "details": {
                        "operation_index": index,
                        "field": "account_id",
                        "value": account_id,
                        "expected": "existing account",
                    },
                }
        elif account_name:
            if (
                account_name not in account_map
                and account_name not in missing_account_names
            ):
                return {
                    "reason": "invalid_operation_payload",
                    "details": {
                        "operation_index": index,
                        "field": "account_name",
                        "value": account_name,
                        "expected": "existing or creatable account",
                    },
                }
        else:
            return {
                "reason": "invalid_operation_payload",
                "details": {
                    "operation_index": index,
                    "field": "account_ref",
                    "value": None,
                    "expected": "account_id or account_name",
                },
            }
        if op_type == "transfer":
            to_account_id = item.get("to_account_id")
            to_account_name = (
                item.get("to_account_name") or ""
            ).strip().lower()
            if to_account_id:
                if to_account_id not in account_ids:
                    return {
                        "reason": "invalid_operation_payload",
                        "details": {
                            "operation_index": index,
                            "field": "to_account_id",
                            "value": to_account_id,
                            "expected": "existing account",
                        },
                    }
            elif to_account_name:
                if (
                    to_account_name not in account_map
                    and to_account_name not in missing_account_names
                ):
                    return {
                        "reason": "invalid_operation_payload",
                        "details": {
                            "operation_index": index,
                            "field": "to_account_name",
                            "value": to_account_name,
                            "expected": "existing or creatable account",
                        },
                    }
            else:
                return {
                    "reason": "invalid_operation_payload",
                    "details": {
                        "operation_index": index,
                        "field": "to_account_ref",
                        "value": None,
                        "expected": "to_account_id or to_account_name",
                    },
                }
        if op_type in {"expense", "fee"}:
            category_id = item.get("category_id")
            category_name = (item.get("category_name") or "").strip().lower()
            if category_id:
                if category_id not in category_ids:
                    return {
                        "reason": "invalid_operation_payload",
                        "details": {
                            "operation_index": index,
                            "field": "category_id",
                            "value": category_id,
                            "expected": "existing category",
                        },
                    }
            elif category_name:
                if (
                    category_name not in category_map
                    and category_name not in missing_category_names
                ):
                    return {
                        "reason": "invalid_operation_payload",
                        "details": {
                            "operation_index": index,
                            "field": "category_name",
                            "value": category_name,
                            "expected": "existing or creatable category",
                        },
                    }
            elif op_type == "expense":
                if "прочее" not in category_map and "прочее" not in missing_category_names:
                    missing_category_names.add("прочее")
    return None


def _rollback_statement_apply(
    client: Any,
    created_transaction_ids: list[str],
    created_adjustment_event_ids: list[str],
    created_account_ids: list[str],
    created_category_ids: list[str],
    previous_debts: dict[str, Any] | None,
    payload: dict[str, Any],
    current_user: dict[str, Any],
    draft: dict[str, Any],
) -> None:
    if created_transaction_ids:
        client.table("account_balance_events").delete().in_(
            "transaction_id", created_transaction_ids
        ).execute()
        client.table("transactions").delete().in_(
            "id", created_transaction_ids
        ).execute()
    if created_adjustment_event_ids:
        client.table("account_balance_events").delete().in_(
            "id", created_adjustment_event_ids
        ).execute()
    if created_account_ids:
        client.table("accounts").delete().in_(
            "id", created_account_ids
        ).execute()
    if created_category_ids:
        client.table("categories").delete().in_(
            "id", created_category_ids
        ).execute()
    if previous_debts and payload.get("debts"):
        target_date = dt.date.fromisoformat(payload["debts"].get("date"))
        upsert_debts(
            current_user["sub"],
            draft["budget_id"],
            target_date,
            credit_cards=int(previous_debts.get("debt_cards_total", 0)),
            people_debts=int(previous_debts.get("debt_other_total", 0)),
        )


def _build_context(
    user_id: str,
    budget_id: str,
    as_of: dt.date,
) -> dict[str, Any]:
    accounts = get_accounts_with_balances(user_id, budget_id, as_of)
    categories = list_categories(user_id, budget_id)
    debts = get_debts_as_of(user_id, budget_id, as_of)
    rules = list_rules(user_id, budget_id)
    return {
        "as_of": as_of.isoformat(),
        "accounts": accounts,
        "categories": categories,
        "debts": debts,
        "rules": rules,
    }


def _map_operation_type(op_type: str | None) -> str | None:
    if not op_type:
        return None
    normalized = op_type.lower()
    if normalized == "commission":
        return "fee"
    if normalized in {"income", "expense", "transfer"}:
        return normalized
    return normalized


def _validate_draft_payload(payload: Any) -> list[str]:
    errors: list[str] = []
    if not isinstance(payload, dict):
        return ["Payload must be an object"]
    required_keys = {
        "operations",
        "summary",
        "accounts_to_create",
        "categories_to_create",
        "counterparties",
        "warnings",
    }
    missing = required_keys - payload.keys()
    if missing:
        errors.append(f"Missing keys: {', '.join(sorted(missing))}")
    operations = payload.get("operations")
    if not isinstance(operations, list):
        errors.append("operations must be a list")
    elif not operations:
        errors.append("operations cannot be empty")
    else:
        for index, item in enumerate(operations):
            if not isinstance(item, dict):
                errors.append(f"operations[{index}] must be an object")
                continue
            for key in ("date", "amount", "type", "account"):
                if item.get(key) in (None, ""):
                    errors.append(f"operations[{index}] missing {key}")
            op_type = (item.get("type") or "").lower()
            if op_type and op_type not in {
                "income",
                "expense",
                "transfer",
                "commission",
            }:
                errors.append(f"operations[{index}] invalid type")
    if not isinstance(payload.get("summary"), dict):
        errors.append("summary must be an object")
    if not isinstance(payload.get("accounts_to_create"), list):
        errors.append("accounts_to_create must be a list")
    if not isinstance(payload.get("categories_to_create"), list):
        errors.append("categories_to_create must be a list")
    if not isinstance(payload.get("counterparties"), list):
        errors.append("counterparties must be a list")
    if not isinstance(payload.get("warnings"), list):
        errors.append("warnings must be a list")
    return errors


def _normalize_operations(
    draft_payload: dict[str, Any],
    accounts: list[dict[str, Any]],
    categories: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[str], list[dict[str, Any]], list[dict[str, Any]]]:
    warnings: list[str] = []
    account_map = _account_name_map(accounts)
    category_map = _category_name_map(categories)
    normalized: list[dict[str, Any]] = []
    missing_accounts: dict[str, dict[str, Any]] = {}
    missing_categories: dict[str, dict[str, Any]] = {}
    for item in draft_payload.get("accounts_to_create") or []:
        name = (item.get("name") or "").strip()
        if not name:
            continue
        account_key = name.lower()
        if account_key in account_map or account_key in missing_accounts:
            continue
        kind = (item.get("type") or "bank").lower()
        if kind not in {"cash", "bank"}:
            kind = "bank"
        missing_accounts[account_key] = {
            "name": name,
            "kind": kind,
        }
    for item in draft_payload.get("categories_to_create") or []:
        name = (item.get("name") or "").strip()
        if not name:
            continue
        category_key = name.lower()
        if category_key in category_map or category_key in missing_categories:
            continue
        missing_categories[category_key] = {
            "name": name,
            "type": "expense",
        }
    for item in draft_payload.get("operations") or []:
        account_name = (item.get("account") or "").strip()
        account_key = account_name.lower()
        category_name = (item.get("category") or "").strip()
        category_key = category_name.lower()
        account_id = account_map.get(account_key) if account_name else None
        category_id = category_map.get(category_key) if category_name else None
        if account_name and not account_id:
            if account_key not in missing_accounts:
                missing_accounts[account_key] = {
                    "name": item.get("account"),
                    "kind": "bank",
                }
        if category_name and not category_id:
            if category_key not in missing_categories:
                missing_categories[category_key] = {
                    "name": item.get("category"),
                    "type": "expense",
                }
        op_type = (item.get("type") or "").lower()
        mapped_type = _map_operation_type(op_type)
        to_account_name = None
        to_account_id = None
        if mapped_type == "transfer":
            counterparty = (item.get("counterparty") or "").strip()
            if counterparty:
                counterparty_key = counterparty.lower()
                if counterparty_key in account_map:
                    to_account_name = counterparty
                    to_account_id = account_map.get(counterparty_key)
        normalized.append(
            {
                "date": item.get("date"),
                "type": mapped_type,
                "kind": "normal",
                "amount": item.get("amount"),
                "account_id": account_id,
                "to_account_id": to_account_id,
                "category_id": category_id,
                "tag": "one_time",
                "note": item.get("description"),
                "debt": None,
                "balance_after": item.get("balance_after"),
                "counterparty": item.get("counterparty"),
                "account_name": item.get("account"),
                "to_account_name": to_account_name,
                "category_name": item.get("category"),
            }
        )
    return (
        normalized,
        warnings,
        list(missing_accounts.values()),
        list(missing_categories.values()),
    )


@router.post("/statement-drafts")
async def post_statement_draft(
    budget_id: str = Form(...),
    file: UploadFile | None = File(None),
    statement_text: str | None = Form(None),
    source: str | None = Form(None),
    statement_date: dt.date | None = Form(None),
    current_user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    if statement_text is not None:
        statement_text = statement_text.strip()
    if statement_text:
        source_filename = None
        source_mime = source or "text/plain"
        source_value = source
        statement_text_value = statement_text
        rows_parsed = None
    else:
        if not file:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Statement file or text is required",
            )
        _ensure_supported_statement(file)
        raw = await file.read()
        source_filename = file.filename
        source_mime = file.content_type
        source_value = None
        content_type = (file.content_type or "").lower()
        filename = (file.filename or "").lower()
        is_csv = "csv" in content_type or filename.endswith(".csv")
        is_pdf = "pdf" in content_type or filename.endswith(".pdf")
        if is_csv:
            csv_rows = _parse_csv_rows(raw)
            normalized_rows = _normalize_csv_rows(csv_rows)
            rows_parsed = len(normalized_rows)
            statement_payload = {
                "source_type": "csv",
                "rows": normalized_rows,
            }
            statement_text_value = json.dumps(
                statement_payload, ensure_ascii=False
            )
        elif is_pdf:
            statement_text = _decode_statement(file, raw)
            pdf_rows = _pdf_text_to_rows(statement_text)
            rows_parsed = len(pdf_rows)
            statement_payload = {
                "source_type": "pdf",
                "rows": pdf_rows,
            }
            statement_text_value = json.dumps(
                statement_payload, ensure_ascii=False
            )
        else:
            statement_text_value = _decode_statement(file, raw)
            text_rows = _pdf_text_to_rows(statement_text_value)
            rows_parsed = len(text_rows)
            statement_payload = {
                "source_type": "text",
                "rows": text_rows,
            }
            statement_text_value = json.dumps(
                statement_payload, ensure_ascii=False
            )
        logger.info(
            "Statement import: rows_parsed=%d, file_name=%s",
            rows_parsed,
            source_filename,
        )
    as_of = statement_date or dt.date.today()
    context = _build_context(current_user["sub"], budget_id, as_of)
    if source_value:
        context["source"] = source_value
    try:
        draft_payload = generate_statement_draft(statement_text_value, context)
    except LLMError as exc:
        logger.error(
            "LLM draft generation failed: %s. Raw response: %s",
            exc,
            exc.raw_response,
        )
        failed_payload = {
            "error": str(exc),
            "llm_raw_response": exc.raw_response,
        }
        create_statement_draft(
            current_user["sub"],
            budget_id,
            source_filename,
            source_mime,
            statement_text_value,
            settings.LLM_MODEL,
            failed_payload,
            status="failed",
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="LLM response is invalid",
        ) from exc
    validation_errors = _validate_draft_payload(draft_payload)
    if validation_errors:
        logger.error(
            "LLM draft validation failed: %s. Payload: %s",
            validation_errors,
            json.dumps(draft_payload, ensure_ascii=False),
        )
        failed_payload = {
            "error": "LLM response does not match contract",
            "validation_errors": validation_errors,
            "llm_raw_response": json.dumps(draft_payload, ensure_ascii=False),
        }
        create_statement_draft(
            current_user["sub"],
            budget_id,
            source_filename,
            source_mime,
            statement_text_value,
            settings.LLM_MODEL,
            failed_payload,
            status="failed",
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="LLM response does not match contract",
        )
    operations_returned = len(draft_payload.get("operations") or [])
    logger.info(
        "Statement draft: operations_returned=%d",
        operations_returned,
    )
    if rows_parsed is not None and rows_parsed > operations_returned:
        logger.error(
            "Data loss detected: CSV rows=%d, operations=%d",
            rows_parsed,
            operations_returned,
        )
    accounts = list_accounts(current_user["sub"], budget_id, as_of)
    categories = list_categories(current_user["sub"], budget_id)
    draft_payload["context"] = context
    (
        normalized_transactions,
        warnings,
        missing_accounts,
        missing_categories,
    ) = _normalize_operations(
        draft_payload, accounts, categories
    )
    draft_payload["normalized_transactions"] = normalized_transactions
    if missing_accounts:
        draft_payload["missing_accounts"] = missing_accounts
    if missing_categories:
        draft_payload["missing_categories"] = missing_categories
    if source_value:
        draft_payload["source"] = source_value
    if warnings:
        draft_payload["warnings"] = warnings
    draft = create_statement_draft(
        current_user["sub"],
        budget_id,
        source_filename,
        source_mime,
        statement_text_value,
        settings.LLM_MODEL,
        draft_payload,
    )
    return {"draft": draft, "payload": draft_payload}


@router.post("/statement-drafts/{draft_id}/revise")
def revise_statement_draft(
    draft_id: str,
    feedback: str = Form(...),
    current_user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    draft = get_statement_draft(current_user["sub"], draft_id)
    context = _build_context(
        current_user["sub"], draft["budget_id"], dt.date.today()
    )
    base_payload = {
        "statement_text": draft.get("source_text"),
        "previous_draft": draft.get("draft_payload"),
        "feedback": feedback,
    }
    try:
        revised_payload = generate_statement_draft(
            json.dumps(base_payload, ensure_ascii=False),
            {"context": context},
        )
    except LLMError as exc:
        logger.error(
            "LLM revise failed: %s. Raw response: %s", exc, exc.raw_response
        )
        update_statement_draft(
            current_user["sub"],
            draft_id,
            {
                "draft_payload": {
                    "error": str(exc),
                    "llm_raw_response": exc.raw_response,
                },
                "feedback": feedback,
                "status": "failed",
                "updated_at": dt.datetime.utcnow().isoformat(),
            },
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="LLM response is invalid",
        ) from exc
    validation_errors = _validate_draft_payload(revised_payload)
    if validation_errors:
        logger.error(
            "LLM revise validation failed: %s. Payload: %s",
            validation_errors,
            json.dumps(revised_payload, ensure_ascii=False),
        )
        update_statement_draft(
            current_user["sub"],
            draft_id,
            {
                "draft_payload": {
                    "error": "LLM response does not match contract",
                    "validation_errors": validation_errors,
                    "llm_raw_response": json.dumps(
                        revised_payload, ensure_ascii=False
                    ),
                },
                "feedback": feedback,
                "status": "failed",
                "updated_at": dt.datetime.utcnow().isoformat(),
            },
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="LLM response does not match contract",
        )
    revised_payload["context"] = context
    accounts = list_accounts(current_user["sub"], draft["budget_id"])
    categories = list_categories(current_user["sub"], draft["budget_id"])
    (
        normalized_transactions,
        warnings,
        missing_accounts,
        missing_categories,
    ) = _normalize_operations(
        revised_payload, accounts, categories
    )
    revised_payload["normalized_transactions"] = normalized_transactions
    if missing_accounts:
        revised_payload["missing_accounts"] = missing_accounts
    if missing_categories:
        revised_payload["missing_categories"] = missing_categories
    if warnings:
        revised_payload["warnings"] = warnings
    updated = update_statement_draft(
        current_user["sub"],
        draft_id,
        {
            "draft_payload": revised_payload,
            "feedback": feedback,
            "status": "revised",
            "updated_at": dt.datetime.utcnow().isoformat(),
        },
    )
    return {"draft": updated, "payload": revised_payload}


@router.post("/statement-drafts/{draft_id}/apply")
def apply_statement_draft(
    draft_id: str,
    confirm: bool = Form(...),
    current_user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    if not confirm:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Confirmation required",
        )
    draft = get_statement_draft(current_user["sub"], draft_id)
    payload = draft.get("draft_payload") or {}
    operations_count = len(payload.get("normalized_transactions") or [])
    logger.info(
        "Applying statement draft %s: operations=%d",
        draft_id,
        operations_count,
    )
    if draft.get("status") == "applied":
        return _statement_apply_error_response(
            "already_applied",
            {"draft_id": draft_id, "status": "applied"},
            status_code=status.HTTP_409_CONFLICT,
        )
    if draft.get("status") == "failed":
        stored_error = payload.get("apply_error") or {}
        return _statement_apply_error_response(
            stored_error.get("reason") or "draft_failed",
            stored_error.get("details") or {"draft_id": draft_id},
            status_code=status.HTTP_409_CONFLICT,
        )
    transactions = payload.get("normalized_transactions") or []
    errors: list[str] = []
    created: list[dict[str, Any]] = []
    created_transaction_ids: list[str] = []
    created_category_ids: list[str] = []
    created_account_ids: list[str] = []
    created_adjustment_event_ids: list[str] = []
    previous_debts: dict[str, Any] | None = None
    client = get_supabase_client()
    missing_accounts = payload.get("missing_accounts") or []
    missing_categories = payload.get("missing_categories") or []
    as_of = dt.date.today()
    accounts = list_accounts(current_user["sub"], draft["budget_id"], as_of)
    categories = list_categories(current_user["sub"], draft["budget_id"])
    account_map = _account_name_map(accounts)
    category_map = _category_name_map(categories)
    validation_error = _validate_apply_operations(
        transactions,
        account_map,
        category_map,
        missing_accounts,
        missing_categories,
    )
    if validation_error:
        logger.info(
            "Validation failed for draft %s: %s",
            draft_id,
            validation_error,
        )
        apply_error = {
            "reason": validation_error["reason"],
            "details": validation_error["details"],
        }
        update_statement_draft(
            current_user["sub"],
            draft_id,
            {
                "status": "failed",
                "draft_payload": {**payload, "apply_error": apply_error},
                "updated_at": dt.datetime.utcnow().isoformat(),
            },
        )
        return _statement_apply_error_response(
            validation_error["reason"],
            validation_error["details"],
            status_code=status.HTTP_400_BAD_REQUEST,
        )
    transactions = _normalize_statement_transactions(transactions)
    payload["normalized_transactions"] = transactions
    logger.info(
        "Validation passed for draft %s: operations=%d",
        draft_id,
        len(transactions),
    )
    try:
        if missing_categories:
            from app.repositories.categories import create_category

            for item in missing_categories:
                name = (item.get("name") or "").strip()
                if not name:
                    continue
                if name.lower() in category_map:
                    continue
                created_category = create_category(
                    current_user["sub"], draft["budget_id"], name
                )
                created_category_ids.append(created_category["id"])
                category_map[name.lower()] = created_category["id"]
        if missing_accounts:
            from app.repositories.accounts import create_account

            for item in missing_accounts:
                name = (item.get("name") or "").strip()
                if not name:
                    continue
                if name.lower() in account_map:
                    continue
                kind = (item.get("kind") or "bank").lower()
                if kind == "card":
                    kind = "bank"
                if kind not in ("cash", "bank"):
                    kind = "bank"
                created_account = create_account(
                    current_user["sub"],
                    draft["budget_id"],
                    name,
                    kind,
                    as_of,
                    0,
                )
                created_account_ids.append(created_account["id"])
                account_map[name.lower()] = created_account["id"]
        accounts = list_accounts(
            current_user["sub"], draft["budget_id"], as_of
        )
        categories = list_categories(current_user["sub"], draft["budget_id"])
        account_map = _account_name_map(accounts)
        category_map = _category_name_map(categories)
        if any(
            item.get("type") == "expense"
            and not (item.get("category_name") or "").strip()
            for item in transactions
        ):
            from app.repositories.categories import create_category

            if "прочее" not in category_map:
                created_category = create_category(
                    current_user["sub"], draft["budget_id"], "Прочее"
                )
                created_category_ids.append(created_category["id"])
                category_map["прочее"] = created_category["id"]
        for index, item in enumerate(transactions, start=1):
            if not item.get("account_id"):
                account_name = (item.get("account_name") or "").strip().lower()
                item["account_id"] = account_map.get(account_name)
            if not item.get("account_id"):
                raise ValueError(
                    f"Не найден счет для транзакции: {item.get('account_name')}"
                )
            if item.get("type") == "transfer" and not item.get("to_account_id"):
                to_account_name = (
                    item.get("to_account_name") or ""
                ).strip().lower()
                item["to_account_id"] = account_map.get(to_account_name)
            if item.get("type") == "transfer" and not item.get("to_account_id"):
                raise ValueError(
                    "Не найден счет назначения для перевода: "
                    f"{item.get('to_account_name')}"
                )
            if item.get("type") == "expense" and not item.get("category_id"):
                category_name = (item.get("category_name") or "").strip().lower()
                if category_name:
                    item["category_id"] = category_map.get(category_name)
                else:
                    item["category_id"] = category_map.get("прочее")
            if item.get("type") == "fee" and not item.get("category_id"):
                category_name = (item.get("category_name") or "").strip().lower()
                if category_name:
                    item["category_id"] = category_map.get(category_name)
            tx_payload = {
                "budget_id": draft["budget_id"],
                "type": item.get("type"),
                "kind": item.get("kind") or "normal",
                "amount": item.get("amount"),
                "date": item.get("date"),
                "account_id": item.get("account_id"),
                "to_account_id": item.get("to_account_id"),
                "category_id": item.get("category_id"),
                "tag": item.get("tag") or "one_time",
                "note": item.get("note"),
            }
            debt = item.get("debt")
            if debt:
                tx_payload["kind"] = "debt"
                tx_payload["note"] = json.dumps(debt, ensure_ascii=False)
            operation_id = item.get("id") or item.get("operation_id") or index
            logger.info(
                "Applying operation #%s: amount=%s (%s)",
                operation_id,
                tx_payload.get("amount"),
                type(tx_payload.get("amount")).__name__,
            )
            transaction = create_transaction(current_user["sub"], tx_payload)
            created.append(transaction)
            if transaction.get("id"):
                created_transaction_ids.append(transaction["id"])
        for adjust in payload.get("balance_adjustments") or []:
            account_name = (adjust.get("account_name") or "").strip().lower()
            account_map = _account_name_map(
                list_accounts(current_user["sub"], draft["budget_id"])
            )
            account_id = account_map.get(account_name)
            if not account_id:
                raise ValueError(
                    f"Не найден счет для корректировки: {account_name}"
                )
            event = create_balance_event(
                current_user["sub"],
                draft["budget_id"],
                dt.date.fromisoformat(adjust.get("date")),
                account_id,
                int(adjust.get("delta", 0)),
                RECONCILE_ADJUST_REASON,
            )
            if event.get("id"):
                created_adjustment_event_ids.append(event["id"])
        debts = payload.get("debts")
        if debts:
            target_date = dt.date.fromisoformat(debts.get("date"))
            previous_debts = get_debts_as_of(
                current_user["sub"], draft["budget_id"], target_date
            )
            upsert_debts(
                current_user["sub"],
                draft["budget_id"],
                target_date,
                credit_cards=int(debts.get("credit_cards_total", 0)),
                people_debts=int(debts.get("people_debts_total", 0)),
            )
        updated = update_statement_draft(
            current_user["sub"],
            draft_id,
            {"status": "applied", "updated_at": dt.datetime.utcnow().isoformat()},
        )
        return {
            "draft": updated,
            "created_transactions": created,
            "errors": errors,
        }
    except HTTPException:
        raise
    except ValueError as exc:
        logger.error("Statement apply failed: %s", exc)
        _rollback_statement_apply(
            client,
            created_transaction_ids,
            created_adjustment_event_ids,
            created_account_ids,
            created_category_ids,
            previous_debts,
            payload,
            current_user,
            draft,
        )
        apply_error = {
            "reason": "invalid_operation_payload",
            "details": {"message": str(exc)},
        }
        update_statement_draft(
            current_user["sub"],
            draft_id,
            {
                "status": "failed",
                "draft_payload": {**payload, "apply_error": apply_error},
                "updated_at": dt.datetime.utcnow().isoformat(),
            },
        )
        return _statement_apply_error_response(
            "invalid_operation_payload",
            {"message": str(exc)},
            status_code=status.HTTP_400_BAD_REQUEST,
        )
    except Exception as exc:
        logger.error("Statement apply failed: %s", exc)
        _rollback_statement_apply(
            client,
            created_transaction_ids,
            created_adjustment_event_ids,
            created_account_ids,
            created_category_ids,
            previous_debts,
            payload,
            current_user,
            draft,
        )
        apply_error = {
            "reason": "internal_error",
            "details": {"message": str(exc)},
        }
        update_statement_draft(
            current_user["sub"],
            draft_id,
            {
                "status": "failed",
                "draft_payload": {**payload, "apply_error": apply_error},
                "updated_at": dt.datetime.utcnow().isoformat(),
            },
        )
        return _statement_apply_error_response(
            "internal_error",
            {"message": "Failed to apply statement draft"},
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        )
