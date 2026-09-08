import { Router, Request, Response } from "express";
import * as repo from "../db/repository";
import { exportSequence } from "../lib/exportSequence";
import {
  runColdCallRegeneration,
  runGenerationForSignal,
  runSingleLinkedInMessageRegeneration,
  runSingleStepRegeneration,
} from "../lib/generationRunner";
import { normalizeSignal } from "../lib/normalize";
import { wordCountFlagForBody } from "../lib/cadencePlaybook";
import { asyncHandler } from "../lib/asyncHandler";
import { LinkedinMessageRow, SequenceEmailRow, SequenceRow } from "../types";

export const sequencesRouter = Router();

// Auth: mounted behind the HTTP Basic Auth middleware in server.ts
// (single shared password via REVIEW_AUTH_PASSWORD, not per-user accounts —
// fine for Tom as sole reviewer). See lib/basicAuth.ts.

// Statuses that mean a sequence has already reached a terminal outcome and
// should not be actioned again by approve/edit/regenerate/reject. This
// guard now applies uniformly to the sequence-level status (which factors
// in all 3 channels — emails, LinkedIn messages, cold call — via
// deriveSequenceStatus) for every new route below, same pattern as the
// existing email routes.
const TERMINAL_STATUSES = new Set(["sent_to_destination", "rejected", "superseded"]);

// Caps how much of a free-text field (e.g. trigger_detail) shows up in the
// queue list summary. Clay can send an entire Claygent-style research brief
// (thousands of characters) in a single field like trigger_detail — the
// full text is still passed to generation untouched via the signal's raw
// fields, this cap only affects the short one-line preview shown in the
// sequences list so a single huge row doesn't blow out the whole table.
const SUMMARY_FIELD_MAX_CHARS = 180;

function truncateForSummary(value: unknown): string {
  const str = String(value ?? "").trim();
  if (str.length <= SUMMARY_FIELD_MAX_CHARS) return str;
  return `${str.slice(0, SUMMARY_FIELD_MAX_CHARS).trimEnd()}…`;
}

function summarizeSignal(rawPayloadJson: string) {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(rawPayloadJson);
  } catch {
    // ignore
  }
  const trigger = [raw.trigger_type, raw.trigger_detail ? truncateForSummary(raw.trigger_detail) : undefined]
    .filter(Boolean)
    .join(": ");
  const funding = raw.funding_stage
    ? `Funding: ${raw.funding_stage}${raw.funding_amount ? ` (${raw.funding_amount})` : ""}`
    : "";
  const headcount = raw.headcount ? `Headcount: ${raw.headcount}` : "";
  const techStack =
    Array.isArray(raw.tech_stack) && raw.tech_stack.length > 0
      ? `Tech stack: ${raw.tech_stack.join(", ")}`
      : "";
  // Prefer trigger/funding (the highest-signal fields); fall back to plain
  // firmographic details so a row with only headcount/tech data doesn't show
  // an empty "No signal summary available" line.
  const summary =
    [trigger, funding].filter(Boolean).join(" | ") ||
    [headcount, techStack].filter(Boolean).join(" | ") ||
    "No signal summary available";
  return {
    contact_name: raw.contact_name || null,
    contact_title: raw.contact_title || null,
    company_name: raw.company_name || null,
    // Belt-and-braces cap on the assembled summary too, in case future
    // fields added to the join above are similarly long-form.
    summary: truncateForSummary(summary),
  };
}

function shapeEmail(email: SequenceEmailRow) {
  const liveBody = email.final_body ?? email.body;
  return {
    ...email,
    word_count_flag: wordCountFlagForBody(email.step, liveBody),
    criteria_passed: repo.safeJsonParse<string[]>(email.criteria_passed, []),
    criteria_failed: repo.safeJsonParse<string[]>(email.criteria_failed, []),
  };
}

function shapeLinkedInMessage(message: LinkedinMessageRow) {
  return { ...message };
}

function shapeSequence(sequence: SequenceRow) {
  return {
    ...sequence,
    personalization_notes: repo.safeJsonParse<string[]>(sequence.personalization_notes, []),
    company_research: repo.safeJsonParse<Record<string, unknown> | null>(sequence.company_research, null),
  };
}

