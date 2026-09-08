/**
 * companies-house-funding.ts
 *
 * ROUGH MOCKUP — a free alternative signal source for UK "funding event"
 * signals, meant to run alongside (or instead of) Clay for this one signal
 * type. It costs nothing but your own compute/hosting: Companies House's
 * API is free, unlimited for reasonable use, and needs only a free API key
 * (register at https://developer.company-information.service.gov.uk/).
 *
 * WHAT IT DOES
 * 1. For each company in a watchlist (by company number), pulls recent
 *    filing history from Companies House.
 * 2. Flags filings that are a reasonable proxy for a funding/capital event
 *    — primarily "SH01" (return of allotment of shares), which is what UK
 *    companies file after most funding rounds.
 * 3. Cross-references the company's officers list to find a named director
 *    (free, from the same API) to use as the outbound contact — covering
 *    the CEO/Founder/MD persona your prompt already expects for funding
 *    signals.
 * 4. Builds a signal-shaped payload and POSTs it to the raw-signal queue
 *    (/api/raw-signals/ingest — see docs/raw-signal-pipeline.md), where it
 *    gets a rule-based score and waits for a human (or the score) to
 *    decide whether it's worth handing to Clay for contact-enrichment,
 *    rather than skipping straight to email generation. It does NOT post
 *    to /api/ingest directly, since these hits have no verified email yet.
 *
 * WHAT IT DOESN'T DO (yet)
 * - No company_domain / contact_email — Companies House doesn't have
 *   these. You'd still need a cheap, one-off email-finding step (Clay's
 *   people-search columns, Hunter.io, or similar) for the contact_email
 *   field, OR route these into a queue for the LinkedIn/cold-call channels
 *   only, which don't strictly need an email.
 * - No target-account discovery — it works off a watchlist of company
 *   numbers you already care about. Discovering NEW target companies for
 *   free would mean a separate step (e.g. Companies House's advanced
 *   search by SIC code + incorporation date range), not included here.
 * - Naive dedupe via a local JSON file — fine for a single-machine cron
 *   job, not for multi-instance deployments.
 *
 * SETUP
 *   export COMPANIES_HOUSE_API_KEY=xxxx        (free, from CH developer hub)
 *   export INGEST_URL=https://clay-email-tool.onrender.com/api/raw-signals/ingest
 *   export INGEST_SECRET=xxxx                  (same value as on Render)
 *   export WATCHLIST_COMPANY_NUMBERS=01234567,07654321   (comma-separated)
 *
 * RUN
 *   npx ts-node scripts/signal-sources/companies-house-funding.ts
 *
 * SCHEDULING
 *   This is a script, not a server — run it on a schedule via a Render Cron
 *   Job, a GitHub Actions scheduled workflow, or any machine with a crontab.
 *   Daily is plenty; Companies House filings aren't real-time anyway.
 */

import fs from "fs";
import path from "path";

