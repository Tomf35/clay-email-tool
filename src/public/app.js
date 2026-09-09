const queueView = document.getElementById("queueView");
const detailView = document.getElementById("detailView");
const queueBody = document.getElementById("queueBody");
const emptyState = document.getElementById("emptyState");
const statusFilter = document.getElementById("statusFilter");
const refreshBtn = document.getElementById("refreshBtn");
const backBtn = document.getElementById("backBtn");
const emailCardsEl = document.getElementById("emailCards");
const linkedinCardsEl = document.getElementById("linkedinCards");

let currentSequenceId = null;

const TERMINAL_STATUSES = new Set(["sent_to_destination", "rejected", "superseded"]);

function fmtDate(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

// UK date format, date only (no time) — dd/mm/yy. Used for trigger_date in
// the Raw Signals table rather than the full ISO timestamp.
function fmtUkDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(-2);
  return `${dd}/${mm}/${yy}`;
}

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function showQueueError(message) {
  const el = document.getElementById("queueError");
  if (!el) return;
  if (!message) {
    el.textContent = "";
    el.classList.add("hidden");
    return;
  }
  el.textContent = message;
  el.classList.remove("hidden");
}

function setActionMessage(message, ok) {
  const el = document.getElementById("actionMessage");
  el.textContent = message || "";
  el.style.color = ok ? "#155724" : "#721c24";
}

// Compact per-step glyph used both in the queue's step indicator and on
// each email card's status badge.
function statusGlyph(status) {
  if (["sent_to_destination", "approved", "edited_approved"].includes(status)) return "✓"; // check
  if (["rejected", "superseded"].includes(status)) return "✗"; // x
  return "•"; // bullet = pending_review
}

async function loadQueue() {
  try {
    const status = statusFilter.value;
    const url = "/api/sequences" + (status ? `?status=${encodeURIComponent(status)}` : "");
    const res = await fetch(url);
    if (!res.ok) {
      let errMsg = `Failed to load queue (HTTP ${res.status})`;
      try {
        const errData = await res.json();
        if (errData && errData.error) errMsg = errData.error;
      } catch {
        // ignore parse failure
      }
      showQueueError(errMsg);
      return;
    }
    const data = await res.json();
    showQueueError(null);
    renderQueue(data.sequences || []);
  } catch (err) {
    showQueueError("Failed to load queue: " + (err && err.message ? err.message : "network error"));
  }
}

function renderQueue(sequences) {
  queueBody.innerHTML = "";
  if (sequences.length === 0) {
    emptyState.classList.remove("hidden");
    return;
  }
  emptyState.classList.add("hidden");

  for (const s of sequences) {
    const tr = document.createElement("tr");
    const steps = (s.steps || [])
      .slice()
      .sort((a, b) => a.step - b.step)
      .map((st) => `${st.step}${statusGlyph(st.status)}`)
      .join(" ");
    tr.innerHTML = `
      <td>${escapeHtml(s.company_name || "—")}</td>
      <td>${escapeHtml(s.contact_name || "—")}${s.contact_title ? ` (${escapeHtml(s.contact_title)})` : ""}</td>
      <td>${escapeHtml(s.summary || "—")}</td>
      <td class="steps-indicator">${escapeHtml(steps)}</td>
      <td><span class="badge badge-${s.status}">${s.status}</span></td>
      <td>${fmtDate(s.generated_at)}</td>
    `;
    tr.addEventListener("click", () => openDetail(s.id));
    queueBody.appendChild(tr);
  }
}

async function openDetail(id) {
  currentSequenceId = id;
  try {
    const res = await fetch(`/api/sequences/${id}`);
    if (!res.ok) {
      showQueueError(`Could not load sequence (HTTP ${res.status})`);
      return;
    }
    const data = await res.json();
    showQueueError(null);
    renderDetail(data);
    queueView.classList.add("hidden");
    detailView.classList.remove("hidden");
  } catch (err) {
    showQueueError("Could not load sequence: " + (err && err.message ? err.message : "network error"));
  }
}

