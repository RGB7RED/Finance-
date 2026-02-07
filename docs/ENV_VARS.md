# Environment variables

## Railway (backend)

- APP_ENV
- JWT_SECRET
- TELEGRAM_BOT_TOKEN
- MF_TELEGRAM_BOT_TOKEN
- BACKEND_API_BASE_URL
- DATABASE_URL
- SUPABASE_DB_URL
- SUPABASE_URL
- SUPABASE_ANON_KEY
- SUPABASE_SERVICE_ROLE_KEY
- CORS_ORIGINS
- LOG_LEVEL

Telegram token can be provided via `TELEGRAM_BOT_TOKEN` or `MF_TELEGRAM_BOT_TOKEN` (the backend uses the first configured key).

### CORS_ORIGINS format

- Use `*` to allow all origins.
- Or provide a comma-separated list of domains (no spaces required).
- Examples:
  - `https://finance-rosy-seven-27.vercel.app`
  - `https://a.vercel.app,https://b.vercel.app`

## Vercel (frontend)

- NEXT_PUBLIC_API_BASE_URL
- NEXT_PUBLIC_APP_ENV

## Supabase

- SUPABASE_URL (project URL)
- SUPABASE_ANON_KEY (public anon key)
- SUPABASE_SERVICE_ROLE_KEY (service role key)

> SUPABASE_SERVICE_ROLE_KEY never goes to the frontend.
