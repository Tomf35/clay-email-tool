import { Router, Request, Response } from "express";
import * as repo from "../db/repository";
import { asyncHandler } from "../lib/asyncHandler";
import { QUALIFY_THRESHOLD, scoreRawSignal } from "../lib/rawSignalScoring";
import { RawSignalStatus } from "../types";

// Split into two routers (mirroring ingestRouter vs sequencesRouter in
// server.ts) so the ingest endpoint can be mounted WITHOUT basicAuth (it's
// called by scripts with their own shared-secret, not a browser) while the
// review-facing routes stay behind basicAuth like /api/sequences.

export const rawSignalIngestRouter = Router();
export const rawSignalsReviewRouter = Router();

// --- Ingest (shared-secret gated) ---
//
// Accepts a raw, pre-enrichment signal hit (e.g. from
// scripts/signal-sources/companies-house-funding.ts), scores it with the
// rule-based scorer, and stores it in the raw_signals queue. This is
// intentionally a SEPARATE endpoint/table from /api/ingest + signals: those
// are for signals that already have a resolved contact and are ready for
// email/LinkedIn/cold-call generation. This one is for cheaper/free signal
// hits that haven't been enriched yet and may not even resolve to a real
// contact — see docs/raw-signal-pipeline.md for the full pipeline design.
rawSignalIngestRouter.post(
  "/raw-signals/ingest",
  asyncHandler(async (req: Request, res: Response) => {
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

    const externalId = body.external_id as string;
    if (!externalId || typeof externalId !== "string") {
      return res.status(400).json({ error: "Missing required field: external_id" });
    }

    const { score, reasons } = scoreRawSignal({
      signal_type: body.signal_type,
      trigger_date: body.trigger_date,
      contact_name: body.contact_name,
      trigger_source_url: body.trigger_source_url,
      headcount: body.headcount,
    });
    const status: RawSignalStatus = score >= QUALIFY_THRESHOLD ? "qualified" : "new";

    const row = repo.upsertRawSignal({
      externalId,
      source: (body.source as string) || "unknown",
      rawPayload: body,
      companyName: body.company_name,
      signalType: body.signal_type,
      triggerDetail: body.trigger_detail,
      triggerDate: body.trigger_date,
      score,
      scoreReasons: reasons,
      status,
    });

    return res.status(200).json({
      raw_signal: { id: row.id, external_id: row.external_id, score: row.score, status: row.status },
    });
  })
);

// --- Review-UI-facing routes (mounted behind basicAuth in server.ts, same
// as /api/sequences) ---

function serializeRawSignal(row: NonNullable<ReturnType<typeof repo.getRawSignalById>>) {
  return {
    ...row,
    raw_payload: JSON.parse(row.raw_payload),
    score_reasons: JSON.parse(row.score_reasons),
  };
}

rawSignalsReviewRouter.get(
  "/raw-signals",
  asyncHandler(async (req: Request, res: Response) => {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const minScore = req.query.min_score ? Number(req.query.min_score) : undefined;
    const rows = repo.listRawSignals({ status, minScore });
    res.json({ raw_signals: rows.map(serializeRawSignal) });
  })
);

rawSignalsReviewRouter.get(
  "/raw-signals/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const row = repo.getRawSignalById(Number(req.params.id));
    if (!row) return res.status(404).json({ error: "Raw signal not found" });
    res.json({ raw_signal: serializeRawSignal(row) });
  })
);

rawSignalsReviewRouter.post(
  "/raw-signals/:id/qualify",
  asyncHandler(async (req: Request, res: Response) => {
    const row = repo.getRawSignalById(Number(req.params.id));
    if (!row) return res.status(404).json({ error: "Raw signal not found" });
    repo.setRawSignalStatus(row.id, "qualified", req.body?.notes);
    res.json({ raw_signal: serializeRawSignal(repo.getRawSignalById(row.id)!) });
  })
);

rawSignalsReviewRouter.post(
  "/raw-signals/:id/dismiss",
  asyncHandler(async (req: Request, res: Response) => {
    const row = repo.getRawSignalById(Number(req.params.id));
    if (!row) return res.status(404).json({ error: "Raw signal not found" });
    repo.setRawSignalStatus(row.id, "dismissed", req.body?.notes);
    res.json({ raw_signal: serializeRawSignal(repo.getRawSignalById(row.id)!) });
  })
);
