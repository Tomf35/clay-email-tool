import Anthropic from "@anthropic-ai/sdk";
import {
  GeneratedColdCallOpener,
  GeneratedCompanyResearch,
  GeneratedFullSequence,
  GeneratedFullSequenceEmail,
  SignalRecord,
} from "../types";
import {
  buildColdCallRegenerationPrompt,
  buildFullSequenceUserPrompt,
  buildLinkedInMessageRegenerationPrompt,
  buildSingleEmailRegenerationPrompt,
  loadClaygentSystemPrompt,
} from "./claygentPrompt";

const PROMPT_VERSION = "v1-claygent";
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929";

const LAVENDER_GRADES = ["T1", "T2", "T3", "G"];
const PERSONALIZATION_TIERS = ["T1", "T2", "T3"];

const EMAIL_ITEM_SCHEMA = {
  type: "object",
  properties: {
    step: { type: "integer", description: "The step number, 1-4." },
    subject: {
      type: "string",
      description: "Subject line for this step, 1-3 words, Title Case, no dashes.",
    },
    body: {
      type: "string",
      description: "The full email body for this step, including greeting and sign-off rules.",
    },
    lavender_score: {
      type: "integer",
      description: "Score out of 100 from Step 13's 12-criteria Lavender rubric (after any Step 14 self-revision).",
    },
    lavender_grade: {
      type: "string",
      enum: LAVENDER_GRADES,
      description: "Letter grade corresponding to lavender_score: T1 (90-100), T2 (70-89), T3 (50-69), G (<=49).",
    },
    criteria_passed: {
      type: "array",
      items: { type: "string" },
      description: "List of the Step 13 criteria names that passed for the final (possibly revised) version.",
    },
    criteria_failed: {
      type: "array",
      items: { type: "string" },
      description: "List of the Step 13 criteria names that failed for the final (possibly revised) version.",
    },
    top_improvement: {
      type: "string",
      description: "One sentence naming the highest-priority remaining improvement. Can be empty if the grade is T1.",
    },
  },
  required: [
    "step",
    "subject",
    "body",
    "lavender_score",
    "lavender_grade",
    "criteria_passed",
    "criteria_failed",
    "top_improvement",
  ],
};

const LINKEDIN_MESSAGE_ITEM_SCHEMA = {
  type: "object",
  properties: {
    position: { type: "integer", description: "The LinkedIn message position, 1-4 (connection request is not numbered here)." },
    day_offset_label: {
      type: "string",
      description: 'Send-day range label, e.g. "Day 1 to 2", "Day 5 to 6", "Day 9 to 10", "Day 13 to 14".',
    },
    label: {
      type: "string",
      enum: ["resource_share", "warm_observation", "clarification", "referral_exit"],
      description: "Which of the 4 LinkedIn message purposes this is.",
    },
    body: {
      type: "string",
      description: "The full LinkedIn message text, following the word-limit and formatting rules for its position.",
    },
  },
  required: ["position", "day_offset_label", "label", "body"],
};

const COLD_CALL_OPENER_PROPERTIES = {
  beat1: {
    type: "string",
    description:
      "Beat 1 (state what you noticed) as clean plain text. Must NOT contain literal \\n or any escape/line-break characters.",
  },
  beat2: {
    type: "string",
    description:
      "Beat 2 (state the pain) as clean plain text. Must NOT contain literal \\n or any escape/line-break characters.",
  },
  beat3: {
    type: "string",
    description:
      "Beat 3 (open question) as clean plain text. Must NOT contain literal \\n or any escape/line-break characters.",
  },
};

const COMPANY_RESEARCH_SCHEMA = {
  type: "object",
  properties: {
    companyName: { type: "string" },
    companyDomain: { type: "string" },
    companyWebsite: { type: "string" },
    companySignal: { type: "string" },
    signalDate: { type: "string", description: "YYYY-MM-DD" },
    signalSource: { type: "string" },
    signalRelevance: { type: "string" },
    signalScore: { type: "integer", description: "0-10" },
    employeeCount: { type: "string" },
    industry: { type: "string" },
    researchDate: { type: "string", description: "YYYY-MM-DD, today's date as provided in the inputs." },
  },
  required: [
    "companyName",
    "companyDomain",
    "companyWebsite",
    "companySignal",
    "signalDate",
    "signalSource",
    "signalRelevance",
    "signalScore",
    "employeeCount",
    "industry",
    "researchDate",
  ],
};

