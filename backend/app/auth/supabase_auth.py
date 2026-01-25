from __future__ import annotations

import json
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from fastapi import HTTPException, status

from app.core.config import settings


def get_supabase_user(access_token: str) -> dict:
    if not settings.SUPABASE_URL or not settings.SUPABASE_ANON_KEY:
        raise RuntimeError("SUPABASE_URL and SUPABASE_ANON_KEY must be set")

    url = f"{settings.SUPABASE_URL.rstrip('/')}/auth/v1/user"
    request = Request(
        url,
        headers={
            "Authorization": f"Bearer {access_token}",
            "apikey": settings.SUPABASE_ANON_KEY,
        },
        method="GET",
    )

    try:
        with urlopen(request, timeout=10) as response:
            if response.status != 200:
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Invalid token",
                )
            return json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError) as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token",
        ) from exc
