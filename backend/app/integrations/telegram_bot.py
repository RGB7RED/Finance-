from __future__ import annotations

import io
import logging
import re
from dataclasses import dataclass
from typing import Any

import httpx
import pdfplumber
from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.constants import ChatAction
from telegram.ext import (
    Application,
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

from app.core.config import get_telegram_bot_token, settings

logger = logging.getLogger(__name__)

STATE_WAITING_STATEMENT_FILE = "WAITING_STATEMENT_FILE"
STATE_WAITING_STATEMENT_FEEDBACK = "WAITING_STATEMENT_FEEDBACK"

CALLBACK_CONFIRM = "statement_confirm"
CALLBACK_REVISE = "statement_revise"

STATEMENT_COMMAND_TEXT = (
    "📄 Загрузка банковской выписки\n\n"
    "1️⃣ Отправь CSV-файл выписки (из банка) или PDF с текстом.\n"
    "2️⃣ Я проанализирую его с помощью ИИ.\n"
    "3️⃣ Покажу черновик операций.\n"
    "4️⃣ Ты сможешь подтвердить или внести правки.\n\n"
    "⚠️ PDF должен содержать текст, а не скан."
)

INVALID_FILE_TEXT = (
    "❌ Неверный формат файла.\n\n"
    "Пожалуйста, отправь выписку в формате CSV или PDF с текстом."
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
    "❌ Не удалось прочитать PDF.\n\n"
    "Этот файл, вероятно, является сканом.\n"
    "Пожалуйста, скачай выписку в формате CSV\n"
    "или PDF с текстом (не скан)."
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
    cleaned = _clean_pdf_text("\n".join(pages_text))
    if not cleaned or not _is_supported_pdf_text(cleaned):
        return None
    return cleaned


async def _request_statement_draft(
    jwt_token: str,
    budget_id: str,
    csv_bytes: bytes,
    filename: str,
) -> dict[str, Any]:
    url = f"{settings.BACKEND_API_BASE_URL.rstrip('/')}/ai/statement-drafts"
    data = {"budget_id": budget_id}
    files = {"file": (filename, io.BytesIO(csv_bytes), "text/csv")}
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


def _format_transactions(transactions: list[dict[str, Any]]) -> str:
    if not transactions:
        return "(операций нет)"
    lines = []
    for item in transactions[:3]:
        amount = _format_currency(item.get("amount"))
        account = item.get("account_name") or "Без счета"
        note = item.get("note") or item.get("category_name") or "Без описания"
        lines.append(f"{amount} — {note} ({account})")
    return "\n".join(lines)


def _format_balance_adjustments(adjustments: list[dict[str, Any]]) -> str:
    if not adjustments:
        return "(нет)"
    lines = []
    for item in adjustments:
        account = item.get("account_name") or "Без счета"
        delta = _format_currency(item.get("delta"))
        lines.append(f"{account}: {delta}")
    return "\n".join(lines)


def _format_warnings(warnings: list[str]) -> str:
    if not warnings:
        return ""
    return "\n".join(f"- {warning}" for warning in warnings)


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
    balance_adjustments = payload.get("balance_adjustments") or []
    debts = payload.get("debts") or {}
    warnings = payload.get("warnings") or []
    lines = [
        "🤖 Я подготовил черновик выписки:\n",
        f"Найдено операций: {len(transactions)}\n",
        "Примеры:",
        _format_transactions(transactions),
        "\nИзменения баланса:",
        _format_balance_adjustments(balance_adjustments),
    ]
    if debts:
        lines.append("\nДолги/корректировки:")
        lines.append(
            f"Карты: {_format_currency(debts.get('credit_cards_total'))}, "
            f"Люди: {_format_currency(debts.get('people_debts_total'))}"
        )
    if warnings:
        lines.append("\n⚠️ Обрати внимание:")
        lines.append(_format_warnings(warnings))
    lines.append("\nПодтвердить применение?")
    return "\n".join(lines)


def _draft_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        [
            [
                InlineKeyboardButton("✅ Да", callback_data=CALLBACK_CONFIRM),
                InlineKeyboardButton("✏️ Изменить", callback_data=CALLBACK_REVISE),
            ]
        ]
    )


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
        _is_csv_document(document) or _is_pdf_document(document)
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
        csv_bytes = await file.download_as_bytearray()
        await update.effective_message.chat.send_action(ChatAction.TYPING)
        try:
            response = await _request_statement_draft(
                jwt_token, budget_id, bytes(csv_bytes), document.file_name
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
    _set_state(context, None)
    await update.effective_message.reply_text(
        _build_draft_message(payload), reply_markup=_draft_keyboard()
    )


async def handle_callback(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> None:
    query = update.callback_query
    if not query:
        return
    await query.answer()
    draft_context = _get_draft_context(context)
    if not draft_context:
        await query.edit_message_text("Черновик не найден. Начните заново.")
        return
    jwt_token = _get_jwt(context)
    if not jwt_token:
        await query.edit_message_text("Сессия истекла. Начните заново.")
        return
    if query.data == CALLBACK_CONFIRM:
        try:
            response = await _request_statement_apply(
                jwt_token, draft_context.draft_id
            )
        except httpx.HTTPError as exc:
            logger.exception("Statement apply failed")
            await query.edit_message_text(
                f"Ошибка применения выписки: {_format_http_error(exc)}"
            )
            return
        _clear_draft_context(context)
        errors = response.get("errors") if isinstance(response, dict) else []
        if errors:
            error_text = "\n".join(f"- {item}" for item in errors)
            await query.edit_message_text(
                f"{CONFIRM_SUCCESS_TEXT}\n\n⚠️ Ошибки применения:\n{error_text}"
            )
        else:
            await query.edit_message_text(CONFIRM_SUCCESS_TEXT)
        return
    if query.data == CALLBACK_REVISE:
        _set_state(context, STATE_WAITING_STATEMENT_FEEDBACK)
        await query.edit_message_text(
            "✏️ Напиши, что нужно изменить (категории, счета, суммы и т.д.)"
        )


async def handle_feedback(
    update: Update, context: ContextTypes.DEFAULT_TYPE
) -> None:
    if _get_state(context) != STATE_WAITING_STATEMENT_FEEDBACK:
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
    _set_state(context, None)
    await update.effective_message.reply_text(
        _build_draft_message(payload), reply_markup=_draft_keyboard()
    )


def register_handlers(app: Application) -> None:
    app.add_handler(CommandHandler("statement", command_statement))
    app.add_handler(MessageHandler(filters.Document.ALL, handle_document))
    app.add_handler(CallbackQueryHandler(handle_callback))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_feedback))
