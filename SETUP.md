# DemoGen — Setup Guide (Vercel-only)

Everything runs on a single Vercel deployment. No Railway, no separate service.

## Architecture

```
User → Vercel
        ├── Next.js App Router  (frontend + API routes)
        ├── plan-stream         (Fluid Compute, 120 s, discovers + plans)
        ├── execute-stream      (Fluid Compute, 180 s, records browser)
        ├── Upstash Redis       (job state, 24 h TTL)
        └── Vercel Blob         (video CDN)

Browser: @sparticuz/chromium (~68 MB, serverless-optimised)
LLM:     HuggingFace router (vision models via OpenAI-compat API)
```

## Prerequisites

- Node.js 20+
- Vercel account (free)
- HuggingFace account → Settings → Access Tokens → New token (read)
- Upstash account (free) → Create a Redis database
- Vercel Blob store (created in Vercel dashboard)

---

## Local Development

### 1. Clone & configure env

```bash
cp .env.example .env.local
# Fill in HF_TOKEN, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN,
# and BLOB_READ_WRITE_TOKEN in .env.local
```

### 2. Install dependencies & Playwright browser

```bash
npm install
npx playwright install chromium   # one-time, installs local Chromium for dev
```

### 3. Run

```bash
npm run dev
```

Open `http://localhost:3000`.

> In local dev the agent auto-detects it's not on Vercel and uses the
> Playwright-installed Chromium instead of @sparticuz/chromium.

---

## Production Deployment

### 1. Create external services (all free tier)

**Upstash Redis**
1. https://upstash.com → Create Database (Global, free tier)
2. Copy `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`

**Vercel Blob**
1. Vercel dashboard → Storage → Create → Blob
2. Copy `BLOB_READ_WRITE_TOKEN`

### 2. Deploy to Vercel

```bash
npm i -g vercel
vercel
```

When prompted, add env vars (or set them in the Vercel dashboard):

```
HF_TOKEN                  = hf_...
UPSTASH_REDIS_REST_URL    = https://...
UPSTASH_REDIS_REST_TOKEN  = ...
BLOB_READ_WRITE_TOKEN     = vercel_blob_rw_...
```

Vercel will run `npm install && npx playwright install chromium --with-deps`
at build time (configured in `vercel.json`), bundling the Chromium binary
into the deployment.

### 3. Done

One URL, one `git push`, zero separate services to manage.

---

## How the two-phase SSE works

| Phase | Endpoint | maxDuration | What happens |
|-------|----------|-------------|--------------|
| Plan  | `GET /api/jobs/[id]/plan-stream`    | 120 s | Browser crawls, LLM scores + plans, emits events, closes |
| Execute | `GET /api/jobs/[id]/execute-stream` | 180 s | Browser records demo, uploads to Blob, emits events, closes |

Connecting to `execute-stream` is the user's approval signal — no separate POST needed.

---

## Monetisation hooks (TODO)

- Stripe Checkout in `app/pricing/page.tsx`
- Gate job creation in `app/api/jobs/route.ts` (check usage counter in Redis)
- Clerk or NextAuth for user accounts
- Neon Postgres for durable job history (replace `lib/redis.ts`)
