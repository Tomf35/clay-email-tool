import db from "./index";
import {
  AuditLogRow,
  GeneratedColdCallOpener,
  GeneratedCompanyResearch,
  LinkedinMessageRow,
  SequenceEmailRow,
  SequenceEmailStatus,
  SequenceRow,
  SequenceStatus,
  SignalRow,
  SignalStatus,
} from "../types";

export function upsertSignal(externalId: string, rawPayload: unknown): SignalRow {
  const existing = db
    .prepare("SELECT * FROM signals WHERE external_id = ?")
    .get(externalId) as SignalRow | undefined;

  const now = new Date().toISOString();
  const payloadJson = JSON.stringify(rawPayload);

  if (existing) {
    db.prepare(
      "UPDATE signals SET raw_payload = ?, status = 'pending_generation' WHERE id = ?"
    ).run(payloadJson, existing.id);
    return getSignalById(existing.id)!;
  }

  const info = db
    .prepare(
      "INSERT INTO signals (external_id, raw_payload, received_at, status) VALUES (?, ?, ?, 'pending_generation')"
    )
    .run(externalId, payloadJson, now);

  return getSignalById(info.lastInsertRowid as number)!;
}

export function getSignalById(id: number): SignalRow | undefined {
  return db.prepare("SELECT * FROM signals WHERE id = ?").get(id) as
    | SignalRow
    | undefined;
}

export function setSignalStatus(id: number, status: SignalStatus): void {
  db.prepare("UPDATE signals SET status = ? WHERE id = ?").run(status, id);
}

/**
 * Pure function: derives an overall status from a flat list of child channel
 * statuses (4 email statuses + 4 LinkedIn message statuses + 1 cold call
 * status = 9 entries once a sequence is fully generated). Does NOT account
 * for explicit "rejected"/"superseded" terminal actions taken directly at
 * the sequence level — those are set directly by the reject/regenerate-
 * whole-sequence handlers and are not re-derived from children afterwards.
 * This function is only used to recompute status after a child's status
 * changes in the course of normal review (single-step/message/cold-call
 * regenerate resetting an item to pending_review, or approving everything).
 */
export function deriveSequenceStatus(statuses: SequenceStatus[]): SequenceStatus {
  if (statuses.length === 0) return "pending_review";
  if (statuses.some((s) => s === "pending_review")) return "pending_review";
  if (statuses.every((s) => s === "sent_to_destination")) {
    return "sent_to_destination";
  }
  if (
    statuses.every((s) =>
      ["approved", "edited_approved", "sent_to_destination"].includes(s)
    )
  ) {
    return "approved";
  }
  // Any other mix (e.g. some rejected/superseded individually, which the
  // current review flows never produce since reject/supersede only happen
  // at the sequence level) falls back to pending_review as the safest
  // default rather than silently reporting a misleading terminal status.
  return "pending_review";
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return "null";
  }
}

export function safeJsonParse<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export interface NewSequenceEmailInput {
  step: number;
  send_day_offset: number;
  step_label: string;
  subject: string;
  body: string;
  lavender_score?: number;
  lavender_grade?: string;
  criteria_passed?: string[];
  criteria_failed?: string[];
  top_improvement?: string;
}

export interface NewLinkedInMessageInput {
  position: number;
  day_offset_label: string;
  label: string;
  body: string;
}