function coldCallShape(sequence: SequenceRow) {
  return {
    beat1: sequence.cold_call_beat1,
    beat2: sequence.cold_call_beat2,
    beat3: sequence.cold_call_beat3,
    final_beat1: sequence.cold_call_final_beat1,
    final_beat2: sequence.cold_call_final_beat2,
    final_beat3: sequence.cold_call_final_beat3,
    status: sequence.cold_call_status,
    reviewed_at: sequence.cold_call_reviewed_at,
    reviewer_notes: sequence.cold_call_reviewer_notes,
  };
}

function loadSignalRecord(sequence: SequenceRow) {
  const signalRow = repo.getSignalById(sequence.signal_id);
  if (!signalRow) return undefined;
  let rawFields: Record<string, unknown> = {};
  try {
    rawFields = JSON.parse(signalRow.raw_payload);
  } catch {
    // ignore
  }
  return { signalRow, signal: normalizeSignal(rawFields) };
}

sequencesRouter.get("/sequences", (req: Request, res: Response) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const sequences = repo.listSequences(status);
  const shaped = sequences.map((s) => {
    const emails = repo.getSequenceEmails(s.id);
    return {
      id: s.id,
      status: s.status,
      generated_at: s.generated_at,
      reviewed_at: s.reviewed_at,
      signal_id: s.signal_id,
      signal_external_id: s.signal.external_id,
      ...summarizeSignal(s.signal.raw_payload),
      steps: emails.map((e) => ({
        step: e.step,
        label: e.step_label,
        status: e.status,
        word_count_flag: wordCountFlagForBody(e.step, e.final_body ?? e.body),
      })),
    };
  });
  res.json({ sequences: shaped });
});

sequencesRouter.get("/sequences/:id", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const sequence = repo.getSequenceById(id);
  if (!sequence) return res.status(404).json({ error: "Sequence not found" });
  const signal = repo.getSignalById(sequence.signal_id);
  if (!signal) return res.status(404).json({ error: "Signal not found for sequence" });

  let rawFields: Record<string, unknown> = {};
  try {
    rawFields = JSON.parse(signal.raw_payload);
  } catch {
    // ignore
  }

  const emails = repo.getSequenceEmails(id).map(shapeEmail);
  const linkedinMessages = repo.getLinkedInMessages(id).map(shapeLinkedInMessage);
  const auditLog = repo.getAuditLogForSequence(id);

  res.json({
    sequence: shapeSequence(sequence),
    emails,
    linkedin_messages: linkedinMessages,
    cold_call: coldCallShape(sequence),
    signal: {
      id: signal.id,
      external_id: signal.external_id,
      status: signal.status,
      received_at: signal.received_at,
      raw_fields: rawFields,
    },
    audit_log: auditLog,
  });
});

