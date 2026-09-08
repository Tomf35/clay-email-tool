# Clay Email Tool (MVP)

Ingests per-contact "signal" rows from Clay (a mix of firmographic
enrichment and intent/trigger data), generates a personalized outbound
email draft per row via Claude, and requires human review/approval in a
lightweight UI before anything is considered "sent". Nothing is ever
auto-sent to a real destination — approval only marks the draft
`sent_to_destination` after calling a stubbed write-back step.

## Stack

- Node.js + TypeScript + Express
- SQLite (via `better-sqlite3`) as the database — self-contained, no
  external DB service needed. Schema is written in plain, portable SQL so
  it would port to Postgres with minimal changes for production/Vercel.
- Anthropic Claude API (`@anthropic-ai/sdk`) for generation, using tool-use
  (structured output) rather than prose-parsing, so `{subject, body}` comes
  back reliably as JSON.
- Vanilla JS single-page frontend served by the same Express app — no
  separate frontend build step.

## Setup

```bash
cd clay-email-tool
npm install
cp .env.example .env
# edit .env: set ANTHROPIC_API_KEY and INGEST_SECRET
npm run dev
```

The server starts on `http://localhost:3000` (or `$PORT`). Open that URL
in a browser to see the review queue.

### Environment variables

| Var | Required | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | For generation to succeed | Claude API key. If unset, `/api/ingest` still accepts and stores rows, but generation fails gracefully — the signal is marked `status=error`, the failure is logged, and the server keeps running (no crash). |
| `INGEST_SECRET` | Yes | Shared secret Clay (or your test curl) must send in the `X-Webhook-Secret` header on `POST /api/ingest`. Without it set, ingest always returns 500. |
| `REVIEW_AUTH_PASSWORD` | No locally, yes in production | HTTP Basic Auth password guarding the review UI and `/api/sequences*`. Any username is accepted; only the password is checked. If unset, those routes are open with no auth (the local-dev default, unchanged from before auth existed). Does **not** affect `/api/ingest`, `/api/clay-writeback`, or `/health`, which stay reachable by Clay's webhook / a health checker with no login prompt. |
| `PORT` | No (default 3000) | Port Express listens on. |
| `ANTHROPIC_MODEL` | No | Override the Claude model used (defaults to `claude-sonnet-4-5-20250929`). |
| `DB_PATH` | No (default `./data/app.db`) | Override the SQLite file path. On Render this points at the mounted persistent disk, e.g. `/data/app.db`. |

## Deploying on Render

This repo includes a `render.yaml` (a "Blueprint") that defines the web
service, build/start commands, a 1GB persistent disk mounted at `/data`
(so the SQLite file survives deploys/restarts), and the env vars the
service needs.