function renderDetail(data) {
  const { sequence, emails, linkedin_messages, cold_call, signal, audit_log } = data;

  document.getElementById("sequenceStatusBadge").outerHTML =
    `<span id="sequenceStatusBadge" class="badge badge-${sequence.status}">${sequence.status}</span>`;

  setActionMessage("", true);
  document.getElementById("regenSequenceNote").value = "";
  document.getElementById("rejectReason").value = "";

  const fieldsDiv = document.getElementById("signalFields");
  const entries = Object.entries(signal.raw_fields || {}).filter(
    ([, v]) => v !== null && v !== undefined && v !== ""
  );
  let html = `<dl>`;
  html += `<dt>External ID</dt><dd>${escapeHtml(signal.external_id)}</dd>`;
  for (const [key, value] of entries) {
    const displayValue = Array.isArray(value) ? JSON.stringify(value) : String(value);
    html += `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(displayValue)}</dd>`;
  }
  html += `</dl>`;
  fieldsDiv.innerHTML = html;

  const auditUl = document.getElementById("auditLog");
  auditUl.innerHTML = "";
  for (const entry of audit_log || []) {
    const li = document.createElement("li");
    li.textContent = `[${fmtDate(entry.timestamp)}] ${entry.action} by ${entry.actor}${entry.detail_text ? ": " + entry.detail_text : ""}`;
    auditUl.appendChild(li);
  }

  // A sequence is only terminal (fully actioned) once ALL THREE channels —
  // the 4 emails, the 4 LinkedIn messages, and the cold call opener — are
  // in a terminal state. The sequence.status column is already derived
  // that way server-side (see deriveSequenceStatus), so checking it alone
  // is sufficient here — but we also independently guard on cold_call and
  // linkedin statuses below for defense in depth.
  const terminal =
    TERMINAL_STATUSES.has(sequence.status) &&
    TERMINAL_STATUSES.has(cold_call.status) &&
    (linkedin_messages || []).every((m) => TERMINAL_STATUSES.has(m.status));

  renderEmailCards(emails, terminal);
  renderLinkedInSection(linkedin_messages, terminal);
  renderColdCallSection(cold_call, terminal);
  renderResearchPanel(sequence);

  document.getElementById("approveSequenceBtn").disabled = terminal;
  document.getElementById("regenerateSequenceBtn").disabled = terminal;
  document.getElementById("rejectSequenceBtn").disabled = terminal;
}

function renderLinkedInSection(messages, sequenceTerminal) {
  const connectionEl = document.getElementById("connectionRequestLine");
  connectionEl.textContent = "Connection request — sent blank, no note — Day 1";

  linkedinCardsEl.innerHTML = "";
  const sorted = (messages || []).slice().sort((a, b) => a.position - b.position);
  for (const message of sorted) {
    const card = document.createElement("div");
    card.className = "email-card";
    card.dataset.position = message.position;

    const bodyValue = message.final_body ?? message.body ?? "";

    card.innerHTML = `
      <div class="email-card-header">
        <h3>Message ${message.position} — ${escapeHtml(message.label)} — ${escapeHtml(message.day_offset_label)}</h3>
        <span class="badge badge-${message.status}">${message.status}</span>
      </div>
      <label>Body</label>
      <textarea class="linkedin-body-input" rows="5">${escapeHtml(bodyValue)}</textarea>
      <div class="email-card-actions">
        <button class="btn-save-edit" ${sequenceTerminal ? "disabled" : ""}>Save edit</button>
        <input type="text" class="linkedin-regen-note" placeholder="Optional note for regenerating this message" ${sequenceTerminal ? "disabled" : ""} />
        <button class="btn-regen-step" ${sequenceTerminal ? "disabled" : ""}>Regenerate this message</button>
      </div>
    `;

    card.querySelector(".btn-save-edit").addEventListener("click", () => saveLinkedInEdit(message.position, card));
    card.querySelector(".btn-regen-step").addEventListener("click", () => regenerateLinkedInMessage(message.position, card));

    linkedinCardsEl.appendChild(card);
  }
}