sequencesRouter.post("/sequences/:id/approve", asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const sequence = repo.getSequenceById(id);
  if (!sequence) return res.status(404).json({ error: "Sequence not found" });
  if (TERMINAL_STATUSES.has(sequence.status)) {
    return res.status(409).json({
      error: `Sequence ${id} cannot be approved because it is already in status '${sequence.status}'`,
    });
  }

  const emails = repo.getSequenceEmails(id);
  if (emails.length !== 4) {
    return res.status(500).json({ error: `Sequence ${id} does not have exactly 4 emails` });
  }
  const linkedinMessages = repo.getLinkedInMessages(id);
  if (linkedinMessages.length !== 4) {
    return res.status(500).json({ error: `Sequence ${id} does not have exactly 4 LinkedIn messages` });
  }

  for (const email of emails) {
    repo.updateSequenceEmailStatus(email.id, "sent_to_destination", {
      finalSubject: email.final_subject || email.subject || "",
      finalBody: email.final_body || email.body || "",
    });
  }
  for (const message of linkedinMessages) {
    repo.updateLinkedInMessageStatus(message.id, "sent_to_destination", {
      finalBody: message.final_body || message.body || "",
    });
  }
  repo.updateColdCallStatus(id, "sent_to_destination", {
    finalBeat1: sequence.cold_call_final_beat1 || sequence.cold_call_beat1 || "",
    finalBeat2: sequence.cold_call_final_beat2 || sequence.cold_call_beat2 || "",
    finalBeat3: sequence.cold_call_final_beat3 || sequence.cold_call_beat3 || "",
  });

  // Derive the post-approval status from the (now all sent_to_destination)
  // children and persist it via setSequenceStatus rather than
  // recomputeSequenceStatus, so that — like reject() — reviewed_at gets
  // stamped on the sequence itself, not just on its children.
  const derivedStatus = repo.deriveSequenceStatus([
    ...repo.getSequenceEmails(id).map((e) => e.status),
    ...repo.getLinkedInMessages(id).map((m) => m.status),
    "sent_to_destination",
  ]);
  repo.setSequenceStatus(id, derivedStatus);
  repo.addAuditLog(
    id,
    null,
    "approve",
    "reviewer",
    "Approved all 4 emails, 4 LinkedIn messages, and the cold call opener as currently edited"
  );

  const signal = repo.getSignalById(sequence.signal_id)!;
  const updatedEmails = repo.getSequenceEmails(id);
  const updatedLinkedIn = repo.getLinkedInMessages(id);
  const updatedSequence = repo.getSequenceById(id)!;

  await exportSequence(updatedSequence, updatedEmails, updatedLinkedIn, signal);
  repo.addAuditLog(
    id,
    null,
    "export",
    "system",
    "Exported sequence (4 emails, 4 LinkedIn messages, cold call opener) to Clay writeback (stub)"
  );

  res.json({
    sequence: shapeSequence(repo.getSequenceById(id)!),
    emails: repo.getSequenceEmails(id).map(shapeEmail),
    linkedin_messages: repo.getLinkedInMessages(id).map(shapeLinkedInMessage),
    cold_call: coldCallShape(repo.getSequenceById(id)!),
  });
}));

sequencesRouter.post(
  "/sequences/:id/emails/:step/edit",
  (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const step = Number(req.params.step);
    const sequence = repo.getSequenceById(id);
    if (!sequence) return res.status(404).json({ error: "Sequence not found" });
    if (TERMINAL_STATUSES.has(sequence.status)) {
      return res.status(409).json({
        error: `Sequence ${id} cannot be edited because it is already in status '${sequence.status}'`,
      });
    }

    const email = repo.getSequenceEmailByStep(id, step);
    if (!email) return res.status(404).json({ error: `Step ${step} not found on sequence ${id}` });

    const { subject, body } = req.body || {};
    if (!subject || !body) {
      return res.status(400).json({ error: "subject and body are required" });
    }

    repo.editSequenceEmail(email.id, subject, body);
    repo.addAuditLog(id, { sequenceEmailId: email.id }, "edit", "reviewer", `Edited step ${step}`);

    res.json({ email: shapeEmail(repo.getSequenceEmailById(email.id)!) });
  }
);

sequencesRouter.post("/sequences/:id/regenerate", asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const sequence = repo.getSequenceById(id);
  if (!sequence) return res.status(404).json({ error: "Sequence not found" });
  if (TERMINAL_STATUSES.has(sequence.status)) {
    return res.status(409).json({
      error: `Sequence ${id} cannot be regenerated because it is already in status '${sequence.status}'`,
    });
  }

  const loaded = loadSignalRecord(sequence);
  if (!loaded) return res.status(404).json({ error: "Signal not found" });
  const { signal } = loaded;

  const note = typeof req.body?.note === "string" ? req.body.note : undefined;

  const result = await runGenerationForSignal(loaded.signalRow, signal, note);

  if (!result.ok) {
    return res.status(502).json({
      error: `Sequence regeneration failed: ${result.error}`,
      previous_sequence_id: id,
    });
  }

  // Mark the old sequence and all of its children superseded.
  for (const email of repo.getSequenceEmails(id)) {
    repo.updateSequenceEmailStatus(email.id, "superseded");
  }
  for (const message of repo.getLinkedInMessages(id)) {
    repo.updateLinkedInMessageStatus(message.id, "superseded");
  }
  repo.updateColdCallStatus(id, "superseded");
  repo.setSequenceStatus(id, "superseded");
  repo.addAuditLog(
    id,
    null,
    "regenerate",
    "reviewer",
    note ? `Superseded by whole-sequence regeneration (note: ${note})` : "Superseded by whole-sequence regeneration"
  );

  res.json({
    previous_sequence_id: id,
    new_sequence: shapeSequence(repo.getSequenceById(result.sequenceId!)!),
    new_emails: repo.getSequenceEmails(result.sequenceId!).map(shapeEmail),
    new_linkedin_messages: repo.getLinkedInMessages(result.sequenceId!).map(shapeLinkedInMessage),
    new_cold_call: coldCallShape(repo.getSequenceById(result.sequenceId!)!),
  });
}));

