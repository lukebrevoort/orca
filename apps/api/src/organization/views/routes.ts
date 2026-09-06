import { Hono, type Context } from "hono";

import type { AuthVariables } from "../../auth/middleware.ts";
import { requireAuth } from "../../auth/middleware.ts";
import { createDatabaseClient } from "../../db/client.ts";
import { createOrganizationViews, OrganizationViewAccessError, OrganizationViewConflictError, OrganizationViewNotFoundError, OrganizationViewQueryError, OrganizationViewSelectionError, OrganizationViewValidationError } from "./module.ts";
import { createSqliteOrganizationViewsRepository } from "./sqlite-repository.ts";

type OrganizationApp = Hono<{ Variables: AuthVariables }>;

function errorResponse(c: Context<{ Variables: AuthVariables }>, error: unknown) {
  if (error instanceof OrganizationViewAccessError) return c.json({ error: { code: error.code, message: error.message } }, 403);
  if (error instanceof OrganizationViewNotFoundError) return c.json({ error: { code: error.code, message: error.message } }, 404);
  if (error instanceof OrganizationViewConflictError) return c.json({ error: { code: error.code, message: error.message } }, 409);
  if (error instanceof OrganizationViewQueryError) return c.json({ error: { code: error.code, message: error.message } }, 400);
  if (error instanceof OrganizationViewSelectionError) return c.json({ error: { code: error.code, message: error.message } }, 400);
  if (error instanceof OrganizationViewValidationError) return c.json({ error: { code: error.code, message: error.message } }, 400);
  if (error instanceof Error && error.name === "ZodError") return c.json({ error: { code: "validation_error", message: "Invalid live View request" } }, 400);
  throw error;
}

export function registerOrganizationViewRoutes(app: OrganizationApp, options: { dbFactory?: typeof createDatabaseClient } = {}) {
  const dbFactory = options.dbFactory ?? createDatabaseClient;
  const open = (workspaceId: string) => {
    const client = dbFactory();
    const accounts = client.sqlite.query("SELECT id FROM oauth_accounts WHERE user_id=? ORDER BY id").all(workspaceId) as Array<{ id: string }>;
    return {
      ...client,
      organization: createOrganizationViews(createSqliteOrganizationViewsRepository(client.sqlite)),
      scope: { workspaceId, accountIds: accounts.map((account) => account.id), actor: { id: workspaceId, type: "human" as const } },
    };
  };

  app.get("/v1/organization/views", requireAuth({ dbFactory }), (c) => {
    const current = open(c.get("auth").userId);
    try { return c.json(current.organization.list({ scope: current.scope })); } catch (error) { return errorResponse(c, error); } finally { current.sqlite.close(); }
  });
  app.post("/v1/organization/views/prepare", requireAuth({ dbFactory }), async (c) => {
    const current = open(c.get("auth").userId);
    try { return c.json(current.organization.prepare({ scope: current.scope, input: await c.req.json() })); } catch (error) { return errorResponse(c, error); } finally { current.sqlite.close(); }
  });
  app.post("/v1/organization/views/preview", requireAuth({ dbFactory }), async (c) => {
    const current = open(c.get("auth").userId);
    try { return c.json(current.organization.preview({ scope: current.scope, request: await c.req.json() })); } catch (error) { return errorResponse(c, error); } finally { current.sqlite.close(); }
  });
  app.post("/v1/organization/views/commit", requireAuth({ dbFactory }), async (c) => {
    const current = open(c.get("auth").userId);
    try { return c.json(current.organization.commit({ scope: current.scope, request: await c.req.json() })); } catch (error) { return errorResponse(c, error); } finally { current.sqlite.close(); }
  });
  app.post("/v1/organization/views", requireAuth({ dbFactory }), async (c) => {
    const current = open(c.get("auth").userId);
    try { return c.json(current.organization.create({ scope: current.scope, request: await c.req.json() }), 201); } catch (error) { return errorResponse(c, error); } finally { current.sqlite.close(); }
  });
  app.post("/v1/organization/views/reorder", requireAuth({ dbFactory }), async (c) => {
    const current = open(c.get("auth").userId);
    try { return c.json(current.organization.reorder({ scope: current.scope, request: await c.req.json() })); } catch (error) { return errorResponse(c, error); } finally { current.sqlite.close(); }
  });
  app.patch("/v1/organization/views/:viewId", requireAuth({ dbFactory }), async (c) => {
    const current = open(c.get("auth").userId);
    try { return c.json(current.organization.update({ scope: current.scope, viewId: c.req.param("viewId"), request: await c.req.json() })); } catch (error) { return errorResponse(c, error); } finally { current.sqlite.close(); }
  });
  app.delete("/v1/organization/views/:viewId", requireAuth({ dbFactory }), (c) => {
    const current = open(c.get("auth").userId);
    try {
      current.organization.remove({ scope: current.scope, viewId: c.req.param("viewId"), request: {
        expectedRevision: Number(c.req.query("expectedRevision")),
        expectedWorkspaceRevision: Number(c.req.query("expectedWorkspaceRevision")),
        idempotencyKey: c.req.query("idempotencyKey"),
      } });
      return c.body(null, 204);
    } catch (error) { return errorResponse(c, error); } finally { current.sqlite.close(); }
  });
  app.get("/v1/organization/views/:viewId/results", requireAuth({ dbFactory }), (c) => {
    const current = open(c.get("auth").userId);
    try {
      return c.json(current.organization.results({ scope: current.scope, viewId: c.req.param("viewId"), query: { ...(c.req.query("limit") ? { limit: Number(c.req.query("limit")) } : {}), ...(c.req.query("cursor") ? { cursor: c.req.query("cursor") } : {}) } }));
    } catch (error) { return errorResponse(c, error); } finally { current.sqlite.close(); }
  });
}
