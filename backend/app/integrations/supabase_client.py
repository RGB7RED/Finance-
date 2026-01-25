from __future__ import annotations

from urllib.parse import urlparse

from supabase import Client, create_client

from app.core.config import settings


def _normalize_supabase_url(raw_url: str) -> str:
    parsed = urlparse(raw_url)
    if not parsed.scheme or not parsed.netloc:
        return raw_url
    return f"{parsed.scheme}://{parsed.netloc}"


def get_supabase_client() -> Client:
    if not settings.SUPABASE_URL or not settings.SUPABASE_SERVICE_ROLE_KEY:
        raise RuntimeError(
            "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set to use Supabase"
        )

    supabase_url = _normalize_supabase_url(settings.SUPABASE_URL)
    return create_client(supabase_url, settings.SUPABASE_SERVICE_ROLE_KEY)
