import asyncio
import os
from types import SimpleNamespace

import pytest
from fastapi import FastAPI

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
    def __init__(self, headers, payload, telegram_application):
        self.headers = headers
        self._payload = payload
        self.app = SimpleNamespace(state=SimpleNamespace(telegram_application=telegram_application))

    async def json(self):
        return self._payload


def test_lifespan_sets_webhook_and_shutdown(monkeypatch):
    dummy_app = _DummyTelegramApp()

    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "token")
    monkeypatch.setenv("PUBLIC_BASE_URL", "https://example.up.railway.app")
    monkeypatch.setenv("TELEGRAM_SECRET", "secret")

    async def _init_app():
        return dummy_app

    monkeypatch.setattr(main, "init_telegram_application", _init_app)

    async def _run_lifespan():
        test_app = FastAPI()
        async with main.lifespan(test_app):
            assert test_app.state.telegram_application is dummy_app

    asyncio.run(_run_lifespan())

    assert dummy_app.bot.webhook_calls == [
        ("https://example.up.railway.app/telegram/webhook", "secret")
    ]
    assert dummy_app.shutdown_called is True


def test_lifespan_raises_without_token(monkeypatch):
    monkeypatch.delenv("TELEGRAM_BOT_TOKEN", raising=False)

    async def _unexpected():
        pytest.fail("init_telegram_application should not be called")

    monkeypatch.setattr(main, "init_telegram_application", _unexpected)

    async def _run_lifespan():
        async with main.lifespan(FastAPI()):
            return

    with pytest.raises(RuntimeError, match="TELEGRAM_BOT_TOKEN not set"):
        asyncio.run(_run_lifespan())


def test_telegram_webhook_handles_missing_telegram_app(monkeypatch, caplog):
    monkeypatch.setenv("TELEGRAM_SECRET", "secret")

    request = _DummyRequest(
        headers={"X-Telegram-Bot-Api-Secret-Token": "secret"},
        payload={"update_id": 123},
        telegram_application=None,
    )

    with caplog.at_level("ERROR"):
        result = asyncio.run(telegram_webhook_routes.telegram_webhook(request))

    assert result == {"ok": True}
    assert "Telegram app not found in app.state" in caplog.text


def test_telegram_webhook_rejects_invalid_secret(monkeypatch):
    monkeypatch.setenv("TELEGRAM_SECRET", "secret")

    request = _DummyRequest(
        headers={"X-Telegram-Bot-Api-Secret-Token": "bad"},
        payload={},
        telegram_application=_DummyTelegramApp(),
    )

    result = asyncio.run(telegram_webhook_routes.telegram_webhook(request))

    assert result == {"ok": True}


def test_telegram_webhook_processes_update(monkeypatch):
    monkeypatch.setenv("TELEGRAM_SECRET", "secret")
    app = _DummyTelegramApp()

    class _Update:
        @staticmethod
        def de_json(data, bot):
            return {"data": data, "bot": bot}

    monkeypatch.setattr(telegram_webhook_routes, "Update", _Update)

    request = _DummyRequest(
        headers={"X-Telegram-Bot-Api-Secret-Token": "secret"},
        payload={"update_id": 123},
        telegram_application=app,
    )

    result = asyncio.run(telegram_webhook_routes.telegram_webhook(request))

    assert result == {"ok": True}
    assert app.processed == [{"data": {"update_id": 123}, "bot": app.bot}]


def test_telegram_webhook_handles_processing_failure(monkeypatch, caplog):
    monkeypatch.setenv("TELEGRAM_SECRET", "secret")

    class _FailingTelegramApp(_DummyTelegramApp):
        async def process_update(self, update):
            raise RuntimeError("boom")

    app = _FailingTelegramApp()

    class _Update:
        @staticmethod
        def de_json(data, bot):
            return {"data": data, "bot": bot}

    monkeypatch.setattr(telegram_webhook_routes, "Update", _Update)

    request = _DummyRequest(
        headers={"X-Telegram-Bot-Api-Secret-Token": "secret"},
        payload={"update_id": 123},
        telegram_application=app,
    )

    with caplog.at_level("ERROR"):
        result = asyncio.run(telegram_webhook_routes.telegram_webhook(request))

    assert result == {"ok": True}
    assert "Telegram webhook processing failed" in caplog.text


def test_init_telegram_application_builds_every_time(monkeypatch):
    calls = []

    class _InitDummyTelegramApp(_DummyTelegramApp):
        async def initialize(self):
            calls.append("initialize")

    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "token")

    def _build_application(_token):
        calls.append("build")
        return _InitDummyTelegramApp()

    monkeypatch.setattr(telegram_bot, "build_application", _build_application)
    monkeypatch.setattr(
        telegram_bot,
        "register_handlers",
        lambda _app: calls.append("handlers"),
    )

    app_one = asyncio.run(telegram_bot.init_telegram_application())
    app_two = asyncio.run(telegram_bot.init_telegram_application())

    assert app_one is not app_two
    assert calls == ["build", "handlers", "initialize", "build", "handlers", "initialize"]
