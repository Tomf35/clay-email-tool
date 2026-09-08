import { SignalRecord } from "../types";
import { getSubstance } from "./signalSubstance";
import {
  ALTITUDE_TIERS,
  AltitudeTier,
  getAltitudeTierGuidance,
  getPersonaTierGuidance,
  getSteps,
  loadCadencePlaybook,
  CadenceStep,
} from "./cadencePlaybook";

const KNOWN_KEYS = new Set([
  "external_id",
  "contact_name",
  "contact_title",
  "contact_email",
  "linkedin_url",
  "company_name",
  "company_domain",
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
]);

function line(label: string, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    return `${label}: ${value.join(", ")}`;
  }
  return `${label}: ${String(value)}`;
}

/**
 * signal-substance.json only defines guidance for HR/Finance/Ops/CEO —
 * "MD" is collapsed to "CEO" for that lookup ONLY, at this call site.
 * cadence-playbook.json (tone/structure) keeps a dedicated MD entry and
 * must NOT go through this mapping.
 */
export function mapPersonaForSubstance(persona: string | undefined): string | undefined {
  if (!persona) return undefined;
  if (persona.trim().toUpperCase() === "MD") return "CEO";
  return persona;
}

/**
 * Pure function: renders only the fields actually present on a SignalRecord
 * into a labeled context block for the LLM prompt. Must never fabricate or
 * imply data that isn't there — it simply omits missing fields.
 */
export function buildSignalContext(signal: SignalRecord): string {
  const lines: string[] = [];

  const contactBits = [
    line("Contact name", signal.contact_name),
    line("Contact title", signal.contact_title),
    line("Contact email", signal.contact_email),
    line("LinkedIn", signal.linkedin_url),
    line("Seniority (given)", signal.seniority),
  ].filter(Boolean) as string[];
  if (contactBits.length) {
    lines.push("## Contact", ...contactBits);
  }

  const companyBits = [
    line("Company name", signal.company_name),
    line("Company domain", signal.company_domain),
    line("Headcount", signal.headcount),
  ].filter(Boolean) as string[];
  if (companyBits.length) {
    lines.push("## Company", ...companyBits);
  }

  const fundingBits = [
    line("Funding stage", signal.funding_stage),
    line("Funding amount", signal.funding_amount),
    line("Funding date", signal.funding_date),
  ].filter(Boolean) as string[];
  if (fundingBits.length) {
    lines.push("## Funding", ...fundingBits);
  }

  const techBits = [line("Tech stack", signal.tech_stack)].filter(
    Boolean
  ) as string[];
  if (techBits.length) {
    lines.push("## Tech", ...techBits);
  }

  const triggerBits = [
    line("Trigger type", signal.trigger_type),
    line("Trigger detail", signal.trigger_detail),
    line("Trigger date", signal.trigger_date),
    line("Trigger source", signal.trigger_source_url),
  ].filter(Boolean) as string[];
  if (triggerBits.length) {
    lines.push("## Trigger / intent signal", ...triggerBits);
  }

  // Tolerate any additional, unmodeled fields Clay may send.
  const extraBits: string[] = [];
  for (const [key, value] of Object.entries(signal)) {
    if (KNOWN_KEYS.has(key)) continue;
    const rendered = line(key, value);
    if (rendered) extraBits.push(rendered);
  }
  if (extraBits.length) {
    lines.push("## Other provided fields", ...extraBits);
  }

  const headcountNum =
    typeof signal.headcount === "number"
      ? signal.headcount
      : typeof signal.headcount === "string" && signal.headcount.trim() !== ""
      ? Number(signal.headcount)
      : undefined;

  const substance = getSubstance(
    signal.signal_type,
    mapPersonaForSubstance(signal.persona),
    Number.isFinite(headcountNum as number) ? headcountNum : undefined
  );

  if (substance) {
    const substanceBits: string[] = [
      `Signal category: ${substance.label} — ${substance.description}`,
    ];
    if (substance.guidance) {
      substanceBits.push(
        `What this contact likely cares about right now: ${substance.guidance}`
      );
    }
    if (substance.sensitivity_note) {
      substanceBits.push(
        `IMPORTANT — handle sensitively: ${substance.sensitivity_note}`
      );
    }
    lines.push(
      "## Signal substance — the ANGLE (internal guidance, not facts about the recipient)",
      ...substanceBits
    );
  }

  if (lines.length === 0) {
    return "No specific signal details were provided beyond the contact/company identifier.";
  }

  return lines.join("\n");
}

/**
 * Renders the cadence playbook (FORM: tone, structure, mechanics) section
 * of the prompt — kept clearly separate from the signal-substance (ANGLE)
 * section above. Persona lookups here use the persona AS GIVEN (MD is
 * NOT collapsed to CEO — cadence-playbook.json has a dedicated MD entry).
 */
