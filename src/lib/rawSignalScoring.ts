/**
 * Rule-based scoring for raw (pre-enrichment) signals.
 *
 * Deliberately simple and fully transparent: every point is a named rule
 * below, and the score comes back with the list of reasons that produced
 * it so a reviewer never has to guess why something scored the way it did.
 * Tune QUALIFY_THRESHOLD or the weights below as real data comes in — no
 * other code needs to change.
 */

export interface RawSignalScoreInput {
  signal_type?: string;
  trigger_date?: string; // ISO date string
  contact_name?: string; // already have a named contact (cheaper to enrich)
  trigger_source_url?: string; // verifiable source
  headcount?: string | number;
}

export interface RawSignalScoreResult {
  score: number;
  reasons: string[];
}

// Points per signal type, reflecting how directly each maps to a Mintago
// buying trigger per the signal-substance playbook. Unknown types get a
// low default rather than being excluded, so nothing is silently dropped.
const SIGNAL_TYPE_WEIGHTS: Record<string, number> = {
  funding_events: 40,
  cost_restructuring: 35,
  hr_recent_change: 30,
  admin_vendor_consolidation: 25,
};
const DEFAULT_SIGNAL_TYPE_WEIGHT = 10;

export const QUALIFY_THRESHOLD = Number(process.env.RAW_SIGNAL_QUALIFY_THRESHOLD || 50);

function daysAgo(dateStr: string | undefined): number | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
}

export function scoreRawSignal(input: RawSignalScoreInput): RawSignalScoreResult {
  const reasons: string[] = [];
  let score = 0;

  const typeKey = (input.signal_type || "").trim();
  const typeWeight = SIGNAL_TYPE_WEIGHTS[typeKey] ?? DEFAULT_SIGNAL_TYPE_WEIGHT;
  score += typeWeight;
  reasons.push(
    typeKey
      ? `signal_type "${typeKey}" (+${typeWeight})`
      : `no signal_type given, default weight (+${typeWeight})`
  );

  const age = daysAgo(input.trigger_date);
  if (age !== null) {
    if (age <= 7) {
      score += 20;
      reasons.push(`trigger is ${age}d old, within 7d (+20)`);
    } else if (age <= 14) {
      score += 10;
      reasons.push(`trigger is ${age}d old, within 14d (+10)`);
    } else if (age <= 30) {
      score += 5;
      reasons.push(`trigger is ${age}d old, within 30d (+5)`);
    } else {
      reasons.push(`trigger is ${age}d old, older than 30d (+0)`);
    }
  } else {
    reasons.push("no trigger_date given (+0)");
  }

  if (input.contact_name) {
    score += 10;
    reasons.push("already have a named contact, cheaper to enrich (+10)");
  }

  if (input.trigger_source_url) {
    score += 5;
    reasons.push("trigger has a verifiable source URL (+5)");
  }

  return { score, reasons };
}
