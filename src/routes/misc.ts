import { Router, Request, Response } from "express";

export const miscRouter = Router();

miscRouter.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// Mock endpoint simulating the real Clay/Salesloft writeback API.
// exportSequence() calls this today with a single payload containing the 4
// approved emails, the 4 approved LinkedIn messages (plus the always-blank
// connection request note), and the 3-beat cold call opener; swap this
// implementation for a real external call later without touching any of
// the approval routes.
miscRouter.post("/clay-writeback", (req: Request, res: Response) => {
  const body = req.body;
  const emailCount = Array.isArray(body?.emails) ? body.emails.length : 0;
  const linkedinCount = Array.isArray(body?.linkedin?.messages) ? body.linkedin.messages.length : 0;
  const hasColdCall = Boolean(
    body?.cold_call_opener?.beat1 || body?.cold_call_opener?.beat2 || body?.cold_call_opener?.beat3
  );
  console.log(
    `[clay-writeback] received payload for sequence ${body?.sequence_id} (${emailCount} email(s), ${linkedinCount} LinkedIn message(s), cold call opener present: ${hasColdCall}) that would be sent to Clay:`,
    JSON.stringify(req.body)
  );
  res.status(200).json({ received: true });
});
