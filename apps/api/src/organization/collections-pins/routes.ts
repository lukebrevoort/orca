import type { Hono } from "hono";

import type { AuthVariables } from "../../auth/middleware.ts";
import { requireAuth } from "../../auth/middleware.ts";
import { requireSessionOwner } from "../../auth/session-owner.ts";
import { getAuthConfig } from "../../auth/config.ts";
import { organizationSavedQueryResultQuerySchema } from "@orca/shared";
import { MailboxCursorError } from "../../mailbox/read.ts";
import { readSavedQueryResults, SavedQueryReadError } from "./query-results-reader.ts";
import { createDatabaseClient } from "../../db/client.ts";
import {
  OrganizationCollectionsPinsAccessError,
  OrganizationCollectionsPinsConflictError,
  OrganizationCollectionsPinsNotFoundError,
} from "./module.ts";
import { createOrganization } from "../module.ts";
import { createSqliteOrganizationRepository } from "../sqlite-repository.ts";

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

  app.get("/v1/organization/collections-pins/queries/:queryId/results", (c, next) => {
    c.header("Cache-Control", "private, no-store");
    c.header("Vary", "x-orca-importance-version", { append: true });
    return next();
  }, requireAuth({ dbFactory }), requireSessionOwner, (c) => {
    const values = c.req.queries();
    const parsed = organizationSavedQueryResultQuerySchema.safeParse(c.req.query());
    if (!parsed.success || Object.values(values).some(value => value.length !== 1)) {
      return c.json({ error: { code: "validation_error", message: "Invalid saved-query result request" } }, 400);
    }
    const { sqlite } = dbFactory();
    try {
      return c.json(readSavedQueryResults(sqlite, {
        auth: c.get("auth"), authSource: c.get("authSource") ?? "cookie",
        queryId: c.req.param("queryId"), query: parsed.data, cursorSecret: getAuthConfig().sessionSecret,
        includeImportance: c.req.header("x-orca-importance-version") === "1",
      }));
    } catch (error) {
      if (error instanceof SavedQueryReadError) return c.json({ error: { code: error.code, message: error.message } }, error.status);
      if (error instanceof MailboxCursorError) return c.json({ error: { code: "invalid_cursor", message: error.message } }, 400);
      throw error;
    } finally { sqlite.close(); }
  });

  function open(workspaceId: string) {
    const client = dbFactory();
    const repository = createSqliteOrganizationRepository(client.db);
    const organization = createOrganization(repository);
    if (!organization.collectionsPins) throw new Error("Collections/Pins Organization composition is unavailable");
    return {
      ...client,
      organization: organization.collectionsPins,
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

  app.get("/v1/organization/collections-pins/query", requireAuth({ dbFactory }), requireSessionOwner, (c) => {
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