1. Create an account at [render.com](https://render.com) if you don't
   have one, and connect your GitHub account (Tom already has this set
   up).
2. Push this repo to GitHub, then in the Render dashboard choose **New
   > Web Service**, connect the repo, and Render will auto-detect
   `render.yaml` and use it to configure the service (build command,
   start command, disk, and env var slots) instead of you configuring
   those by hand.
3. Render will prompt you to fill in the env vars marked `sync: false`
   in `render.yaml` before the first deploy:
   - `ANTHROPIC_API_KEY` — get one at
     [console.anthropic.com](https://console.anthropic.com/).
   - `INGEST_SECRET` — any random string you pick yourself, e.g. the
     output of `openssl rand -hex 24`. This is what you'll send back to
     Clay as the webhook header value (see below).
   - `REVIEW_AUTH_PASSWORD` — any random string you pick yourself, e.g.
     another `openssl rand -hex 24`. **Set this before or immediately
     after your first deploy** — see the warning below.
   - `ANTHROPIC_MODEL` — optional, leave blank to use the default.
   - `DB_PATH` is *not* prompted for — `render.yaml` sets it directly to
     `/data/app.db` (the mounted disk) since it isn't a secret.
4. Confirm the persistent disk is attached: in the Render dashboard, open
   the service, go to the **Disks** tab, and you should see
   `clay-email-tool-data` mounted at `/data` with 1GB — `render.yaml`
   provisions this automatically, but it's worth a quick visual check
   before you rely on data surviving a restart.
5. Deploy. Once the build/start commands succeed, Render assigns a
   public HTTPS URL (something like
   `https://clay-email-tool.onrender.com`) — that's your service.

### Pointing Clay at the deployed service

In Clay, set the webhook enrichment column's URL to:

```
https://<your-render-url>/api/ingest
```

- Method: `POST`
- Header: `X-Webhook-Secret: <the INGEST_SECRET value you set on Render>`
- Body: the signal fields — see the "Example curl commands" section
  above for the exact field shape Clay's payload should match.

### Review UI and auth — read this before going live

The review UI (and `GET`/`POST /api/sequences*`) is now served at
`https://<your-render-url>/`. Once `REVIEW_AUTH_PASSWORD` is set, the
browser will prompt for HTTP Basic Auth — any username, and the
`REVIEW_AUTH_PASSWORD` value as the password.

**Warning:** the service is publicly reachable on the internet the
moment it's live. Set `REVIEW_AUTH_PASSWORD` before your first deploy,
or immediately after, so the review UI isn't sitting open with no auth
in the meantime. `/api/ingest`, `/api/clay-writeback`, and `/health`
intentionally stay reachable without a login prompt (Clay's webhook and
any health checker aren't browsers and can't do a Basic Auth prompt),
so don't expect auth on those.

Also note `/api/clay-writeback` is still a stub/mock — it logs whatever
it receives and returns 200, but doesn't call a real Clay or Salesloft
API yet. Wiring up a real write-back integration is a separate
follow-up task, not part of this deploy.

## Project layout

```
src/
  server.ts              Express app wiring, static file serving, error handling
  types.ts                Shared TS types (SignalRecord, DraftRow, etc.)
  db/
    index.ts              SQLite connection + schema (signals, drafts, audit_log)
    repository.ts          Data access helpers used by routes
  lib/
    normalize.ts           Turns arbitrary Clay JSON into a SignalRecord
    promptBuilder.ts        Pure function: SignalRecord -> labeled context block
    generation.ts           Calls Claude (tool-use) to produce {subject, body}
    generationRunner.ts      Orchestrates generation + persistence + error handling
    exportDraft.ts           Stubbed write-back step (calls /api/clay-writeback)
  routes/
    ingest.ts               POST /api/ingest
    drafts.ts                GET/POST endpoints for the review workflow
    misc.ts                   /health and the mock /api/clay-writeback endpoint
  public/                  Vanilla JS/HTML/CSS review UI (served statically)
config/
  systemPrompt.md          Editable system prompt (loaded at runtime, not hardcoded)
```

## Data contract (SignalRecord)

All fields are optional except `external_id` (or a fallback identifier —
see below). Unrecognized fields Clay sends are tolerated and stored in
`raw_payload`, and are still rendered into the generation prompt under an
"Other provided fields" section, so nothing Clay sends is silently
dropped.

Recognized fields: `contact_name`, `contact_title`, `contact_email`,
`linkedin_url`, `company_name`, `company_domain`, `funding_stage`,
`funding_amount`, `funding_date`, `headcount`, `tech_stack` (array or
comma-separated string), `trigger_type`, `trigger_detail`,
`trigger_date`, `trigger_source_url`.

The ingest endpoint accepts `external_id`, or falls back to `id`, then
`contact_email`, then `email` if `external_id` is absent, as the dedup key.

## API

- `POST /api/ingest` — header `X-Webhook-Secret: <INGEST_SECRET>`, body:
  arbitrary JSON signal payload. Upserts the signal by `external_id`,
  synchronously runs generation, and returns the resulting signal/draft
  status.
- `GET /api/drafts?status=pending_review` — list drafts, most recent
  first, with company/contact/trigger summary. Omit `status` for all.
- `GET /api/drafts/:id` — full detail: raw signal fields, draft, audit log.
- `POST /api/drafts/:id/approve` — approves as-is, sets
  `final_subject`/`final_body` from the current draft, writes an audit
  log entry, and calls the stubbed `exportDraft()`.
- `POST /api/drafts/:id/edit-approve` — body `{subject, body}`, marks
  `edited_approved`, sets final fields to the provided values, exports.
- `POST /api/drafts/:id/regenerate` — body `{note?}`, re-runs generation
  for the same signal (with an optional extra instruction), creates a
  **new** draft row, and marks the old one `superseded` (it is not
  overwritten, so history is preserved).
- `POST /api/drafts/:id/reject` — body `{reason}`, marks `rejected` and
  logs the reason.
- `POST /api/clay-writeback` — mock endpoint; logs whatever payload it
  receives and returns 200. This simulates the real Clay/Salesloft
  write-back API that `exportDraft()` would call in production — the
  interface is built cleanly so a real HTTP call can be swapped in later
  without touching the approval routes.
- `GET /health` — basic health check.

## Example curl commands

Set these once:

```bash
export BASE=http://localhost:3000
export SECRET=changeme   # must match INGEST_SECRET in your .env
```

### 1. Firmographic-only row (no trigger/intent data)

```bash
curl -s -X POST "$BASE/api/ingest" \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: $SECRET" \
  -d '{
    "external_id": "row-001",
    "contact_name": "Priya Shah",
    "contact_title": "Head of People",
    "contact_email": "priya@northfieldtech.co.uk",
    "company_name": "Northfield Tech",
    "company_domain": "northfieldtech.co.uk",
    "headcount": 85,
    "tech_stack": ["HubSpot", "BambooHR", "Slack"]
  }' | jq
```

### 2. Intent/trigger-only row (minimal firmographic detail)

```bash
curl -s -X POST "$BASE/api/ingest" \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: $SECRET" \
  -d '{
    "external_id": "row-002",
    "contact_email": "j.morgan@brightlane.io",
    "trigger_type": "leadership_change",
    "trigger_detail": "James Morgan promoted to CFO",
    "trigger_date": "2026-08-15",
    "trigger_source_url": "https://linkedin.com/in/jmorgan-example"
  }' | jq
```

### 3. Combined row (firmographic + funding + trigger)

```bash
curl -s -X POST "$BASE/api/ingest" \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: $SECRET" \
  -d '{
    "external_id": "row-003",
    "contact_name": "Alex Turner",
    "contact_title": "COO",
    "contact_email": "alex@fernwoodgroup.com",
    "linkedin_url": "https://linkedin.com/in/alexturner-example",
    "company_name": "Fernwood Group",
    "company_domain": "fernwoodgroup.com",
    "funding_stage": "Series A",
    "funding_amount": "£4.2m",
    "funding_date": "2026-06-01",
    "headcount": 42,
    "tech_stack": ["Xero", "Deel"],
    "trigger_type": "job_change",
    "trigger_detail": "Alex Turner joined as COO 2 months ago",
    "trigger_date": "2026-07-01"
  }' | jq
```

Each call returns something like:

```json
{
  "signal": { "id": 1, "external_id": "row-001", "status": "generated" },
  "draft": { "id": 1, "status": "pending_review" }
}
```

Then open `http://localhost:3000/` to review, edit, approve, regenerate,
or reject the generated drafts. Approving or edit-approving logs a
"would send to Clay" payload to the server console via the
`/api/clay-writeback` mock endpoint.

## Non-goals / out of scope for this build

- No real Clay/Salesloft write-back integration — `exportSequence()` calls a
  local mock endpoint (`/api/clay-writeback`) only. Wiring this up to a real
  Clay/Salesloft API call is a separate follow-up task, not part of this
  deploy.
- No multi-user auth — `REVIEW_AUTH_PASSWORD` (see `src/lib/basicAuth.ts`) is
  a single shared password for the review UI, not per-user accounts. Fine
  for Tom as sole reviewer today; would need real per-user auth (session
  cookies / API keys tied to a user record) if more reviewers are added.
- No background job queue — generation runs synchronously inside the
  request handler, per the plan.
- No A/B testing/eval framework, no CRM sync.

## Known risks / things to focus testing on

- Generation failures (missing/invalid API key, malformed tool output,
  network errors) are caught in `lib/generation.ts` /
  `lib/generationRunner.ts` and turned into `signal.status = 'error'`
  rather than an unhandled exception — verify this holds under real
  Claude API error responses (e.g. rate limits, invalid model name), not
  just the "no key" case exercised during the build sanity check.
- `better-sqlite3` is a native module; if `npm install` is run on a
  different OS/architecture than where `node_modules` was built, a
  rebuild (`npm rebuild better-sqlite3`) may be needed.
- The regenerate flow re-reads `raw_payload` from the `signals` table and
  re-normalizes it rather than reusing the original in-memory object —
  this should be equivalent but is worth a specific test.
- The mock `exportDraft()` makes an actual loopback HTTP call to its own
  server on `PORT` rather than an in-process function call, to exercise
  the same interface a real integration would use; if the server were
  ever run in a mode where `localhost:$PORT` isn't reachable from itself
  (e.g. behind certain proxies/containers), this call would silently fail
  (logged, not thrown) and the draft would still be marked
  `sent_to_destination` even though the mock write-back didn't actually
  fire — worth confirming the desired behavior here in review.