export function buildCadenceContext(signal: SignalRecord): string {
  const playbook = loadCadencePlaybook();
  const lines: string[] = [];

  lines.push("## Universal subject line rules");
  for (const rule of playbook.universal_subject_rules.rules as string[]) {
    lines.push(`- ${rule}`);
  }

  lines.push("", "## Universal body rules");
  for (const rule of playbook.universal_body_rules.rules as string[]) {
    lines.push(`- ${rule}`);
  }
  lines.push("Avoid:");
  for (const rule of playbook.universal_body_rules.avoid as string[]) {
    lines.push(`- ${rule}`);
  }

  lines.push("", "## Formatting rules (apply to every email)");
  for (const rule of playbook.formatting_rules.rules as string[]) {
    lines.push(`- ${rule}`);
  }

  const seniority = signal.seniority as AltitudeTier | undefined;
  lines.push("", "## Seniority / altitude tier");
  if (seniority) {
    lines.push(`Given seniority: ${seniority}`);
    const tierGuidance = getAltitudeTierGuidance(seniority);
    if (tierGuidance) lines.push(`Altitude guidance: ${tierGuidance}`);
  } else {
    lines.push(
      "No seniority was provided for this contact. This is the ONE place in this prompt " +
        "where you are explicitly permitted to infer rather than only use given facts: infer " +
        "the seniority/altitude tier (Executive / Director / Manager / IC) from the contact's " +
        "title using the definitions below, and use that inferred tier to choose tone."
    );
    lines.push("Altitude tier definitions:");
    for (const tier of ALTITUDE_TIERS) {
      const guidance = getAltitudeTierGuidance(tier);
      lines.push(`- ${tier}${guidance ? `: ${guidance}` : ""}`);
    }
  }

  const personaGuidance = getPersonaTierGuidance(signal.persona, seniority);
  if (personaGuidance) {
    lines.push("", `## Persona tone guidance (${signal.persona})`);
    if (personaGuidance.overview) lines.push(personaGuidance.overview);
    if (personaGuidance.structure) lines.push(`Structure: ${personaGuidance.structure}`);
    if (personaGuidance.avoid && personaGuidance.avoid.length) {
      lines.push("Avoid:");
      for (const a of personaGuidance.avoid) lines.push(`- ${a}`);
    }
    if (personaGuidance.tierGuidance) {
      lines.push(`Tone for this tier: ${personaGuidance.tierGuidance}`);
    } else if (!seniority) {
      lines.push(
        "(Once you've inferred the seniority tier above, apply this persona's guidance for that tier.)"
      );
    }
  }

  return lines.join("\n");
}

function renderStep(step: CadenceStep): string {
  const lines: string[] = [
    `Step ${step.step} — "${step.label}" — send day offset: ${step.send_day_offset}`,
    `Framework: ${step.framework}`,
    step.sentence_count_range
      ? `Target length: ${step.sentence_count_range[0]}-${step.sentence_count_range[1]} sentences`
      : `Target length: ${step.word_count_range[0]}-${step.word_count_range[1]} words`,
    `Pitch allowed: ${step.pitch_allowed ? "yes" : "no"}`,
  ];
  for (const rule of step.special_rules) {
    lines.push(`- ${rule}`);
  }
  return lines.join("\n");
}

/** Builds the full user-turn prompt for generating a brand-new 4-email sequence. */
export function buildSequenceUserPrompt(
  signal: SignalRecord,
  extraInstruction?: string
): string {
  const context = buildSignalContext(signal);
  const cadence = buildCadenceContext(signal);
  const playbook = loadCadencePlaybook();
  const steps = getSteps();

  let prompt = `Signal context (the ANGLE — use only these facts):\n${context}\n\n`;
  prompt += `Cadence playbook (the FORM — tone, structure, and mechanics):\n${cadence}\n\n`;
  prompt += `## The 4-email sequence to write\n`;
  prompt += steps.map(renderStep).join("\n\n");
  prompt += `\n\n## Cross-sequence rules\n`;
  for (const rule of playbook.cross_sequence_rules) {
    prompt += `- ${rule}\n`;
  }
  prompt += `\nWrite all 4 emails now, using only the facts in the signal context above and the persona/seniority tone guidance to shape voice and structure.`;

  if (extraInstruction && extraInstruction.trim()) {
    prompt += `\n\nAdditional instruction from the reviewer for this regeneration: ${extraInstruction.trim()}`;
  }
  return prompt;
}

/**
 * Builds the user-turn prompt for regenerating a single step, passing the
 * other 3 steps' current final content as fixed context so the model
 * varies phrasing and stays consistent with them.
 */
export function buildSingleStepRegenerationPrompt(
  signal: SignalRecord,
  targetStep: number,
  otherSteps: { step: number; label: string; subject: string; body: string }[],
  extraInstruction?: string
): string {
  const context = buildSignalContext(signal);
  const cadence = buildCadenceContext(signal);
  const stepMeta = getSteps().find((s) => s.step === targetStep);

  let prompt = `Signal context (the ANGLE — use only these facts):\n${context}\n\n`;
  prompt += `Cadence playbook (the FORM — tone, structure, and mechanics):\n${cadence}\n\n`;
  prompt += `## The other emails already in this sequence\n`;
  prompt +=
    "These other emails in the sequence already exist — don't repeat their observations, and stay consistent with them:\n\n";
  for (const other of otherSteps.sort((a, b) => a.step - b.step)) {
    prompt += `Step ${other.step} — "${other.label}"\nSubject: ${other.subject}\nBody:\n${other.body}\n\n`;
  }

  prompt += `## The single email to (re)write\n`;
  prompt += stepMeta ? renderStep(stepMeta) : `Step ${targetStep}`;
  prompt += `\n\nWrite ONLY this one step now, consistent with the rest of the sequence above.`;

  if (extraInstruction && extraInstruction.trim()) {
    prompt += `\n\nAdditional instruction from the reviewer for this regeneration: ${extraInstruction.trim()}`;
  }
  return prompt;
}