export function createSequence(params: {
  signalId: number;
  modelUsed: string | null;
  promptVersion: string | null;
  emails: NewSequenceEmailInput[];
  linkedinMessages: NewLinkedInMessageInput[];
  coldCall: GeneratedColdCallOpener;
  companyResearch?: GeneratedCompanyResearch;
  personalizationTier?: string;
  personalizationTierReason?: string;
  personalizationNotes?: string[];
}): SequenceRow {
  const now = new Date().toISOString();
  const insertSequence = db.prepare(
    `INSERT INTO sequences
       (signal_id, model_used, prompt_version, generated_at, status,
        personalization_tier, personalization_tier_reason, personalization_notes,
        company_research, cold_call_beat1, cold_call_beat2, cold_call_beat3, cold_call_status)
     VALUES (?, ?, ?, ?, 'pending_review', ?, ?, ?, ?, ?, ?, ?, 'pending_review')`
  );
  const insertEmail = db.prepare(
    `INSERT INTO sequence_emails
       (sequence_id, step, send_day_offset, step_label, subject, body, status,
        lavender_score, lavender_grade, criteria_passed, criteria_failed, top_improvement)
     VALUES (?, ?, ?, ?, ?, ?, 'pending_review', ?, ?, ?, ?, ?)`
  );
  const insertLinkedIn = db.prepare(
    `INSERT INTO linkedin_messages
       (sequence_id, position, day_offset_label, label, body, status)
     VALUES (?, ?, ?, ?, ?, 'pending_review')`
  );

  const txn = db.transaction(() => {
    const info = insertSequence.run(
      params.signalId,
      params.modelUsed,
      params.promptVersion,
      now,
      params.personalizationTier ?? null,
      params.personalizationTierReason ?? null,
      safeJsonStringify(params.personalizationNotes ?? []),
      safeJsonStringify(params.companyResearch ?? null),
      params.coldCall?.beat1 ?? null,
      params.coldCall?.beat2 ?? null,
      params.coldCall?.beat3 ?? null
    );
    const sequenceId = info.lastInsertRowid as number;
    for (const email of params.emails) {
      insertEmail.run(
        sequenceId,
        email.step,
        email.send_day_offset,
        email.step_label,
        email.subject,
        email.body,
        email.lavender_score ?? null,
        email.lavender_grade ?? null,
        safeJsonStringify(email.criteria_passed ?? []),
        safeJsonStringify(email.criteria_failed ?? []),
        email.top_improvement ?? null
      );
    }
    for (const message of params.linkedinMessages) {
      insertLinkedIn.run(
        sequenceId,
        message.position,
        message.day_offset_label,
        message.label,
        message.body
      );
    }
    return sequenceId;
  });

  const sequenceId = txn();
  return getSequenceById(sequenceId)!;
}

export function getSequenceById(id: number): SequenceRow | undefined {
  return db.prepare("SELECT * FROM sequences WHERE id = ?").get(id) as
    | SequenceRow
    | undefined;
}

export function listSequences(status?: string): (SequenceRow & { signal: SignalRow })[] {
  const rows = status
    ? (db
        .prepare("SELECT * FROM sequences WHERE status = ? ORDER BY generated_at DESC")
        .all(status) as SequenceRow[])
    : (db
        .prepare("SELECT * FROM sequences ORDER BY generated_at DESC")
        .all() as SequenceRow[]);

  return rows.map((row) => ({
    ...row,
    signal: getSignalById(row.signal_id)!,
  }));
}

export function getSequenceEmails(sequenceId: number): SequenceEmailRow[] {
  return db
    .prepare("SELECT * FROM sequence_emails WHERE sequence_id = ? ORDER BY step ASC")
    .all(sequenceId) as SequenceEmailRow[];
}

export function getSequenceEmailByStep(
  sequenceId: number,
  step: number
): SequenceEmailRow | undefined {
  return db
    .prepare("SELECT * FROM sequence_emails WHERE sequence_id = ? AND step = ?")
    .get(sequenceId, step) as SequenceEmailRow | undefined;
}

export function getSequenceEmailById(id: number): SequenceEmailRow | undefined {
  return db.prepare("SELECT * FROM sequence_emails WHERE id = ?").get(id) as
    | SequenceEmailRow
    | undefined;
}

export function getLinkedInMessages(sequenceId: number): LinkedinMessageRow[] {
  return db
    .prepare("SELECT * FROM linkedin_messages WHERE sequence_id = ? ORDER BY position ASC")
    .all(sequenceId) as LinkedinMessageRow[];
}

export function getLinkedInMessageByPosition(
  sequenceId: number,
  position: number
): LinkedinMessageRow | undefined {
  return db
    .prepare("SELECT * FROM linkedin_messages WHERE sequence_id = ? AND position = ?")
    .get(sequenceId, position) as LinkedinMessageRow | undefined;
}

