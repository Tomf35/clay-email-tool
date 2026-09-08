// Core shared types for the Clay email review tool.

export interface SignalRecord {
  external_id: string; // required, dedup key (Clay row id or email)

  contact_name?: string;
  contact_title?: string;
  contact_email?: string;
  linkedin_url?: string;

  company_name?: string;
  company_domain?: string;

  funding_stage?: string;
  funding_amount?: string;
  funding_date?: string;

  // Employee count. NOTE: this field is intentionally reused as the
  // "employee count" input the Claygent prompt asks for — there is no
  // separate `employee_count` field. Do not add one; map headcount to
  // "Employee count" when rendering the prompt's INPUTS section.
  headcount?: string | number;

  tech_stack?: string[];

  trigger_type?: string;
  trigger_detail?: string;
  trigger_date?: string;
  trigger_source_url?: string;

  // Which Mintago "signal substance" category this row represents, e.g.
  // "hr_recent_change", "funding_events", "cost_restructuring", etc.
  // See config/signal-substance.json (DEPRECATED — kept only for reference,
  // no longer read by the active generation path). Tolerate unknown/missing
  // values.
  signal_type?: string;

  // The persona Clay has identified for this contact, when known.
  // One of "HR" | "Finance" | "Ops" | "CEO" | "MD". Tolerate unknown/missing
  // values. Note: signal-substance.json only defines HR/Finance/Ops/CEO —
  // "MD" is collapsed to "CEO" for that lookup at the call site (see
  // mapPersonaForSubstance in signalSubstance usage), but keeps its own
  // dedicated tone/structure guidance in config/cadence-playbook.json.
  // Both config files are DEPRECATED from the active generation path (see
  // config/claygent-prompt.md) but this field is still passed through and
  // rendered as supplementary context.
  persona?: string;

  // Seniority/altitude tier for the contact, when known: one of
  // "Executive" | "Director" | "Manager" | "IC". Tolerate unknown/missing
  // values — if absent, the model is instructed to infer it from
  // contact_title using the altitude tier definitions in
  // config/cadence-playbook.json (DEPRECATED, see note on persona above).
  seniority?: string;

  // --- Fields added for the Claygent prompt integration ---

  // The prospect's own LinkedIn "About" section, when known. Used as
  // supporting context for hook/tone, never as the hook itself.
  linkedin_profile_summary?: string;

  // Pre-enriched recent LinkedIn posts/shares for the prospect. Passed
  // through as-is — we don't deep-validate the shape of each entry beyond
  // tolerating its absence. Expected shape per entry: { text, date, type }
  // where type is "post" | "share", but unknown/malformed entries are
  // rendered best-effort rather than rejected.
  linkedin_activity?: Array<{ text?: string; date?: string; type?: "post" | "share" }>;

  // Pre-found company-level signal (Clay/enrichment provided) — used as the
  // Step 2 fallback hook per the Claygent prompt. No web search is ever
  // performed by our code or the model; this must be provided upstream.
  company_signal_detail?: string;
  company_signal_date?: string;
  company_signal_source?: string; // URL

  company_website?: string;
  industry?: string;

  // Anything else Clay sends that we don't explicitly model.
  // Populated automatically by the normalizer for unknown keys.
  [key: string]: unknown;
}

export type SignalStatus = "pending_generation" | "generated" | "error";

// Shared status enum for both sequence-level (cached/derived) status and
// per-email status.
export type SequenceStatus =
  | "pending_review"
  | "approved"
  | "rejected"
  | "edited_approved"
  | "sent_to_destination"
  | "superseded";

export type SequenceEmailStatus = SequenceStatus;

export interface SignalRow {
  id: number;
  external_id: string;
  raw_payload: string; // JSON text
  received_at: string;
  status: SignalStatus;
}

export interface SequenceRow {
  id: number;
  signal_id: number;
  model_used: string | null;
  prompt_version: string | null;
  generated_at: string;
  status: SequenceStatus;
  reviewed_at: string | null;
  reviewer_notes: string | null;

  // --- Claygent prompt integration fields ---
  personalization_tier: string | null; // "T1" | "T2" | "T3"
  personalization_tier_reason: string | null;
  personalization_notes: string | null; // JSON array of 1-3 strings
  company_research: string | null; // JSON blob, see GeneratedCompanyResearch

  cold_call_beat1: string | null;
  cold_call_beat2: string | null;
  cold_call_beat3: string | null;
  cold_call_status: SequenceStatus;
  cold_call_final_beat1: string | null;
  cold_call_final_beat2: string | null;
  cold_call_final_beat3: string | null;
  cold_call_reviewed_at: string | null;
  cold_call_reviewer_notes: string | null;
}

export interface SequenceEmailRow {
  id: number;
  sequence_id: number;
  step: number; // 1-4
  send_day_offset: number; // 1, 5, 9, 12
  step_label: string; // e.g. "cold_open"
  subject: string | null;
  body: string | null;
  status: SequenceEmailStatus;
  reviewed_at: string | null;
  reviewer_notes: string | null;
  final_subject: string | null;
  final_body: string | null;

  // Lavender scoring output from the Claygent prompt's Step 13/14.
  lavender_score: number | null;
  lavender_grade: string | null; // "T1" | "T2" | "T3" | "G"
  criteria_passed: string | null; // JSON array of strings
  criteria_failed: string | null; // JSON array of strings
  top_improvement: string | null;
}

export interface LinkedinMessageRow {
  id: number;
  sequence_id: number;
  position: number; // 1-4 (connection request is not a row — see decisions)
  day_offset_label: string; // e.g. "Day 1 to 2"
  label: string; // resource_share | warm_observation | clarification | referral_exit
  body: string | null;
  status: SequenceStatus;
  reviewed_at: string | null;
  reviewer_notes: string | null;
  final_body: string | null;
}

export interface AuditLogRow {
  id: number;
  sequence_id: number;
  sequence_email_id: number | null;
  linkedin_message_id: number | null;
  action: string;
  actor: string;
  timestamp: string;
  detail_text: string | null;
}

export interface GeneratedEmail {
  subject: string;
  body: string;
}

export interface GeneratedSequenceEmail extends GeneratedEmail {
  step: number;
}

export interface GeneratedEmailLavenderFields {
  lavender_score: number;
  lavender_grade: string; // "T1" | "T2" | "T3" | "G"
  criteria_passed: string[];
  criteria_failed: string[];
  top_improvement: string;
}

export type GeneratedFullSequenceEmail = GeneratedSequenceEmail & GeneratedEmailLavenderFields;

export interface GeneratedLinkedInMessage {
  position: number;
  day_offset_label: string;
  label: string;
  body: string;
}

export interface GeneratedColdCallOpener {
  beat1: string;
  beat2: string;
  beat3: string;
}

export interface GeneratedCompanyResearch {
  companyName: string;
  companyDomain: string;
  companyWebsite: string;
  companySignal: string;
  signalDate: string;
  signalSource: string;
  signalRelevance: string;
  signalScore: number;
  employeeCount: string;
  industry: string;
  researchDate: string;
}

export interface GeneratedFullSequence {
  emails: GeneratedFullSequenceEmail[];
  linkedin_connection_request_note: string;
  linkedin_messages: GeneratedLinkedInMessage[];
  cold_call_opener: GeneratedColdCallOpener;
  company_research: GeneratedCompanyResearch;
  personalization_notes: string[];
  personalization_tier: string;
  personalization_tier_reason: string;
}
