from datetime import date

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.auth.jwt import get_current_user
from app.repositories.reports import reconcile_by_date

router = APIRouter()


class ReconcileOut(BaseModel):
    date: date
    bottom_total: int
    top_total: int
    diff: int
    is_ok: bool


@router.get("/reconcile")
def get_reconcile(
    budget_id: str,
    date: date,
    current_user: dict = Depends(get_current_user),
) -> ReconcileOut:
    return reconcile_by_date(current_user["sub"], budget_id, date)