sequencesRouter.post(
  "/sequences/:id/emails/:step/regenerate",
  asyncHandler(async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const step = Number(req.params.step);
    const sequence = repo.getSequenceById(id);
    if (!sequence) return res.status(404).json({ error: "Sequence not found" });
    if (TERMINAL_STATUSES.has(sequence.status)) {
      return res.status(409).json({
        error: `Sequence ${id} cannot be regenerated because it is already in status '${sequence.status}'`,
      });
    }

    const email = repo.getSequenceEmailByStep(id, step);
    if (!email) return res.status(404).json({ error: `Step ${step} not found on sequence ${id}` });

    const loaded = loadSignalRecord(sequence);
    if (!loaded) return res.status(404).json({ error: "Signal not found" });
    const { signal } = loaded;

    const note = typeof req.body?.note === "string" ? req.body.note : undefined;

    const result = await runSingleStepRegeneration(signal, id, step, note);

    if (!result.ok) {
      return res.status(502).json({
        error: `Step ${step} regeneration failed: ${result.error}`,
      });
    }

    repo.addAuditLog(
      id,
      { sequenceEmailId: email.id },
      "regenerate-step",
      "reviewer",
      note ? `Regenerated step ${step} (note: ${note})` : `Regenerated step ${step}`
    );

    res.json({
      sequence: shapeSequence(repo.getSequenceById(id)!),
      email: shapeEmail(repo.getSequenceEmailByStep(id, step)!),
    });
  })
);

sequencesRouter.post(
  "/sequences/:id/linkedin/:position/edit",
  (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const position = Number(req.params.position);
    const sequence = repo.getSequenceById(id);
    if (!sequence) return res.status(404).json({ error: "Sequence not found" });
    if (TERMINAL_STATUSES.has(sequence.status)) {
      return res.status(409).json({
        error: `Sequence ${id} cannot be edited because it is already in status '${sequence.status}'`,
      });
    }

    const message = repo.getLinkedInMessageByPosition(id, position);
    if (!message) return res.status(404).json({ error: `LinkedIn position ${position} not found on sequence ${id}` });

    const { body } = req.body || {};
    if (!body) {
      return res.status(400).json({ error: "body is required" });
    }

    repo.editLinkedInMessage(message.id, body);
    repo.addAuditLog(
      id,
      { linkedinMessageId: message.id },
      "edit",
      "reviewer",
      `Edited LinkedIn message ${position}`
    );

    res.json({ linkedin_message: shapeLinkedInMessage(repo.getLinkedInMessageById(message.id)!) });
  }
);

sequencesRouter.post(
  "/sequences/:id/linkedin/:position/regenerate",
  asyncHandler(async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const position = Number(req.params.position);
    const sequence = repo.getSequenceById(id);
    if (!sequence) return res.status(404).json({ error: "Sequence not found" });
    if (TERMINAL_STATUSES.has(sequence.status)) {
      return res.status(409).json({
        error: `Sequence ${id} cannot be regenerated because it is already in status '${sequence.status}'`,
      });
    }

    const message = repo.getLinkedInMessageByPosition(id, position);
    if (!message) return res.status(404).json({ error: `LinkedIn position ${position} not found on sequence ${id}` });

    const loaded = loadSignalRecord(sequence);
    if (!loaded) return res.status(404).json({ error: "Signal not found" });
    const { signal } = loaded;

    const note = typeof req.body?.note === "string" ? req.body.note : undefined;

    const result = await runSingleLinkedInMessageRegeneration(signal, id, position, note);

    if (!result.ok) {
      return res.status(502).json({
        error: `LinkedIn message ${position} regeneration failed: ${result.error}`,
      });
    }

    repo.addAuditLog(
      id,
      { linkedinMessageId: message.id },
      "regenerate-linkedin",
      "reviewer",
      note ? `Regenerated LinkedIn message ${position} (note: ${note})` : `Regenerated LinkedIn message ${position}`
    );

    res.json({
      sequence: shapeSequence(repo.getSequenceById(id)!),
      linkedin_message: shapeLinkedInMessage(repo.getLinkedInMessageByPosition(id, position)!),
    });
  })
);

