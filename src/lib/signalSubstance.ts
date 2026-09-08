import fs from "fs";
import path from "path";

const SUBSTANCE_PATH = path.join(
  __dirname,
  "..",
  "..",
  "config",
  "signal-substance.json"
);

export interface SignalSubstanceResult {
  label: string;
  description: string;
  guidance: string | null;
  sensitivity_note?: string;
}

interface SignalSubstanceEntry {
  label: string;
  description: string;
  primary_persona: string;
  sensitivity_note?: string;
  routing_note?: string;
  personas: Record<string, Record<string, string>>;
}

// Loaded once at startup and cached in module scope.
let SUBSTANCE_DATA: Record<string, SignalSubstanceEntry> | null = null;

function loadSubstanceData(): Record<string, SignalSubstanceEntry> {
  if (SUBSTANCE_DATA) return SUBSTANCE_DATA;
  const raw = fs.readFileSync(SUBSTANCE_PATH, "utf-8");
  const parsed = JSON.parse(raw);
  // Strip the _meta key, keep only signal_type entries.
  const { _meta, ...rest } = parsed;
  SUBSTANCE_DATA = rest as Record<string, SignalSubstanceEntry>;
  return SUBSTANCE_DATA;
}

const FIXED_PERSONAS = new Set(["HR", "Finance", "Ops", "CEO"]);

// Canonical-cased persona lookup keyed by lowercased/trimmed input, so a
// Clay row sending "finance", "FINANCE", or " Finance " still resolves to
// the "Finance" key used in signal-substance.json, instead of silently
// dropping all guidance.
const PERSONA_BY_LOWERCASE: Record<string, string> = {
  hr: "HR",
  finance: "Finance",
  ops: "Ops",
  ceo: "CEO",
};

/**
 * Normalizes a caller-provided persona string to the canonical casing used
 * as keys in signal-substance.json ("HR"/"Finance"/"Ops"/"CEO"). Returns
 * undefined (and logs a warning) if the value doesn't match a known
 * persona after trimming/lowercasing, rather than silently proceeding with
 * a value that will never match.
 */
function normalizePersona(persona: string | undefined): string | undefined {
  if (!persona) return undefined;
  const trimmed = persona.trim();
  const canonical = PERSONA_BY_LOWERCASE[trimmed.toLowerCase()];
  if (!canonical) {
    console.warn(
      `[signalSubstance] Unrecognized persona "${persona}" — expected one of HR/Finance/Ops/CEO (case-insensitive). No persona-specific guidance will be included for this row.`
    );
    return undefined;
  }
  return canonical;
}

/**
 * Normalizes a caller-provided signal_type string to match the lowercase
 * snake_case keys used in signal-substance.json, tolerating surrounding
 * whitespace and casing differences.
 */
function normalizeSignalType(signalType: string | undefined): string | undefined {
  if (!signalType) return undefined;
  return signalType.trim().toLowerCase();
}

// Signal types whose primary_persona is a routing mode rather than a fixed
// persona. For these, we require an explicit persona from the caller
// (Clay-provided or otherwise) — there's no single sensible default,
// since the "right" persona depends on which role/topic/contact triggered
// the signal, which we don't have enough information to infer here.
const ROUTING_MODES = new Set(["role_routed", "topic_routed", "contact_matched"]);

/**
 * Bands a headcount number into one of the 6 Mintago size bands.
 * Returns null if headcount is missing or below the smallest band (11-50).
 */
export function bandForHeadcount(headcount: number | undefined): string | null {
  if (headcount === undefined || headcount === null || Number.isNaN(headcount)) {
    return null;
  }
  if (headcount < 11) return null;
  if (headcount <= 50) return "11-50";
  if (headcount <= 100) return "51-100";
  if (headcount <= 150) return "101-150";
  if (headcount <= 200) return "151-200";
  if (headcount <= 250) return "201-250";
  return "250+";
}

/**
 * Looks up the relevant slice of the signal-substance playbook for a given
 * signal type, persona, and company headcount. Returns null if the signal
 * type isn't recognized. Tolerates missing persona/headcount by returning
 * whatever partial info is available (label/description with a null
 * guidance) rather than throwing.
 */
export function getSubstance(
  signalType: string | undefined,
  persona: string | undefined,
  headcount: number | undefined
): SignalSubstanceResult | null {
  const normalizedType = normalizeSignalType(signalType);
  if (!normalizedType) return null;

  const data = loadSubstanceData();
  const entry = data[normalizedType];
  if (!entry) return null;

  // Determine which persona's guidance to use.
  let effectivePersona: string | undefined = normalizePersona(persona);
  if (!effectivePersona) {
    if (FIXED_PERSONAS.has(entry.primary_persona)) {
      effectivePersona = entry.primary_persona;
    } else if (ROUTING_MODES.has(entry.primary_persona)) {
      // No explicit persona given for a routing-mode signal — we don't
      // guess. Still return label/description so the prompt at least
      // names the signal category, but with no persona-specific guidance.
      effectivePersona = undefined;
    }
  }

  const result: SignalSubstanceResult = {
    label: entry.label,
    description: entry.description,
    guidance: null,
  };
  if (entry.sensitivity_note) {
    result.sensitivity_note = entry.sensitivity_note;
  }

  if (!effectivePersona || !entry.personas[effectivePersona]) {
    return result;
  }

  const band = bandForHeadcount(headcount);
  if (!band) {
    return result;
  }

  const guidance = entry.personas[effectivePersona][band];
  result.guidance = guidance || null;
  return result;
}
