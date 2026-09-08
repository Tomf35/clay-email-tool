import { SignalRecord, SignalRow, SequenceEmailRow, LinkedinMessageRow } from "../types";
import {
  generateColdCallOpener,
  generateFullSequence,
  generateSingleEmailStep,
  generateSingleLinkedInMessage,
} from "./generation";
import * as repo from "../db/repository";

// Fixed send-day-offset/label metadata for the 4 emails. This is the source
// of truth for these values now that config/cadence-playbook.json is
// deprecated from the active generation path — the Claygent prompt itself
// defines Email 1/Day 1, Email 2/Day 5, Email 3/Day 9, Email 4/Day 12.
const EMAIL_STEP_META: Record<number, { send_day_offset: number; step_label: string }> = {
  1: { send_day_offset: 1, step_label: "cold_open" },
  2: { send_day_offset: 5, step_label: "resource_share" },
  3: { send_day_offset: 9, step_label: "clarification" },
  4: { send_day_offset: 12, step_label: "referral_exit" },
};

/**
 * Runs generation for a signal and persists the outcome: on success creates
 * a new pending_review sequence (with all 4 emails, 4 LinkedIn messages,
 * cold call opener, company research, and personalization fields) and
 * marks the signal generated; on failure (missing API key, API error, bad
 * output) logs the error and marks the signal status=error WITHOUT
 * throwing further — callers should not crash the request/server on
 * generation failure.
 */
export async function runGenerationForSignal(
  signalRow: SignalRow,
  signal: SignalRecord,
  extraInstruction?: string
): Promise<{ ok: boolean; sequenceId?: number; error?: string }> {
  try {
    const result = await generateFullSequence(signal, extraInstruction);

    const sequenceEmails = result.emails.map((email) => {
      const meta = EMAIL_STEP_META[email.step];
      if (!meta) {
        throw new Error(`No step metadata found for step ${email.step}`);
      }
      return {
        step: email.step,
        send_day_offset: meta.send_day_offset,
        step_label: meta.step_label,
        subject: email.subject,
        body: email.body,
        lavender_score: email.lavender_score,
        lavender_grade: email.lavender_grade,
        criteria_passed: email.criteria_passed,
        criteria_failed: email.criteria_failed,
        top_improvement: email.top_improvement,
      };
    });

    const sequence = repo.createSequence({
      signalId: signalRow.id,
      modelUsed: result.model,
      promptVersion: result.promptVersion,
      emails: sequenceEmails,
      linkedinMessages: result.linkedin_messages,
      coldCall: result.cold_call_opener,
      companyResearch: result.company_research,
      personalizationTier: result.personalization_tier,
      personalizationTierReason: result.personalization_tier_reason,
      personalizationNotes: result.personalization_notes,
    });
    repo.setSignalStatus(signalRow.id, "generated");
    return { ok: true, sequenceId: sequence.id };
  } catch (err: any) {
    console.error(
      `Sequence generation failed for signal ${signalRow.external_id}:`,
      err?.message || err
    );
    repo.setSignalStatus(signalRow.id, "error");
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * Regenerates a single step of an existing sequence in place, passing the
 * other 3 steps' current final content (final_subject/final_body if
 * present, else subject/body) as fixed context.
 */
export async function runSingleStepRegeneration(
  signal: SignalRecord,
  sequenceId: number,
  targetStep: number,
  extraInstruction?: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const allEmails = repo.getSequenceEmails(sequenceId);
    const target = allEmails.find((e) => e.step === targetStep);
    if (!target) {
      return { ok: false, error: `Step ${targetStep} not found on sequence ${sequenceId}` };
    }

    const otherSteps = allEmails.filter((e) => e.step !== targetStep).map((e) => liveEmailContent(e));

    const result = await generateSingleEmailStep(signal, targetStep, otherSteps, extraInstruction);

    repo.replaceSequenceEmailContent(target.id, {
      subject: result.subject,
      body: result.body,
      lavender_score: result.lavender_score,
      lavender_grade: result.lavender_grade,
      criteria_passed: result.criteria_passed,
      criteria_failed: result.criteria_failed,
      top_improvement: result.top_improvement,
    });
    repo.recomputeSequenceStatus(sequenceId);

    return { ok: true };
  } catch (err: any) {
    console.error(
      `Single-step regeneration failed for sequence ${sequenceId} step ${targetStep}:`,
      err?.message || err
    );
    return { ok: false, error: err?.message || String(err) };
  }
}

/** Builds the "hook context" fed to LinkedIn/cold-call regeneration: Email 1's live content. */
function emailHookContextForSequence(sequenceId: number): string {
  const email1 = repo.getSequenceEmailByStep(sequenceId, 1);
  if (!email1) return "Not available.";
  const subject = email1.final_subject || email1.subject || "";
  const body = email1.final_body || email1.body || "";
  return `Email 1 subject: ${subject}\nEmail 1 body:\n${body}`;
}

/**
 * Regenerates a single LinkedIn message of an existing sequence in place,
 * passing the sibling LinkedIn messages' current content AND the email
 * sequence's hook/content as fixed context.
 */
export async function runSingleLinkedInMessageRegeneration(
  signal: SignalRecord,
  sequenceId: number,
  position: number,
  extraInstruction?: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const allMessages = repo.getLinkedInMessages(sequenceId);
    const target = allMessages.find((m) => m.position === position);
    if (!target) {
      return { ok: false, error: `LinkedIn position ${position} not found on sequence ${sequenceId}` };
    }

    const siblings = allMessages.filter((m) => m.position !== position).map((m) => liveLinkedInContent(m));
    const emailHookContext = emailHookContextForSequence(sequenceId);

    const result = await generateSingleLinkedInMessage(
      signal,
      position,
      target.day_offset_label,
      target.label,
      siblings,
      emailHookContext,
      extraInstruction
    );

    repo.replaceLinkedInMessageContent(target.id, result.body);
    repo.recomputeSequenceStatus(sequenceId);

    return { ok: true };
  } catch (err: any) {
    console.error(
      `Single LinkedIn message regeneration failed for sequence ${sequenceId} position ${position}:`,
      err?.message || err
    );
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * Regenerates the cold call opener block of an existing sequence in place,
 * feeding the sequence's existing hook (Email 1) as context.
 */
export async function runColdCallRegeneration(
  signal: SignalRecord,
  sequenceId: number,
  extraInstruction?: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const emailHookContext = emailHookContextForSequence(sequenceId);
    const result = await generateColdCallOpener(signal, emailHookContext, extraInstruction);

    repo.replaceColdCallContent(sequenceId, result.beat1, result.beat2, result.beat3);
    repo.recomputeSequenceStatus(sequenceId);

    return { ok: true };
  } catch (err: any) {
    console.error(`Cold call opener regeneration failed for sequence ${sequenceId}:`, err?.message || err);
    return { ok: false, error: err?.message || String(err) };
  }
}

function liveEmailContent(e: SequenceEmailRow): { step: number; label: string; subject: string; body: string } {
  return {
    step: e.step,
    label: e.step_label,
    subject: e.final_subject || e.subject || "",
    body: e.final_body || e.body || "",
  };
}

function liveLinkedInContent(
  m: LinkedinMessageRow
): { position: number; day_offset_label: string; label: string; body: string } {
  return {
    position: m.position,
    day_offset_label: m.day_offset_label,
    label: m.label,
    body: m.final_body || m.body || "",
  };
}
