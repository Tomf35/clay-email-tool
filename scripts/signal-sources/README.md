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
