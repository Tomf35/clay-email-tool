import fs from "fs";
import path from "path";
import { SignalRecord } from "../types";
import { getSubstance } from "./signalSubstance";

const CLAYGENT_PROMPT_PATH = path.join(
  __dirname,
  "..",
  "..",
  "config",
  "claygent-prompt.md"
);

// Cached in module scope after first read, same pattern used elsewhere in
// this repo (see cadencePlaybook.ts / signalSubstance.ts) for config
// loading. This file is treated as finished, authoritative content — we
// only ever read it, never generate or modify it here.
let CACHED_SYSTEM_PROMPT: string | null = null;

export function loadClaygentSystemPrompt(): string {
  if (CACHED_SYSTEM_PROMPT) return CACHED_SYSTEM_PROMPT;
  CACHED_SYSTEM_PROMPT = fs.readFileSync(CLAYGENT_PROMPT_PATH, "utf-8");
  return CACHED_SYSTEM_PROMPT;
}

/**
 * The actual current server date, formatted as YYYY-MM-DD. This must be
 * injected by our code into the prompt's INPUTS section — the prompt is
 * explicit that the model must never guess "today" from its training data.
 */
export function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

function line(label: string, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    return `${label}: ${value.join(", ")}`;
  }
  return `${label}: ${String(value)}`;
}

const KNOWN_INPUT_KEYS = new Set([
  "external_id",
  "contact_name",
  "contact_title",
  "contact_email",
  "linkedin_url",
  "company_name",
  "company_domain",
  "company_website",
  "industry",
  "funding_stage",
  "funding_amount",
  "funding_date",
  "headcount",
  "tech_stack",
  "trigger_type",
  "trigger_detail",
  "trigger_date",
  "trigger_source_url",
  "signal_type",
  "persona",
  "seniority",
  "linkedin_profile_summary",
  "linkedin_activity",
  "company_signal_detail",
  "company_signal_date",
  "company_signal_source",
]);

function renderLinkedInActivity(activity: SignalRecord["linkedin_activity"]): string {
  if (!Array.isArray(activity) || activity.length === 0) {
    return "not provided";
  }
  return activity
    .map((item) => {
      if (item && typeof item === "object") {
        const date = item.date || "unknown date";
        const type = item.type || "post";
        const text = item.text || "";
        return `- [${date}] (${type}): ${text}`;
      }
      return `- ${String(item)}`;
    })
    .join("\n");
}

/**
 * Renders the "INPUTS" section the Claygent prompt's Objective/Instructions
 * expect to receive: prospect name/title/company, headcount/employee count,
 * today's date (computed server-side, never left for the model to guess),
 * LinkedIn Profile Summary, LinkedIn Activity, the pre-found company signal,
 * and any other existing signal fields as supplementary context. Fields
 * that are absent are explicitly noted as "not provided" rather than
 * omitted, since the prompt's research steps branch on their presence.
 */