function renderColdCallSection(coldCall, sequenceTerminal) {
  document.getElementById("coldCallStatusBadge").outerHTML =
    `<span id="coldCallStatusBadge" class="badge badge-${coldCall.status}">${coldCall.status}</span>`;

  document.getElementById("coldCallBeat1").value = coldCall.final_beat1 ?? coldCall.beat1 ?? "";
  document.getElementById("coldCallBeat2").value = coldCall.final_beat2 ?? coldCall.beat2 ?? "";
  document.getElementById("coldCallBeat3").value = coldCall.final_beat3 ?? coldCall.beat3 ?? "";

  document.getElementById("coldCallSaveBtn").disabled = sequenceTerminal;
  document.getElementById("coldCallRegenBtn").disabled = sequenceTerminal;
  document.getElementById("coldCallRegenNote").disabled = sequenceTerminal;
  document.getElementById("coldCallRegenNote").value = "";
}

function renderResearchPanel(sequence) {
  const tierBlock = document.getElementById("personalizationTierBlock");
  if (sequence.personalization_tier) {
    tierBlock.innerHTML = `<span class="badge badge-tier">${escapeHtml(sequence.personalization_tier)}</span> ${escapeHtml(sequence.personalization_tier_reason || "")}`;
  } else {
    tierBlock.innerHTML = `<em>No personalization tier recorded.</em>`;
  }

  const notesBlock = document.getElementById("personalizationNotesBlock");
  const notes = sequence.personalization_notes || [];
  if (notes.length) {
    notesBlock.innerHTML = `<ul>${notes.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul>`;
  } else {
    notesBlock.innerHTML = `<em>No personalization notes recorded.</em>`;
  }

  const researchBlock = document.getElementById("companyResearchBlock");
  const research = sequence.company_research;
  if (research && typeof research === "object") {
    let dl = "<dl>";
    for (const [key, value] of Object.entries(research)) {
      dl += `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`;
    }
    dl += "</dl>";
    researchBlock.innerHTML = dl;
  } else {
    researchBlock.innerHTML = `<em>No company research recorded.</em>`;
  }
}

function renderEmailCards(emails, sequenceTerminal) {
  emailCardsEl.innerHTML = "";
  const sorted = (emails || []).slice().sort((a, b) => a.step - b.step);
  for (const email of sorted) {
    const card = document.createElement("div");
    card.className = "email-card";
    card.dataset.step = email.step;

    const subjectValue = email.final_subject ?? email.subject ?? "";
    const bodyValue = email.final_body ?? email.body ?? "";

    card.innerHTML = `
      <div class="email-card-header">
        <h3>Step ${email.step} — ${escapeHtml(email.step_label)} — Day ${email.send_day_offset}</h3>
        <span class="badge badge-${email.status}">${email.status}</span>
        ${email.word_count_flag ? `<span class="badge badge-wordcount-flag">word count out of range</span>` : ""}
      </div>
      <label>Subject</label>
      <input type="text" class="email-subject-input" value="${escapeHtml(subjectValue)}" />
      <label>Body</label>
      <textarea class="email-body-input" rows="8">${escapeHtml(bodyValue)}</textarea>
      <div class="email-card-actions">
        <button class="btn-save-edit" ${sequenceTerminal ? "disabled" : ""}>Save edit</button>
        <input type="text" class="email-regen-note" placeholder="Optional note for regenerating this email" ${sequenceTerminal ? "disabled" : ""} />
        <button class="btn-regen-step" ${sequenceTerminal ? "disabled" : ""}>Regenerate this email</button>
      </div>
    `;

    card.querySelector(".btn-save-edit").addEventListener("click", () => saveEmailEdit(email.step, card));
    card.querySelector(".btn-regen-step").addEventListener("click", () => regenerateStep(email.step, card));

    emailCardsEl.appendChild(card);
  }
}

async function postJson(path, body) {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      // ignore parse failure, handled below
    }
    if (!res.ok) {
      setActionMessage("Error: " + (data && data.error ? data.error : `Unknown error (HTTP ${res.status})`), false);
      return null;
    }
    return data;
  } catch (err) {
    setActionMessage("Error: " + (err && err.message ? err.message : "network error"), false);
    return null;
  }
}

async function saveEmailEdit(step, card) {
  const subject = card.querySelector(".email-subject-input").value;
  const body = card.querySelector(".email-body-input").value;
  const data = await postJson(`/api/sequences/${currentSequenceId}/emails/${step}/edit`, { subject, body });
  if (data) {
    setActionMessage(`Step ${step} edit saved.`, true);
    openDetail(currentSequenceId);
  }
}

