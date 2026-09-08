/**
 * companies-house-stream-funding.ts
 *
 * ROUGH MOCKUP — the "no watchlist" version of companies-house-funding.ts.
 * Instead of polling a fixed list of company numbers, this connects to
 * Companies House's STREAMING API and watches every filing event across
 * ALL UK companies in real time, picking out capital/funding-type filings
 * as they happen. This means discovering brand-new target companies you
 * never had to know about in advance — the tradeoff (see README.md and
 * the header of the watchlist version) is that it needs a permanently-open
 * connection, so it must run as an always-on process, not a scheduled job.
 *
 * WHAT IT DOES
 * 1. Opens a long-lived HTTPS connection to
 *    https://stream.companieshouse.gov.uk/filings (same free API key as
 *    the REST API, sent as HTTP Basic Auth username).
 * 2. Reads newline-delimited JSON filing events as they're published,
 *    across every company in the UK register.
 * 3. Filters to `data.category === "capital"` (the category SH01 —
 *    return of allotment of shares — falls under; the usual proxy for a
 *    funding event, same as the watchlist version).
 * 4. Optionally filters further by company type (private limited only, by
 *    default) to cut noise from PLCs/large caps outside Mintago's ICP —
 *    tune COMPANY_TYPE_FILTER below or remove it entirely.
 * 5. For each match, looks up the company profile + an active officer via
 *    the ordinary REST API (same calls as the watchlist script) and POSTs
 *    a raw signal into /api/raw-signals/ingest.
 * 6. Persists the stream's last-seen `timepoint` to a local file so a
 *    restart resumes from where it left off instead of re-scanning
 *    history or silently skipping events while it was down.
 *
 * WHAT'S ROUGH ABOUT THIS MOCKUP (read before relying on it)
 * - Timepoint persistence is a local JSON file. On Render that only
 *   survives restarts if this process's working directory is on a
 *   persistent disk (the same /data disk your main service already has —
 *   point TIMEPOINT_FILE at a path under it). On a plain ephemeral
 *   filesystem, a redeploy silently resets to "start from now" and any
 *   gap in coverage while it was down is lost, not backfilled.
 * - Reconnect logic here is a fixed delay + one retry of "start fresh if
 *   the saved timepoint is rejected as too old" (HTTP 416). No exponential
 *   backoff, no alerting if it stays disconnected — fine to prove the
 *   pattern, not fine to trust unattended for weeks.
 * - No dedupe beyond the raw_signals table's own external_id uniqueness —
 *   fine, since that's already enforced server-side.
 * - Full-stream volume: Companies House processes on the order of several
 *   thousand filings a day nationally; the "capital" category is a
 *   meaningful subset of that, not all of it, but this WILL surface far
 *   more candidate companies than a hand-picked watchlist. The per-hit
 *   REST lookups (profile + officers) are rate-limited by Companies House
 *   (currently 600 requests per 5-minute window per key) — if this trips
 *   that limit in practice, add a small queue/backoff around
 *   getCompanyProfile/getOfficers rather than calling them inline as
 *   events arrive.
 *
 * SETUP
 *   export COMPANIES_HOUSE_API_KEY=xxxx
 *   export INGEST_URL=https://clay-email-tool.onrender.com/api/raw-signals/ingest
 *   export INGEST_SECRET=xxxx
 *   export TIMEPOINT_FILE=/data/ch-stream-timepoint.json   (optional, see note above)
 *
 * RUN (as a long-lived process, not a cron job — see header notes)
 *   npx ts-node scripts/signal-sources/companies-house-stream-funding.ts
 */

import https from "https";
import fs from "fs";
import path from "path";

const CH_API_KEY = process.env.COMPANIES_HOUSE_API_KEY;
const INGEST_URL = process.env.INGEST_URL;
const INGEST_SECRET = process.env.INGEST_SECRET;
const TIMEPOINT_FILE =
  process.env.TIMEPOINT_FILE || path.join(__dirname, ".stream-timepoint.json");

// Filing categories treated as a funding-event proxy, same rule as the
// watchlist version. "capital" covers SH01 (return of allotment of
// shares) among a few other capital-structure filings.
const FUNDING_CATEGORIES = new Set(["capital"]);

// Only alert on private limited companies by default — set to null to
// disable this filter entirely and catch every company type.
const COMPANY_TYPE_FILTER: string | null = "ltd";

const RECONNECT_DELAY_MS = 5000;

function chAuthHeader(): string {
  return "Basic " + Buffer.from(`${CH_API_KEY}:`).toString("base64");
}

async function chGet(pathname: string): Promise<any> {
  const res = await fetch(`https://api.company-information.service.gov.uk${pathname}`, {
    headers: { Authorization: chAuthHeader() },
  });
  if (!res.ok) {
    throw new Error(`Companies House API error ${res.status} on ${pathname}: ${await res.text()}`);
  }
  return res.json();
}

async function getCompanyProfile(companyNumber: string): Promise<any> {
  return chGet(`/company/${companyNumber}`);
}

async function getOfficers(companyNumber: string): Promise<any[]> {
  const data = await chGet(`/company/${companyNumber}/officers`);
  return (data.items || []).filter((o: any) => !o.resigned_on);
}

function pickPrimaryOfficer(officers: any[]): any | undefined {
  const directors = officers.filter((o) => (o.officer_role || "").toLowerCase().includes("director"));
  const pool = directors.length ? directors : officers;
  return pool.sort((a, b) => (a.appointed_on || "").localeCompare(b.appointed_on || ""))[0];
}

