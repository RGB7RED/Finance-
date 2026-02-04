from datetime import date

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from app.auth.jwt import get_current_user
from app.repositories.reports import (
    balance_by_day,
    balance_by_accounts,
    cashflow_by_day,
    expenses_by_category,
    month_report,
    summary,
)

router = APIRouter()


class CashflowDay(BaseModel):
    date: date
    income_total: int
    expense_total: int
    net_total: int


class BalanceDay(BaseModel):
    date: date
    assets_total: int
    debts_total: int
    balance: int
    delta_balance: int


class BalanceByAccountsItem(BaseModel):
    account_id: str
    name: str
    kind: str
    currency: str | None = None
    amount: int


class BalanceByAccountsReport(BaseModel):
    date: date
    accounts: list[BalanceByAccountsItem]
    total: int


class ReportsGoal(BaseModel):
    title: str
    target: int
    current: int
    deadline: date | None = None


class ReportsSummary(BaseModel):
    debt_cards_total: int
    debt_other_total: int
    goals_active: list[ReportsGoal]


class MonthReportDay(BaseModel):
    date: date
    top_total: int
    bottom_total: int
    diff: int


class MonthReport(BaseModel):
    month: str
    days: list[MonthReportDay]
    month_income: int
    month_expense: int
    month_net: int
    avg_net_per_day: int


class ExpensesByCategoryChild(BaseModel):
    category_id: str
    category_name: str
    amount: int
    share: float


class ExpensesByCategoryItem(BaseModel):
    category_id: str
    category_name: str
    amount: int
    share: float
    children: list[ExpensesByCategoryChild]


class ExpensesByCategoryReport(BaseModel):
    total_expense: int
    items: list[ExpensesByCategoryItem]


@router.get("/reports/cashflow")
def get_reports_cashflow(
    budget_id: str,
    from_date: date = Query(alias="from"),
    to_date: date = Query(alias="to"),
    current_user: dict = Depends(get_current_user),
) -> list[CashflowDay]:
    return cashflow_by_day(current_user["sub"], budget_id, from_date, to_date)


@router.get("/reports/balance")
def get_reports_balance(
    budget_id: str,
    from_date: date = Query(alias="from"),
    to_date: date = Query(alias="to"),
    current_user: dict = Depends(get_current_user),
) -> list[BalanceDay]:
    return balance_by_day(current_user["sub"], budget_id, from_date, to_date)


@router.get("/reports/balance-by-accounts")
def get_reports_balance_by_accounts(
    budget_id: str,
    target_date: date = Query(alias="date"),
    current_user: dict = Depends(get_current_user),
) -> BalanceByAccountsReport:
    return balance_by_accounts(current_user["sub"], budget_id, target_date)


@router.get("/reports/summary")
def get_reports_summary(
    budget_id: str, current_user: dict = Depends(get_current_user)
) -> ReportsSummary:
    return summary(current_user["sub"], budget_id)


@router.get("/reports/month")
def get_reports_month(
    budget_id: str,
    month: str,
    current_user: dict = Depends(get_current_user),
) -> MonthReport:
    return month_report(current_user["sub"], budget_id, month)


@router.get("/reports/expenses-by-category")
def get_reports_expenses_by_category(
    budget_id: str,
    from_date: date = Query(alias="from"),
    to_date: date = Query(alias="to"),
    limit: int = Query(default=10, ge=1, le=100),
    current_user: dict = Depends(get_current_user),
) -> ExpensesByCategoryReport:
    return expenses_by_category(
        current_user["sub"],
        budget_id,
        from_date,
        to_date,
        limit,
    )
