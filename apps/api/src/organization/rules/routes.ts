import type { Hono, MiddlewareHandler } from "hono";
import { orcaLanguageTextLimits } from "@orca/shared";
import { eq } from "drizzle-orm";

import type { AuthVariables } from "../../auth/middleware.ts";
import { requireAuth } from "../../auth/middleware.ts";
import { createDatabaseClient } from "../../db/client.ts";
import { oauthAccounts } from "../../db/schema.ts";
import { getLatestOrcaEvaluationTrace } from "./evaluation-sqlite.ts";
import {
  RuleAuthorityError,
  RuleIdempotencyConflictError,
  RuleRevisionConflictError,
  RuleRevisionCursorError,
  RuleRevisionCursorStaleError,
  RuleSetRevisionConflictError,
  RuleOrderValidationError,
  WorkspaceSchemaConflictError,
  createRuleRevisionService,
} from "./service.ts";
import { createSqliteRuleRevisionRepository } from "./sqlite-repository.ts";

type OrganizationApp = Hono<{ Variables: AuthVariables }>;

const maximumJsonEscapeBytesPerCodeUnit = 6;
const maximumCompileEnvelopeWithoutStringValues = new TextEncoder().encode(JSON.stringify({
  ruleId: "",
  idempotencyKey: "",
  expectedRuleRevision: Number.MAX_SAFE_INTEGER,
  workspaceSchemaRevision: Number.MAX_SAFE_INTEGER,
  source: "",
})).byteLength;

/**
 * Maximum compact JSON serialization of the shared compile request: JSON may
 * escape every permitted string code unit as `\uXXXX` (6 wire bytes). The
 * fixed portion includes every field, maximum safe-integer revisions, quotes,
 * separators, and property names. Whitespace and unknown fields remain bounded
 * transport overhead and are rejected once they exceed this valid envelope.
 */
export const RULE_COMPILE_BODY_LIMIT_BYTES = maximumCompileEnvelopeWithoutStringValues
  + maximumJsonEscapeBytesPerCodeUnit * (
    orcaLanguageTextLimits.maximumSourceCodeUnits
    + 2 * orcaLanguageTextLimits.maximumIdentifierCodeUnits
  );

const ruleCompileBodyLimit: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
  const request = c.req.raw;
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength) && BigInt(declaredLength) > BigInt(RULE_COMPILE_BODY_LIMIT_BYTES)) {
    return c.json({ error: { code: "payload_too_large", message: "Rule compile request exceeds the bounded JSON envelope" } }, 413);
  }
  if (!request.body) return next();

  let actualLength = 0;
  const chunks: Uint8Array[] = [];
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    actualLength += value.byteLength;
    if (actualLength > RULE_COMPILE_BODY_LIMIT_BYTES) {
      await reader.cancel().catch(() => undefined);
      return c.json({ error: { code: "payload_too_large", message: "Rule compile request exceeds the bounded JSON envelope" } }, 413);
    }
    chunks.push(value);
  }
  c.req.raw = new Request(request, {
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    duplex: "half",
  } as RequestInit);
  return next();
};

