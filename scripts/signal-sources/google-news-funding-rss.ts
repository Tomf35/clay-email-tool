/**
 * google-news-funding-rss.ts
 *
 * ROUGH MOCKUP — a zero-setup, zero-cost alternative/complement to the
 * Companies House scripts. Polls a Google News RSS search for UK funding
 * coverage and posts candidate hits into the raw-signal queue
 * (/api/raw-signals/ingest — see docs/raw-signal-pipeline.md).
 *
 * WHY THIS ONE
 * - No API key, no registration, nothing to set up beyond the ingest
 *   endpoint/secret you already have.
 * - Runs as a one-shot script like companies-house-funding.ts (fits a
 *   cron job / scheduled task), NOT a persistent connection like
 *   companies-house-stream-funding.ts — no second paid Render service.
 * - Press coverage of a raise often comes with round size/investors/stage
 *   already in the headline — richer personalization material than a
 *   bare Companies House filing.
 *
 * THE TRADEOFF (read before relying on it)
 * - This is unstructured text, not structured data. The "company name" is
 *   a best-effort regex guess at the subject of the headline — it WILL
 *   occasionally be wrong (e.g. it picks up an investor's name instead of
 *   the company's, or mis-splits an unusual headline shape). Treat
 *   `company_name` as a strong hint for a human reviewer, not a verified
 *   fact the way a Companies House company number is.
 * - Coverage bias: press mostly covers rounds worth writing about. This
 *   will skew toward bigger/more notable raises and likely UNDER-catches
 *   the small, quiet SME rounds that Companies House filings pick up
 *   regardless of whether anyone wrote about them. Treat this as a
 *   complement to the Companies House scripts, not a replacement, if
 *   quiet small-company rounds matter to your ICP.
 * - Optional Companies House resolution (turning the guessed name into a
 *   real company_number + contact) is best-effort: it takes the single
 *   top search-by-name result and assumes it's the right company. For a
 *   common name this can easily resolve to the wrong entity — a human
 *   reviewer should sanity-check `company_signal_source` (a Companies
 *   House profile URL) before trusting the resolved contact, or you can
 *   leave COMPANIES_HOUSE_API_KEY unset entirely and just get
 *   company_name + the article link, no resolution attempted.
 * - Same rough dedupe as the other scripts: a local JSON file of seen
 *   article GUIDs, fine for one machine on a schedule, not for more.
 *
 * SETUP
 *   export INGEST_URL=https://clay-email-tool.onrender.com/api/raw-signals/ingest
 *   export INGEST_SECRET=xxxx
 *   export COMPANIES_HOUSE_API_KEY=xxxx   (optional — enables name resolution)
 *   export GOOGLE_NEWS_RSS_QUERY='("raises" OR "secures" OR "funding round") UK startup'
 *     (optional — see DEFAULT_QUERY below for what runs without this set)
 *
 * RUN (one-shot — schedule via cron / a Render Cron Job / GitHub Actions,
 * same as companies-house-funding.ts; every 1-4 hours is plenty for news)
 *   npx ts-node scripts/signal-sources/google-news-funding-rss.ts
 */

import fs from "fs";
import path from "path";

const INGEST_URL = process.env.INGEST_URL;
const INGEST_SECRET = process.env.INGEST_SECRET;
const CH_API_KEY = process.env.COMPANIES_HOUSE_API_KEY; // optional

const DEFAULT_QUERY =
  '("raises" OR "secures" OR "closes funding" OR "funding round") (startup OR company) UK';
const QUERY = process.env.GOOGLE_NEWS_RSS_QUERY || DEFAULT_QUERY;

const SEEN_FILE = path.join(__dirname, ".seen-news-articles.json");

// Headline verbs used to split "<company> <verb> ..." into a company-name
// guess. Ordered roughly by how commonly funding headlines use them.
const FUNDING_VERBS = [
  "raises",
  "secures",
  "lands",
  "nets",
  "bags",
  "closes",
  "scores",
  "pulls in",
  "banks",
];

interface SeenStore {
  guids: string[];
}

function loadSeen(): SeenStore {
  try {
    return JSON.parse(fs.readFileSync(SEEN_FILE, "utf8"));
  } catch {
    return { guids: [] };
  }
}

function saveSeen(seen: SeenStore) {
  // Cap the seen list so this file doesn't grow forever.
  const trimmed = { guids: seen.guids.slice(-2000) };
  fs.writeFileSync(SEEN_FILE, JSON.stringify(trimmed, null, 2));
}

function decodeXmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractTagContent(itemXml: string, tag: string): string | undefined {
  const cdataMatch = new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`).exec(itemXml);
  if (cdataMatch) return cdataMatch[1].trim();
  const plainMatch = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(itemXml);
  if (plainMatch) return decodeXmlEntities(plainMatch[1].trim());
  return undefined;
}

interface RssItem {
  title: string;
  link: string;
  pubDate?: string;
  guid: string;
}

// Deliberately minimal, regex-based RSS parsing rather than pulling in an
// XML library — Google News RSS's <item> shape is simple and stable
// enough that this is fine for a mockup. If it ever breaks on a feed
// shape change, that's the signal to swap in a real XML parser.
function parseRssItems(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const itemBlocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const block of itemBlocks) {
    const title = extractTagContent(block, "title");
    const link = extractTagContent(block, "link");
    const pubDate = extractTagContent(block, "pubDate");
    const guid = extractTagContent(block, "guid") || link;
    if (title && link && guid) {
      items.push({ title, link, pubDate, guid });
    }
  }
  return items;
}

// Google News RSS titles are typically "<Company> <verb> <amount> ... - <Source>".
// Strips the " - <Source>" suffix, then splits on the first funding verb.
function extractCompanyName(title: string): string | undefined {
  const withoutSource = title.replace(/\s+-\s+[^-]+$/, "").trim();
  const lower = withoutSource.toLowerCase();
  let bestIndex = -1;
  for (const verb of FUNDING_VERBS) {
    const idx = lower.indexOf(` ${verb} `);
    if (idx !== -1 && (bestIndex === -1 || idx < bestIndex)) bestIndex = idx;
  }
  if (bestIndex === -1) return undefined;
  const name = withoutSource.slice(0, bestIndex).trim();
  return name || undefined;
}

function parsePubDate(pubDate: string | undefined): string | undefined {
  if (!pubDate) return undefined;
  const d = new Date(pubDate);
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}

// --- Optional, best-effort Companies House name resolution ---

function chAuthHeader(): string {
  return "Basic " + Buffer.from(`${CH_API_KEY}:`).toString("base64");
}

async function chGet(pathname: string): Promise<any> {
  const res = await fetch(`https://api.company-information.service.gov.uk${pathname}`, {
    headers: { Authorization: chAuthHeader() },
  });
  if (!res.ok) throw new Error(`Companies House API error ${res.status} on ${pathname}`);
  return res.json();
}

async function resolveViaCompaniesHouse(
  companyName: string
): Promise<{ companyNumber: string; contactName?: string; contactTitle?: string; profileUrl: string } | undefined> {
  const search = await chGet(`/search/companies?q=${encodeURIComponent(companyName)}&items_per_page=1`);
  const top = search.items?.[0];
  if (!top || top.company_status !== "active") return undefined;

  const companyNumber = top.company_number;
  const profileUrl = `https://find-and-update.company-information.service.gov.uk/company/${companyNumber}`;
  try {
    const officersData = await chGet(`/company/${companyNumber}/officers`);
    const active = (officersData.items || []).filter((o: any) => !o.resigned_on);
    const directors = active.filter((o: any) => (o.officer_role || "").toLowerCase().includes("director"));
    const officer = (directors.length ? directors : active).sort((a: any, b: any) =>
      (a.appointed_on || "").localeCompare(b.appointed_on || "")
    )[0];
    return {
      companyNumber,
      contactName: officer?.name,
      contactTitle: officer?.officer_role,
      profileUrl,
    };
  } catch {
    return { companyNumber, profileUrl };
  }
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

async function main() {
  const feedUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(QUERY)}&hl=en-GB&gl=GB&ceid=GB:en`;
  console.log(`[news-scan] fetching ${feedUrl}`);

  const res = await fetch(feedUrl);
  if (!res.ok) {
    console.error(`[news-scan] failed to fetch RSS feed: HTTP ${res.status}`);
    process.exit(1);
  }
  const xml = await res.text();
  const items = parseRssItems(xml);
  console.log(`[news-scan] parsed ${items.length} article(s) from feed`);

  const seen = loadSeen();
  const seenSet = new Set(seen.guids);
  const newItems = items.filter((item) => !seenSet.has(item.guid));
  console.log(`[news-scan] ${newItems.length} new (not previously seen)`);

  for (const item of newItems) {
    const companyName = extractCompanyName(item.title);
    if (!companyName) {
      console.log(`[news-scan] could not extract a company name, skipping: "${item.title}"`);
      seen.guids.push(item.guid);
      continue;
    }

    let resolved: Awaited<ReturnType<typeof resolveViaCompaniesHouse>>;
    if (CH_API_KEY) {
      try {
        resolved = await resolveViaCompaniesHouse(companyName);
      } catch (err: any) {
        console.error(`[news-scan] Companies House resolution failed for "${companyName}":`, err.message);
      }
      // With resolution turned on, treat "didn't resolve to a real active
      // UK company" as a UK-only filter: this is exactly what catches
      // false-positive extractions like "Government raises concerns..."
      // (not a company at all) or genuine non-UK companies Google News
      // still surfaced despite the UK-biased query. Without a CH key set,
      // this filter doesn't run at all — every extracted name is posted
      // as-is, unresolved, for a human to judge in the review queue.
      if (!resolved) {
        console.log(`[news-scan] "${companyName}" did not resolve to an active UK company, skipping: "${item.title}"`);
        seen.guids.push(item.guid);
        continue;
      }
    }

    const signal = {
      external_id: `news-${Buffer.from(item.guid).toString("base64").slice(0, 40)}`,
      source: "google_news_rss",
      company_name: companyName,
      contact_name: resolved?.contactName,
      contact_title: resolved?.contactTitle,
      signal_type: "funding_events",
      persona: "CEO",
      trigger_type: "funding_news",
      trigger_detail: item.title,
      trigger_date: parsePubDate(item.pubDate),
      trigger_source_url: item.link,
      company_signal_detail: item.title,
      company_signal_date: parsePubDate(item.pubDate),
      company_signal_source: resolved?.profileUrl || item.link,
    };

    await postSignal(signal);
    seen.guids.push(item.guid);
  }

  saveSeen(seen);
}

main().catch((err) => {
  console.error("[news-scan] fatal error:", err);
  process.exit(1);
});
