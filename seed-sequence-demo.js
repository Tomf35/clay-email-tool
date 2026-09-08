const Database = require("better-sqlite3");
const db = new Database("data/app.db");

function insertSignal(external_id, raw) {
  db.prepare(
    `INSERT INTO signals (external_id, raw_payload, received_at, status) VALUES (?, ?, datetime('now'), 'generated')`
  ).run(external_id, JSON.stringify(raw));
  return db.prepare(`SELECT id FROM signals WHERE external_id = ?`).get(external_id).id;
}

const STEPS = [
  { step: 1, send_day_offset: 1, step_label: "cold_open" },
  { step: 2, send_day_offset: 5, step_label: "resource_share" },
  { step: 3, send_day_offset: 8, step_label: "clarification" },
  { step: 4, send_day_offset: 12, step_label: "referral_exit" },
];

function insertSequence(signalId, emails) {
  const seqId = db
    .prepare(
      `INSERT INTO sequences (signal_id, model_used, prompt_version, generated_at, status)
       VALUES (?, 'claude-sonnet-4-5-20250929 (simulated - no live API key)', 'v2-sequence', datetime('now'), 'pending_review')`
    )
    .run(signalId).lastInsertRowid;
  STEPS.forEach((s, i) => {
    db.prepare(
      `INSERT INTO sequence_emails (sequence_id, step, send_day_offset, step_label, subject, body, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending_review')`
    ).run(seqId, s.step, s.send_day_offset, s.step_label, emails[i].subject, emails[i].body);
  });
  return seqId;
}

// Signal: Managing Director, high_hiring_velocity, headcount 45 (11-50 band).
// MD -> collapses to CEO for angle (funding/growth framing), keeps its own
// cross-functional-cost tone for structure. Seniority: Executive.
const signalId = insertSignal("clay-row-301", {
  contact_name: "Ellie Marsh",
  contact_title: "Managing Director",
  contact_email: "ellie@marshfield-supply.co.uk",
  company_name: "Marshfield Supply Co",
  headcount: 45,
  signal_type: "high_hiring_velocity",
  persona: "MD",
  seniority: "Executive",
  trigger_detail: "11 open roles posted across warehouse and ops in the last 3 weeks",
});

insertSequence(signalId, [
  {
    subject: "Hiring Pace",
    body:
      "Ellie,\n\nCurious if I'm off base here — looks like Marshfield's got over a dozen roles open right now.\n\nMost teams hiring this fast end up running benefits, payroll, and admin across two or three different tools without meaning to.\n\nWe help SMEs run all of it through one setup instead. Worth a quick look?\n\nTom",
  },
  {
    subject: "Hiring At Scale",
    body:
      "Ellie,\n\nSaw this piece on how fast-hiring SME ops teams keep offer consistency without adding headcount to HR — thought it was relevant given where Marshfield's at.\n\nWorth a skim either way.\n\nAny thoughts on my last note?\n\nTom",
  },
  {
    subject: "Re: Hiring Pace",
    body:
      "Ellie,\n\nReaching out again since Marshfield's still hiring at real pace.\n\nMintago brings pension, savings, and financial wellbeing benefits into one setup, so it's one thing to manage instead of several as headcount grows.\n\nGiven you're likely across HR, finance, and ops decisions all at once at Marshfield's size, that consolidation is usually the part that saves the most time.\n\nOpen to a short call this week?\n\nTom",
  },
  {
    subject: "Wrong Timing?",
    body:
      "Ellie,\n\nIf benefits/financial wellbeing sits with someone else on your team, happy to loop them in instead.\n\nOtherwise, reaching out was just about the hiring pace at Marshfield and whether a simpler setup would help.\n\nTom\n\nP.S. Happy to send the one-pager either way, no need to hop on a call first.",
  },
]);

console.log("Seeded sequence for signal", signalId);
