# Alternative signal sources

Rough, standalone scripts that source signals more cheaply than a Clay
enrichment waterfall and POST them into this app's `/api/raw-signals/ingest`
queue (see `docs/raw-signal-pipeline.md`), where each gets a rule-based
score and waits for a human — or the score — to decide whether it's worth
handing to Clay for contact-find/enrich, rather than skipping straight to
email generation. Each script is independent — run whichever ones are
useful, ignore the rest.

## companies-house-funding.ts

Sources UK "funding event" signals from Companies House (the UK company
registry) instead of a Clay funding-data column. Companies House's API is
free, requires only a free API key, and has no per-lookup credit cost.

**What it gives you for free:** company profile data, a proxy for recent
funding events (SH01 share-allotment filings), and a named active director
to use as the outbound contact for the CEO/Founder/MD persona.

**What it doesn't give you:** a contact email, or discovery of brand-new
target companies (it works off a watchlist you provide). See the comments
at the top of the script for the full breakdown and setup/run instructions.

This is a mockup meant to prove the pattern, not a finished production
job — before relying on it, you'd want: a real dedupe store (not a local
JSON file) if running from more than one machine, a way to grow the
watchlist automatically, and a plan for filling in contact_email (e.g. a
cheap one-off email-finder call, or routing these into LinkedIn/cold-call
outreach only, which don't require one).

## companies-house-stream-funding.ts

The "no watchlist" version: instead of polling a fixed list of company
numbers, this connects to Companies House's **streaming API** and watches
every filing event across ALL UK companies in real time, catching
funding-type filings from companies you never had to know about in
advance.

**The tradeoff:** this needs a permanently-open connection, so unlike the
watchlist version it can't run as a scheduled cron job — it has to run as
an always-on process. On Render that means a second paid service (a
Background Worker, same ~$7/month Starter tier as the main web service),
so this saves Clay credits but doesn't get hosting to zero.

See the comments at the top of the script for the full breakdown,
including what's rough about this mockup (timepoint persistence,
reconnect handling, no backoff) before running it unattended for real.

## google-news-funding-rss.ts

The zero-setup option: polls a Google News RSS search for UK funding
coverage — no API key, no registration, nothing to set up beyond the
ingest endpoint/secret you already have. Runs as a one-shot script like
`companies-house-funding.ts` (schedule it via cron), not a persistent
connection, so no extra hosting cost either.

**The tradeoff:** this is unstructured text, not structured data. The
company name is a best-effort regex guess at the headline's subject —
tested against sample headlines including a genuine false positive
("Government raises concerns over funding gap...", which isn't a company
raising money at all). Setting `COMPANIES_HOUSE_API_KEY` (optional, same
free key as the other two scripts) turns on a real UK-company check: a
name that doesn't resolve to an active UK company gets skipped rather
than posted, which is exactly what catches cases like that. Without the
key, every extracted name is posted unresolved for a human to judge.

Also worth knowing: press mostly covers rounds worth writing about, so
this will skew toward bigger/more notable raises and likely miss the
small, quiet SME rounds a Companies House filing would catch regardless
of whether anyone wrote about it. Treat this as a complement to the other
two scripts, not a replacement, if quiet small-company rounds matter to
your ICP.

Parsing/extraction was verified against a realistic sample RSS feed
(see the script's comments) rather than a live fetch — this sandbox's
network policy blocks news.google.com outright, so the live fetch itself
was untested until you ran it manually (which is how we caught and fixed
a real external_id collision bug — see git history).

### Running it daily without your laptop needing to be on

`.github/workflows/scan-google-news.yml` runs this script automatically
once a day via GitHub Actions — free (well within the free-tier minutes
at this volume), and it runs on GitHub's servers rather than yours, so it
fires whether or not your machine is on. To turn it on:

1. In your repo on GitHub: **Settings → Secrets and variables → Actions**.
2. Add three repository secrets: `INGEST_URL` (your Render
   `/api/raw-signals/ingest` URL), `INGEST_SECRET` (same value as on
   Render), and `COMPANIES_HOUSE_API_KEY` (optional, but recommended —
   without it the Companies House verification step is skipped and every
   extracted name is posted unresolved).
3. That's it — the workflow runs daily at 07:00 UTC. You can also trigger
   it manually any time from the repo's **Actions** tab (**Actions → Scan
   Google News for UK funding signals → Run workflow**) to test it
   without waiting for the schedule.

One caveat: GitHub Actions runners are thrown away after every run, so
the workflow uses GitHub's cache to persist the script's "which articles
have I already posted" file between days — otherwise every daily run
would re-see the same recent articles. See the comments in the workflow
file for how that's wired up. GitHub also auto-disables a repo's
scheduled workflows after 60 days with no commits at all to the repo —
unlikely to matter here given how often this repo is being pushed to,
but worth knowing if it ever goes quiet for a long stretch.
