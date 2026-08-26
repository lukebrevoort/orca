import type { Hono } from "hono";

import type { AuthVariables } from "../../auth/middleware.ts";
import { requireAuth } from "../../auth/middleware.ts";
import { createDatabaseClient } from "../../db/client.ts";
import { RuleRevisionConflictError, WorkspaceSchemaConflictError, createRuleRevisionService } from "./service.ts";
import { createSqliteRuleRevisionRepository } from "./sqlite-repository.ts";

type OrganizationApp = Hono<{ Variables: AuthVariables }>;

export function registerOrganizationRuleRoutes(app: OrganizationApp, options: { dbFactory?: typeof createDatabaseClient } = {}) {
  const dbFactory = options.dbFactory ?? createDatabaseClient;

  app.post("/v1/organization/rules/compile", requireAuth({ dbFactory }), async (c) => {
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
        if (error instanceof RuleRevisionConflictError) return c.json({ error: { code: error.code, message: error.message, expectedRevision: error.expectedRevision, actualRevision: error.actualRevision } }, error.actualRevision === null ? 404 : 409);
        if (error instanceof Error && error.name === "ZodError") return c.json({ error: { code: "validation_error", message: "Invalid Rule compile request", issues: "issues" in error ? error.issues : [] } }, 400);
        throw error;
      }
    } finally { client.sqlite.close(); }
  });

  app.get("/v1/organization/rules/:ruleId", requireAuth({ dbFactory }), (c) => {
    const client = dbFactory();
    try {
      try {
        return c.json(createRuleRevisionService(createSqliteRuleRevisionRepository(client.db)).get({ workspaceId: c.get("auth").userId, ruleId: c.req.param("ruleId") }));
      } catch (error) {
        if (error instanceof RuleRevisionConflictError) return c.json({ error: { code: "not_found", message: "Rule is unavailable in this Workspace" } }, 404);
        throw error;
      }
    } finally { client.sqlite.close(); }
  });
}
