from __future__ import annotations

import json
from typing import Any

import httpx

from app.core.config import settings


class LLMError(RuntimeError):
    def __init__(self, message: str, raw_response: str | None = None) -> None:
        super().__init__(message)
        self.raw_response = raw_response


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
        "и вернуть детерминированный JSON-ответ. Всегда отвечай валидным JSON, "
        "без комментариев и без Markdown. НЕЛЬЗЯ возвращать текст.\n\n"
        "Критичные правила:\n"
        "- НЕ использовать OCR. Только текстовый PDF.\n"
        "- Обработай ВСЕ страницы и ВСЕ операции, ничего не пропускай.\n"
        "- Типы операций строго: income, expense, transfer, commission.\n"
        "- Переводы («Перевод от/для», «Перевод СБП») всегда transfer.\n"
        "- Переводы не являются доходом/расходом.\n"
        "- Комиссии банка — commission.\n"
        "- Основной счет выписки обязан быть указан.\n"
        "- Люди (имена с инициалами/ФИО) — контрагенты, НЕ счета.\n"
        "- Категорию из выписки создавать можно: не пиши warning, если она создается.\n"
        "- Балансы не искажать: проверяй сумму операций и остатки.\n"
        "- Обработай ВСЕ операции из входных данных, без подмножеств.\n"
        "- Если операций много, можно агрегировать summary, но operations[] "
        "должен содержать все операции.\n"
        "- operations[] НЕ может быть пустым.\n\n"
        "Формат ответа (строго):\n"
        "{\n"
        '  "operations": [\n'
        "    {\n"
        '      "date": "YYYY-MM-DD",\n'
        '      "amount": -650.00,\n'
        '      "currency": "RUB",\n'
        '      "type": "expense|income|transfer|commission",\n'
        '      "account": "Счет 40817810955192982036",\n'
        '      "counterparty": "Пятерочка",\n'
        '      "category": "Супермаркеты",\n'
        '      "description": "Покупка",\n'
        '      "balance_after": 12345.67\n'
        "    }\n"
        "  ],\n"
        '  "summary": {\n'
        '    "total_operations": 0,\n'
        '    "income_total": 0,\n'
        '    "expense_total": 0,\n'
        '    "net_total": 0,\n'
        '    "by_account": {}\n'
        "  },\n"
        '  "accounts_to_create": [\n'
        "    {\n"
        '      "name": "Счет 40817810955192982036",\n'
        '      "type": "bank",\n'
        '      "currency": "RUB"\n'
        "    }\n"
        "  ],\n"
        '  "categories_to_create": [\n'
        "    {\n"
        '      "name": "Супермаркеты",\n'
        '      "parent": null\n'
        "    }\n"
        "  ],\n"
        '  "counterparties": ["контрагенты, если есть"],\n'
        '  "warnings": ["только если дата/сумма/тип не распознаны"]\n'
        "}\n"
        "Если данных недостаточно, массивы оставляй пустыми, но ключи всегда "
        "присутствуют."
    )
    user_prompt = (
        "Контекст пользователя (счета, остатки, долги, категории):\n"
        f"{json.dumps(context, ensure_ascii=False)}\n\n"
        "Выписка (структурированные данные JSON, все строки без исключения):\n"
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
        raw_response = None
        if exc.response is not None:
            raw_response = exc.response.text
        raise LLMError(f"LLM request failed: {exc}", raw_response) from exc
    choices = data.get("choices") or []
    if not choices:
        raise LLMError("LLM response missing choices", json.dumps(data))
    message = choices[0].get("message", {}).get("content")
    if not message:
        raise LLMError("LLM response missing content", json.dumps(data))
    try:
        return json.loads(message)
    except json.JSONDecodeError as exc:
        raise LLMError("LLM returned invalid JSON", message) from exc