export function getLinkedInMessageById(id: number): LinkedinMessageRow | undefined {
  return db.prepare("SELECT * FROM linkedin_messages WHERE id = ?").get(id) as
    | LinkedinMessageRow
    | undefined;
}

export function getLatestSequenceForSignal(signalId: number): SequenceRow | undefined {
  return db
    .prepare(
      "SELECT * FROM sequences WHERE signal_id = ? ORDER BY generated_at DESC LIMIT 1"
    )
    .get(signalId) as SequenceRow | undefined;
}

/**
 * Recomputes and persists sequences.status from ALL of its children's
 * statuses: the 4 emails, the 4 LinkedIn messages, and the cold call
 * opener block. A sequence is only fully "approved"/"sent_to_destination"
 * once every one of these 9 items is in a terminal accepted state.
 */
export function recomputeSequenceStatus(sequenceId: number): void {
  const emails = getSequenceEmails(sequenceId);
  const linkedin = getLinkedInMessages(sequenceId);
  const sequence = getSequenceById(sequenceId);
  const statuses: SequenceStatus[] = [
    ...emails.map((e) => e.status),
    ...linkedin.map((l) => l.status),
  ];
  if (sequence) statuses.push(sequence.cold_call_status as SequenceStatus);
  const status = deriveSequenceStatus(statuses);
  db.prepare("UPDATE sequences SET status = ? WHERE id = ?").run(status, sequenceId);
}

export function setSequenceStatus(
  id: number,
  status: SequenceStatus,
  extra?: { reviewerNotes?: string }
): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE sequences
     SET status = ?, reviewed_at = ?, reviewer_notes = COALESCE(?, reviewer_notes)
     WHERE id = ?`
  ).run(status, now, extra?.reviewerNotes ?? null, id);
}

/** Updates a single sequence_email's status (and optionally final content). */
export function updateSequenceEmailStatus(
  id: number,
  status: SequenceEmailStatus,
  extra?: { finalSubject?: string; finalBody?: string; reviewerNotes?: string }
): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE sequence_emails
     SET status = ?, reviewed_at = ?, final_subject = COALESCE(?, final_subject), final_body = COALESCE(?, final_body), reviewer_notes = COALESCE(?, reviewer_notes)
     WHERE id = ?`
  ).run(
    status,
    now,
    extra?.finalSubject ?? null,
    extra?.finalBody ?? null,
    extra?.reviewerNotes ?? null,
    id
  );
}

/** Edits (final_subject/final_body only) a single sequence_email — no status change. */
export function editSequenceEmail(
  id: number,
  finalSubject: string,
  finalBody: string
): void {
  db.prepare(
    `UPDATE sequence_emails SET final_subject = ?, final_body = ? WHERE id = ?`
  ).run(finalSubject, finalBody, id);
}

/** Replaces a single sequence_email's generated content in place (regeneration of one step). */
export function replaceSequenceEmailContent(
  id: number,
  content: {
    subject: string;
    body: string;
    lavender_score?: number;
    lavender_grade?: string;
    criteria_passed?: string[];
    criteria_failed?: string[];
    top_improvement?: string;
  }
): void {
  db.prepare(
    `UPDATE sequence_emails
     SET subject = ?, body = ?, status = 'pending_review', reviewed_at = NULL,
         reviewer_notes = NULL, final_subject = NULL, final_body = NULL,
         lavender_score = ?, lavender_grade = ?, criteria_passed = ?, criteria_failed = ?, top_improvement = ?
     WHERE id = ?`
  ).run(
    content.subject,
    content.body,
    content.lavender_score ?? null,
    content.lavender_grade ?? null,
    safeJsonStringify(content.criteria_passed ?? []),
    safeJsonStringify(content.criteria_failed ?? []),
    content.top_improvement ?? null,
    id
  );
}

