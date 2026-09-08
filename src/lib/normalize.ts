import { SignalRecord } from "../types";
import { normalizeSeniority } from "./cadencePlaybook";

/**
 * Normalizes an arbitrary Clay webhook payload into a SignalRecord.
 * Known fields are mapped to their typed slots; anything else is retained
 * on the object as-is so it survives into raw_payload/generation context.
 */
export function normalizeSignal(payload: Record<string, unknown>): SignalRecord {
  const externalId =
    (payload.external_id as string) ||
    (payload.id as string) ||
    (payload.contact_email as string) ||
    (payload.email as string);

  if (!externalId || typeof externalId !== "string") {
    throw new Error(
      "Missing required identifier: provide external_id, id, contact_email, or email"
    );
  }

  const techStackRaw = payload.tech_stack;
  let tech_stack: string[] | undefined;
  if (Array.isArray(techStackRaw)) {
    tech_stack = techStackRaw.map((v) => String(v));
  } else if (typeof techStackRaw === "string" && techStackRaw.trim()) {
    tech_stack = techStackRaw.split(",").map((s) => s.trim()).filter(Boolean);
  }

  const record: SignalRecord = {
    ...payload,
    external_id: externalId,
    contact_name: payload.contact_name as string | undefined,
    contact_title: payload.contact_title as string | undefined,
    contact_email: (payload.contact_email as string) || (payload.email as string) || undefined,
    linkedin_url: payload.linkedin_url as string | undefined,
    company_name: payload.company_name as string | undefined,
    company_domain: payload.company_domain as string | undefined,
    funding_stage: payload.funding_stage as string | undefined,
    funding_amount: payload.funding_amount as string | undefined,
    funding_date: payload.funding_date as string | undefined,
    headcount: payload.headcount as string | number | undefined,
    tech_stack,
    trigger_type: payload.trigger_type as string | undefined,
    trigger_detail: payload.trigger_detail as string | undefined,
    trigger_date: payload.trigger_date as string | undefined,
    trigger_source_url: payload.trigger_source_url as string | undefined,
    // Pass through untouched if present; tolerate unknown/missing values.
    signal_type: payload.signal_type as string | undefined,
    persona: payload.persona as string | undefined,
    // Case-insensitive normalize (Executive/Director/Manager/IC), same
    // pattern as signalSubstance.ts's normalizePersona — warns and passes
    // through as undefined on an unrecognized value rather than throwing,
    // so the prompt builder falls back to asking the model to infer
    // seniority from contact_title.
    seniority: normalizeSeniority(payload.seniority as string | undefined),

    // --- Claygent prompt integration fields ---
    // Tolerated exactly like the existing fields above: passed through
    // as-is if present, undefined if absent, no extra validation. The
    // spread of `payload` above already carries these through for any
    // caller reading the raw signal, but we also map them onto the typed
    // slots for callers that only see the SignalRecord type.
    linkedin_profile_summary: payload.linkedin_profile_summary as string | undefined,
    linkedin_activity: Array.isArray(payload.linkedin_activity)
      ? (payload.linkedin_activity as SignalRecord["linkedin_activity"])
      : undefined,
    company_signal_detail: payload.company_signal_detail as string | undefined,
    company_signal_date: payload.company_signal_date as string | undefined,
    company_signal_source: payload.company_signal_source as string | undefined,
    company_website: payload.company_website as string | undefined,
    industry: payload.industry as string | undefined,
  };

  return record;
}
