import { and, desc, eq } from "drizzle-orm";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { validator } from "hono/validator";
import { authSessionSchema, inboxQuerySchema, inboxResponseSchema, mailAccountSchema } from "@orca/shared";

import { createGmailAuthApp } from "./auth/gmail/routes.ts";
import { requireAuth, type AuthVariables } from "./auth/middleware.ts";
import { getServerConfig } from "./config/server.ts";
import { createDatabaseClient } from "./db/client.ts";
import { emailLabels, emails, labels, oauthAccounts, users } from "./db/schema.ts";
import { GmailSyncError, syncGmailAccountPage } from "./providers/gmail/sync.ts";

const serverConfig = getServerConfig();

type CreateAppOptions = {
  dbFactory?: typeof createDatabaseClient;
  syncPage?: typeof syncGmailAccountPage;
};

export function createApp(options: CreateAppOptions = {}): Hono<{
  Variables: AuthVariables;
}> {
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

  app.get("/v1/auth/session", requireAuth({ dbFactory }), (c) => {
    const auth = c.get("auth");
    const { db, sqlite } = dbFactory();
    try {
      const user = db.select().from(users).where(eq(users.id, auth.userId)).get();
      if (!user) {
        return c.json({ error: { code: "unauthorized", message: "Authentication required" } }, 401);
      }
      return jsonWithSchema(c, authSessionSchema, {
        isAuthenticated: true,
        user: { id: user.id, email: user.email, name: user.displayName },
        expiresAt: auth.expiresAt.toISOString(),
      });
    } finally {
      sqlite.close();
    }
  });

  app.get("/v1/me", requireAuth({ dbFactory }), (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const account = getConnectedAccount(db, c.get("auth").userId);
      if (!account) {
        return c.json({ error: { code: "not_found", message: "No Gmail account is connected" } }, 404);
      }
      return jsonWithSchema(c, mailAccountSchema, toMailAccount(account));
    } finally {
      sqlite.close();
    }
  });

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
    requireAuth({ dbFactory }),
    (c) => {
      c.req.valid("query");
      const { db, sqlite } = dbFactory();
      try {
        const account = getConnectedAccount(db, c.get("auth").userId);
        if (!account) {
          return c.json({ error: { code: "not_found", message: "No Gmail account is connected" } }, 404);
        }
        const rows = db.select({
          id: emails.id,
          providerMessageId: emails.providerMessageId,
          threadId: emails.threadId,
          fromAddress: emails.fromAddress,
          fromName: emails.fromName,
          subject: emails.subject,
          snippet: emails.snippet,
          receivedAt: emails.receivedAt,
          isRead: emails.isRead,
          labelName: labels.name,
        }).from(emails)
          .leftJoin(emailLabels, eq(emailLabels.emailId, emails.id))
          .leftJoin(labels, eq(labels.id, emailLabels.labelId))
          .where(eq(emails.accountId, account.id))
          .orderBy(desc(emails.receivedAt))
          .limit(100)
          .all();
        const byId = new Map<string, { id: string; providerMessageId: string; threadId: string; fromAddress: string | null; fromName: string | null; subject: string | null; snippet: string | null; receivedAt: Date | null; isRead: boolean; labels: string[] }>();
        for (const row of rows) {
          const message = byId.get(row.id) ?? {
            ...row,
            labels: [],
          };
          if (row.labelName) message.labels.push(row.labelName);
          byId.set(row.id, message);
        }
        return jsonWithSchema(c, inboxResponseSchema, {
          account: toMailAccount(account),
          messages: [...byId.values()].map((message) => ({
            id: message.id,
            provider: "gmail",
            providerMessageId: message.providerMessageId,
            threadId: message.threadId,
            from: { name: message.fromName, email: message.fromAddress ?? "unknown@invalid" },
            subject: message.subject ?? "",
            snippet: message.snippet ?? "",
            receivedAt: (message.receivedAt ?? new Date(0)).toISOString(),
            unread: !message.isRead,
            labels: message.labels,
          })),
          nextCursor: null,
        });
      } finally {
        sqlite.close();
      }
    },
  );

  app.route("/v1/auth/gmail", createGmailAuthApp());

  app.post(
    "/v1/sync/gmail",
    requireAuth({ dbFactory }),
    async (c) => {
      const auth = c.get("auth");
      const { db, sqlite } = dbFactory();

      try {
        const account = getConnectedAccount(db, auth.userId);

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

        let result = await syncPage(db, { accountId: account.id, pageSize: 100 });
        let pages = 1;
        let emailCount = result.emailCount;
        let threadCount = result.threadCount;
        let labelCount = result.labelCount;
        let contactCount = result.contactCount;
        while (result.nextCursor && pages < 20) {
          result = await syncPage(db, { accountId: account.id, pageSize: 100 });
          pages += 1;
          emailCount += result.emailCount;
          threadCount += result.threadCount;
          labelCount += result.labelCount;
          contactCount += result.contactCount;
        }
        return c.json({ ...result, emailCount, threadCount, labelCount, contactCount, pages }, 200);
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

type ConnectedAccount = {
  id: string;
  providerEmail: string;
  displayName: string | null;
};

function getConnectedAccount(db: ReturnType<typeof createDatabaseClient>["db"], userId: string): ConnectedAccount | undefined {
  return db.select({ id: oauthAccounts.id, providerEmail: oauthAccounts.providerEmail, displayName: users.displayName })
    .from(oauthAccounts)
    .innerJoin(users, eq(users.id, oauthAccounts.userId))
    .where(and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, "gmail")))
    .get();
}

function toMailAccount(account: ConnectedAccount) {
  return {
    id: account.id,
    provider: "gmail" as const,
    email: account.providerEmail,
    displayName: account.displayName ?? account.providerEmail.split("@")[0] ?? account.providerEmail,
  };
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