const WRITE_FULL_SEQUENCE_TOOL: Anthropic.Tool = {
  name: "write_full_sequence",
  description:
    "Submit the complete generated output: the 4-email sequence, the LinkedIn connection request note plus 4 " +
    "LinkedIn messages, the 3-beat cold call opener, the company research summary, and the personalization " +
    "tier/notes.",
  input_schema: {
    type: "object",
    properties: {
      emails: {
        type: "array",
        minItems: 4,
        maxItems: 4,
        items: EMAIL_ITEM_SCHEMA,
        description: "Exactly 4 items, one per step (1-4), in order.",
      },
      linkedin_connection_request_note: {
        type: "string",
        description: "Should always be an empty string per the prompt's rule (send blank, no note).",
      },
      linkedin_messages: {
        type: "array",
        minItems: 4,
        maxItems: 4,
        items: LINKEDIN_MESSAGE_ITEM_SCHEMA,
        description: "Exactly 4 items, one per position (1-4), in order.",
      },
      cold_call_opener: {
        type: "object",
        properties: COLD_CALL_OPENER_PROPERTIES,
        required: ["beat1", "beat2", "beat3"],
      },
      company_research: COMPANY_RESEARCH_SCHEMA,
      personalization_notes: {
        type: "array",
        minItems: 1,
        maxItems: 3,
        items: { type: "string" },
        description: "1 to 3 bullet points explaining the personalization choices made across the sequence.",
      },
      personalization_tier: {
        type: "string",
        enum: PERSONALIZATION_TIERS,
      },
      personalization_tier_reason: {
        type: "string",
        description: "One-sentence explanation of why that tier was assigned.",
      },
    },
    required: [
      "emails",
      "linkedin_connection_request_note",
      "linkedin_messages",
      "cold_call_opener",
      "company_research",
      "personalization_notes",
      "personalization_tier",
      "personalization_tier_reason",
    ],
  },
};

const WRITE_SINGLE_EMAIL_TOOL: Anthropic.Tool = {
  name: "write_single_email",
  description: "Submit the regenerated subject, body, and Lavender score for a single step of the sequence.",
  input_schema: {
    type: "object",
    properties: {
      subject: EMAIL_ITEM_SCHEMA.properties.subject,
      body: EMAIL_ITEM_SCHEMA.properties.body,
      lavender_score: EMAIL_ITEM_SCHEMA.properties.lavender_score,
      lavender_grade: EMAIL_ITEM_SCHEMA.properties.lavender_grade,
      criteria_passed: EMAIL_ITEM_SCHEMA.properties.criteria_passed,
      criteria_failed: EMAIL_ITEM_SCHEMA.properties.criteria_failed,
      top_improvement: EMAIL_ITEM_SCHEMA.properties.top_improvement,
    },
    required: [
      "subject",
      "body",
      "lavender_score",
      "lavender_grade",
      "criteria_passed",
      "criteria_failed",
      "top_improvement",
    ],
  },
};

const WRITE_SINGLE_LINKEDIN_MESSAGE_TOOL: Anthropic.Tool = {
  name: "write_single_linkedin_message",
  description: "Submit the regenerated body for a single LinkedIn message in the sequence.",
  input_schema: {
    type: "object",
    properties: {
      body: LINKEDIN_MESSAGE_ITEM_SCHEMA.properties.body,
    },
    required: ["body"],
  },
};

const WRITE_COLD_CALL_OPENER_TOOL: Anthropic.Tool = {
  name: "write_cold_call_opener",
  description: "Submit the regenerated 3-beat cold call opener.",
  input_schema: {
    type: "object",
    properties: COLD_CALL_OPENER_PROPERTIES,
    required: ["beat1", "beat2", "beat3"],
  },
};

export class GenerationConfigError extends Error {}
export class GenerationApiError extends Error {}

function getClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new GenerationConfigError(
      "ANTHROPIC_API_KEY is not set. Generation is unavailable until this env var is configured."
    );
  }
  return new Anthropic({ apiKey });
}

function callTool(
  client: Anthropic,
  system: string,
  userPrompt: string,
  tool: Anthropic.Tool,
  maxTokens: number
): Promise<Anthropic.Message> {
  return client.messages
    .create({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      tools: [tool],
      tool_choice: { type: "tool", name: tool.name },
      messages: [{ role: "user", content: userPrompt }],
    })
    .catch((err: any) => {
      throw new GenerationApiError(`Claude API call failed: ${err?.message || String(err)}`);
    });
}

function extractToolInput(response: Anthropic.Message, toolName: string): Record<string, unknown> {
  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use" && block.name === toolName
  );
  if (!toolUse || !toolUse.input) {
    throw new GenerationApiError(`Claude response did not include the expected ${toolName} tool call.`);
  }
  return toolUse.input as Record<string, unknown>;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v));
}

function warnIfContainsEscapes(fieldName: string, value: string): void {
  if (value.includes("\\n") || value.includes("\n")) {
    console.warn(
      `[generation] Cold call ${fieldName} contained a line break/escape character — advisory only, not blocking. Value: ${JSON.stringify(value)}`
    );
  }
}

