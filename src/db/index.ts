import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const DATA_DIR = path.join(__dirname, "..", "..", "data");
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, "app.db");

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// Schema is written in plain, portable SQL (no SQLite-only features)
// so it can be ported to Postgres with minimal changes later.
//
// NOTE: this replaces the old single-email "drafts" table with a
// sequence-based model (sequences + sequence_emails). There is no
// migration path from the old schema — dev data was wiped when this
// change shipped.
db.exec(`
  CREATE TABLE IF NOT EXISTS signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    external_id TEXT NOT NULL UNIQUE,
    raw_payload TEXT NOT NULL,
    received_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending_generation'
  );

  CREATE TABLE IF NOT EXISTS sequences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_id INTEGER NOT NULL REFERENCES signals(id),
    model_used TEXT,
    prompt_version TEXT,
    generated_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending_review',
    reviewed_at TEXT,
    reviewer_notes TEXT,

    -- Claygent prompt integration: research/personalization + cold call
    -- opener, which is reviewed as a single block (not per-beat) alongside
    -- the 4 emails and 4 LinkedIn messages. The LinkedIn connection request
    -- has no content (sent blank, no note) so it is not modeled as a row
    -- anywhere.
    personalization_tier TEXT,
    personalization_tier_reason TEXT,
    personalization_notes TEXT,
    company_research TEXT,
    cold_call_beat1 TEXT,
    cold_call_beat2 TEXT,
    cold_call_beat3 TEXT,
    cold_call_status TEXT NOT NULL DEFAULT 'pending_review',
    cold_call_final_beat1 TEXT,
    cold_call_final_beat2 TEXT,
    cold_call_final_beat3 TEXT,
    cold_call_reviewed_at TEXT,
    cold_call_reviewer_notes TEXT
  );

  CREATE TABLE IF NOT EXISTS sequence_emails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sequence_id INTEGER NOT NULL REFERENCES sequences(id),
    step INTEGER NOT NULL,
    send_day_offset INTEGER NOT NULL,
    step_label TEXT NOT NULL,
    subject TEXT,
    body TEXT,
    status TEXT NOT NULL DEFAULT 'pending_review',
    reviewed_at TEXT,
    reviewer_notes TEXT,
    final_subject TEXT,
    final_body TEXT,
    lavender_score INTEGER,
    lavender_grade TEXT,
    criteria_passed TEXT,
    criteria_failed TEXT,
    top_improvement TEXT,
    UNIQUE(sequence_id, step)
  );

  CREATE TABLE IF NOT EXISTS linkedin_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sequence_id INTEGER NOT NULL REFERENCES sequences(id),
    position INTEGER NOT NULL,
    day_offset_label TEXT NOT NULL,
    label TEXT NOT NULL,
    body TEXT,
    status TEXT NOT NULL DEFAULT 'pending_review',
    reviewed_at TEXT,
    reviewer_notes TEXT,
    final_body TEXT,
    UNIQUE(sequence_id, position)
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sequence_id INTEGER NOT NULL REFERENCES sequences(id),
    sequence_email_id INTEGER REFERENCES sequence_emails(id),
    linkedin_message_id INTEGER REFERENCES linkedin_messages(id),
    action TEXT NOT NULL,
    actor TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    detail_text TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_sequences_signal_id ON sequences(signal_id);
  CREATE INDEX IF NOT EXISTS idx_sequences_status ON sequences(status);
  CREATE INDEX IF NOT EXISTS idx_sequence_emails_sequence_id ON sequence_emails(sequence_id);
  CREATE INDEX IF NOT EXISTS idx_sequence_emails_status ON sequence_emails(status);
  CREATE INDEX IF NOT EXISTS idx_linkedin_messages_sequence_id ON linkedin_messages(sequence_id);
  CREATE INDEX IF NOT EXISTS idx_linkedin_messages_status ON linkedin_messages(status);
  CREATE INDEX IF NOT EXISTS idx_audit_log_sequence_id ON audit_log(sequence_id);
`);

export default db;
