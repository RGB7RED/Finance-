from __future__ import annotations

from datetime import datetime, timedelta, timezone

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core.config import settings
from app.auth.supabase_auth import get_supabase_user
from app.repositories.users import ensure_user

bearer_scheme = HTTPBearer(auto_error=False)


def create_access_token(user_id: str, telegram_id: int) -> str:
    if not settings.JWT_SECRET:
        raise RuntimeError("JWT_SECRET must be set")

    expires_at = datetime.now(timezone.utc) + timedelta(days=7)
    payload = {"sub": user_id, "tg_id": telegram_id, "exp": expires_at}
    return jwt.encode(payload, settings.JWT_SECRET, algorithm="HS256")


def verify_access_token(token: str) -> dict:
    if not settings.JWT_SECRET:
        raise RuntimeError("JWT_SECRET must be set")

    try:
        return jwt.decode(token, settings.JWT_SECRET, algorithms=["HS256"])
    except jwt.PyJWTError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token"
        ) from exc


def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
) -> dict:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
        )

    supabase_user = get_supabase_user(credentials.credentials)
    user_id = supabase_user.get("id")
    email = supabase_user.get("email")
    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token",
        )

    ensure_user(user_id, email)
    return {"user_id": user_id, "email": email}
