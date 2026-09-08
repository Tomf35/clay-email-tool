import http from "http";
import { LinkedinMessageRow, SequenceEmailRow, SequenceRow, SignalRow } from "../types";

/**
 * Stubbed "send to destination" step. In production this would call the
 * real Clay/Salesloft write-back API. For this build it POSTs the whole
 * approved sequence — the 4 emails, the 4 LinkedIn messages, and the
 * 3-beat cold call opener — in one call, to our own mock
 * /api/clay-writeback endpoint so the interface is exercised end-to-end
 * and can be swapped for a real integration later without touching
 * callers of exportSequence(). Real downstream integration is still a
 * stub, but no channel's content is silently dropped on the way out.
 */
export async function exportSequence(
  sequence: SequenceRow,
  emails: SequenceEmailRow[],
  linkedinMessages: LinkedinMessageRow[],
  signal: SignalRow
): Promise<void> {
  const port = process.env.PORT || "3000";
  const payload = JSON.stringify({
    sequence_id: sequence.id,
    signal_external_id: signal.external_id,
    status: sequence.status,
    emails: emails
      .slice()
      .sort((a, b) => a.step - b.step)
      .map((e) => ({
        step: e.step,
        send_day_offset: e.send_day_offset,
        subject: e.final_subject ?? e.subject,
        body: e.final_body ?? e.body,
        lavender_score: e.lavender_score,
        lavender_grade: e.lavender_grade,
      })),
    linkedin: {
      connection_request: {
        note: "",
        send_day_offset: 1,
      },
      messages: linkedinMessages
        .slice()
        .sort((a, b) => a.position - b.position)
        .map((m) => ({
          position: m.position,
          day_offset_label: m.day_offset_label,
          label: m.label,
          body: m.final_body ?? m.body,
        })),
    },
    cold_call_opener: {
      beat1: sequence.cold_call_final_beat1 ?? sequence.cold_call_beat1,
      beat2: sequence.cold_call_final_beat2 ?? sequence.cold_call_beat2,
      beat3: sequence.cold_call_final_beat3 ?? sequence.cold_call_beat3,
    },
  });

  await new Promise<void>((resolve) => {
    const req = http.request(
      {
        hostname: "localhost",
        port: Number(port),
        path: "/api/clay-writeback",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => resolve());
      }
    );
    req.on("error", (err) => {
      console.error("exportSequence: writeback call failed:", err.message);
      resolve(); // Never let export failure crash the approval flow.
    });
    req.write(payload);
    req.end();
  });
}
