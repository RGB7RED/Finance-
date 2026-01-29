import os
import sys
import uuid
from pathlib import Path

os.environ.setdefault("APP_ENV", "test")
os.environ.setdefault("JWT_SECRET", "test-secret")
os.environ.setdefault("CORS_ORIGINS", "*")
os.environ.setdefault("LOG_LEVEL", "INFO")

sys.path.append(str(Path(__file__).resolve().parents[1]))

from app.repositories import transactions as transactions_repo


class FakeResponse:
    def __init__(self, data):
        self.data = data


class FakeTable:
    def __init__(self, name, store):
        self._name = name
        self._store = store
        self._payload = None

    def insert(self, payload):
        self._payload = payload
        return self

    def execute(self):
        if self._name != "transactions":
            return FakeResponse([])
        record = {**self._payload, "id": str(uuid.uuid4())}
        self._store.append(record)
        return FakeResponse([record])


class FakeClient:
    def __init__(self, store):
        self._store = store

    def table(self, name):
        return FakeTable(name, self._store)


def test_goal_transfer_allows_multiple_events(monkeypatch):
    created_transactions = []
    created_events = []

    def fake_create_balance_event(
        user_id,
        budget_id,
        target_date,
        account_id,
        delta,
        reason,
        transaction_id=None,
    ):
        created_events.append(
            {
                "user_id": user_id,
                "budget_id": budget_id,
                "date": target_date,
                "account_id": account_id,
                "delta": delta,
                "reason": reason,
                "transaction_id": transaction_id,
            }
        )
        return {"id": str(uuid.uuid4())}

    monkeypatch.setattr(
        transactions_repo, "get_supabase_client", lambda: FakeClient(created_transactions)
    )
    monkeypatch.setattr(
        transactions_repo, "_ensure_budget_access", lambda *_args, **_kwargs: None
    )
    monkeypatch.setattr(
        transactions_repo, "_ensure_account_in_budget", lambda *_args, **_kwargs: None
    )
    monkeypatch.setattr(
        transactions_repo, "create_balance_event", fake_create_balance_event
    )

    payload = {
        "budget_id": "budget-1",
        "type": "expense",
        "kind": "goal_transfer",
        "amount": 100,
        "date": "2024-01-10",
        "account_id": "acc-1",
        "category_id": None,
        "goal_id": "goal-1",
        "tag": "one_time",
        "note": "Top up",
    }

    first = transactions_repo.create_transaction("user-1", payload)
    second = transactions_repo.create_transaction("user-1", payload)

    assert len(created_transactions) == 2
    assert len(created_events) == 2
    assert created_events[0]["transaction_id"] == first["id"]
    assert created_events[1]["transaction_id"] == second["id"]