function parseEmailItem(raw: unknown): GeneratedFullSequenceEmail {
  const item = raw as Record<string, unknown>;
  if (
    typeof item?.step !== "number" ||
    typeof item?.subject !== "string" ||
    !item.subject ||
    typeof item?.body !== "string" ||
    !item.body ||
    item.step < 1 ||
    item.step > 4
  ) {
    throw new GenerationApiError("write_full_sequence/write_single_email output contained a malformed email entry.");
  }
  const grade = typeof item.lavender_grade === "string" ? item.lavender_grade : "G";
  if (!LAVENDER_GRADES.includes(grade)) {
    console.warn(`[generation] Unrecognized lavender_grade "${grade}" — expected one of ${LAVENDER_GRADES.join("/")}.`);
  }
  return {
    step: item.step as number,
    subject: item.subject as string,
    body: item.body as string,
    lavender_score: typeof item.lavender_score === "number" ? item.lavender_score : 0,
    lavender_grade: grade,
    criteria_passed: asStringArray(item.criteria_passed),
    criteria_failed: asStringArray(item.criteria_failed),
    top_improvement: typeof item.top_improvement === "string" ? item.top_improvement : "",
  };
}

function parseCompanyResearch(raw: unknown): GeneratedCompanyResearch {
  const item = (raw as Record<string, unknown>) || {};
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const score = typeof item.signalScore === "number" ? item.signalScore : Number(item.signalScore) || 0;
  return {
    companyName: str(item.companyName),
    companyDomain: str(item.companyDomain),
    companyWebsite: str(item.companyWebsite),
    companySignal: str(item.companySignal),
    signalDate: str(item.signalDate),
    signalSource: str(item.signalSource),
    signalRelevance: str(item.signalRelevance),
    signalScore: score,
    employeeCount: str(item.employeeCount),
    industry: str(item.industry),
    researchDate: str(item.researchDate),
  };
}

function parseColdCallOpener(raw: unknown): GeneratedColdCallOpener {
  const item = (raw as Record<string, unknown>) || {};
  const beat1 = typeof item.beat1 === "string" ? item.beat1 : "";
  const beat2 = typeof item.beat2 === "string" ? item.beat2 : "";
  const beat3 = typeof item.beat3 === "string" ? item.beat3 : "";
  warnIfContainsEscapes("beat1", beat1);
  warnIfContainsEscapes("beat2", beat2);
  warnIfContainsEscapes("beat3", beat3);
  return { beat1, beat2, beat3 };
}

/**
 * Calls Claude once to generate the full output for the given signal: the
 * 4-email sequence, the 5-part LinkedIn sequence, the 3-beat cold call
 * opener, company research, and personalization tier/notes. The self-
 * revision/rewrite loop described in the prompt's Step 14 happens inside
 * the model's own reasoning within this single call — we do not perform a
 * second real API round-trip to enforce it.
 */
export async function generateFullSequence(
  signal: SignalRecord,
  extraInstruction?: string
): Promise<GeneratedFullSequence & { model: string; promptVersion: string }> {
  const client = getClient();
  const system = loadClaygentSystemPrompt();
  const userPrompt = buildFullSequenceUserPrompt(signal, extraInstruction);

  const response = await callTool(client, system, userPrompt, WRITE_FULL_SEQUENCE_TOOL, 8192);
  const input = extractToolInput(response, "write_full_sequence");

  const rawEmails = input.emails;
  if (!Array.isArray(rawEmails) || rawEmails.length !== 4) {
    throw new GenerationApiError("write_full_sequence output did not contain exactly 4 emails.");
  }
  const emails = rawEmails.map(parseEmailItem).sort((a, b) => a.step - b.step);
  if (emails.map((e) => e.step).join(",") !== "1,2,3,4") {
    throw new GenerationApiError(
      `write_full_sequence output did not contain steps 1-4 exactly once each (got: ${emails.map((e) => e.step).join(",")}).`
    );
  }

  const connectionNote =
    typeof input.linkedin_connection_request_note === "string" ? input.linkedin_connection_request_note : "";
  if (connectionNote.trim() !== "") {
    console.warn(
      `[generation] linkedin_connection_request_note was non-empty ("${connectionNote}") — advisory only, per the prompt the connection request must always be sent blank.`
    );
  }

  const rawLinkedIn = input.linkedin_messages;
  if (!Array.isArray(rawLinkedIn) || rawLinkedIn.length !== 4) {
    throw new GenerationApiError("write_full_sequence output did not contain exactly 4 LinkedIn messages.");
  }
  const linkedinMessages = rawLinkedIn
    .map((raw) => {
      const item = raw as Record<string, unknown>;
      if (
        typeof item?.position !== "number" ||
        typeof item?.day_offset_label !== "string" ||
        !item.day_offset_label ||
        typeof item?.label !== "string" ||
        !item.label ||
        typeof item?.body !== "string" ||
        !item.body
      ) {
        throw new GenerationApiError("write_full_sequence output contained a malformed LinkedIn message entry.");
      }
      return {
        position: item.position as number,
        day_offset_label: item.day_offset_label as string,
        label: item.label as string,
        body: item.body as string,
      };
    })
    .sort((a, b) => a.position - b.position);
  if (linkedinMessages.map((m) => m.position).join(",") !== "1,2,3,4") {
    throw new GenerationApiError(
      `write_full_sequence output did not contain LinkedIn positions 1-4 exactly once each (got: ${linkedinMessages
        .map((m) => m.position)
        .join(",")}).`
    );
  }

  const coldCallOpener = parseColdCallOpener(input.cold_call_opener);
  const companyResearch = parseCompanyResearch(input.company_research);

  const personalizationNotes = asStringArray(input.personalization_notes);
  const personalizationTier =
    typeof input.personalization_tier === "string" ? input.personalization_tier : "T3";
  if (!PERSONALIZATION_TIERS.includes(personalizationTier)) {
    console.warn(
      `[generation] Unrecognized personalization_tier "${personalizationTier}" — expected one of ${PERSONALIZATION_TIERS.join("/")}.`
    );
  }
  const personalizationTierReason =
    typeof input.personalization_tier_reason === "string" ? input.personalization_tier_reason : "";

  return {
    emails,
    linkedin_connection_request_note: connectionNote,
    linkedin_messages: linkedinMessages,
    cold_call_opener: coldCallOpener,
    company_research: companyResearch,
    personalization_notes: personalizationNotes,
    personalization_tier: personalizationTier,
    personalization_tier_reason: personalizationTierReason,
    model: MODEL,
    promptVersion: PROMPT_VERSION,
  };
}

