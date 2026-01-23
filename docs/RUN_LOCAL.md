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
