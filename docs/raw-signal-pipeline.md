# Raw signal pipeline

## Why this exists

Today, Clay does two jobs: finding a raw trigger (a funding round, a hiring
spike, etc.) AND enriching/finding the contact for it — and it charges data
credits for both, on every row, whether or not that row ever turns into a
sequence a human approves. This pipeline splits those two jobs so Clay only
gets paid for the second one, and only on rows a human (or a score) has
already decided are worth enriching.

```
free/cheap source          this app                       Clay                 this app (existing)
------------------    ->  ----------------------     ->  -----------------  -> --------------------------
Companies House scan       raw_signals table               find contact        /api/ingest (unchanged)
job-board scan             (score, status: new/           enrich company       normalize -> generate ->
news/RSS scan               qualified/dismissed/            email/etc.          review queue (unchanged)
Clay (still fine for        sent_to_clay)
 signal types with no
 cheap alternative)
```

## What's built (this slice)

- `raw_signals` table — id, external_id (dedupe key), source, raw_payload,
  company_name/signal_type/trigger_detail/trigger_date (denormalized for
  display), score, score_reasons (JSON array of the rules that fired),
  status (`new` | `qualified` | `dismissed` | `sent_to_clay`), reviewed_at,
  reviewer_notes.
- `POST /api/raw-signals/ingest` — shared-secret gated (same
  `INGEST_SECRET` as `/api/ingest`), same shape of caller as the Companies
  House script: anyone with the secret can post a raw signal payload. Scores
  it on arrival via `src/lib/rawSignalScoring.ts` and auto-sets status to
  `qualified` if the score clears `RAW_SIGNAL_QUALIFY_THRESHOLD` (default
  50), otherwise leaves it `new` for manual triage. Re-posting the same
  `external_id` refreshes score/payload but never overwrites a status a
  human has already set (qualified/dismissed/sent_to_clay).
- `GET /api/raw-signals` (+ `/:id`, `/:id/qualify`, `/:id/dismiss`) —
  behind the same basicAuth as the sequence review routes. Lets a reviewer
  see the queue, filter by status, and override the score's call in either
  direction.
- A "Raw signals" tab in the review UI, next to the existing "Sequences"
  tab — same page, same auth, its own table with a score pill (colored by
  band), qualify/dismiss buttons, and a status filter.

## Scoring (rule-based, `src/lib/rawSignalScoring.ts`)

Every point is a named rule, and the reasons list is stored and shown (as
the score pill's tooltip in the UI) so a reviewer never has to guess why
something scored the way it did:

| Rule | Points |
| --- | --- |
| `signal_type` weight — funding_events +40, cost_restructuring +35, hr_recent_change +30, admin_vendor_consolidation +25, anything else +10 | up to 40 |
| Trigger recency — within 7d +20, within 14d +10, within 30d +5, older +0 | up to 20 |
| Already has a named contact (cheaper to enrich) | +10 |
| Trigger has a verifiable source URL | +5 |

`QUALIFY_THRESHOLD` defaults to 50 and is overridable via the
`RAW_SIGNAL_QUALIFY_THRESHOLD` env var — tune it once real volume/quality
data comes in, no code change needed. This is intentionally simple; nothing
here stops it from being replaced or supplemented with a Claude-scored
pass later if the rules prove too blunt (e.g. borderline scores routed to
a cheap classification call) — that was explicitly deferred, not designed
away.

## Next step: handing qualified signals to Clay (not yet built)

The chosen mechanism is **Clay polls this app** (rather than this app
calling into a Clay webhook), so Clay's own scheduling/retry handling does
the work and this app stays simple. The shape, when you're ready to build
it:

```
GET /api/raw-signals/qualified-for-clay
Header: X-Webhook-Secret: <INGEST_SECRET>
```

- Returns `status = 'qualified'` rows, oldest first, capped at some page
  size (e.g. 50) so Clay can page through a backlog safely.
- On return, this endpoint immediately flips each returned row to
  `sent_to_clay` (optimistic — a network failure between the response
  leaving this server and Clay receiving it would mark a row sent that
  Clay never actually got; acceptable for a v1, but worth knowing). A more
  robust version would have Clay explicitly ack rows it successfully
  loaded via a second small `POST /api/raw-signals/:id/ack-sent`, and only
  flip status on that ack — that's the natural v2 if drops turn out to
  matter in practice.
- Response shape mirrors what `/api/ingest` already expects downstream,
  so Clay's enrichment table just needs to map its own output (found
  contact_name/email/linkedin_url/etc.) back onto the existing `/api/ingest`
  payload shape — no new schema for Clay to learn, it's the same fields
  this app already accepts today.
- Clay side: a scheduled table run (e.g. every 30–60 min) calling this
  endpoint, running your existing find-contact/enrich workflow only on
  what comes back, then POSTing each enriched result to `/api/ingest` same
  as today.

This is a small addition (one route, reusing the existing repository
functions) — flagged as a follow-up rather than built now so the
polling/ack behavior above gets a real decision first, since retry/ack
semantics are the one part of this whole pipeline with actual product
risk (a dropped row silently never reaching Clay).

## Feeding the raw_signals queue

Right now the only source wired up is
`scripts/signal-sources/companies-house-funding.ts`, which POSTs into
`/api/raw-signals/ingest` (update it — or add new scripts — to point at
that endpoint instead of `/api/ingest`, since it now belongs in the
raw-signal queue, not the enriched-signal one). Any other free/cheap
source (a job-board scanner, an RSS/news scanner) plugs in the same way:
whatever shape of payload, as long as it includes `external_id` and ideally
`signal_type`/`trigger_date`/`company_name` for scoring to have something
to work with.
