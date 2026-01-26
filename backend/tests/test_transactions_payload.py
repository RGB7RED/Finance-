import datetime as dt

from app.repositories.transactions import _serialize_payload


def _contains_date(obj: object) -> bool:
    if isinstance(obj, (dt.date, dt.datetime)):
        return True
    if isinstance(obj, dict):
        return any(_contains_date(value) for value in obj.values())
    if isinstance(obj, list):
        return any(_contains_date(item) for item in obj)
    return False


def test_serialize_payload_converts_dates() -> None:
    payload = {
        "date": dt.date(2024, 1, 2),
        "created_at": dt.datetime(2024, 1, 2, 3, 4, 5, tzinfo=dt.timezone.utc),
        "nested": {"at": dt.datetime(2024, 1, 2, 6, 7, 8)},
    }

    serialized = _serialize_payload(payload)

    assert not _contains_date(serialized)
    assert serialized["date"] == "2024-01-02"
    assert serialized["created_at"].startswith("2024-01-02T03:04:05")
