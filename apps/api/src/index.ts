import { and, eq } from "drizzle-orm";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { validator } from "hono/validator";
import {
  accountFixture,
  authSessionFixture,
  authSessionSchema,
  inboxFixture,
  inboxQuerySchema,
  inboxResponseSchema,
  mailAccountSchema,
} from "@orca/shared";

import { requireAuth, type AuthVariables } from "./auth/middleware.ts";
import { getServerConfig } from "./config/server.ts";
import { createDatabaseClient } from "./db/client.ts";
import { oauthAccounts } from "./db/schema.ts";
import { GmailSyncError, syncGmailAccountPage } from "./providers/gmail/sync.ts";

const serverConfig = getServerConfig();

type CreateAppOptions = {
  dbFactory?: typeof createDatabaseClient;
  syncPage?: typeof syncGmailAccountPage;
};

export function createApp(options: CreateAppOptions = {}) {
  const dbFactory = options.dbFactory ?? createDatabaseClient;
  const syncPage = options.syncPage ?? syncGmailAccountPage;

  const app = new Hono<{ Variables: AuthVariables }>();

  app.use(
    "*",
    cors({
      origin: [serverConfig.webOrigin],
    }),
  );

  app.get("/health", (c) =>
    c.json({
      ok: true,
      service: "orca-api",
    }),
  );

  app.get("/v1/auth/session", (c) => jsonWithSchema(c, authSessionSchema, authSessionFixture));

  app.get("/v1/me", (c) => jsonWithSchema(c, mailAccountSchema, accountFixture));

  app.get(
    "/v1/inbox",
    validator("query", (value, c) => {
      const result = inboxQuerySchema.safeParse(value);
      if (!result.success) {
        return c.json(
          {
            error: {
              code: "validation_error",
              message: "Invalid inbox query parameters",
              issues: result.error.issues.map((issue) => ({
                path: issue.path.join(".") || "query",
                message: issue.message,
              })),
            },
          } satisfies ValidationErrorResponse,
          400,
        );
      }

      return result.data;
    }),
    (c) => {
      c.req.valid("query");

      return jsonWithSchema(c, inboxResponseSchema, {
        account: accountFixture,
        messages: inboxFixture,
        nextCursor: null,
      });
    },
  );

  app.post(
    "/v1/sync/gmail",
    requireAuth({ dbFactory }),
    async (c) => {
      const auth = c.get("auth");
      const { db, sqlite } = dbFactory();

      try {
        const account = db
          .select({
            id: oauthAccounts.id,
          })
          .from(oauthAccounts)
          .where(
            and(
              eq(oauthAccounts.userId, auth.userId),
              eq(oauthAccounts.provider, "gmail"),
            ),
          )
          .get();

        if (!account) {
          return c.json(
            {
              error: {
                code: "not_found",
                message: "No Gmail account is connected for this user",
              },
            },
            404,
          );
        }

        const result = await syncPage(db, {
          accountId: account.id,
        });

        return c.json(result, 200);
      } catch (error) {
        console.error("Gmail sync failed", {
          userId: auth.userId,
          error,
        });

        const publicError = toPublicSyncError(error);

        return c.json(
          {
            error: {
              code: publicError.code,
              message: publicError.message,
            },
          },
          publicError.status,
        );
      } finally {
        sqlite.close();
      }
    },
  );

  return app;
}

export const app = createApp();

type ValidationErrorResponse = {
  error: {
    code: "validation_error";
    message: string;
    issues: Array<{
      path: string;
      message: string;
    }>;
  };
};

type JsonSchema<T> = {
  parse(value: unknown): T;
};

function jsonWithSchema<T>(
  c: Context,
  schema: JsonSchema<T>,
  value: unknown,
) {
  return c.json(schema.parse(value));
}

function toPublicSyncError(error: unknown) {
  if (error instanceof GmailSyncError) {
    switch (error.code) {
      case "provider_auth_error":
        return {
          code: "provider_auth_error",
          message: "Gmail needs to be reconnected before sync can continue",
          status: 401,
        } as const;
      case "sync_conflict":
        return {
          code: "sync_conflict",
          message: "Gmail sync cannot start until the connected account is fully configured",
          status: 409,
        } as const;
      case "provider_error":
      default:
        return {
          code: "provider_error",
          message: "Gmail sync is temporarily unavailable",
          status: 502,
        } as const;
    }
  }

  return {
    code: "internal_error",
    message: "Gmail sync failed unexpectedly",
    status: 500,
  } as const;
}

const { port } = serverConfig;

if (import.meta.main) {
  serve({
    fetch: app.fetch,
    port,
  });

  console.log(`Orca API listening on http://localhost:${port}`);
}
