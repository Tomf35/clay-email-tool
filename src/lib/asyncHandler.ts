import { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Wraps an async Express route handler so that any rejected promise
 * (including one caused by a thrown synchronous error inside the async
 * function) is forwarded to `next(err)` instead of being silently dropped.
 *
 * Express 4 does not catch exceptions thrown inside async handlers — a
 * rejected promise from an async route handler just becomes an unhandled
 * rejection and the request is left open forever (see
 * process.on("unhandledRejection") in server.ts). Wrapping every async
 * handler with this utility routes those errors into the existing global
 * error-handling middleware in server.ts, which always sends a clean JSON
 * error response.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
