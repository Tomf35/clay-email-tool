import fs from "fs";
import path from "path";

const PLAYBOOK_PATH = path.join(
  __dirname,
  "..",
  "..",
  "config",
  "cadence-playbook.json"
);

export interface CadenceStep {
  step: number;
  send_day_offset: number;
  label: string;
  framework: string;
  word_count_range: [number, number];
  sentence_count_range?: [number, number];
  pitch_allowed: boolean;
  special_rules: string[];
}

export interface CadencePlaybook {
  _meta: Record<string, unknown>;
  universal_subject_rules: Record<string, unknown>;
  universal_body_rules: Record<string, unknown>;
  formatting_rules: Record<string, unknown>;
  altitude_tiers: Record<string, { titles_example?: string; guidance: string }>;
  personas: Record<
    string,
    {
      overview?: string;
      structure?: string;
      avoid?: string[];
      tiers: Record<string, { titles_example?: string; guidance: string }>;
    }
  >;
  steps: CadenceStep[];
  cross_sequence_rules: string[];
}

let CACHED: CadencePlaybook | null = null;

export function loadCadencePlaybook(): CadencePlaybook {
  if (CACHED) return CACHED;
  const raw = fs.readFileSync(PLAYBOOK_PATH, "utf-8");
  CACHED = JSON.parse(raw) as CadencePlaybook;
  return CACHED;
}

export function getSteps(): CadenceStep[] {
  return loadCadencePlaybook().steps;
}

export function getStepByNumber(step: number): CadenceStep | undefined {
  return getSteps().find((s) => s.step === step);
}

export const ALTITUDE_TIERS = ["Executive", "Director", "Manager", "IC"] as const;
export type AltitudeTier = (typeof ALTITUDE_TIERS)[number];

const TIER_BY_LOWERCASE: Record<string, AltitudeTier> = {
  executive: "Executive",
  director: "Director",
  manager: "Manager",
  ic: "IC",
};

/**
 * Normalizes a caller-provided seniority string to the canonical casing
 * used as keys in cadence-playbook.json ("Executive"/"Director"/"Manager"/
 * "IC"). Returns undefined (and logs a warning) if the value doesn't match
 * after trimming/lowercasing — same pattern as
 * signalSubstance.ts's normalizePersona.
 */
export function normalizeSeniority(seniority: string | undefined): AltitudeTier | undefined {
  if (!seniority) return undefined;
  const trimmed = seniority.trim();
  const canonical = TIER_BY_LOWERCASE[trimmed.toLowerCase()];
  if (!canonical) {
    console.warn(
      `[cadencePlaybook] Unrecognized seniority "${seniority}" — expected one of Executive/Director/Manager/IC (case-insensitive). The model will be asked to infer seniority from contact_title instead.`
    );
    return undefined;
  }
  return canonical;
}

// Canonical-cased cadence persona lookup keyed by lowercased/trimmed input,
// so a Clay row sending "ceo", "HR", or " Finance " still resolves to the
// canonical key used in cadence-playbook.json, instead of silently dropping
// the entire persona tone/structure section. Same pattern as
// signalSubstance.ts's normalizePersona, but scoped to this module's own
// (superset, includes MD) persona set.
const CADENCE_PERSONA_BY_LOWERCASE: Record<string, string> = {
  hr: "HR",
  finance: "Finance",
  ops: "Ops",
  ceo: "CEO",
  md: "MD",
};

/**
 * Normalizes a caller-provided persona string to the canonical casing used
 * as keys in cadence-playbook.json ("HR"/"Finance"/"Ops"/"CEO"/"MD").
 * Returns undefined (and logs a warning) if the value doesn't match a known
 * persona after trimming/lowercasing, same pattern as normalizeSeniority
 * above and signalSubstance.ts's normalizePersona.
 */
export function normalizePersona(persona: string | undefined): string | undefined {
  if (!persona) return undefined;
  const trimmed = persona.trim();
  const canonical = CADENCE_PERSONA_BY_LOWERCASE[trimmed.toLowerCase()];
  if (!canonical) {
    console.warn(
      `[cadencePlaybook] Unrecognized persona "${persona}" — expected one of HR/Finance/Ops/CEO/MD (case-insensitive). No persona tone/structure guidance will be included for this row.`
    );
    return undefined;
  }
  return canonical;
}

/**
 * Looks up the persona+tier tone/structure guidance from the cadence
 * playbook. Persona here is the "cadence persona" — MD gets its own
 * dedicated entry (not collapsed to CEO, unlike the signal-substance
 * lookup). Falls back gracefully if persona/tier isn't recognized.
 */
export function getPersonaTierGuidance(
  persona: string | undefined,
  tier: AltitudeTier | undefined
): { overview?: string; structure?: string; avoid?: string[]; tierGuidance?: string } | null {
  const playbook = loadCadencePlaybook();
  const normalizedPersona = normalizePersona(persona);
  if (!normalizedPersona) return null;
  const personaEntry = playbook.personas[normalizedPersona];
  if (!personaEntry) return null;

  const result: { overview?: string; structure?: string; avoid?: string[]; tierGuidance?: string } = {
    overview: personaEntry.overview,
    structure: personaEntry.structure,
    avoid: personaEntry.avoid,
  };

  if (tier && personaEntry.tiers[tier]) {
    result.tierGuidance = personaEntry.tiers[tier].guidance;
  }

  return result;
}

export function getAltitudeTierGuidance(tier: AltitudeTier | undefined): string | null {
  if (!tier) return null;
  const playbook = loadCadencePlaybook();
  return playbook.altitude_tiers[tier]?.guidance ?? null;
}

export function countWords(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

/**
 * Advisory, non-blocking word-count flag for a sequence_emails row.
 * DECISION: rather than persisting a `word_count_flag` column that could
 * go stale the moment a reviewer edits final_subject/final_body, this is
 * computed on read from whichever content is currently "live" for the
 * row (final_body if present/edited, else the originally generated body)
 * against that step's target word_count_range. Returns false (no flag)
 * for unknown steps or empty bodies with no data to judge.
 */
export function wordCountFlagForBody(step: number, body: string | null | undefined): boolean {
  if (!body) return false;
  const stepMeta = getStepByNumber(step);
  if (!stepMeta) return false;
  const count = countWords(body);
  const [min, max] = stepMeta.word_count_range;
  return count < min || count > max;
}
