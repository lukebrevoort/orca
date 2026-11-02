import { createHash } from "node:crypto";
import type { Hono, MiddlewareHandler } from "hono";
import { feedbackTicketSubmissionSchema, type FeedbackTicketSubmission, type FeedbackTicketReceipt } from "@orca/shared";
import type { FeedbackReport } from "@feedback-kit/core";
import { requireAuth, type AuthVariables } from "./auth/middleware.ts";
import { createDatabaseClient } from "./db/client.ts";
import { readBoundedRequestBody } from "./request-body.ts";
import { createLinearFeedbackSubmitter } from "./integrations/linear.ts";

export type FeedbackTicketDelivery = (report: FeedbackReport, options: { issueId: string }) => Promise<FeedbackTicketReceipt>;

// Linear is the durable record. Exact retries derive the same opaque UUID even
// after a process restart or session-key rotation. Including normalized content
// prevents changed feedback from acknowledging an earlier, different report.
// The client request UUID supplies random entropy; set v4/variant bits to match
// Linear IssueCreateInput.id, which documents a UUIDv4.
export function feedbackTicketId(userId: string, input: FeedbackTicketSubmission): string {
  const bytes = createHash("sha256").update(JSON.stringify(["orca-feedback-ticket-v1", userId, input.id, input.message, input.platform])).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function report(input: FeedbackTicketSubmission, issueId: string): FeedbackReport {
  return { schemaVersion: 1, id: issueId, project: { id: "orca", name: "Orca" },
    kind: "other", severity: "normal", title: input.message.split(/\r?\n/, 1)[0]!.slice(0, 100), description: input.message,
    context: { route: "/feedback", url: "/feedback", title: "Orca", userAgent: input.platform,
      viewport: { width: 0, height: 0, pixelRatio: 1 }, locale: "", timezone: "", capturedAt: new Date().toISOString() },
    elements: [], attachments: [], metadata: { platform: input.platform } };
}
function validReceipt(receipt: FeedbackTicketReceipt): boolean {
  try {
    const url = new URL(receipt.url);
    return typeof receipt.identifier === "string" && receipt.identifier.length > 0 && receipt.identifier.length <= 100
      && url.protocol === "https:" && url.hostname === "linear.app" && !url.username && !url.password;
  } catch { return false; }
}

export function registerFeedbackTicketRoutes(app: Hono<{ Variables: AuthVariables }>, options: {
  dbFactory?: typeof createDatabaseClient;
  allowedOrigin: string;
  deliver?: FeedbackTicketDelivery | null;
  ownerUserId?: string;
}) {
  const dbFactory = options.dbFactory ?? createDatabaseClient;
  const deliver = options.deliver === undefined ? createLinearFeedbackSubmitter() : options.deliver;
  // One configured personal workspace is not a per-user Linear integration.
  // Require an explicit Orca identity; never use the first user or Linear ID.
  const ownerUserId = (options.ownerUserId ?? process.env.LINEAR_FEEDBACK_OWNER_USER_ID)?.trim();
  const path = "/v1/feedback/ticket";
  const inFlight = new Map<string, Promise<FeedbackTicketReceipt>>();
  app.use(path, requireAuth({ dbFactory }));
  const originGuard: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (c.req.method === "POST") {
      const origin = c.req.header("origin");
      if (origin ? origin !== options.allowedOrigin : !c.req.header("authorization")) {
        return c.json({ error: { code: "invalid_origin", message: "Feedback must come from Orca." } }, 403);
      }
    }
    await next();
  };
  app.use(path, originGuard);
  app.get(path, (c) => c.json({ available: Boolean(ownerUserId && ownerUserId === c.get("auth").userId && deliver) }));
  app.post(path, async (c) => {
    const userId = c.get("auth").userId;
    if (!ownerUserId || ownerUserId !== userId) return c.json({ error: { code: "feedback_unavailable", message: "Linear feedback is not connected for this account." } }, 403);
    if (!deliver) return c.json({ error: { code: "feedback_unavailable", message: "Linear feedback is not connected yet. Your message has not been sent." } }, 503);
    const bytes = await readBoundedRequestBody(c.req.raw, 64 * 1024);
    if (!bytes) return c.json({ error: { code: "payload_too_large", message: "Feedback is too large." } }, 413);
    let body: unknown;
    try { body = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { return c.json({ error: { code: "invalid_feedback", message: "Feedback must be valid JSON." } }, 400); }
    const parsed = feedbackTicketSubmissionSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: { code: "invalid_feedback", message: "Write a message of up to 10,000 characters and try again." } }, 400);
    const issueId = feedbackTicketId(userId, parsed.data);
    let pending = inFlight.get(issueId);
    if (!pending) {
      if (inFlight.size >= 4) return c.json({ error: { code: "feedback_busy", message: "Feedback is busy. Please retry in a moment." } }, 429);
      pending = Promise.resolve().then(() => deliver(report(parsed.data, issueId), { issueId }));
      inFlight.set(issueId, pending);
    }
    try {
      const receipt = await pending;
      if (!validReceipt(receipt)) throw new Error("Invalid Linear receipt");
      return c.json({ identifier: receipt.identifier, url: receipt.url }, 201);
    } catch {
      // A timeout may follow a successful create. Keep the same request payload
      // on retry so Linear can confirm the existing issue without duplication.
      return c.json({ error: { code: "feedback_delivery_failed", message: "Could not confirm your Linear ticket. Keep this message and retry." } }, 502);
    } finally {
      if (inFlight.get(issueId) === pending) inFlight.delete(issueId);
    }
  });
}
