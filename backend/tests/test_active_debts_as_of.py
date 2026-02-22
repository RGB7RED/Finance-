import datetime as dt
import os

os.environ.setdefault("APP_ENV", "test")
os.environ.setdefault("JWT_SECRET", "test-secret")
os.environ.setdefault("CORS_ORIGINS", "*")
os.environ.setdefault("LOG_LEVEL", "INFO")

from app.repositories import transactions


class FakeResponse:
    def __init__(self, data):
        self.data = data


class FakeQuery:
    def __init__(self, data):
        self._data = data
        self._filters = []
        self._lte = None
        self._orders = []

    def select(self, *_args, **_kwargs):
        return self

    def eq(self, key, value):
        self._filters.append((key, value))
        return self

    def lte(self, key, value):
        self._lte = (key, value)
        return self

    def order(self, key):
        self._orders.append(key)
        return self

    def execute(self):
        data = list(self._data)
        for key, value in self._filters:
            data = [item for item in data if item.get(key) == value]
        if self._lte:
            key, value = self._lte
            data = [item for item in data if item.get(key) <= value]
        for key in self._orders:
            data.sort(key=lambda item: item.get(key) or "")
        return FakeResponse(data)


class FakeClient:
    def __init__(self, data_by_table):
        self._data_by_table = data_by_table

    def table(self, name):
        return FakeQuery(self._data_by_table.get(name, []))


def test_list_active_debts_as_of_filters_closed(monkeypatch):
    budgets = [{"id": "budget-1", "user_id": "user-1"}]
    txs = [
        {
            "id": "1",
            "budget_id": "budget-1",
            "user_id": "user-1",
            "kind": "debt",
            "date": "2024-01-01",
            "type": "income",
            "amount": 100,
            "note": '{"debt_type":"people","direction":"borrowed","note":"Иван"}',
            "created_at": "2024-01-01T10:00:00Z",
        },
        {
            "id": "2",
            "budget_id": "budget-1",
            "user_id": "user-1",
            "kind": "debt",
            "date": "2024-01-03",
            "type": "expense",
            "amount": 100,
            "note": '{"debt_type":"people","direction":"repaid","note":"Иван"}',
            "created_at": "2024-01-03T10:00:00Z",
        },
    ]
    monkeypatch.setattr(
        transactions,
        "get_supabase_client",
        lambda: FakeClient({"budgets": budgets, "transactions": txs}),
    )

    result_on_open = transactions.list_active_debts_as_of(
        "user-1", "budget-1", dt.date(2024, 1, 2)
    )
    result_on_close = transactions.list_active_debts_as_of(
        "user-1", "budget-1", dt.date(2024, 1, 3)
    )

    assert result_on_open == [
        {
            "creditor": "Иван",
            "creditor_name": "Иван",
            "amount": 100,
            "debt_date": "2024-01-01",
            "closed_at": None,
        }
    ]
    assert result_on_close == []