function loadTimepoint(): number | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(TIMEPOINT_FILE, "utf8"));
    return raw.timepoint;
  } catch {
    return undefined;
  }
}

function saveTimepoint(timepoint: number) {
  try {
    fs.writeFileSync(TIMEPOINT_FILE, JSON.stringify({ timepoint }));
  } catch (err) {
    console.error("[stream] failed to persist timepoint:", err);
  }
}

// A stream event's resource_uri looks like
// "/company/12345678/filing-history/abcdEFGH..." — the company number is
// the path segment right after "/company/". This is the same convention
// Companies House uses for resource_uri across all its streams; there is
// no dedicated company_number field on the filing data itself.
function extractCompanyNumber(resourceUri: string | undefined): string | undefined {
  const match = /\/company\/([^/]+)\//.exec(resourceUri || "");
  return match?.[1];
}

async function postSignal(signal: Record<string, unknown>): Promise<void> {
  if (!INGEST_URL || !INGEST_SECRET) {
    console.log("[dry-run] would POST:", JSON.stringify(signal, null, 2));
    return;
  }
  const res = await fetch(INGEST_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Webhook-Secret": INGEST_SECRET },
    body: JSON.stringify(signal),
  });
  const body = await res.json().catch(() => ({}));
  console.log(`[ingest] ${res.status}`, JSON.stringify(body));
}

async function handleFilingEvent(event: any) {
  const data = event?.data;
  const timepoint = event?.event?.timepoint;
  if (typeof timepoint === "number") saveTimepoint(timepoint);

  if (!data || !FUNDING_CATEGORIES.has(data.category)) return;

  const companyNumber = extractCompanyNumber(event.resource_uri);
  if (!companyNumber) {
    console.log("[stream] funding-category filing with no parseable company number, skipping:", event.resource_uri);
    return;
  }

  try {
    const profile = await getCompanyProfile(companyNumber);
    if (COMPANY_TYPE_FILTER && profile.type !== COMPANY_TYPE_FILTER) {
      console.log(`[stream] ${companyNumber} is type "${profile.type}", not "${COMPANY_TYPE_FILTER}" — skipping`);
      return;
    }

    const officers = await getOfficers(companyNumber);
    const officer = pickPrimaryOfficer(officers);
    if (!officer) {
      console.log(`[stream] ${companyNumber} — funding filing but no active officer to use as contact, skipping`);
      return;
    }

    const signal = {
      external_id: `ch-stream-${companyNumber}-${data.transaction_id}`,
      source: "companies_house_stream",
      company_name: profile.company_name,
      contact_name: officer.name,
      contact_title: officer.officer_role,
      contact_email: undefined,
      signal_type: "funding_events",
      persona: "CEO",
      trigger_type: "funding_filing",
      trigger_detail: `Filed ${data.description || data.type} (share allotment) with Companies House`,
      trigger_date: data.date,
      trigger_source_url: `https://find-and-update.company-information.service.gov.uk/company/${companyNumber}/filing-history`,
      company_signal_detail: `Companies House filing (${data.type}) indicating a recent share allotment/funding event`,
      company_signal_date: data.date,
      company_signal_source: `https://find-and-update.company-information.service.gov.uk/company/${companyNumber}`,
    };

    await postSignal(signal);
  } catch (err: any) {
    console.error(`[stream] error processing ${companyNumber}:`, err.message);
  }
}

function connect() {
  if (!CH_API_KEY) {
    console.error("Missing COMPANIES_HOUSE_API_KEY");
    process.exit(1);
  }

  const timepoint = loadTimepoint();
  const qs = timepoint ? `?timepoint=${timepoint}` : "";
  console.log(`[stream] connecting${timepoint ? ` from timepoint ${timepoint}` : " (no saved timepoint, starting from now)"}...`);

  const req = https.get(
    {
      hostname: "stream.companieshouse.gov.uk",
      path: `/filings${qs}`,
      auth: `${CH_API_KEY}:`,
    },
    (res) => {
      if (res.statusCode === 416) {
        console.warn("[stream] saved timepoint rejected as too old (416) — dropping it and reconnecting fresh");
        saveTimepoint(0);
        try {
          fs.unlinkSync(TIMEPOINT_FILE);
        } catch {
          // ignore
        }
        setTimeout(connect, RECONNECT_DELAY_MS);
        return;
      }
      if (res.statusCode !== 200) {
        console.error(`[stream] unexpected status ${res.statusCode}, reconnecting in ${RECONNECT_DELAY_MS}ms`);
        setTimeout(connect, RECONNECT_DELAY_MS);
        return;
      }

      console.log("[stream] connected");
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue; // CH sends periodic blank "heartbeat" lines
          try {
            const event = JSON.parse(trimmed);
            handleFilingEvent(event);
          } catch (err) {
            console.error("[stream] failed to parse line:", trimmed.slice(0, 200));
          }
        }
      });
      res.on("end", () => {
        console.warn(`[stream] connection ended, reconnecting in ${RECONNECT_DELAY_MS}ms`);
        setTimeout(connect, RECONNECT_DELAY_MS);
      });
    }
  );

  req.on("error", (err) => {
    console.error("[stream] connection error:", err.message, `— reconnecting in ${RECONNECT_DELAY_MS}ms`);
    setTimeout(connect, RECONNECT_DELAY_MS);
  });

  req.end();
}

connect();
