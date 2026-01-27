import datetime as dt
import os

os.environ.setdefault("APP_ENV", "test")
os.environ.setdefault("JWT_SECRET", "test-secret")
os.environ.setdefault("CORS_ORIGINS", "*")
os.environ.setdefault("LOG_LEVEL", "INFO")

from app.repositories import daily_account_balances
from app.repositories import daily_state


class FakeResponse:
    def __init__(self, data):
        self.data = data


class FakeQuery:
    def __init__(self, data):
        self._data = data
        self._filters = []
        self._lte = None
        self._order_key = None
        self._order_desc = False
        self._limit = None

    def select(self, *_args, **_kwargs):
        return self

    def eq(self, key, value):
        self._filters.append((key, value))
        return self

    def lte(self, key, value):
        self._lte = (key, value)
        return self

    def order(self, key, desc=False):
        self._order_key = key
        self._order_desc = desc
        return self

    def limit(self, value):
        self._limit = value
        return self

    def execute(self):
        data = list(self._data)
        for key, value in self._filters:
            data = [item for item in data if item.get(key) == value]
        if self._lte:
            key, value = self._lte
            data = [item for item in data if item.get(key) <= value]
        if self._order_key:
            data.sort(
                key=lambda item: item.get(self._order_key),
                reverse=self._order_desc,
            )
        if self._limit is not None:
            data = data[: self._limit]
        return FakeResponse(data)


class FakeClient:
    def __init__(self, data_by_table):
        self._data_by_table = data_by_table

    def table(self, name):
        return FakeQuery(self._data_by_table.get(name, []))


def test_get_balances_as_of_returns_last_known(monkeypatch):
    budgets = [{"id": "budget-1", "user_id": "user-1"}]
    balances = [
        {
            "budget_id": "budget-1",
            "user_id": "user-1",
            "date": "2024-01-01",
            "account_id": "acc-1",
            "amount": 100,
        },
        {
            "budget_id": "budget-1",
            "user_id": "user-1",
            "date": "2024-01-03",
            "account_id": "acc-1",
            "amount": 150,
        },
        {
            "budget_id": "budget-1",
            "user_id": "user-1",
            "date": "2024-01-02",
            "account_id": "acc-2",
            "amount": 200,
        },
    ]
    fake_client = FakeClient(
        {"budgets": budgets, "daily_account_balances": balances}
    )
    monkeypatch.setattr(
        daily_account_balances, "get_supabase_client", lambda: fake_client
    )
    monkeypatch.setattr(
        daily_account_balances,
        "list_accounts",
        lambda *_args, **_kwargs: [
            {"id": "acc-1"},
            {"id": "acc-2"},
            {"id": "acc-3"},
        ],
    )

    result = daily_account_balances.get_balances_as_of(
        "user-1", "budget-1", dt.date(2024, 1, 2)
    )

    assert result == {"acc-1": 100, "acc-2": 200, "acc-3": 0}


def test_get_debts_as_of_returns_last_known(monkeypatch):
    budgets = [{"id": "budget-1", "user_id": "user-1"}]
    states = [
        {
            "budget_id": "budget-1",
            "user_id": "user-1",
            "date": "2024-01-01",
            "debt_cards_total": 10,
            "debt_other_total": 5,
        },
        {
            "budget_id": "budget-1",
            "user_id": "user-1",
            "date": "2024-01-04",
            "debt_cards_total": 20,
            "debt_other_total": 0,
        },
    ]
    fake_client = FakeClient({"budgets": budgets, "daily_state": states})
    monkeypatch.setattr(daily_state, "get_supabase_client", lambda: fake_client)

    result = daily_state.get_debts_as_of(
        "user-1", "budget-1", dt.date(2024, 1, 3)
    )

    assert result == {"debt_cards_total": 10, "debt_other_total": 5}