export function registerOrganizationRuleRoutes(app: OrganizationApp, options: { dbFactory?: typeof createDatabaseClient } = {}) {
  const dbFactory = options.dbFactory ?? createDatabaseClient;

  app.post("/v1/organization/rules/compile", requireAuth({ dbFactory }), ruleCompileBodyLimit, async (c) => {
    const client = dbFactory();
    try {
      let request: unknown;
      try { request = await c.req.json(); } catch { return c.json({ error: { code: "validation_error", message: "Compile requires a valid JSON request" } }, 400); }
      try {
        const service = createRuleRevisionService(createSqliteRuleRevisionRepository(client.db));
        const result = service.compile({ actor: { id: c.get("auth").userId, type: "human" }, workspaceId: c.get("auth").userId, request });
        if (!result.ok) return c.json(result, 422);
        return c.json(result, result.revision.revision === 1 ? 201 : 200);
      } catch (error) {
        if (error instanceof WorkspaceSchemaConflictError) return c.json({ error: { code: error.code, message: error.message, expectedRevision: error.expectedRevision, actualRevision: error.actualRevision } }, 409);
        if (error instanceof RuleIdempotencyConflictError) return c.json({ error: { code: error.code, message: error.message } }, 409);
        if (error instanceof RuleAuthorityError) {
          const status = error.code === "revision_conflict" || error.code === "duplicate_idempotency_key" ? 409
            : error.code === "invalid_request" || error.code === "idempotency_key_required" || error.code === "expected_revision_required" ? 400 : 403;
          return c.json({ error: { code: error.code, message: error.message } }, status);
        }
        if (error instanceof RuleRevisionConflictError) return c.json({ error: { code: error.code, message: error.message, expectedRevision: error.expectedRevision, actualRevision: error.actualRevision } }, error.actualRevision === null ? 404 : 409);
        if (error instanceof Error && error.name === "ZodError") return c.json({ error: { code: "validation_error", message: "Invalid Rule compile request", issues: "issues" in error ? error.issues : [] } }, 400);
        throw error;
      }
    } finally { client.sqlite.close(); }
  });

  app.post("/v1/organization/rules/reorder", requireAuth({ dbFactory }), async (c) => {
    const client = dbFactory();
    try {
      let request: unknown;
      try { request = await c.req.json(); } catch { return c.json({ error: { code: "validation_error", message: "Rule reorder requires a valid JSON request" } }, 400); }
      try {
        return c.json(createRuleRevisionService(createSqliteRuleRevisionRepository(client.db)).reorder({
          actor: { id: c.get("auth").userId, type: "human" }, workspaceId: c.get("auth").userId, request,
        }));
      } catch (error) {
        if (error instanceof WorkspaceSchemaConflictError) return c.json({ error: { code: error.code, message: error.message, expectedRevision: error.expectedRevision, actualRevision: error.actualRevision } }, 409);
        if (error instanceof RuleSetRevisionConflictError) return c.json({ error: { code: error.code, message: error.message, expectedRevision: error.expectedRevision, actualRevision: error.actualRevision } }, 409);
        if (error instanceof RuleRevisionConflictError) return c.json({ error: { code: error.code, message: error.message, expectedRevision: error.expectedRevision, actualRevision: error.actualRevision } }, error.actualRevision === null ? 404 : 409);
        if (error instanceof RuleIdempotencyConflictError) return c.json({ error: { code: error.code, message: error.message } }, 409);
        if (error instanceof RuleOrderValidationError) return c.json({ error: { code: error.code, message: error.message } }, 400);
        if (error instanceof RuleAuthorityError) return c.json({ error: { code: error.code, message: error.message } }, error.code === "revision_conflict" ? 409 : 403);
        if (error instanceof Error && error.name === "ZodError") return c.json({ error: { code: "validation_error", message: "Invalid Rule reorder request", issues: "issues" in error ? error.issues : [] } }, 400);
        throw error;
      }
    } finally { client.sqlite.close(); }
  });

  app.get("/v1/organization/rules/:ruleId", requireAuth({ dbFactory }), (c) => {
    const client = dbFactory();
    try {
      try {
        return c.json(createRuleRevisionService(createSqliteRuleRevisionRepository(client.db)).get({
          workspaceId: c.get("auth").userId,
          ruleId: c.req.param("ruleId"),
          query: {
            ...(c.req.query("limit") === undefined ? {} : { limit: c.req.query("limit") }),
            ...(c.req.query("cursor") === undefined ? {} : { cursor: c.req.query("cursor") }),
          },
        }));
      } catch (error) {
        if (error instanceof RuleRevisionConflictError) return c.json({ error: { code: "not_found", message: "Rule is unavailable in this Workspace" } }, 404);
        if (error instanceof RuleRevisionCursorError) return c.json({ error: { code: error.code, message: error.message } }, 400);
        if (error instanceof RuleRevisionCursorStaleError) return c.json({ error: { code: error.code, message: error.message } }, 409);
        if (error instanceof Error && error.name === "ZodError") return c.json({ error: { code: "validation_error", message: "Invalid Rule revision history query" } }, 400);
        throw error;
      }
    } finally { client.sqlite.close(); }
  });

  app.get("/v1/organization/evaluations/latest", requireAuth({ dbFactory }), (c) => {
    const client = dbFactory();
    try {
      const workspaceId = c.get("auth").userId;
      const accountId = c.req.query("accountId")?.trim() || undefined;
      const threadId = c.req.query("threadId")?.trim() || undefined;
      if (accountId) {
        const owned = client.db.select({ id: oauthAccounts.id }).from(oauthAccounts)
          .where(eq(oauthAccounts.userId, workspaceId)).all().some((account) => account.id === accountId);
        if (!owned) return c.json({ error: { code: "account_denied", message: "Account is outside this Workspace" } }, 403);
      }
      return c.json({ trace: getLatestOrcaEvaluationTrace(client.db, { workspaceId, ...(accountId ? { accountId } : {}), ...(threadId ? { threadId } : {}) }) });
    } finally { client.sqlite.close(); }
  });
}