sequencesRouter.post("/sequences/:id/coldcall/edit", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const sequence = repo.getSequenceById(id);
  if (!sequence) return res.status(404).json({ error: "Sequence not found" });
  if (TERMINAL_STATUSES.has(sequence.status)) {
    return res.status(409).json({
      error: `Sequence ${id} cannot be edited because it is already in status '${sequence.status}'`,
    });
  }

  const { beat1, beat2, beat3 } = req.body || {};
  if (!beat1 || !beat2 || !beat3) {
    return res.status(400).json({ error: "beat1, beat2, and beat3 are all required" });
  }

  repo.editColdCall(id, beat1, beat2, beat3);
  repo.addAuditLog(id, null, "edit", "reviewer", "Edited cold call opener");

  res.json({ cold_call: coldCallShape(repo.getSequenceById(id)!) });
});

sequencesRouter.post("/sequences/:id/coldcall/regenerate", asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const sequence = repo.getSequenceById(id);
  if (!sequence) return res.status(404).json({ error: "Sequence not found" });
  if (TERMINAL_STATUSES.has(sequence.status)) {
    return res.status(409).json({
      error: `Sequence ${id} cannot be regenerated because it is already in status '${sequence.status}'`,
    });
  }

  const loaded = loadSignalRecord(sequence);
  if (!loaded) return res.status(404).json({ error: "Signal not found" });
  const { signal } = loaded;

  const note = typeof req.body?.note === "string" ? req.body.note : undefined;

  const result = await runColdCallRegeneration(signal, id, note);

  if (!result.ok) {
    return res.status(502).json({
      error: `Cold call opener regeneration failed: ${result.error}`,
    });
  }

  repo.addAuditLog(
    id,
    null,
    "regenerate-coldcall",
    "reviewer",
    note ? `Regenerated cold call opener (note: ${note})` : "Regenerated cold call opener"
  );

  res.json({
    sequence: shapeSequence(repo.getSequenceById(id)!),
    cold_call: coldCallShape(repo.getSequenceById(id)!),
  });
}));

sequencesRouter.post("/sequences/:id/reject", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const sequence = repo.getSequenceById(id);
  if (!sequence) return res.status(404).json({ error: "Sequence not found" });
  if (TERMINAL_STATUSES.has(sequence.status)) {
    return res.status(409).json({
      error: `Sequence ${id} cannot be rejected because it is already in status '${sequence.status}'`,
    });
  }

  const reason = typeof req.body?.reason === "string" ? req.body.reason : "";

  for (const email of repo.getSequenceEmails(id)) {
    repo.updateSequenceEmailStatus(email.id, "rejected", { reviewerNotes: reason });
  }
  for (const message of repo.getLinkedInMessages(id)) {
    repo.updateLinkedInMessageStatus(message.id, "rejected", { reviewerNotes: reason });
  }
  repo.updateColdCallStatus(id, "rejected", { reviewerNotes: reason });
  repo.setSequenceStatus(id, "rejected", { reviewerNotes: reason });
  repo.addAuditLog(id, null, "reject", "reviewer", reason || "No reason given");

  res.json({
    sequence: shapeSequence(repo.getSequenceById(id)!),
    emails: repo.getSequenceEmails(id).map(shapeEmail),
    linkedin_messages: repo.getLinkedInMessages(id).map(shapeLinkedInMessage),
    cold_call: coldCallShape(repo.getSequenceById(id)!),
  });
});
