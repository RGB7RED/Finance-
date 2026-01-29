from __future__ import annotations

from datetime import date as dt_date
from typing import Literal, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app.auth.jwt import get_current_user
from app.repositories.goals import (
    adjust_goal_amount,
    create_goal,
    delete_goal,
    list_goals,
    update_goal,
)

router = APIRouter()


class GoalCreateRequest(BaseModel):
    budget_id: str
    title: str
    target_amount: int = Field(gt=0)
    deadline: Optional[dt_date] = None


class GoalUpdateRequest(BaseModel):
    title: str | None = None
    target_amount: int | None = Field(default=None, gt=0)
    current_amount: int | None = Field(default=None, ge=0)
    deadline: Optional[dt_date] = None
    status: Literal["active", "done", "archived"] | None = None


class GoalOut(BaseModel):
    id: str
    budget_id: str
    user_id: str
    title: str
    target_amount: int
    current_amount: int
    deadline: Optional[dt_date] = None
    status: Literal["active", "done", "archived"]
    created_at: str


class GoalAdjustRequest(BaseModel):
    budget_id: str
    account_id: str
    delta: int
    note: str | None = None
    date: Optional[dt_date] = None


@router.get("/goals")
def get_goals(
    budget_id: str, current_user: dict = Depends(get_current_user)
) -> list[GoalOut]:
    return list_goals(current_user["sub"], budget_id)


@router.post("/goals")
def post_goals(
    payload: GoalCreateRequest, current_user: dict = Depends(get_current_user)
) -> GoalOut:
    record = create_goal(
        current_user["sub"],
        payload.budget_id,
        payload.title,
        payload.target_amount,
        payload.deadline.isoformat() if payload.deadline else None,
    )
    return GoalOut(**record)


@router.patch("/goals/{goal_id}")
def patch_goals(
    goal_id: str,
    payload: GoalUpdateRequest,
    current_user: dict = Depends(get_current_user),
) -> GoalOut:
    fields = payload.model_dump(mode="json", exclude_none=True)
    record = update_goal(current_user["sub"], goal_id, fields)
    return GoalOut(**record)


@router.post("/goals/{goal_id}/adjust")
def adjust_goal(
    goal_id: str,
    payload: GoalAdjustRequest,
    current_user: dict = Depends(get_current_user),
) -> dict[str, object]:
    result = adjust_goal_amount(
        current_user["sub"],
        goal_id,
        payload.budget_id,
        payload.account_id,
        payload.delta,
        payload.note,
        payload.date,
    )
    return result


@router.delete("/goals/{goal_id}")
def delete_goals(
    goal_id: str, current_user: dict = Depends(get_current_user)
) -> dict[str, str]:
    delete_goal(current_user["sub"], goal_id)
    return {"status": "deleted"}
