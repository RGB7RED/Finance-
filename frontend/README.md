# Frontend (Next.js)

## Install

```bash
npm install
```

## Development

```bash
npm run dev
```

## Environment

Set `NEXT_PUBLIC_API_BASE_URL` to point to the backend API. The Telegram `initData` is only available inside the Telegram Mini App, so opening the app in a regular browser will show the unauthorized screen.

After login, default budgets are ensured and the dashboard shows accounts and categories for the active budget.

## Build

```bash
npm run build
```