async function regenerateStep(step, card) {
  const note = card.querySelector(".email-regen-note").value;
  const data = await postJson(`/api/sequences/${currentSequenceId}/emails/${step}/regenerate`, { note });
  if (data) {
    setActionMessage(`Step ${step} regenerated.`, true);
    openDetail(currentSequenceId);
  }
}

async function saveLinkedInEdit(position, card) {
  const body = card.querySelector(".linkedin-body-input").value;
  const data = await postJson(`/api/sequences/${currentSequenceId}/linkedin/${position}/edit`, { body });
  if (data) {
    setActionMessage(`LinkedIn message ${position} edit saved.`, true);
    openDetail(currentSequenceId);
  }
}

async function regenerateLinkedInMessage(position, card) {
  const note = card.querySelector(".linkedin-regen-note").value;
  const data = await postJson(`/api/sequences/${currentSequenceId}/linkedin/${position}/regenerate`, { note });
  if (data) {
    setActionMessage(`LinkedIn message ${position} regenerated.`, true);
    openDetail(currentSequenceId);
  }
}

document.getElementById("coldCallSaveBtn").addEventListener("click", async () => {
  const beat1 = document.getElementById("coldCallBeat1").value;
  const beat2 = document.getElementById("coldCallBeat2").value;
  const beat3 = document.getElementById("coldCallBeat3").value;
  const data = await postJson(`/api/sequences/${currentSequenceId}/coldcall/edit`, { beat1, beat2, beat3 });
  if (data) {
    setActionMessage("Cold call opener edit saved.", true);
    openDetail(currentSequenceId);
  }
});

document.getElementById("coldCallRegenBtn").addEventListener("click", async () => {
  const note = document.getElementById("coldCallRegenNote").value;
  const data = await postJson(`/api/sequences/${currentSequenceId}/coldcall/regenerate`, { note });
  if (data) {
    setActionMessage("Cold call opener regenerated.", true);
    openDetail(currentSequenceId);
  }
});

document.getElementById("approveSequenceBtn").addEventListener("click", async () => {
  const data = await postJson(`/api/sequences/${currentSequenceId}/approve`, {});
  if (data) {
    setActionMessage("Sequence approved and exported.", true);
    openDetail(currentSequenceId);
  }
});

document.getElementById("regenerateSequenceBtn").addEventListener("click", async () => {
  const note = document.getElementById("regenSequenceNote").value;
  const data = await postJson(`/api/sequences/${currentSequenceId}/regenerate`, { note });
  if (data && data.new_sequence) {
    setActionMessage("Whole sequence regenerated. Showing new sequence.", true);
    openDetail(data.new_sequence.id);
  }
});

document.getElementById("rejectSequenceBtn").addEventListener("click", async () => {
  const reason = document.getElementById("rejectReason").value;
  const data = await postJson(`/api/sequences/${currentSequenceId}/reject`, { reason });
  if (data) {
    setActionMessage("Sequence rejected.", true);
    openDetail(currentSequenceId);
  }
});

backBtn.addEventListener("click", () => {
  detailView.classList.add("hidden");
  queueView.classList.remove("hidden");
  loadQueue();
});

statusFilter.addEventListener("change", loadQueue);
refreshBtn.addEventListener("click", loadQueue);

// --- Raw signals tab ---
//
// A second, independent queue: pre-enrichment signal hits (e.g. from the
// Companies House scraper) with a rule-based score, awaiting a human call
// on whether to send them to Clay for contact-find/enrich. See
// docs/raw-signal-pipeline.md for the full design.

const rawSignalsView = document.getElementById("rawSignalsView");
const rawSignalsBody = document.getElementById("rawSignalsBody");
const rawSignalsEmptyState = document.getElementById("rawSignalsEmptyState");
const rawSignalStatusFilter = document.getElementById("rawSignalStatusFilter");
const rawSignalRefreshBtn = document.getElementById("rawSignalRefreshBtn");
const tabSequencesBtn = document.getElementById("tabSequencesBtn");
const tabRawSignalsBtn = document.getElementById("tabRawSignalsBtn");
const sequenceFilters = document.getElementById("sequenceFilters");
const rawSignalFilters = document.getElementById("rawSignalFilters");

