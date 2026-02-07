from __future__ import annotations

import io
import logging
import re
from dataclasses import dataclass
from typing import Any

import httpx
import pdfplumber
from telegram import Update
from telegram.constants import ChatAction
from telegram.ext import (
    Application,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

from app.core.config import get_telegram_bot_token, settings

logger = logging.getLogger(__name__)

STATE_WAITING_STATEMENT_FILE = "WAITING_STATEMENT_FILE"
STATE_WAITING_STATEMENT_FEEDBACK = "WAITING_STATEMENT_FEEDBACK"
STATE_WAITING_STATEMENT_CONFIRM = "WAITING_STATEMENT_CONFIRM"

STATEMENT_COMMAND_TEXT = (
    "📄 Загрузка банковской выписки\n\n"
    "1️⃣ Пришлите файл выписки:\n"
    "— PDF\n"
    "— Excel (.xls / .xlsx)\n"
    "— CSV\n\n"
    "2️⃣ Выписка должна содержать:\n"
    "— дату операции\n"
    "— сумму\n"
    "— описание (если есть)\n\n"
    "3️⃣ После загрузки я:\n"
    "— распознаю операции\n"
    "— предложу категории и счета\n"
    "— создам недостающие категории и счета (если подтвердите)\n"
    "— покажу черновик перед применением\n\n"
    "📎 Просто отправьте файл следующим сообщением"
)

INVALID_FILE_TEXT = (
    "❌ Неверный формат файла.\n\n"
    "Пожалуйста, отправь выписку в формате PDF, XLS/XLSX или CSV."
)

CONFIRM_SUCCESS_TEXT = (
    "✅ Выписка успешно применена.\n"
    "Операции добавлены в учёт."
)

PDF_RECEIVED_TEXT = (
    "📄 Получен PDF-файл.\n"
    "Пробую извлечь текст выписки…"
)

PDF_UNSUPPORTED_TEXT = (
    "⚠️ Не удалось корректно извлечь данные из PDF.\n"
    "Проверь, что файл — текстовый, а не скан."
)

PDF_MIN_TEXT_LENGTH = 300
PDF_MIN_ALNUM_RATIO = 0.3


@dataclass
class DraftContext:
    draft_id: str
    budget_id: str


def build_application(token: str) -> Application:
    return Application.builder().token(token).build()


def _get_jwt(context: ContextTypes.DEFAULT_TYPE) -> str | None:
    return context.user_data.get("jwt")


def _get_budget_id(context: ContextTypes.DEFAULT_TYPE) -> str | None:
    return context.user_data.get("budget_id")


def _set_state(context: ContextTypes.DEFAULT_TYPE, state: str | None) -> None:
    if state is None:
        context.user_data.pop("state", None)
        return
    context.user_data["state"] = state


def _get_state(context: ContextTypes.DEFAULT_TYPE) -> str | None:
    return context.user_data.get("state")


def _get_draft_context(context: ContextTypes.DEFAULT_TYPE) -> DraftContext | None:
    raw = context.user_data.get("draft_context")
    if not isinstance(raw, dict):
        return None
    draft_id = raw.get("draft_id")
    budget_id = raw.get("budget_id")
    if not draft_id or not budget_id:
        return None
    return DraftContext(draft_id=draft_id, budget_id=budget_id)


def _set_draft_context(
    context: ContextTypes.DEFAULT_TYPE, draft_id: str, budget_id: str
) -> None:
    context.user_data["draft_context"] = {
        "draft_id": draft_id,
        "budget_id": budget_id,
    }


def _clear_draft_context(context: ContextTypes.DEFAULT_TYPE) -> None:
    context.user_data.pop("draft_context", None)


async def _ensure_auth(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> str | None:
    jwt_token = _get_jwt(context)
    if jwt_token:
        return jwt_token
    if not update.effective_user:
        return None
    telegram_id = update.effective_user.id
    payload = {
        "telegram_id": telegram_id,
        "username": update.effective_user.username,
        "first_name": update.effective_user.first_name,
        "last_name": update.effective_user.last_name,
    }
    url = f"{settings.BACKEND_API_BASE_URL.rstrip('/')}/auth/telegram-bot"
    headers: dict[str, str] = {}
    bot_token = get_telegram_bot_token()
    if bot_token:
        headers["X-Telegram-Bot-Token"] = bot_token
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.post(url, json=payload, headers=headers)
            response.raise_for_status()
            data = response.json()
    except httpx.HTTPError as exc:
        logger.exception("Telegram auth failed")
        await update.effective_message.reply_text(
            f"Ошибка авторизации: {_format_http_error(exc)}"
        )
        return None
    jwt_token = data.get("access_token") if isinstance(data, dict) else None
    if not jwt_token:
        await update.effective_message.reply_text(
            "Ошибка авторизации: токен не получен."
        )
        return None
    context.user_data["jwt"] = jwt_token
    return jwt_token


async def _ensure_budget(
    update: Update, context: ContextTypes.DEFAULT_TYPE, jwt_token: str
) -> str | None:
    budget_id = _get_budget_id(context)
    if budget_id:
        return budget_id
    try:
        budgets = await _request_budgets(jwt_token)
    except httpx.HTTPError as exc:
        logger.exception("Budget fetch failed")
        await update.effective_message.reply_text(
            f"Ошибка получения бюджета: {_format_http_error(exc)}"
        )
        return None
    if not budgets:
        await update.effective_message.reply_text(
            "Не найден бюджет для пользователя."
        )
        return None
    selected = budgets[0]
    budget_id = selected.get("id") if isinstance(selected, dict) else None
    if not budget_id:
        await update.effective_message.reply_text(
            "Не удалось определить бюджет пользователя."
        )
        return None
    context.user_data["budget_id"] = budget_id
    return budget_id


def _is_csv_document(document: Any) -> bool:
    mime_type = (getattr(document, "mime_type", "") or "").lower()
    filename = (getattr(document, "file_name", "") or "").lower()
    if mime_type == "text/csv":
        return True
    return filename.endswith(".csv")


def _is_pdf_document(document: Any) -> bool:
    mime_type = (getattr(document, "mime_type", "") or "").lower()
    filename = (getattr(document, "file_name", "") or "").lower()
    if mime_type == "application/pdf":
        return True
    return filename.endswith(".pdf")


def _is_excel_document(document: Any) -> bool:
    mime_type = (getattr(document, "mime_type", "") or "").lower()
    filename = (getattr(document, "file_name", "") or "").lower()
    if "spreadsheetml.sheet" in mime_type or "ms-excel" in mime_type:
        return True
    return filename.endswith((".xls", ".xlsx"))


def _clean_pdf_text(raw_text: str) -> str:
    lines = []
    for line in raw_text.splitlines():
        cleaned = re.sub(r"[ \t]+", " ", line).strip()
        if cleaned:
            lines.append(cleaned)
    return "\n".join(lines)


def _is_supported_pdf_text(text: str) -> bool:
    if len(text) < PDF_MIN_TEXT_LENGTH:
        return False
    alnum_count = sum(char.isalnum() for char in text)
    if not text:
        return False
    return (alnum_count / len(text)) >= PDF_MIN_ALNUM_RATIO


def _extract_pdf_text(pdf_bytes: bytes) -> str | None:
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
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
    if not cleaned or not _is_supported_pdf_text(cleaned):
        return None
    return cleaned


async def _request_statement_draft(
    jwt_token: str,
    budget_id: str,
    file_bytes: bytes,
    filename: str,
    mime_type: str,
) -> dict[str, Any]:
    url = f"{settings.BACKEND_API_BASE_URL.rstrip('/')}/ai/statement-drafts"
    data = {"budget_id": budget_id}
    files = {"file": (filename, io.BytesIO(file_bytes), mime_type)}
    headers = {"Authorization": f"Bearer {jwt_token}"}
    async with httpx.AsyncClient(timeout=60) as client:
        response = await client.post(url, data=data, files=files, headers=headers)
        response.raise_for_status()
        return response.json()


async def _request_statement_draft_text(
    jwt_token: str,
    budget_id: str,
    statement_text: str,
    source: str,
) -> dict[str, Any]:
    url = f"{settings.BACKEND_API_BASE_URL.rstrip('/')}/ai/statement-drafts"
    data = {
        "budget_id": budget_id,
        "statement_text": statement_text,
        "source": source,
    }
    headers = {"Authorization": f"Bearer {jwt_token}"}
    async with httpx.AsyncClient(timeout=60) as client:
        response = await client.post(url, data=data, headers=headers)
        response.raise_for_status()
        return response.json()


async def _request_statement_apply(
    jwt_token: str,
    draft_id: str,
) -> dict[str, Any]:
    url = (
        f"{settings.BACKEND_API_BASE_URL.rstrip('/')}/ai/statement-drafts/"
        f"{draft_id}/apply"
    )
    headers = {"Authorization": f"Bearer {jwt_token}"}
    data = {"confirm": "true"}
    async with httpx.AsyncClient(timeout=60) as client:
        response = await client.post(url, data=data, headers=headers)
        response.raise_for_status()
        return response.json()


async def _request_statement_revise(
    jwt_token: str, draft_id: str, feedback: str
) -> dict[str, Any]:
    url = (
        f"{settings.BACKEND_API_BASE_URL.rstrip('/')}/ai/statement-drafts/"
        f"{draft_id}/revise"
    )
    headers = {"Authorization": f"Bearer {jwt_token}"}
    data = {"feedback": feedback}
    async with httpx.AsyncClient(timeout=60) as client:
        response = await client.post(url, data=data, headers=headers)
        response.raise_for_status()
        return response.json()


async def _request_budgets(jwt_token: str) -> list[dict[str, Any]]:
    url = f"{settings.BACKEND_API_BASE_URL.rstrip('/')}/budgets"
    headers = {"Authorization": f"Bearer {jwt_token}"}
    async with httpx.AsyncClient(timeout=20) as client:
        response = await client.get(url, headers=headers)
        response.raise_for_status()
        data = response.json()
        return data if isinstance(data, list) else []


def _format_currency(amount: Any) -> str:
    try:
        value = float(amount)
    except (TypeError, ValueError):
        return str(amount)
    if value.is_integer():
        return f"{int(value)}"
    return f"{value:.2f}"


def _format_signed_amount(value: float) -> str:
    sign = "+" if value > 0 else "-" if value < 0 else ""
    return f"{sign}{_format_currency(abs(value))}"


def _extract_amount(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _format_warnings(warnings: list[str]) -> str:
    if not warnings:
        return ""
    return "\n".join(f"— {warning}" for warning in warnings)


def _format_http_error(exc: httpx.HTTPError) -> str:
    if isinstance(exc, httpx.HTTPStatusError):
        try:
            payload = exc.response.json()
        except ValueError:
            return exc.response.text or str(exc)
        if isinstance(payload, dict):
            detail = payload.get("detail")
            if detail:
                return str(detail)
        return str(payload)
    return str(exc)


def _build_draft_message(payload: dict[str, Any]) -> str:
    transactions = payload.get("transactions") or []
    normalized = payload.get("normalized_transactions") or []
    warnings = payload.get("warnings") or []
    missing_accounts = payload.get("missing_accounts") or []
    missing_categories = payload.get("missing_categories") or []
    counterparties = payload.get("counterparties") or []
    expenses = [tx for tx in transactions if tx.get("type") == "expense"]
    fees = [tx for tx in transactions if tx.get("type") == "fee"]
    incomes = [tx for tx in transactions if tx.get("type") == "income"]
    transfers = [tx for tx in transactions if tx.get("type") == "transfer"]
    expense_total = sum(_extract_amount(tx.get("amount")) for tx in expenses)
    fee_total = sum(_extract_amount(tx.get("amount")) for tx in fees)
    income_total = sum(_extract_amount(tx.get("amount")) for tx in incomes)
    net_total = income_total - expense_total - fee_total
    account_totals: dict[str, float] = {}
    for tx in transactions:
        amount = _extract_amount(tx.get("amount"))
        account_name = tx.get("account_name") or "Без счета"
        if tx.get("type") == "expense":
            account_totals[account_name] = account_totals.get(
                account_name, 0.0
            ) - amount
        elif tx.get("type") == "fee":
            account_totals[account_name] = account_totals.get(
                account_name, 0.0
            ) - amount
        elif tx.get("type") == "income":
            account_totals[account_name] = account_totals.get(
                account_name, 0.0
            ) + amount
        elif tx.get("type") == "transfer":
            account_totals[account_name] = account_totals.get(
                account_name, 0.0
            ) - amount
            to_name = tx.get("to_account_name") or "Без счета"
            account_totals[to_name] = account_totals.get(to_name, 0.0) + amount
    account_lines = [
        f"— {name}: {_format_signed_amount(total)}"
        for name, total in account_totals.items()
    ]
    if not account_lines:
        account_lines = ["— (нет)"]
    lines = [
        "🤖 Я подготовил черновик выписки\n",
        "1️⃣ Количество операций (всего / по типам)",
        f"— Всего: {len(transactions)}",
        f"— Доходы: {len(incomes)}",
        f"— Расходы: {len(expenses)}",
        f"— Переводы: {len(transfers)}",
        f"— Комиссии: {len(fees)}\n",
        "2️⃣ Итоги (income / expense / net)",
        f"— Доходы: {_format_signed_amount(income_total)}",
        f"— Расходы: {_format_signed_amount(-expense_total)}",
        f"— Комиссии: {_format_signed_amount(-fee_total)}",
        f"— Чистый итог: {_format_signed_amount(net_total)}\n",
        "3️⃣ Счета и их изменение",
        *account_lines,
    ]
    if missing_accounts:
        lines.append("\n4️⃣ Что будет создано")
        lines.append("— Счета:")
        for item in missing_accounts:
            name = item.get("name") or "Без названия"
            kind = item.get("kind") or "bank"
            lines.append(f"— {name} (тип: {kind})")
    if missing_categories:
        if not missing_accounts:
            lines.append("\n4️⃣ Что будет создано")
        lines.append("— Категории:")
        for item in missing_categories:
            name = item.get("name") or "Без названия"
            lines.append(f"— {name}")
    if counterparties:
        lines.append("\n5️⃣ Контрагенты")
        for name in counterparties:
            lines.append(f"— {name}")
    if warnings:
        lines.append("\n6️⃣ Warnings")
        lines.append(_format_warnings(warnings))
    lines.append("\n7️⃣ Вопрос подтверждения")
    lines.append("❓ Применить изменения? Напишите: Да / Отмена")
    return "\n".join(lines)


async def command_statement(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> None:
    await update.effective_message.reply_text(STATEMENT_COMMAND_TEXT)
    _set_state(context, STATE_WAITING_STATEMENT_FILE)


async def handle_document(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> None:
    if _get_state(context) != STATE_WAITING_STATEMENT_FILE:
        return
    document = update.message.document if update.message else None
    if not document or not (
        _is_csv_document(document)
        or _is_pdf_document(document)
        or _is_excel_document(document)
    ):
        await update.effective_message.reply_text(INVALID_FILE_TEXT)
        return
    jwt_token = await _ensure_auth(update, context)
    if not jwt_token:
        return
    budget_id = await _ensure_budget(update, context, jwt_token)
    if not budget_id:
        return
    file = await document.get_file()
    if _is_pdf_document(document):
        await update.effective_message.reply_text(PDF_RECEIVED_TEXT)
        await update.effective_message.chat.send_action(ChatAction.UPLOAD_DOCUMENT)
        pdf_bytes = await file.download_as_bytearray()
        await update.effective_message.chat.send_action(ChatAction.TYPING)
        try:
            statement_text = _extract_pdf_text(bytes(pdf_bytes))
        except Exception:
            logger.exception("PDF text extraction failed")
            await update.effective_message.reply_text(PDF_UNSUPPORTED_TEXT)
            return
        if not statement_text:
            await update.effective_message.reply_text(PDF_UNSUPPORTED_TEXT)
            return
        try:
            response = await _request_statement_draft_text(
                jwt_token, budget_id, statement_text, "pdf_text"
            )
        except httpx.HTTPError as exc:
            logger.exception("Statement draft failed")
            await update.effective_message.reply_text(
                f"Ошибка загрузки выписки: {_format_http_error(exc)}"
            )
            return
    else:
        await update.effective_message.chat.send_action(ChatAction.UPLOAD_DOCUMENT)
        file_bytes = await file.download_as_bytearray()
        await update.effective_message.chat.send_action(ChatAction.TYPING)
        filename = document.file_name or "statement"
        mime_type = document.mime_type or "text/csv"
        try:
            response = await _request_statement_draft(
                jwt_token, budget_id, bytes(file_bytes), filename, mime_type
            )
        except httpx.HTTPError as exc:
            logger.exception("Statement draft failed")
            await update.effective_message.reply_text(
                f"Ошибка загрузки выписки: {_format_http_error(exc)}"
            )
            return
    payload = response.get("payload") or {}
    draft = response.get("draft") or {}
    draft_id = draft.get("id")
    if not draft_id:
        await update.effective_message.reply_text(
            "Не удалось получить черновик выписки."
        )
        return
    _set_draft_context(context, draft_id, budget_id)
    _set_state(context, STATE_WAITING_STATEMENT_CONFIRM)
    await update.effective_message.reply_text(_build_draft_message(payload))


async def _apply_statement_draft(
    update: Update, context: ContextTypes.DEFAULT_TYPE, jwt_token: str
) -> None:
    draft_context = _get_draft_context(context)
    if not draft_context:
        await update.effective_message.reply_text(
            "Черновик не найден. Начните заново."
        )
        _set_state(context, None)
        return
    try:
        response = await _request_statement_apply(
            jwt_token, draft_context.draft_id
        )
    except httpx.HTTPError as exc:
        logger.exception("Statement apply failed")
        await update.effective_message.reply_text(
            f"Ошибка применения выписки: {_format_http_error(exc)}"
        )
        return
    _clear_draft_context(context)
    errors = response.get("errors") if isinstance(response, dict) else []
    if errors:
        error_text = "\n".join(f"- {item}" for item in errors)
        await update.effective_message.reply_text(
            f"{CONFIRM_SUCCESS_TEXT}\n\n⚠️ Ошибки применения:\n{error_text}"
        )
    else:
        await update.effective_message.reply_text(CONFIRM_SUCCESS_TEXT)


async def handle_feedback(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> None:
    state = _get_state(context)
    if state not in (
        STATE_WAITING_STATEMENT_FEEDBACK,
        STATE_WAITING_STATEMENT_CONFIRM,
    ):
        return
    draft_context = _get_draft_context(context)
    if not draft_context:
        await update.effective_message.reply_text(
            "Черновик не найден. Начните заново."
        )
        _set_state(context, None)
        return
    jwt_token = _get_jwt(context)
    if not jwt_token:
        await update.effective_message.reply_text(
            "Сессия истекла. Начните заново."
        )
        _set_state(context, None)
        return
    feedback = update.effective_message.text or ""
    if not feedback.strip():
        await update.effective_message.reply_text(
            "Пожалуйста, пришлите текст с уточнениями."
        )
        return
    if state == STATE_WAITING_STATEMENT_CONFIRM:
        normalized = feedback.strip().lower()
        if normalized in {"да", "yes"}:
            jwt_token = _get_jwt(context)
            if not jwt_token:
                await update.effective_message.reply_text(
                    "Сессия истекла. Начните заново."
                )
                _set_state(context, None)
                return
            _set_state(context, None)
            await _apply_statement_draft(update, context, jwt_token)
            return
        if normalized in {"отмена", "cancel"}:
            _clear_draft_context(context)
            _set_state(context, None)
            await update.effective_message.reply_text(
                "Ок, отменил применение выписки."
            )
            return
        _set_state(context, STATE_WAITING_STATEMENT_FEEDBACK)
    await update.effective_message.chat.send_action(ChatAction.TYPING)
    try:
        response = await _request_statement_revise(
            jwt_token, draft_context.draft_id, feedback
        )
    except httpx.HTTPError as exc:
        logger.exception("Statement revise failed")
        await update.effective_message.reply_text(
            f"Ошибка обновления черновика: {_format_http_error(exc)}"
        )
        return
    payload = response.get("payload") or {}
    draft = response.get("draft") or {}
    draft_id = draft.get("id")
    if not draft_id:
        await update.effective_message.reply_text(
            "Не удалось получить обновленный черновик."
        )
        return
    _set_draft_context(context, draft_id, draft_context.budget_id)
    _set_state(context, STATE_WAITING_STATEMENT_CONFIRM)
    await update.effective_message.reply_text(_build_draft_message(payload))


def register_handlers(app: Application) -> None:
    app.add_handler(CommandHandler("statement", command_statement))
    app.add_handler(MessageHandler(filters.Document.ALL, handle_document))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_feedback))
