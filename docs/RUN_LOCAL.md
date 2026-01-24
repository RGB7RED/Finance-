# Run locally

## Frontend

1. Go to the frontend directory.
2. Copy the env template.
3. Install dependencies and start the dev server.

```bash
cd frontend
cp .env.example .env.local
npm install
npm run dev
```

Note: `.npmrc` pins the public registry to avoid 403 errors during `npm install`.

## Backend

1. Go to the backend directory.
2. Copy the env template.
3. Create a virtual environment, install dependencies, and run the server.

```bash
cd backend
cp .env.example .env
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

## Запуск через Docker Compose

1. Create the backend environment file.

```bash
cd backend
cp .env.example .env
```

2. Build and run the backend service.

```bash
cd ..
docker compose up --build
```

3. Check the health endpoint.

```bash
curl http://localhost:8000/health
```
