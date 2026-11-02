import { and, count, desc, eq, lte, isNull } from "drizzle-orm";
import type { Hono, MiddlewareHandler } from "hono";
import { feedbackQueueSubmissionSchema, type FeedbackQueueItem } from "@orca/shared";
import type { FeedbackReport } from "@feedback-kit/core";
import { requireAuth, type AuthVariables } from "./auth/middleware.ts";
import { createDatabaseClient } from "./db/client.ts";
import { feedbackQueue } from "./db/schema.ts";
import { readBoundedRequestBody } from "./request-body.ts";
import { createLinearFeedbackSubmitter } from "./integrations/linear.ts";

type Row = typeof feedbackQueue.$inferSelect;
export type FeedbackQueueDelivery = (report: FeedbackReport, options: { issueId: string }) => Promise<{ identifier: string; url: string }>;
export const feedbackQueueLimit = 1_000;
const retryCooldownMs = 30_000;
const leaseMs = 60_000;

function item(row: Row): FeedbackQueueItem {
  return { id: row.id, title: row.title, description: row.description, kind: row.kind,
    platform: row.platform, route: row.route, createdAt: row.createdAt,
    status: row.identifier ? "delivered" : "queued", identifier: row.identifier,
    url: row.url, deliveryError: row.deliveryError };
}
function report(row: Row): FeedbackReport {
  return { schemaVersion: 1, id: row.issueId, project: { id: "orca", name: "Orca" },
    kind: row.kind, severity: "normal", title: row.title, description: row.description,
    context: { route: row.route, url: row.route, title: "Orca", userAgent: row.platform,
      viewport: { width: 0, height: 0, pixelRatio: 1 }, locale: "", timezone: "", capturedAt: row.createdAt },
    elements: [], attachments: [], metadata: { platform: row.platform } };
}

export function registerFeedbackQueueRoutes(app: Hono<{ Variables: AuthVariables }>, options: {
  dbFactory?: typeof createDatabaseClient;
  allowedOrigin: string;
  deliver?: FeedbackQueueDelivery | null;
  now?: () => number;
}) {
  const dbFactory = options.dbFactory ?? createDatabaseClient;
  const deliver = options.deliver === undefined ? createLinearFeedbackSubmitter() : options.deliver;
  const now = options.now ?? Date.now;
  const path = "/v1/feedback/queue";
  const auth = requireAuth({ dbFactory });
  app.use(path, auth);
  app.use(`${path}/*`, auth);
  const originGuard: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (c.req.method !== "GET" && c.req.method !== "OPTIONS") {
      const origin = c.req.header("origin");
      // Native callers authenticate with a bearer, web mutations require Origin.
      if (origin ? origin !== options.allowedOrigin : !c.req.header("authorization")) {
        return c.json({ error: { code: "invalid_origin", message: "Feedback must come from Orca." } }, 403);
      }
    }
    await next();
  };
  app.use(path, originGuard);
  app.use(`${path}/*`, originGuard);
  const condition = (userId: string, id: string) => and(eq(feedbackQueue.userId, userId), eq(feedbackQueue.id, id));
  async function attempt(userId: string, id: string) {
    const { db, sqlite } = dbFactory();
    try {
      if (!deliver) return;
      const started = now();
      const claimed = db.update(feedbackQueue).set({ leaseUntil: started + leaseMs, lastAttemptAt: started })
        .where(and(condition(userId, id), isNull(feedbackQueue.identifier), lte(feedbackQueue.leaseUntil, started), lte(feedbackQueue.lastAttemptAt, started - retryCooldownMs)))
        .returning().get();
      if (!claimed) return;
      try {
        const result = await deliver(report(claimed), { issueId: claimed.issueId });
        // No provider error bodies or credentials are persisted or exposed.
        if (!/^https:\/\/linear\.app\//.test(result.url) || !result.identifier) throw new Error("Invalid delivery receipt");
        db.update(feedbackQueue).set({ identifier: result.identifier, url: result.url, deliveryError: null, leaseUntil: 0 })
          .where(and(condition(userId, id), eq(feedbackQueue.lastAttemptAt, started))).run();
      } catch {
        db.update(feedbackQueue).set({ deliveryError: "Saved in Orca. Linear delivery failed; retry in a moment.", leaseUntil: 0 })
          .where(and(condition(userId, id), eq(feedbackQueue.lastAttemptAt, started))).run();
      }
    } finally { sqlite.close(); }
  }
  function read(userId: string, id: string) {
    const { db, sqlite } = dbFactory();
    try { return db.select().from(feedbackQueue).where(condition(userId, id)).get(); }
    finally { sqlite.close(); }
  }
  app.get(path, (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const rows = db.select().from(feedbackQueue).where(eq(feedbackQueue.userId, c.get("auth").userId))
        .orderBy(desc(feedbackQueue.createdAt), desc(feedbackQueue.id)).limit(100).all();
      return c.json({ items: rows.map(item), deliveryAvailable: Boolean(deliver) });
    } finally { sqlite.close(); }
  });
  app.post(path, async (c) => {
    const bytes = await readBoundedRequestBody(c.req.raw, 64 * 1024);
    if (!bytes) return c.json({ error: { code: "payload_too_large", message: "Feedback is too large." } }, 413);
    let body: unknown;
    try { body = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { return c.json({ error: { code: "invalid_feedback", message: "Feedback must be valid JSON." } }, 400); }
    const parsed = feedbackQueueSubmissionSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: { code: "invalid_feedback", message: "Check the feedback fields and try again." } }, 400);
    const input = parsed.data;
    const userId = c.get("auth").userId;
    const { db, sqlite } = dbFactory();
    let outcome: "new" | "existing" | "conflict" | "full";
    try {
      outcome = db.transaction((tx) => {
        const existing = tx.select().from(feedbackQueue).where(condition(userId, input.id)).get();
        if (existing) {
          return ["title", "description", "kind", "platform", "route"].every((key) => existing[key as keyof Row] === input[key as keyof typeof input]) ? "existing" : "conflict";
        }
        const total = tx.select({ total: count() }).from(feedbackQueue).where(eq(feedbackQueue.userId, userId)).get()!.total;
        if (total >= feedbackQueueLimit) return "full";
        tx.insert(feedbackQueue).values({ ...input, userId, issueId: crypto.randomUUID(), createdAt: new Date(now()).toISOString() }).run();
        return "new";
      });
    } finally { sqlite.close(); }
    if (outcome === "conflict") return c.json({ error: { code: "feedback_conflict", message: "This submission ID already belongs to different feedback." } }, 409);
    if (outcome === "full") return c.json({ error: { code: "feedback_limit", message: "Your feedback queue is full. Please contact support." } }, 429);
    if (outcome === "new") await attempt(userId, input.id);
    const row = read(userId, input.id);
    if (!row) return c.json({ error: { code: "not_found", message: "Feedback is no longer available." } }, 404);
    return c.json({ item: item(row), deliveryAvailable: Boolean(deliver) }, outcome === "new" ? 201 : 200);
  });
  app.post(`${path}/:id/retry`, async (c) => {
    const userId = c.get("auth").userId;
    const id = c.req.param("id");
    if (!read(userId, id)) return c.json({ error: { code: "not_found", message: "Feedback not found." } }, 404);
    await attempt(userId, id);
    const row = read(userId, id);
    if (!row) return c.json({ error: { code: "not_found", message: "Feedback is no longer available." } }, 404);
    return c.json({ item: item(row), deliveryAvailable: Boolean(deliver) });
  });
}
