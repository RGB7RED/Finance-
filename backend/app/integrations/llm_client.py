from __future__ import annotations

import json
from typing import Any

import httpx

from app.core.config import settings


class LLMError(RuntimeError):
    pass


def _build_headers() -> dict[str, str]:
    if not settings.LLM_API_KEY:
        raise LLMError("LLM_API_KEY is not configured")
    return {
        "Authorization": f"Bearer {settings.LLM_API_KEY}",
        "Content-Type": "application/json",
    }


def _chat_payload(messages: list[dict[str, str]]) -> dict[str, Any]:
    return {
        "model": settings.LLM_MODEL,
        "messages": messages,
        "temperature": 0.2,
    }


def generate_statement_draft(
    statement_text: str, context: dict[str, Any]
) -> dict[str, Any]:
    system_prompt = (
        "Ты финансовый ассистент. Твоя задача — разобрать банковскую выписку "
        "и предложить черновик изменений. Всегда отвечай валидным JSON без "
        "комментариев и без Markdown.\n\n"
        "Критичные правила:\n"
        "- НЕ использовать OCR. Если PDF выглядит как скан, укажи это в notes.\n"
        "- Обработай ВСЕ страницы и ВСЕ операции, ничего не пропускай.\n"
        "- Типы операций строго: income, expense, transfer, fee.\n"
        "- Переводы («Перевод от/для», «Перевод СБП») всегда transfer.\n"
        "- Переводы не являются доходом/расходом.\n"
        "- Комиссии банка — fee.\n"
        "- Основной счет выписки обязан быть указан (карта/счет).\n"
        "- Люди (имена с инициалами/ФИО) — это контрагенты, НЕ счета.\n"
        "- Категорию из выписки создавать можно: не пиши warning, если она создается.\n"
        "- Балансы не искажать: проверяй сумму операций и остатки.\n\n"
        "Формат ответа:\n"
        "{\n"
        '  "summary": "короткое описание",\n'
        '  "transactions": [\n'
        "    {\n"
        '      "date": "YYYY-MM-DD",\n'
        '      "type": "income|expense|transfer|fee",\n'
        '      "kind": "normal|transfer|goal_transfer|debt",\n'
        '      "amount": 12345,\n'
        '      "account_name": "название счета",\n'
        '      "account_kind": "cash|bank|card",\n'
        '      "to_account_name": "название счета назначения или null",\n'
        '      "to_account_kind": "cash|bank|card|null",\n'
        '      "category_name": "категория или null",\n'
        '      "category_type": "expense|income|null",\n'
        '      "tag": "one_time|subscription",\n'
        '      "note": "краткая заметка или null",\n'
        '      "balance_after": 0,\n'
        '      "counterparty": "контрагент или null",\n'
        '      "debt": {"direction": "borrowed|repaid", "debt_type": "people|cards"}\n'
        "    }\n"
        "  ],\n"
        '  "balance_adjustments": [\n'
        "    {\n"
        '      "date": "YYYY-MM-DD",\n'
        '      "account_name": "название счета",\n'
        '      "delta": 0,\n'
        '      "note": "пояснение или null"\n'
        "    }\n"
        "  ],\n"
        '  "debts": {\n'
        '    "date": "YYYY-MM-DD",\n'
        '    "credit_cards_total": 0,\n'
        '    "people_debts_total": 0\n'
        "  },\n"
        '  "counterparties": ["контрагенты, если есть"],\n'
        '  "statement_stats": {\n'
        '    "total": 0,\n'
        '    "by_type": {"income": 0, "expense": 0, "transfer": 0, "fee": 0},\n'
        '    "unparsed": [{"count": 0, "reason": "почему не распознано"}]\n'
        "  },\n"
        '  "balance_check": {\n'
        '    "opening_balance": 0,\n'
        '    "closing_balance": 0,\n'
        '    "income_total": 0,\n'
        '    "expense_total": 0,\n'
        '    "transfer_net": 0,\n'
        '    "fee_total": 0,\n'
        '    "difference": 0,\n'
        '    "is_balanced": true\n'
        "  },\n"
        '  "notes": ["предупреждения или пустой массив"]\n'
        "}\n"
        "Если данных недостаточно, оставляй массивы пустыми и поля debts null."
    )
    user_prompt = (
        "Контекст пользователя (счета, остатки, долги, категории):\n"
        f"{json.dumps(context, ensure_ascii=False)}\n\n"
        "Текст выписки:\n"
        f"{statement_text}"
    )
    payload = _chat_payload(
        [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ]
    )
    url = f"{settings.LLM_API_BASE_URL.rstrip('/')}/chat/completions"
    try:
        with httpx.Client(timeout=60) as client:
            response = client.post(url, headers=_build_headers(), json=payload)
            response.raise_for_status()
            data = response.json()
    except httpx.HTTPError as exc:
        raise LLMError(f"LLM request failed: {exc}") from exc
    choices = data.get("choices") or []
    if not choices:
        raise LLMError("LLM response missing choices")
    message = choices[0].get("message", {}).get("content")
    if not message:
        raise LLMError("LLM response missing content")
    try:
        return json.loads(message)
    except json.JSONDecodeError as exc:
        raise LLMError("LLM returned invalid JSON") from exc
