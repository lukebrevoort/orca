import type { Hono, MiddlewareHandler } from "hono";
import { orcaLanguageTextLimits } from "@orca/shared";
import { and, asc, eq } from "drizzle-orm";

import type { AuthVariables } from "../../auth/middleware.ts";
import { requireAuth } from "../../auth/middleware.ts";
import { createDatabaseClient } from "../../db/client.ts";
import { oauthAccounts, organizationChangeActions, organizationChangeSets } from "../../db/schema.ts";
import {
  OrcaRuleChangeSetError,
  OrcaRuleCompensationConflictError,
  createSqliteRuleChangeSetService,
  sqliteRuleChangeSetCapabilitySource,
} from "./change-set-sqlite.ts";
import { getLatestOrcaEvaluationTrace } from "./evaluation-sqlite.ts";
import {
  OrcaThreadCorrectionError,
  correctOrganizationThread,
} from "./correction.ts";
import { HistoricalSimulationBindingError, createHistoricalRuleSimulationService } from "./simulation.ts";
import { createSqliteHistoricalRuleSimulationRepository } from "./simulation-sqlite.ts";
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

  const capabilityFor = (db: ReturnType<typeof createDatabaseClient>["db"], workspaceId: string) => {
    const capability = sqliteRuleChangeSetCapabilitySource.load(db, { workspaceId });
    if (!capability) throw new OrcaRuleChangeSetError("capability_missing", "No current live Capability authorizes Rule Change Sets");
    return capability.snapshot;
  };

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

  app.post("/v1/organization/rules/:ruleId/simulate", requireAuth({ dbFactory }), async (c) => {
    const client = dbFactory();
    try {
      let request: unknown;
      try { request = await c.req.json(); } catch { return c.json({ error: { code: "validation_error", message: "Simulation requires a valid JSON request" } }, 400); }
      if (typeof request === "object" && request !== null && "ruleId" in request && request.ruleId !== c.req.param("ruleId")) {
        return c.json({ error: { code: "validation_error", message: "Path and Simulation Rule IDs must match" } }, 400);
      }
      try {
        const workspaceId = c.get("auth").userId;
        return c.json(createHistoricalRuleSimulationService(createSqliteHistoricalRuleSimulationRepository(client.db)).simulate({
          actor: { id: workspaceId, type: "human" },
          workspaceId,
          request,
        }));
      } catch (error) {
        if (error instanceof HistoricalSimulationBindingError) return c.json({ error: { code: error.code, message: error.message } }, 409);
        if (error instanceof Error && /Account scope is not owned/.test(error.message)) return c.json({ error: { code: "account_denied", message: error.message } }, 403);
        if (error instanceof Error && error.name === "ZodError") return c.json({ error: { code: "validation_error", message: "Invalid historical Simulation request" } }, 400);
        throw error;
      }
    } finally { client.sqlite.close(); }
  });

  app.post("/v1/organization/threads/:threadId/correct", requireAuth({ dbFactory }), async (c) => {
    const client = dbFactory();
    try {
      let request: unknown;
      try { request = await c.req.json(); } catch { return c.json({ error: { code: "validation_error", message: "Correction requires a valid JSON request" } }, 400); }
      if (typeof request === "object" && request !== null && "threadId" in request && request.threadId !== c.req.param("threadId")) {
        return c.json({ error: { code: "validation_error", message: "Path and correction Thread IDs must match" } }, 400);
      }
      try {
        const workspaceId = c.get("auth").userId;
        return c.json(correctOrganizationThread(client.db, {
          actor: { id: workspaceId, type: "human" }, workspaceId, request,
        }));
      } catch (error) {
        if (error instanceof OrcaThreadCorrectionError) {
          const status = error.code === "thread_not_found" ? 404
            : error.code === "revision_conflict" || error.code === "idempotency_conflict" ? 409
              : error.code === "evaluation_exhausted" ? 503 : 403;
          return c.json({ error: { code: error.code, message: error.message } }, status);
        }
        if (error instanceof Error && error.name === "ZodError") return c.json({ error: { code: "validation_error", message: "Invalid Thread correction request" } }, 400);
        throw error;
      }
    } finally { client.sqlite.close(); }
  });

  app.post("/v1/organization/rules/:ruleId/activate", requireAuth({ dbFactory }), async (c) => {
    const client = dbFactory();
    try {
      let request: unknown;
      try { request = await c.req.json(); } catch { return c.json({ error: { code: "validation_error", message: "Activation requires a valid JSON request" } }, 400); }
      if (typeof request === "object" && request !== null && "ruleId" in request && request.ruleId !== c.req.param("ruleId")) {
        return c.json({ error: { code: "validation_error", message: "Path and Activation Rule IDs must match" } }, 400);
      }
      try {
        const workspaceId = c.get("auth").userId;
        const capabilitySnapshot = capabilityFor(client.db, workspaceId);
        return c.json(createSqliteRuleChangeSetService(client.db).activate({
          actor: capabilitySnapshot.actor,
          capabilitySnapshot,
          workspaceId,
          request,
        }));
      } catch (error) {
        if (error instanceof OrcaRuleChangeSetError) {
          const status = error.code === "simulation_binding_conflict" || error.code === "revision_conflict" || error.code === "duplicate_idempotency_key" ? 409
            : error.code === "change_set_not_found" ? 404
              : error.code.endsWith("denied") || error.code.includes("capability") ? 403 : 400;
          return c.json({ error: { code: error.code, message: error.message } }, status);
        }
        if (error instanceof Error && error.name === "ZodError") return c.json({ error: { code: "validation_error", message: "Invalid Rule activation request" } }, 400);
        throw error;
      }
    } finally { client.sqlite.close(); }
  });

  app.post("/v1/organization/change-sets/:changeSetId/revert", requireAuth({ dbFactory }), async (c) => {
    const client = dbFactory();
    try {
      let request: unknown;
      try { request = await c.req.json(); } catch { return c.json({ error: { code: "validation_error", message: "Revert requires a valid JSON request" } }, 400); }
      if (typeof request === "object" && request !== null && "changeSetId" in request && request.changeSetId !== c.req.param("changeSetId")) {
        return c.json({ error: { code: "validation_error", message: "Path and Revert Change Set IDs must match" } }, 400);
      }
      try {
        const workspaceId = c.get("auth").userId;
        const capabilitySnapshot = capabilityFor(client.db, workspaceId);
        return c.json(createSqliteRuleChangeSetService(client.db).revert({
          actor: capabilitySnapshot.actor,
          capabilitySnapshot,
          workspaceId,
          request,
        }));
      } catch (error) {
        if (error instanceof OrcaRuleCompensationConflictError) {
          return c.json({ error: { code: error.code, message: error.message, conflicts: error.conflicts } }, 409);
        }
        if (error instanceof OrcaRuleChangeSetError) {
          const status = error.code === "change_set_not_found" ? 404
            : error.code === "revision_conflict" || error.code === "change_set_already_reverted" || error.code === "duplicate_idempotency_key" ? 409
              : error.code.endsWith("denied") || error.code.includes("capability") ? 403 : 400;
          return c.json({ error: { code: error.code, message: error.message } }, status);
        }
        if (error instanceof Error && error.name === "ZodError") return c.json({ error: { code: "validation_error", message: "Invalid Rule revert request" } }, 400);
        throw error;
      }
    } finally { client.sqlite.close(); }
  });

  app.get("/v1/organization/change-sets/:changeSetId", requireAuth({ dbFactory }), (c) => {
    const client = dbFactory();
    try {
      const workspaceId = c.get("auth").userId;
      const changeSet = client.db.select().from(organizationChangeSets).where(and(
        eq(organizationChangeSets.workspaceId, workspaceId),
        eq(organizationChangeSets.id, c.req.param("changeSetId")),
      )).get();
      if (!changeSet) return c.json({ error: { code: "not_found", message: "Change Set is unavailable in this Workspace" } }, 404);
      const actions = client.db.select().from(organizationChangeActions).where(and(
        eq(organizationChangeActions.workspaceId, workspaceId),
        eq(organizationChangeActions.changeId, changeSet.id),
      )).orderBy(asc(organizationChangeActions.position)).all();
      return c.json({
        changeSet: {
          id: changeSet.id,
          operation: changeSet.operation,
          status: changeSet.status,
          simulationId: changeSet.simulationId,
          risk: changeSet.risk,
          revertsChangeId: changeSet.revertsChangeId,
          revertedByChangeId: changeSet.revertedByChangeId,
          workspaceRevisionBefore: changeSet.workspaceRevisionBefore,
          workspaceRevisionAfter: changeSet.workspaceRevisionAfter,
          authorityTrace: JSON.parse(changeSet.authorityTrace),
          createdAt: changeSet.createdAt.toISOString(),
        },
        trace: JSON.parse(changeSet.traceJson),
        actions: actions.map((action) => ({
          position: action.position,
          kind: action.actionKind,
          resourceFamily: action.resourceFamily,
          resourceId: action.resourceId,
          before: action.beforeJson ? JSON.parse(action.beforeJson) : null,
          after: action.afterJson ? JSON.parse(action.afterJson) : null,
        })),
        inverse: JSON.parse(changeSet.inverseJson),
        resultingRevisions: JSON.parse(changeSet.resultingRevisionsJson),
      });
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