function showRawSignalError(message) {
  const el = document.getElementById("rawSignalError");
  if (!el) return;
  if (!message) {
    el.textContent = "";
    el.classList.add("hidden");
    return;
  }
  el.textContent = message;
  el.classList.remove("hidden");
}

function scorePillClass(score) {
  if (score >= 50) return "score-pill-high";
  if (score >= 25) return "score-pill-mid";
  return "score-pill-low";
}

async function loadRawSignals() {
  try {
    const status = rawSignalStatusFilter.value;
    const url = "/api/raw-signals" + (status ? `?status=${encodeURIComponent(status)}` : "");
    const res = await fetch(url);
    if (!res.ok) {
      let errMsg = `Failed to load raw signals (HTTP ${res.status})`;
      try {
        const errData = await res.json();
        if (errData && errData.error) errMsg = errData.error;
      } catch {
        // ignore parse failure
      }
      showRawSignalError(errMsg);
      return;
    }
    const data = await res.json();
    showRawSignalError(null);
    renderRawSignals(data.raw_signals || []);
  } catch (err) {
    showRawSignalError("Failed to load raw signals: " + (err && err.message ? err.message : "network error"));
  }
}

function renderRawSignals(rows) {
  rawSignalsBody.innerHTML = "";
  if (rows.length === 0) {
    rawSignalsEmptyState.classList.remove("hidden");
    return;
  }
  rawSignalsEmptyState.classList.add("hidden");

  for (const r of rows) {
    const tr = document.createElement("tr");
    const isDecided = r.status !== "new" && r.status !== "qualified";
    tr.innerHTML = `
      <td><span class="score-pill ${scorePillClass(r.score)}" title="${escapeHtml((r.score_reasons || []).join("; "))}">${r.score}</span></td>
      <td>${escapeHtml(r.company_name || "—")}</td>
      <td>${escapeHtml(r.signal_type || "—")}</td>
      <td>${escapeHtml(r.trigger_detail || "—")}</td>
      <td>${escapeHtml(fmtUkDate(r.trigger_date) || "—")}</td>
      <td>${escapeHtml(r.source || "—")}</td>
      <td><span class="badge badge-${r.status}">${r.status}</span></td>
      <td class="row-actions">
        <button class="qualify-btn" ${isDecided ? "disabled" : ""}>Qualify</button>
        <button class="dismiss-btn btn-reject" ${isDecided ? "disabled" : ""}>Dismiss</button>
      </td>
    `;
    tr.querySelector(".qualify-btn").addEventListener("click", async (e) => {
      e.stopPropagation();
      await postJson(`/api/raw-signals/${r.id}/qualify`, {});
      loadRawSignals();
    });
    tr.querySelector(".dismiss-btn").addEventListener("click", async (e) => {
      e.stopPropagation();
      const reason = window.prompt("Reason for dismissing (optional):") || undefined;
      await postJson(`/api/raw-signals/${r.id}/dismiss`, { notes: reason });
      loadRawSignals();
    });
    rawSignalsBody.appendChild(tr);
  }
}

function switchTab(tab) {
  const showRaw = tab === "raw";
  tabSequencesBtn.classList.toggle("active", !showRaw);
  tabRawSignalsBtn.classList.toggle("active", showRaw);
  sequenceFilters.classList.toggle("hidden", showRaw);
  rawSignalFilters.classList.toggle("hidden", !showRaw);
  detailView.classList.add("hidden");
  queueView.classList.toggle("hidden", showRaw);
  rawSignalsView.classList.toggle("hidden", !showRaw);
  if (showRaw) loadRawSignals();
  else loadQueue();
}

tabSequencesBtn.addEventListener("click", () => switchTab("sequences"));
tabRawSignalsBtn.addEventListener("click", () => switchTab("raw"));
rawSignalStatusFilter.addEventListener("change", loadRawSignals);
rawSignalRefreshBtn.addEventListener("click", loadRawSignals);

loadQueue();
