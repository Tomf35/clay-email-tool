import crypto from "crypto";
import { Request, Response, NextFunction } from "express";

// Minimal, single-shared-password HTTP Basic Auth for the review UI and the
// /api/sequences* routes. This is NOT per-user auth — every reviewer shares
// the same password (fine for Tom as sole reviewer today). If this tool ever
// grows beyond a single trusted operator, replace this with real per-user
// accounts (session cookies / API keys tied to a user record).
//
// Behavior:
// - If REVIEW_AUTH_PASSWORD is not set, this middleware is a no-op (local
//   dev without the env var works with zero friction, matching prior
//   behavior before auth existed).
// - If it is set, any request must present HTTP Basic Auth credentials with
//   any username and a password matching REVIEW_AUTH_PASSWORD, compared with
//   a timing-safe comparison to avoid leaking the password via a timing
//   side-channel.
//
// This must NOT be mounted in front of /api/ingest, /api/clay-writeback, or
// /health — those are called by Clay's webhook / the platform health
// checker (no browser, no login prompt) and use their own existing
// shared-secret/none mechanisms instead.
export function basicAuth(req: Request, res: Response, next: NextFunction) {
  const expectedPassword = process.env.REVIEW_AUTH_PASSWORD;

  // No password configured: auth is disabled entirely (local dev default).
  if (!expectedPassword) {
    return next();
  }

  const header = req.header("authorization") || req.header("Authorization");
  if (header && header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
    const separatorIndex = decoded.indexOf(":");
    if (separatorIndex !== -1) {
      const password = decoded.slice(separatorIndex + 1);
      if (timingSafeEqualStrings(password, expectedPassword)) {
        return next();
      }
    }
  }

  res.set("WWW-Authenticate", 'Basic realm="Clay email tool review UI"');
  return res.status(401).json({ error: "Authentication required." });
}

// Compares two strings in constant time relative to the length of the
// expected value, avoiding both a plain `===` timing side-channel and a
// crash from crypto.timingSafeEqual on mismatched buffer lengths.
function timingSafeEqualStrings(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) {
    // Still do a constant-time compare against a same-length buffer so the
    // length mismatch itself doesn't short-circuit instantly compared to the
    // matching-length path, then report false regardless of its result.
    crypto.timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}