export function buildInputsSection(signal: SignalRecord): string {
  const lines: string[] = [];

  lines.push("## INPUTS");
  lines.push(`Prospect name: ${signal.contact_name || "not provided"}`);
  lines.push(`Prospect title: ${signal.contact_title || "not provided"}`);
  lines.push(`Company name: ${signal.company_name || "not provided"}`);

  // NOTE: headcount is reused as "employee count" — there is no separate
  // employee_count field (see the comment on SignalRecord.headcount).
  const headcount = signal.headcount;
  const headcountDisplay =
    headcount !== undefined && headcount !== null && String(headcount).trim() !== ""
      ? String(headcount)
      : "not provided";
  lines.push(`Employee count (headcount): ${headcountDisplay}`);

  lines.push(`Today's date: ${todayDateString()}`);

  lines.push("");
  lines.push("LinkedIn Profile Summary:");
  lines.push(
    signal.linkedin_profile_summary && signal.linkedin_profile_summary.trim()
      ? signal.linkedin_profile_summary.trim()
      : "not provided"
  );

  lines.push("");
  lines.push("LinkedIn Activity (recent posts/shares):");
  lines.push(renderLinkedInActivity(signal.linkedin_activity));

  lines.push("");
  lines.push("Pre-found company signal:");
  if (
    signal.company_signal_detail ||
    signal.company_signal_date ||
    signal.company_signal_source
  ) {
    lines.push(`- Detail: ${signal.company_signal_detail || "not provided"}`);
    lines.push(`- Date: ${signal.company_signal_date || "not provided"}`);
    lines.push(`- Source: ${signal.company_signal_source || "not provided"}`);
  } else {
    lines.push("not provided");
  }

  const supplementary = [
    line("Contact email", signal.contact_email),
    line("LinkedIn URL", signal.linkedin_url),
    line("Company domain", signal.company_domain),
    line("Company website", signal.company_website),
    line("Industry", signal.industry),
    line("Funding stage", signal.funding_stage),
    line("Funding amount", signal.funding_amount),
    line("Funding date", signal.funding_date),
    line("Tech stack", signal.tech_stack),
    line("Trigger type", signal.trigger_type),
    line("Trigger detail", signal.trigger_detail),
    line("Trigger date", signal.trigger_date),
    line("Trigger source", signal.trigger_source_url),
    line("Signal type (Clay-provided)", signal.signal_type),
    line("Persona (given)", signal.persona),
    line("Seniority (given)", signal.seniority),
  ].filter(Boolean) as string[];

  lines.push("");
  lines.push("## Supplementary context (other signal fields provided)");
  if (supplementary.length) {
    lines.push(...supplementary);
  } else {
    lines.push("None provided beyond the above.");
  }

  // Tolerate any additional, unmodeled fields Clay may send.
  const extra: string[] = [];
  for (const [key, value] of Object.entries(signal)) {
    if (KNOWN_INPUT_KEYS.has(key)) continue;
    const rendered = line(key, value);
    if (rendered) extra.push(rendered);
  }
  if (extra.length) {
    lines.push("", "## Other provided fields", ...extra);
  }

  // Supplementary persona/company-size playbook guidance (config/signal-
  // substance.json), layered in alongside — never in place of — this
  // prompt's own persona/seniority rules and Headcount Stage Framework.
  // Omitted entirely if no signal_type was provided or it isn't recognized,
  // so signals without one see no regression from before this was added.
  const numericHeadcount =
    headcount !== undefined && headcount !== null && String(headcount).trim() !== ""
      ? Number(headcount)
      : undefined;
  const substance = getSubstance(
    signal.signal_type,
    signal.persona,
    Number.isFinite(numericHeadcount as number) ? (numericHeadcount as number) : undefined
  );
  if (substance) {
    lines.push("", "## Persona and company size context (supplementary)");
    lines.push(`${substance.label}: ${substance.description}`);
    if (substance.guidance) {
      lines.push("");
      lines.push("What this contact likely cares about right now:");
      lines.push(substance.guidance);
    }
    if (substance.sensitivity_note) {
      lines.push("");
      lines.push(`IMPORTANT — handle sensitively: ${substance.sensitivity_note}`);
    }
  }

  return lines.join("\n");
}

/** Builds the user-turn prompt for generating the full sequence from scratch. */
export function buildFullSequenceUserPrompt(
  signal: SignalRecord,
  extraInstruction?: string
): string {
  let prompt = buildInputsSection(signal);
  prompt +=
    "\n\nWrite the full 4-email sequence, the 5-part LinkedIn sequence (blank connection request note plus 4 messages), " +
    "the 3-beat cold call opener, the company research summary, and the personalization notes/tier now, using the " +
    "write_full_sequence tool, following every instruction and rule in the system prompt exactly.";
  if (extraInstruction && extraInstruction.trim()) {
    prompt += `\n\nAdditional instruction from the reviewer for this regeneration: ${extraInstruction.trim()}`;
  }
  return prompt;
}

/**
 * Builds the user-turn prompt for regenerating a single email step, passing
 * the other 3 steps' current final content as fixed context so the model
 * stays consistent with the rest of the sequence and reuses the same hook.
 */
