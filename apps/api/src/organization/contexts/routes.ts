import type { Hono } from "hono";

import type { AuthVariables } from "../../auth/middleware.ts";
import { requireAuth } from "../../auth/middleware.ts";
import { createDatabaseClient } from "../../db/client.ts";
import {
  createOrganization,
  OrganizationAuthorityError,
  OrganizationRevisionConflictError,
} from "../module.ts";
import { createSqliteOrganizationRepository } from "../sqlite-repository.ts";
import {
  OrganizationContextsAccessError,
  OrganizationContextsConflictError,
  OrganizationContextsNotFoundError,
  OrganizationContextsValidationError,
} from "./module.ts";

type OrganizationApp = Hono<{ Variables: AuthVariables }>;

function errorResponse(c: Parameters<Parameters<OrganizationApp["onError"]>[0]>[1], error: unknown) {
  if (error instanceof OrganizationContextsAccessError) return c.json({ error: { code: error.code, message: "The requested Account scope is not authorized" } }, 403);
  if (error instanceof OrganizationContextsNotFoundError) return c.json({ error: { code: error.code, message: error.message } }, 404);
  if (error instanceof OrganizationContextsConflictError) return c.json({ error: { code: error.code, message: "Context state changed; refresh and try again" } }, 409);
  if (error instanceof OrganizationContextsValidationError) return c.json({ error: { code: error.code, message: error.message, issues: error.issues } }, error.code === "revision_conflict" ? 409 : 400);
  if (error instanceof OrganizationRevisionConflictError) {
    return c.json({
      error: {
        code: error.code,
        message: error.message,
        expectedRevision: error.expectedRevision,
        actualRevision: error.actualRevision,
      },
    }, 409);
  }
  if (error instanceof OrganizationAuthorityError) {
    const status = error.code === "revision_conflict" || error.code === "duplicate_idempotency_key" ? 409
      : error.code === "invalid_request" || error.code === "idempotency_key_required" || error.code === "expected_revision_required" ? 400
        : 403;
    return c.json({ error: { code: error.code, message: error.message } }, status);
  }
  if (error instanceof Error && (error.name === "ZodError" || error instanceof SyntaxError)) return c.json({ error: { code: "validation_error", message: "Invalid Context Organization request" } }, 400);
  throw error;
}

export function registerOrganizationContextRoutes(app: OrganizationApp, options: { dbFactory?: typeof createDatabaseClient } = {}) {
  const dbFactory = options.dbFactory ?? createDatabaseClient;
  function open(workspaceId: string) {
    const client = dbFactory();
    const repository = createSqliteOrganizationRepository(client.db);
    const organization = createOrganization(repository).contexts;
    if (!organization) throw new Error("Context Organization composition is unavailable");
    return { ...client, organization, scope: { actor: { id: workspaceId, type: "human" as const }, workspaceId, accountIds: repository.listAccountIds(workspaceId) } };
  }

  app.get("/v1/organization/contexts/describe", requireAuth({ dbFactory }), (c) => {
    const { organization, scope, sqlite } = open(c.get("auth").userId);
    try { return c.json(organization.describe({ scope })); } catch (error) { return errorResponse(c, error); } finally { sqlite.close(); }
  });
  app.get("/v1/organization/contexts/query", requireAuth({ dbFactory }), (c) => {
    const { organization, scope, sqlite } = open(c.get("auth").userId);
    try {
      const contextId = c.req.query("contextId");
      const contextTypeId = c.req.query("contextTypeId");
      if (contextId && !contextTypeId) throw new SyntaxError("contextId requires contextTypeId");
      return c.json(organization.query({ scope, query: {
        ...(c.req.query("accountId") ? { accountIds: [c.req.query("accountId")] } : {}),
        ...(c.req.query("threadId") ? { threadId: c.req.query("threadId") } : {}),
        ...(contextTypeId ? { contextTypeId } : {}),
        ...(contextId && contextTypeId ? { contextRef: { contextId, contextTypeId } } : {}),
        ...(c.req.query("relationshipTypeId") ? { relationshipTypeId: c.req.query("relationshipTypeId") } : {}),
        ...(c.req.query("includeRetired") ? { includeRetired: c.req.query("includeRetired") === "true" } : {}),
        ...(c.req.query("limit") ? { limit: Number(c.req.query("limit")) } : {}),
      } }));
    } catch (error) { return errorResponse(c, error); } finally { sqlite.close(); }
  });
  app.get("/v1/organization/contexts/audit", requireAuth({ dbFactory }), (c) => {
    const { organization, scope, sqlite } = open(c.get("auth").userId);
    try { return c.json({ changes: organization.audit({ scope }) }); } catch (error) { return errorResponse(c, error); } finally { sqlite.close(); }
  });
  app.post("/v1/organization/contexts/apply", requireAuth({ dbFactory }), async (c) => {
    const { organization, scope, sqlite } = open(c.get("auth").userId);
    try { return c.json(organization.apply({ scope, request: await c.req.json() })); } catch (error) { return errorResponse(c, error); } finally { sqlite.close(); }
  });
  app.post("/v1/organization/contexts/revert", requireAuth({ dbFactory }), async (c) => {
    const { organization, scope, sqlite } = open(c.get("auth").userId);
    try { return c.json(organization.revert({ scope, request: await c.req.json() })); } catch (error) { return errorResponse(c, error); } finally { sqlite.close(); }
  });
}
