import { Router, Request, Response } from "express";
import { normalizeSignal } from "../lib/normalize";
import * as repo from "../db/repository";
import { runGenerationForSignal } from "../lib/generationRunner";
import { asyncHandler } from "../lib/asyncHandler";

export const ingestRouter = Router();

// Auth: this route is intentionally NOT behind the review UI's HTTP Basic
// Auth (see lib/basicAuth.ts / server.ts) since Clay's webhook calls it
// directly with no browser. The shared X-Webhook-Secret header below is the
// only gate. If this tool ever grows beyond a single trusted operator, add
// real per-caller auth (e.g. per-integration API keys tied to a record).
ingestRouter.post("/ingest", asyncHandler(async (req: Request, res: Response) => {
  const secret = req.header("X-Webhook-Secret");
  const expected = process.env.INGEST_SECRET;

  if (!expected) {
    return res.status(500).json({
      error: "Server misconfigured: INGEST_SECRET is not set.",
    });
  }
  if (!secret || secret !== expected) {
    return res.status(401).json({ error: "Invalid or missing X-Webhook-Secret header." });
  }

  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return res.status(400).json({ error: "Request body must be a JSON object." });
  }

  let signal;
  try {
    signal = normalizeSignal(body);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }

  const signalRow = repo.upsertSignal(signal.external_id, body);

  const result = await runGenerationForSignal(signalRow, signal);

  return res.status(200).json({
    signal: {
      id: signalRow.id,
      external_id: signalRow.external_id,
      status: result.ok ? "generated" : "error",
    },
    sequence: result.ok
      ? { id: result.sequenceId, status: "pending_review" }
      : null,
    error: result.ok ? undefined : result.error,
  });
}));
