import type { Hono } from "hono";

import type { AuthVariables } from "../../auth/middleware.ts";
import { requireAuth } from "../../auth/middleware.ts";
import { createDatabaseClient } from "../../db/client.ts";
import {
  OrganizationCollectionsPinsAccessError,
  OrganizationCollectionsPinsConflictError,
  OrganizationCollectionsPinsNotFoundError,
  createOrganizationCollectionsPins,
} from "./module.ts";
import { createSqliteOrganizationCollectionsPinsRepository } from "./sqlite-repository.ts";

type OrganizationApp = Hono<{ Variables: AuthVariables }>;

function errorResponse(c: Parameters<Parameters<OrganizationApp["onError"]>[0]>[1], error: unknown) {
  if (error instanceof OrganizationCollectionsPinsAccessError) {
    return c.json({ error: { code: error.code, message: "The requested Account scope is not authorized" } }, 403);
  }
  if (error instanceof OrganizationCollectionsPinsNotFoundError) {
    return c.json({ error: { code: error.code, message: error.message } }, 404);
  }
  if (error instanceof OrganizationCollectionsPinsConflictError) {
    return c.json({ error: { code: "conflict", message: "Collections/Pins state changed; refresh and try again" } }, 409);
  }
  if (error instanceof Error && (error.name === "ZodError" || error instanceof SyntaxError)) {
    return c.json({ error: { code: "validation_error", message: "Invalid Collections/Pins Organization request" } }, 400);
  }
  throw error;
}

export function registerOrganizationCollectionsPinsRoutes(
  app: OrganizationApp,
  options: { dbFactory?: typeof createDatabaseClient } = {},
) {
  const dbFactory = options.dbFactory ?? createDatabaseClient;

  function open(workspaceId: string) {
    const client = dbFactory();
    const repository = createSqliteOrganizationCollectionsPinsRepository(client.db);
    return {
      ...client,
      organization: createOrganizationCollectionsPins(repository),
      scope: {
        actor: { id: workspaceId, type: "human" as const },
        workspaceId,
        accountIds: repository.listAccountIds(workspaceId),
      },
    };
  }

  app.get("/v1/organization/collections-pins/describe", requireAuth({ dbFactory }), (c) => {
    const { organization, scope, sqlite } = open(c.get("auth").userId);
    try {
      return c.json(organization.describe({ scope }));
    } catch (error) {
      return errorResponse(c, error);
    } finally {
      sqlite.close();
    }
  });

  app.get("/v1/organization/collections-pins/query", requireAuth({ dbFactory }), (c) => {
    const { organization, scope, sqlite } = open(c.get("auth").userId);
    try {
      return c.json(organization.query({
        scope,
        query: {
          ...(c.req.query("accountId") ? { accountIds: [c.req.query("accountId")] } : {}),
          ...(c.req.query("collectionId") ? { collectionId: c.req.query("collectionId") } : {}),
          ...(c.req.query("threadId") ? { threadId: c.req.query("threadId") } : {}),
        },
      }));
    } catch (error) {
      return errorResponse(c, error);
    } finally {
      sqlite.close();
    }
  });

  app.get("/v1/organization/collections-pins/audit", requireAuth({ dbFactory }), (c) => {
    const { organization, scope, sqlite } = open(c.get("auth").userId);
    try {
      return c.json({ changes: organization.audit({ scope }) });
    } catch (error) {
      return errorResponse(c, error);
    } finally {
      sqlite.close();
    }
  });

  app.post("/v1/organization/collections-pins/apply", requireAuth({ dbFactory }), async (c) => {
    const { organization, scope, sqlite } = open(c.get("auth").userId);
    try {
      return c.json(organization.apply({ scope, request: await c.req.json() }));
    } catch (error) {
      return errorResponse(c, error);
    } finally {
      sqlite.close();
    }
  });

  app.post("/v1/organization/collections-pins/revert", requireAuth({ dbFactory }), async (c) => {
    const { organization, scope, sqlite } = open(c.get("auth").userId);
    try {
      return c.json(organization.revert({ scope, request: await c.req.json() }));
    } catch (error) {
      return errorResponse(c, error);
    } finally {
      sqlite.close();
    }
  });
}
