import http from "http";
import https from "https";
import { URL } from "url";
import { LinkedinMessageRow, SequenceEmailRow, SequenceRow, SignalRow } from "../types";

/**
 * "Send to destination" step. Posts the whole approved sequence — the 4
 * emails, the 5 LinkedIn touches (connection note + 4 messages), and the
 * 3-beat cold call opener — as one FLAT JSON object (no nested
 * arrays/objects) to a Clay incoming webhook, since Clay's webhook column
 * auto-detection maps flat top-level keys to table columns and can't turn
 * a nested array into columns on its own.
 *
 * Destination is configurable via CLAY_WRITEBACK_URL so this can point at
 * a real Clay webhook in production while still defaulting to our own
 * mock /api/clay-writeback endpoint (same flat shape) when that env var
 * isn't set, e.g. in local dev.
 *
 * Never throws — a failed export is logged but must not crash or block
 * the approval flow, since the sequence has already been marked approved
 * in our own database by the time this runs.
 */
export async function exportSequence(
  sequence: SequenceRow,
  emails: SequenceEmailRow[],
  linkedinMessages: LinkedinMessageRow[],
  signal: SignalRow
): Promise<void> {
  const sortedEmails = emails.slice().sort((a, b) => a.step - b.step);
  const sortedLinkedIn = linkedinMessages.slice().sort((a, b) => a.position - b.position);

  let rawFields: Record<string, unknown> = {};
  try {
    rawFields = JSON.parse(signal.raw_payload);
  } catch {
    // ignore — fields below just fall back to null
  }

  const payloadObj: Record<string, unknown> = {
    sequence_id: sequence.id,
    signal_external_id: signal.external_id,
    contact_name: rawFields.contact_name ?? null,
    contact_email: rawFields.contact_email ?? null,
    company_name: rawFields.company_name ?? null,
    status: sequence.status,
  };

  for (const e of sortedEmails) {
    payloadObj[`email_${e.step}_send_day_offset`] = e.send_day_offset;
    payloadObj[`email_${e.step}_subject`] = e.final_subject ?? e.subject;
    payloadObj[`email_${e.step}_body`] = e.final_body ?? e.body;
  }

  payloadObj.linkedin_connection_note = "";
  sortedLinkedIn.forEach((m, i) => {
    payloadObj[`linkedin_message_${i + 1}`] = m.final_body ?? m.body;
  });

  payloadObj.cold_call_beat_1 = sequence.cold_call_final_beat1 ?? sequence.cold_call_beat1;
  payloadObj.cold_call_beat_2 = sequence.cold_call_final_beat2 ?? sequence.cold_call_beat2;
  payloadObj.cold_call_beat_3 = sequence.cold_call_final_beat3 ?? sequence.cold_call_beat3;

  const payload = JSON.stringify(payloadObj);
  const destination = process.env.CLAY_WRITEBACK_URL;

  await new Promise<void>((resolve) => {
    const onDone = () => resolve();
    const onError = (err: Error) => {
      console.error("exportSequence: writeback call failed:", err.message);
      resolve(); // Never let export failure crash the approval flow.
    };

    if (destination) {
      let url: URL;
      try {
        url = new URL(destination);
      } catch (err) {
        onError(err as Error);
        return;
      }
      const req = https.request(
        {
          hostname: url.hostname,
          port: url.port || 443,
          path: url.pathname + url.search,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
          },
        },
        (res) => {
          res.on("data", () => {});
          res.on("end", onDone);
        }
      );
      req.on("error", onError);
      req.write(payload);
      req.end();
    } else {
      const port = process.env.PORT || "3000";
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
          res.on("end", onDone);
        }
      );
      req.on("error", onError);
      req.write(payload);
      req.end();
    }
  });
}