const CH_API_KEY = process.env.COMPANIES_HOUSE_API_KEY;
const INGEST_URL = process.env.INGEST_URL;
const INGEST_SECRET = process.env.INGEST_SECRET;
const WATCHLIST = (process.env.WATCHLIST_COMPANY_NUMBERS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const SEEN_FILE = path.join(__dirname, ".seen-filings.json");
const LOOKBACK_DAYS = 14;

// Filing categories that are a reasonable free proxy for "the company just
// raised money". SH01 = return of allotment of shares, the filing almost
// every UK company makes shortly after taking on new equity investment.
const FUNDING_FILING_TYPES = new Set(["SH01"]);

interface SeenStore {
  [companyNumber: string]: string[]; // filing transaction ids already processed
}

function loadSeen(): SeenStore {
  try {
    return JSON.parse(fs.readFileSync(SEEN_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveSeen(seen: SeenStore) {
  fs.writeFileSync(SEEN_FILE, JSON.stringify(seen, null, 2));
}

function chAuthHeader(): string {
  // Companies House uses HTTP Basic auth with the API key as the username
  // and an empty password.
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

async function getRecentFilings(companyNumber: string): Promise<any[]> {
  const data = await chGet(`/company/${companyNumber}/filing-history?category=capital&items_per_page=25`);
  return data.items || [];
}

async function getOfficers(companyNumber: string): Promise<any[]> {
  const data = await chGet(`/company/${companyNumber}/officers`);
  return (data.items || []).filter((o: any) => !o.resigned_on);
}

function withinLookback(dateStr: string): boolean {
  const filingDate = new Date(dateStr);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - LOOKBACK_DAYS);
  return filingDate >= cutoff;
}

function pickPrimaryOfficer(officers: any[]): any | undefined {
  // Prefer a "director" role over "secretary" etc.; officers list has no
  // seniority signal beyond role/appointment date, so this is a heuristic.
  const directors = officers.filter((o) => (o.officer_role || "").toLowerCase().includes("director"));
  const pool = directors.length ? directors : officers;
  // Earliest-appointed active officer is a reasonable founder/MD proxy.
  return pool.sort((a, b) => (a.appointed_on || "").localeCompare(b.appointed_on || ""))[0];
}

async function postSignal(signal: Record<string, unknown>): Promise<void> {
  if (!INGEST_URL || !INGEST_SECRET) {
    console.log("[dry-run, INGEST_URL/INGEST_SECRET not set] would POST:", JSON.stringify(signal, null, 2));
    return;
  }
  const res = await fetch(INGEST_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Webhook-Secret": INGEST_SECRET,
    },
    body: JSON.stringify(signal),
  });
  const body = await res.json().catch(() => ({}));
  console.log(`[ingest] ${res.status}`, JSON.stringify(body));
}

async function main() {
  if (!CH_API_KEY) {
    console.error("Missing COMPANIES_HOUSE_API_KEY — register free at https://developer.company-information.service.gov.uk/");
    process.exit(1);
  }
  if (!WATCHLIST.length) {
    console.error("Missing WATCHLIST_COMPANY_NUMBERS — comma-separated list of UK company numbers to monitor.");
    process.exit(1);
  }

  const seen = loadSeen();

  for (const companyNumber of WATCHLIST) {
    console.log(`\n[scan] ${companyNumber}`);
    try {
      const [profile, filings, officers] = await Promise.all([
        getCompanyProfile(companyNumber),
        getRecentFilings(companyNumber),
        getOfficers(companyNumber),
      ]);

      seen[companyNumber] = seen[companyNumber] || [];

      const newFundingFilings = filings.filter(
        (f: any) =>
          FUNDING_FILING_TYPES.has(f.type) &&
          withinLookback(f.date) &&
          !seen[companyNumber].includes(f.transaction_id)
      );

      if (!newFundingFilings.length) {
        console.log("  no new funding-type filings in lookback window");
        continue;
      }

      const officer = pickPrimaryOfficer(officers);
      if (!officer) {
        console.log("  found a funding filing but no active officer to use as contact — skipping");
        continue;
      }

      for (const filing of newFundingFilings) {
        const signal = {
          external_id: `ch-${companyNumber}-${filing.transaction_id}`,
          source: "companies_house",
          company_name: profile.company_name,
          headcount: undefined, // Companies House doesn't report headcount
          contact_name: officer.name,
          contact_title: officer.officer_role,
          // No email available from this source — see header notes.
          contact_email: undefined,
          signal_type: "funding_events",
          persona: "CEO",
          trigger_type: "funding_filing",
          trigger_detail: `Filed ${filing.description || filing.type} (share allotment) with Companies House`,
          trigger_date: filing.date,
          trigger_source_url: `https://find-and-update.company-information.service.gov.uk/company/${companyNumber}/filing-history`,
          company_signal_detail: `Companies House filing (${filing.type}) indicating a recent share allotment/funding event`,
          company_signal_date: filing.date,
          company_signal_source: `https://find-and-update.company-information.service.gov.uk/company/${companyNumber}`,
        };

        await postSignal(signal);
        seen[companyNumber].push(filing.transaction_id);
      }
    } catch (err: any) {
      console.error(`  error scanning ${companyNumber}:`, err.message);
    }
  }

  saveSeen(seen);
}

main();
