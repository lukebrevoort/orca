import { isAbsolute } from "node:path";
import { z } from "zod";
import { mailSearchLimits, mailSearchPageSchema } from "@orca/shared/mail-search";
import { inboxClassificationResponseSchema, inboxMessageSchema, inboxQuerySchema, mailProviderSchema } from "@orca/shared/schemas";

/** Private stdin/stdout protocol, never an HTTP or MCP request schema. Authority,
 * mode and cursor key are supplied by the server and never accepted from users. */
export const rankedSearchProtocolVersion = 1 as const;
export const rankedSearchProcessLimits = Object.freeze({
  maxActive: 1,
  maxQueued: 8,
  maxQueuedPerUser: 1,
  deadlineMs: 2_000,
  queueWaitMs: 1_000,
  maxRequestBytes: 64 * 1024,
  maxStdoutBytes: 2 * 1024 * 1024,
});

const identifier = z.string().min(1).max(1_024).refine(value => !value.includes("\0"));
const nonnegativeNumber = z.number().finite().nonnegative();
const nonnegativeInteger = nonnegativeNumber.int().max(Number.MAX_SAFE_INTEGER);
export const rankedSearchWorkerRequestSchema = z.object({
  version: z.literal(rankedSearchProtocolVersion),
  databasePath: z.string().max(4_096).refine(value => isAbsolute(value) && !value.includes("\0")),
  authorization: z.object({ userId: identifier, accountIds: z.array(identifier).max(1_000).optional() }).strict(),
  mode: z.enum(["metadata", "full"]),
  expectedEpoch: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  // Private pipe only: never argv, environment, metrics, logs, or a reply.
  cursorKey: z.string().min(1).max(4_096),
  exactCounts: z.boolean().optional(),
  query: inboxQuerySchema.omit({ accountId: true }).extend({
    query: z.string().min(1).max(mailSearchLimits.inputCharacters),
    cursor: z.string().min(1).max(2_048).optional(),
    senderAddress: z.string().trim().min(1).max(320).optional(),
    attentionBehavior: z.enum(["notify", "focus", "normal", "quiet", "hidden"]).optional(),
    collectionId: identifier.optional(),
    destinationId: identifier.optional(),
    limit: z.number().int().min(1).max(100),
    receivedAfter: z.iso.datetime({ offset: true }).optional(),
    receivedBefore: z.iso.datetime({ offset: true }).optional(),
  }).strict(),
}).strict().superRefine((request, context) => {
  if (request.exactCounts && request.mode !== "metadata") {
    context.addIssue({ code: "custom", path: ["exactCounts"], message: "Exact counts require metadata mode" });
  }
  if (request.query.limit > mailSearchLimits.maxPageSize && !(request.mode === "metadata" && request.exactCounts)) {
    context.addIssue({ code: "custom", path: ["query", "limit"], message: "Ranked search page exceeds its limit" });
  }
});
export type RankedSearchWorkerRequest = z.infer<typeof rankedSearchWorkerRequestSchema>;

export const rankedSearchWorkerErrorCodeSchema = z.enum([
  "search_invalid_query", "search_anchor_required", "no_accounts",
  "search_not_activated", "search_mode_changed",
  "search_index_updating", "search_index_blocked", "search_index_unavailable",
  "search_cursor_stale", "search_invalid_cursor", "search_busy", "search_aborted",
  "search_budget_exceeded", "search_failed",
]);
export type RankedSearchWorkerErrorCode = z.infer<typeof rankedSearchWorkerErrorCodeSchema>;

// The legacy metadata/count adapter can return 100 messages. This private schema
// does not widen the public ranked-search schema's 50-message limit.
const privatePageSchema = mailSearchPageSchema.safeExtend({
  accounts: mailSearchPageSchema.shape.accounts.max(1_000),
  messages: z.array(inboxMessageSchema).max(100),
  snapshot: z.string().min(1).max(256),
});
export const rankedSearchWorkerResultSchema = z.object({
  page: privatePageSchema,
  counts: inboxClassificationResponseSchema.shape.counts.optional(),
  freshness: inboxClassificationResponseSchema.shape.freshness.unwrap(),
  capabilityAccounts: z.array(z.object({
    id: identifier, provider: mailProviderSchema, scope: z.string().max(16_384).nullable(),
  }).strict()).max(1_000),
  metric: z.object({
    durationMs: nonnegativeNumber,
    candidateRows: nonnegativeInteger,
    indexBatches: nonnegativeInteger,
    shortBodyBytes: nonnegativeInteger,
    projectedMessages: nonnegativeInteger.max(100),
  }).strict(),
}).strict().superRefine((result, context) => {
  if (result.counts && result.page.coverage !== "stored-metadata") {
    context.addIssue({ code: "custom", path: ["counts"], message: "Exact counts require metadata coverage" });
  }
  if (!result.counts && result.page.messages.length > mailSearchLimits.maxPageSize) {
    context.addIssue({ code: "custom", path: ["page", "messages"], message: "Ranked search page exceeds its limit" });
  }
  if (result.metric.projectedMessages !== result.page.messages.length) {
    context.addIssue({ code: "custom", path: ["metric"], message: "Projection count does not match the page" });
  }
});
export const rankedSearchWorkerReplySchema = z.discriminatedUnion("ok", [
  z.object({
    version: z.literal(rankedSearchProtocolVersion), ok: z.literal(true),
    result: rankedSearchWorkerResultSchema, peakRssBytes: nonnegativeInteger.nullable(),
  }).strict(),
  z.object({
    version: z.literal(rankedSearchProtocolVersion), ok: z.literal(false),
    code: rankedSearchWorkerErrorCodeSchema, peakRssBytes: nonnegativeInteger.nullable(),
  }).strict(),
]);
export type RankedSearchWorkerReply = z.infer<typeof rankedSearchWorkerReplySchema>;