/**
 * Calls Claude once to regenerate a single email step, passing the other 3
 * steps' current final content as fixed context.
 */
export async function generateSingleEmailStep(
  signal: SignalRecord,
  targetStep: number,
  otherSteps: { step: number; label: string; subject: string; body: string }[],
  extraInstruction?: string
): Promise<GeneratedFullSequenceEmail & { model: string; promptVersion: string }> {
  const client = getClient();
  const system = loadClaygentSystemPrompt();
  const userPrompt = buildSingleEmailRegenerationPrompt(signal, targetStep, otherSteps, extraInstruction);

  const response = await callTool(client, system, userPrompt, WRITE_SINGLE_EMAIL_TOOL, 2048);
  const input = extractToolInput(response, "write_single_email");

  const parsed = parseEmailItem({ ...input, step: targetStep });
  return { ...parsed, model: MODEL, promptVersion: PROMPT_VERSION };
}

/**
 * Calls Claude once to regenerate a single LinkedIn message, feeding the
 * sibling LinkedIn messages' current content AND the email sequence's
 * hook/content as fixed context (do not research again).
 */
export async function generateSingleLinkedInMessage(
  signal: SignalRecord,
  position: number,
  dayOffsetLabel: string,
  label: string,
  siblingMessages: { position: number; day_offset_label: string; label: string; body: string }[],
  emailHookContext: string,
  extraInstruction?: string
): Promise<{ body: string; model: string; promptVersion: string }> {
  const client = getClient();
  const system = loadClaygentSystemPrompt();
  const userPrompt = buildLinkedInMessageRegenerationPrompt(
    signal,
    position,
    dayOffsetLabel,
    label,
    siblingMessages,
    emailHookContext,
    extraInstruction
  );

  const response = await callTool(client, system, userPrompt, WRITE_SINGLE_LINKEDIN_MESSAGE_TOOL, 1024);
  const input = extractToolInput(response, "write_single_linkedin_message");

  if (typeof input.body !== "string" || !input.body) {
    throw new GenerationApiError("write_single_linkedin_message output is missing body.");
  }

  return { body: input.body, model: MODEL, promptVersion: PROMPT_VERSION };
}

/**
 * Calls Claude once to regenerate just the cold call opener block, feeding
 * the sequence's existing hook as context.
 */
export async function generateColdCallOpener(
  signal: SignalRecord,
  emailHookContext: string,
  extraInstruction?: string
): Promise<GeneratedColdCallOpener & { model: string; promptVersion: string }> {
  const client = getClient();
  const system = loadClaygentSystemPrompt();
  const userPrompt = buildColdCallRegenerationPrompt(signal, emailHookContext, extraInstruction);

  const response = await callTool(client, system, userPrompt, WRITE_COLD_CALL_OPENER_TOOL, 1024);
  const input = extractToolInput(response, "write_cold_call_opener");

  const opener = parseColdCallOpener(input);
  return { ...opener, model: MODEL, promptVersion: PROMPT_VERSION };
}
