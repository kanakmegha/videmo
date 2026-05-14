# DemoGen — Setup Guide

## Architecture

```
Browser → Next.js (Vercel) → Python FastAPI Agent (Railway/Fly.io)
                                       ↓
                               Playwright + Vision LLM
                                       ↓
                               WebM video recording
```

## Prerequisites

- Node.js 20+
- Python 3.11+
- A HuggingFace account with API token (free tier works)

---

## Local Development

### 1. Clone & configure env

```bash
cp .env.example .env.local        # Next.js env
cp .env.example agent/.env        # Python agent env
# Fill in HF_TOKEN in agent/.env
```

### 2. Start the Python Agent

```bash
cd agent
python -m venv .venv && source .venv/bin/activate  # or .venv\Scripts\activate on Windows
pip install -r requirements.txt
playwright install chromium
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

Agent runs at `http://localhost:8000`.  
Health check: `curl http://localhost:8000/health`

### 3. Start the Next.js Frontend

```bash
npm install
npm run dev
```

Frontend runs at `http://localhost:3000`.

---

## Production Deployment

### Python Agent → Railway

1. Create a new Railway project, connect your repo
2. Set **Root Directory** to `agent/`
3. Add env var: `HF_TOKEN=your_token`
4. Add **start command**: `uvicorn main:app --host 0.0.0.0 --port $PORT`
5. In the build step, add: `playwright install chromium --with-deps`
6. Note your service URL (e.g. `https://demogen-agent.up.railway.app`)

### Next.js Frontend → Vercel

```bash
npm i -g vercel
vercel
```

Set environment variable in Vercel dashboard:
```
AGENT_API_URL = https://your-agent.railway.app
```

---

## How it works

1. **User enters a URL** on the landing page
2. `POST /api/jobs` creates a job and starts the Python agent
3. User is redirected to `/jobs/[id]`
4. **Discover phase**: agent crawls up to 8 pages via BFS
5. **Strategize phase**: vision LLM scores each page by demo value (1–10)
6. **Plan phase**: LLM generates a 5–8 step action sequence
7. **Plan is shown** to the user — they review and click "Execute Demo"
8. **Execute phase**: agent runs the plan in headless Chromium, recording video
9. **Video** is served via `/api/jobs/[id]/video`

---

## Monetisation hooks (TODO)

- Add Stripe Checkout for Pro/Team plans (see `app/pricing/page.tsx`)
- Gate job creation behind a usage counter in middleware
- Add Clerk/NextAuth for user authentication
- Persist jobs to Neon Postgres (replace in-memory `jobs` dict in `agent/main.py`)
