from __future__ import annotations

import csv
import datetime as dt
import io
import json
import logging
from typing import Any

import openpyxl
import pdfplumber
import xlrd
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status

from app.auth.jwt import get_current_user
from app.core.config import settings
from app.integrations.llm_client import LLMError, generate_statement_draft
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
    is_xlsx = (
        "spreadsheetml.sheet" in content_type or filename.endswith(".xlsx")
    )
    is_xls = "ms-excel" in content_type or filename.endswith(".xls")
    if not (is_csv or is_text or is_xlsx or is_xls or is_pdf):
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="Поддерживаются только PDF, XLS/XLSX или CSV выписки. "
            "Сохраните файл в поддерживаемом формате и попробуйте снова.",
        )


def _cell_to_text(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _rows_to_csv(rows: list[list[Any]]) -> str:
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    for row in rows:
        writer.writerow([_cell_to_text(cell) for cell in row])
    return buffer.getvalue()


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


def _decode_xlsx(raw_bytes: bytes) -> str:
    workbook = openpyxl.load_workbook(
        filename=io.BytesIO(raw_bytes), data_only=True
    )
    sheet = workbook.active
    rows = list(sheet.iter_rows(values_only=True))
    table = _rows_to_csv([list(row) for row in rows])
    return f"Sheet: {sheet.title}\n{table}".strip()


def _decode_xls(raw_bytes: bytes) -> str:
    workbook = xlrd.open_workbook(file_contents=raw_bytes)
    sheet = workbook.sheet_by_index(0)
    rows = [sheet.row_values(row_idx) for row_idx in range(sheet.nrows)]
    table = _rows_to_csv(rows)
    return f"Sheet: {sheet.name}\n{table}".strip()


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
    if "spreadsheetml.sheet" in content_type or filename.endswith(".xlsx"):
        return _decode_xlsx(raw_bytes)
    if "ms-excel" in content_type or filename.endswith(".xls"):
        return _decode_xls(raw_bytes)
    return raw_bytes.decode("utf-8", errors="replace")


def _account_name_map(accounts: list[dict[str, Any]]) -> dict[str, str]:
    return {account["name"].lower(): account["id"] for account in accounts}


def _category_name_map(categories: list[dict[str, Any]]) -> dict[str, str]:
    return {category["name"].lower(): category["id"] for category in categories}


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


def _normalize_transactions(
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
    for item in draft_payload.get("transactions") or []:
        account_name = (item.get("account_name") or "").strip().lower()
        to_account_name = (item.get("to_account_name") or "").strip().lower()
        category_name = (item.get("category_name") or "").strip().lower()
        account_id = account_map.get(account_name) if account_name else None
        to_account_id = account_map.get(to_account_name) if to_account_name else None
        category_id = category_map.get(category_name) if category_name else None
        if account_name and not account_id:
            warnings.append(f"Счет не найден: {item.get('account_name')}")
            if account_name not in missing_accounts:
                missing_accounts[account_name] = {
                    "name": item.get("account_name"),
                    "kind": item.get("account_kind") or "bank",
                }
        if to_account_name and not to_account_id:
            warnings.append(
                f"Счет назначения не найден: {item.get('to_account_name')}"
            )
            if to_account_name not in missing_accounts:
                missing_accounts[to_account_name] = {
                    "name": item.get("to_account_name"),
                    "kind": item.get("to_account_kind") or "bank",
                }
        if category_name and not category_id:
            warnings.append(
                f"Категория не найдена: {item.get('category_name')}"
            )
            if category_name not in missing_categories:
                missing_categories[category_name] = {
                    "name": item.get("category_name"),
                    "type": item.get("category_type") or "expense",
                }
        normalized.append(
            {
                "date": item.get("date"),
                "type": item.get("type"),
                "kind": item.get("kind"),
                "amount": item.get("amount"),
                "account_id": account_id,
                "to_account_id": to_account_id,
                "category_id": category_id,
                "tag": item.get("tag"),
                "note": item.get("note"),
                "debt": item.get("debt"),
                "account_name": item.get("account_name"),
                "to_account_name": item.get("to_account_name"),
                "category_name": item.get("category_name"),
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
        statement_text_value = _decode_statement(file, raw)
    as_of = statement_date or dt.date.today()
    context = _build_context(current_user["sub"], budget_id, as_of)
    if source_value:
        context["source"] = source_value
    try:
        draft_payload = generate_statement_draft(statement_text_value, context)
    except LLMError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)
        ) from exc
    if draft_payload.get("notes"):
        draft_payload.setdefault("warnings", [])
        draft_payload["warnings"].extend(draft_payload.get("notes") or [])
    accounts = list_accounts(current_user["sub"], budget_id, as_of)
    categories = list_categories(current_user["sub"], budget_id)
    draft_payload["context"] = context
    (
        normalized_transactions,
        warnings,
        missing_accounts,
        missing_categories,
    ) = _normalize_transactions(
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
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)
        ) from exc
    if revised_payload.get("notes"):
        revised_payload.setdefault("warnings", [])
        revised_payload["warnings"].extend(revised_payload.get("notes") or [])
    revised_payload["context"] = context
    accounts = list_accounts(current_user["sub"], draft["budget_id"])
    categories = list_categories(current_user["sub"], draft["budget_id"])
    (
        normalized_transactions,
        warnings,
        missing_accounts,
        missing_categories,
    ) = _normalize_transactions(
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
    transactions = payload.get("normalized_transactions") or []
    errors: list[str] = []
    created: list[dict[str, Any]] = []
    missing_accounts = payload.get("missing_accounts") or []
    missing_categories = payload.get("missing_categories") or []
    as_of = dt.date.today()
    if missing_categories:
        categories = list_categories(current_user["sub"], draft["budget_id"])
        category_map = _category_name_map(categories)
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
            category_map[name.lower()] = created_category["id"]
    if missing_accounts:
        accounts = list_accounts(
            current_user["sub"], draft["budget_id"], as_of
        )
        account_map = _account_name_map(accounts)
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
            account_map[name.lower()] = created_account["id"]
    accounts = list_accounts(current_user["sub"], draft["budget_id"], as_of)
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
            category_map["прочее"] = created_category["id"]
    for item in transactions:
        if not item.get("account_id"):
            account_name = (item.get("account_name") or "").strip().lower()
            item["account_id"] = account_map.get(account_name)
        if not item.get("account_id"):
            errors.append(
                f"Не найден счет для транзакции: {item.get('account_name')}"
            )
            continue
        if item.get("type") == "transfer" and not item.get("to_account_id"):
            to_account_name = (item.get("to_account_name") or "").strip().lower()
            item["to_account_id"] = account_map.get(to_account_name)
        if item.get("type") == "transfer" and not item.get("to_account_id"):
            errors.append(
                "Не найден счет назначения для перевода: "
                f"{item.get('to_account_name')}"
            )
            continue
        if item.get("type") == "expense" and not item.get("category_id"):
            category_name = (item.get("category_name") or "").strip().lower()
            if category_name:
                item["category_id"] = category_map.get(category_name)
            else:
                item["category_id"] = category_map.get("прочее")
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
        created.append(create_transaction(current_user["sub"], tx_payload))
    for adjust in payload.get("balance_adjustments") or []:
        account_name = (adjust.get("account_name") or "").strip().lower()
        account_map = _account_name_map(
            list_accounts(current_user["sub"], draft["budget_id"])
        )
        account_id = account_map.get(account_name)
        if not account_id:
            errors.append(f"Не найден счет для корректировки: {account_name}")
            continue
        create_balance_event(
            current_user["sub"],
            draft["budget_id"],
            dt.date.fromisoformat(adjust.get("date")),
            account_id,
            int(adjust.get("delta", 0)),
            RECONCILE_ADJUST_REASON,
        )
    debts = payload.get("debts")
    if debts:
        target_date = dt.date.fromisoformat(debts.get("date"))
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
