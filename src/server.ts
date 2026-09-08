import dotenv from "dotenv";
dotenv.config();

import express from "express";
import path from "path";
import "./db"; // ensure schema is initialized on boot
import { ingestRouter } from "./routes/ingest";
import { sequencesRouter } from "./routes/sequences";
import { miscRouter } from "./routes/misc";
import { rawSignalIngestRouter, rawSignalsReviewRouter } from "./routes/rawSignals";
import { basicAuth } from "./lib/basicAuth";

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: "2mb" }));

// Auth seam: HTTP Basic Auth (single shared password via REVIEW_AUTH_PASSWORD)
// guards the review UI and /api/sequences*. It intentionally does NOT guard
// /api/ingest, /api/clay-writeback, or /health below, since those are called
// by Clay's webhook / the platform health checker, not a browser, and use
// their own existing shared-secret/none mechanisms. See lib/basicAuth.ts.
app.use("/api", ingestRouter);
app.use("/api", rawSignalIngestRouter);
app.use("/api", miscRouter);
app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.use("/api", basicAuth, sequencesRouter);
app.use("/api", basicAuth, rawSignalsReviewRouter);

app.use(basicAuth, express.static(path.join(__dirname, "..", "src", "public")));

// SPA fallback so /sequences/:id style deep links (if ever used) still load the UI.
app.get("*", basicAuth, (req, res, next) => {
  if (req.path.startsWith("/api")) return next();
  res.sendFile(path.join(__dirname, "..", "src", "public", "index.html"));
});

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("Unhandled error:", err);
  const status = err?.status || err?.statusCode || 500;
  const message = status === 500 ? "Internal server error" : err?.message || "Request error";
  res.status(status).json({ error: message });
});

app.listen(PORT, () => {
  console.log(`Clay email tool listening on http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn(
      "WARNING: ANTHROPIC_API_KEY is not set. Ingest will still accept rows but generation will fail gracefully and signals will be marked status=error."
    );
  }
  if (!process.env.INGEST_SECRET) {
    console.warn(
      "WARNING: INGEST_SECRET is not set. POST /api/ingest will reject all requests with a 500 until this is configured."
    );
  }
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception (server staying alive):", err);
});
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection (server staying alive):", err);
});