export function buildSingleEmailRegenerationPrompt(
  signal: SignalRecord,
  targetStep: number,
  otherSteps: { step: number; label: string; subject: string; body: string }[],
  extraInstruction?: string
): string {
  let prompt = buildInputsSection(signal);
  prompt += "\n\n## The other emails already in this sequence\n";
  prompt +=
    "These already exist — don't repeat their observations, stay consistent with them, and reuse the same hook/research rather than finding a new one:\n\n";
  for (const other of otherSteps.slice().sort((a, b) => a.step - b.step)) {
    prompt += `Step ${other.step} — "${other.label}"\nSubject: ${other.subject}\nBody:\n${other.body}\n\n`;
  }
  prompt += `## The single email to (re)write: Step ${targetStep}\n`;
  prompt +=
    "Write ONLY this one email now, using the write_single_email tool, following every applicable rule for " +
    "this step from the system prompt, consistent with the rest of the sequence above.";
  if (extraInstruction && extraInstruction.trim()) {
    prompt += `\n\nAdditional instruction from the reviewer for this regeneration: ${extraInstruction.trim()}`;
  }
  return prompt;
}

/**
 * Builds the user-turn prompt for regenerating a single LinkedIn message,
 * passing the sibling LinkedIn messages' current content AND the email
 * sequence's hook/content as fixed context — per the prompt's instruction
 * to reuse the same hook from the email sequence and not research again.
 */
export function buildLinkedInMessageRegenerationPrompt(
  signal: SignalRecord,
  position: number,
  dayOffsetLabel: string,
  label: string,
  siblingMessages: { position: number; day_offset_label: string; label: string; body: string }[],
  emailHookContext: string,
  extraInstruction?: string
): string {
  let prompt = buildInputsSection(signal);
  prompt +=
    "\n\n## Hook and research already established (from the email sequence) — do not research again, reuse this hook\n";
  prompt += emailHookContext;

  prompt += "\n\n## The other LinkedIn messages already in this sequence\n";
  if (siblingMessages.length === 0) {
    prompt += "(none yet)\n";
  } else {
    for (const m of siblingMessages.slice().sort((a, b) => a.position - b.position)) {
      prompt += `Position ${m.position} — "${m.label}" (${m.day_offset_label}):\n${m.body}\n\n`;
    }
  }

  prompt += `## The single LinkedIn message to (re)write: position ${position} — "${label}" (${dayOffsetLabel})\n`;
  prompt +=
    "Write ONLY this one LinkedIn message now, using the write_single_linkedin_message tool, following every " +
    "applicable rule for this message from the system prompt (word limits, formatting, no dashes, persona/" +
    "seniority match), reusing the hook above rather than researching again.";
  if (extraInstruction && extraInstruction.trim()) {
    prompt += `\n\nAdditional instruction from the reviewer for this regeneration: ${extraInstruction.trim()}`;
  }
  return prompt;
}

/**
 * Builds the user-turn prompt for regenerating just the cold call opener
 * block, reusing the email sequence's existing hook as context (per the
 * prompt's Step 15 instruction: "using the same hook and research already
 * found — no additional research").
 */
export function buildColdCallRegenerationPrompt(
  signal: SignalRecord,
  emailHookContext: string,
  extraInstruction?: string
): string {
  let prompt = buildInputsSection(signal);
  prompt +=
    "\n\n## Hook and research already established (from the email sequence) — do not research again, reuse this hook\n";
  prompt += emailHookContext;
  prompt +=
    "\n\nWrite the 3-beat cold call opener now, using the write_cold_call_opener tool, following every applicable " +
    "rule from the system prompt's cold call opening instructions (Step 15), matched to the prospect's persona and " +
    "seniority, reusing the hook above rather than researching again.";
  if (extraInstruction && extraInstruction.trim()) {
    prompt += `\n\nAdditional instruction from the reviewer for this regeneration: ${extraInstruction.trim()}`;
  }
  return prompt;
}
