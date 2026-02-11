import asyncio
import os
from types import SimpleNamespace

os.environ.setdefault("APP_ENV", "test")
os.environ.setdefault("JWT_SECRET", "test-secret")
os.environ.setdefault("CORS_ORIGINS", "*")
os.environ.setdefault("LOG_LEVEL", "INFO")

from app import main
from app.integrations import telegram_polling_lock


class _DummyUpdater:
    def __init__(self):
        self.started = False

    async def start_polling(self):
        self.started = True

    async def stop(self):
        return None


class _DummyApp:
    def __init__(self):
        self.updater = _DummyUpdater()
        self.initialized = False
        self.started = False

    async def initialize(self):
        self.initialized = True

    async def start(self):
        self.started = True

    async def stop(self):
        return None

    async def shutdown(self):
        return None


def test_acquire_polling_lock_disabled_without_database_url(monkeypatch, caplog):
    monkeypatch.setattr(telegram_polling_lock.settings, "DATABASE_URL", None)
    monkeypatch.setattr(telegram_polling_lock.settings, "SUPABASE_DB_URL", None)

    result = telegram_polling_lock.acquire_telegram_polling_lock()

    assert result.mode == "disabled"
    assert result.connection is None
    assert "telegram_bot_lock=disabled reason=missing_database_url" in caplog.text


def test_start_telegram_bot_runs_when_lock_is_disabled(monkeypatch):
    dummy_app = _DummyApp()
    calls = []

    monkeypatch.setattr(main, "get_telegram_bot_token", lambda: "token")
    monkeypatch.setattr(
        main,
        "acquire_telegram_polling_lock",
        lambda: telegram_polling_lock.TelegramPollingLockResult(mode="disabled"),
    )
    monkeypatch.setattr(main, "build_application", lambda _token: dummy_app)

    def _register_handlers(application):
        calls.append(application)

    monkeypatch.setattr(main, "register_handlers", _register_handlers)

    asyncio.run(main.start_telegram_bot())

    assert calls == [dummy_app]
    assert dummy_app.initialized is True
    assert dummy_app.started is True
    assert dummy_app.updater.started is True


def test_start_telegram_bot_skips_when_lock_not_acquired(monkeypatch):
    state = SimpleNamespace()
    monkeypatch.setattr(main.app, "state", state, raising=False)
    monkeypatch.setattr(main, "get_telegram_bot_token", lambda: "token")
    monkeypatch.setattr(
        main,
        "acquire_telegram_polling_lock",
        lambda: telegram_polling_lock.TelegramPollingLockResult(mode="skipped"),
    )

    asyncio.run(main.start_telegram_bot())

    assert not hasattr(state, "telegram_app")
