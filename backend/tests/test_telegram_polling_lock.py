import asyncio
import os

import pytest
from fastapi import HTTPException

os.environ.setdefault("APP_ENV", "test")
os.environ.setdefault("JWT_SECRET", "test-secret")
os.environ.setdefault("CORS_ORIGINS", "*")
os.environ.setdefault("LOG_LEVEL", "INFO")

from app import main
from app.api import telegram_webhook_routes
from app.integrations import telegram_bot


class _DummyBot:
    def __init__(self):
        self.webhook_calls = []

    async def set_webhook(self, url, secret_token=None):
        self.webhook_calls.append((url, secret_token))


class _DummyTelegramApp:
    def __init__(self):
        self.bot = _DummyBot()
        self.processed = []
        self.shutdown_called = False

    async def process_update(self, update):
        self.processed.append(update)

    async def shutdown(self):
        self.shutdown_called = True


class _DummyRequest:
    def __init__(self, headers, payload):
        self.headers = headers
        self._payload = payload

    async def json(self):
        return self._payload


def test_start_telegram_bot_sets_webhook(monkeypatch):
    dummy_app = _DummyTelegramApp()

    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "token")
    monkeypatch.setenv("PUBLIC_BASE_URL", "https://example.up.railway.app")
    monkeypatch.setenv("TELEGRAM_SECRET", "secret")
    async def _init_app():
        return dummy_app

    monkeypatch.setattr(main, "init_telegram_application", _init_app)

    asyncio.run(main.start_telegram_bot())

    assert dummy_app.bot.webhook_calls == [
        ("https://example.up.railway.app/telegram/webhook", "secret")
    ]


def test_start_telegram_bot_skips_without_token(monkeypatch):
    monkeypatch.delenv("TELEGRAM_BOT_TOKEN", raising=False)
    async def _unexpected():
        pytest.fail("init_telegram_application should not be called")

    monkeypatch.setattr(main, "init_telegram_application", _unexpected)

    asyncio.run(main.start_telegram_bot())


def test_telegram_webhook_rejects_invalid_secret(monkeypatch):
    monkeypatch.setenv("TELEGRAM_SECRET", "secret")
    telegram_bot.telegram_application = _DummyTelegramApp()

    request = _DummyRequest(
        headers={"X-Telegram-Bot-Api-Secret-Token": "bad"}, payload={}
    )

    with pytest.raises(HTTPException) as exc:
        asyncio.run(telegram_webhook_routes.telegram_webhook(request))

    assert exc.value.status_code == 403


def test_telegram_webhook_processes_update(monkeypatch):
    monkeypatch.setenv("TELEGRAM_SECRET", "secret")
    app = _DummyTelegramApp()
    telegram_bot.telegram_application = app

    class _Update:
        @staticmethod
        def de_json(data, bot):
            return {"data": data, "bot": bot}

    monkeypatch.setattr(telegram_webhook_routes, "Update", _Update)

    request = _DummyRequest(
        headers={"X-Telegram-Bot-Api-Secret-Token": "secret"},
        payload={"update_id": 123},
    )

    result = asyncio.run(telegram_webhook_routes.telegram_webhook(request))

    assert result == {"ok": True}
    assert app.processed == [{"data": {"update_id": 123}, "bot": app.bot}]


def test_init_telegram_application_builds_once(monkeypatch):
    dummy_app = _DummyTelegramApp()
    calls = []

    async def _initialize():
        calls.append("initialize")

    dummy_app.initialize = _initialize

    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "token")
    monkeypatch.setattr(telegram_bot, "telegram_application", None)
    monkeypatch.setattr(telegram_bot, "build_application", lambda _token: dummy_app)
    monkeypatch.setattr(telegram_bot, "register_handlers", lambda _app: calls.append("handlers"))

    app_one = asyncio.run(telegram_bot.init_telegram_application())
    app_two = asyncio.run(telegram_bot.init_telegram_application())

    assert app_one is dummy_app
    assert app_two is dummy_app
    assert calls == ["handlers", "initialize"]