/** Updates a single linkedin_messages row's status (and optionally final content). */
export function updateLinkedInMessageStatus(
  id: number,
  status: SequenceStatus,
  extra?: { finalBody?: string; reviewerNotes?: string }
): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE linkedin_messages
     SET status = ?, reviewed_at = ?, final_body = COALESCE(?, final_body), reviewer_notes = COALESCE(?, reviewer_notes)
     WHERE id = ?`
  ).run(status, now, extra?.finalBody ?? null, extra?.reviewerNotes ?? null, id);
}

/** Edits (final_body only) a single linkedin_messages row — no status change. */
export function editLinkedInMessage(id: number, finalBody: string): void {
  db.prepare(`UPDATE linkedin_messages SET final_body = ? WHERE id = ?`).run(
    finalBody,
    id
  );
}

/** Replaces a single linkedin_messages row's generated content in place (regeneration). */
export function replaceLinkedInMessageContent(id: number, body: string): void {
  db.prepare(
    `UPDATE linkedin_messages
     SET body = ?, status = 'pending_review', reviewed_at = NULL,
         reviewer_notes = NULL, final_body = NULL
     WHERE id = ?`
  ).run(body, id);
}

/** Updates the cold call opener's status (and optionally final content), sequence-level fields. */
export function updateColdCallStatus(
  sequenceId: number,
  status: SequenceStatus,
  extra?: {
    finalBeat1?: string;
    finalBeat2?: string;
    finalBeat3?: string;
    reviewerNotes?: string;
  }
): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE sequences
     SET cold_call_status = ?, cold_call_reviewed_at = ?,
         cold_call_final_beat1 = COALESCE(?, cold_call_final_beat1),
         cold_call_final_beat2 = COALESCE(?, cold_call_final_beat2),
         cold_call_final_beat3 = COALESCE(?, cold_call_final_beat3),
         cold_call_reviewer_notes = COALESCE(?, cold_call_reviewer_notes)
     WHERE id = ?`
  ).run(
    status,
    now,
    extra?.finalBeat1 ?? null,
    extra?.finalBeat2 ?? null,
    extra?.finalBeat3 ?? null,
    extra?.reviewerNotes ?? null,
    sequenceId
  );
}

/** Edits (final beats only) the cold call opener as one block — no status change. */
export function editColdCall(
  sequenceId: number,
  beat1: string,
  beat2: string,
  beat3: string
): void {
  db.prepare(
    `UPDATE sequences
     SET cold_call_final_beat1 = ?, cold_call_final_beat2 = ?, cold_call_final_beat3 = ?
     WHERE id = ?`
  ).run(beat1, beat2, beat3, sequenceId);
}

/** Replaces the cold call opener's generated content in place (regeneration). */
export function replaceColdCallContent(
  sequenceId: number,
  beat1: string,
  beat2: string,
  beat3: string
): void {
  db.prepare(
    `UPDATE sequences
     SET cold_call_beat1 = ?, cold_call_beat2 = ?, cold_call_beat3 = ?,
         cold_call_status = 'pending_review', cold_call_reviewed_at = NULL,
         cold_call_reviewer_notes = NULL,
         cold_call_final_beat1 = NULL, cold_call_final_beat2 = NULL, cold_call_final_beat3 = NULL
     WHERE id = ?`
  ).run(beat1, beat2, beat3, sequenceId);
}

export function addAuditLog(
  sequenceId: number,
  ids: { sequenceEmailId?: number | null; linkedinMessageId?: number | null } | null,
  action: string,
  actor: string,
  detailText?: string
): AuditLogRow {
  const now = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO audit_log (sequence_id, sequence_email_id, linkedin_message_id, action, actor, timestamp, detail_text)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      sequenceId,
      ids?.sequenceEmailId ?? null,
      ids?.linkedinMessageId ?? null,
      action,
      actor,
      now,
      detailText ?? null
    );
  return db
    .prepare("SELECT * FROM audit_log WHERE id = ?")
    .get(info.lastInsertRowid as number) as AuditLogRow;
}

export function getAuditLogForSequence(sequenceId: number): AuditLogRow[] {
  return db
    .prepare("SELECT * FROM audit_log WHERE sequence_id = ? ORDER BY timestamp ASC")
    .all(sequenceId) as AuditLogRow[];
}
