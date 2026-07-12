import { and, asc, desc, eq } from "drizzle-orm";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { validator } from "hono/validator";
import sanitizeHtml from "sanitize-html";
import { authSessionSchema, inboxQuerySchema, inboxResponseSchema, mailAccountSchema, syncStatusSchema, threadDetailSchema, threadQuerySchema } from "@orca/shared";

import { createGmailAuthApp } from "./auth/gmail/routes.ts";
import { requireAuth, type AuthVariables } from "./auth/middleware.ts";
import { getServerConfig } from "./config/server.ts";
import { createDatabaseClient } from "./db/client.ts";
import { emailAttachments, emailLabels, emails, labels, oauthAccounts, threads, users } from "./db/schema.ts";
import { GmailSyncError, syncGmailAccountPage } from "./providers/gmail/sync.ts";

const serverConfig = getServerConfig();

type CreateAppOptions = {
  dbFactory?: typeof createDatabaseClient;
  syncPage?: typeof syncGmailAccountPage;
};

type SyncStatusRecord = { state: "syncing" | "error"; error: string | null };

export function createApp(options: CreateAppOptions = {}): Hono<{
  Variables: AuthVariables;
}> {
  const dbFactory = options.dbFactory ?? createDatabaseClient;
  const syncPage = options.syncPage ?? syncGmailAccountPage;
  const syncStatuses = new Map<string, SyncStatusRecord>();

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

  const getSyncStatus = (c: Context<{ Variables: AuthVariables }>) => {
    const { db, sqlite } = dbFactory();
    try {
      const accounts = getConnectedAccounts(db, c.get("auth").userId);
      return jsonWithSchema(c, syncStatusSchema, {
        accounts: accounts.map((account) => {
          const activeStatus = syncStatuses.get(account.id);
          const authNeeded = !account.accessTokenEncrypted || !account.refreshTokenEncrypted;
          return {
            ...toMailAccount(account),
            state: activeStatus?.state ?? (authNeeded ? "auth_needed" : "idle"),
            lastSyncedAt: account.lastSyncedAt?.toISOString() ?? null,
            error: activeStatus?.error ?? null,
          };
        }),
      });
    } finally {
      sqlite.close();
    }
  };
  app.get("/v1/sync/status", requireAuth({ dbFactory }), getSyncStatus);
  app.get("/api/sync/status", requireAuth({ dbFactory }), getSyncStatus);

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

  app.get(
    "/v1/threads/:threadId",
    validator("query", (value, c) => {
      const result = threadQuerySchema.safeParse(value);
      if (!result.success) {
        return c.json({ error: { code: "validation_error", message: "An accountId is required to read a thread" } }, 400);
      }
      return result.data;
    }),
    requireAuth({ dbFactory }),
    (c) => {
      const { db, sqlite } = dbFactory();
      try {
        const account = getConnectedAccountById(db, c.get("auth").userId, c.req.valid("query").accountId);
      if (!account) {
        return c.json({ error: { code: "not_found", message: "Thread not found" } }, 404);
      }

      // Account scope is part of the lookup so a valid ID from another account
      // is indistinguishable from an unknown thread.
      const thread = db.select().from(threads)
        .where(and(eq(threads.id, c.req.param("threadId")), eq(threads.accountId, account.id)))
        .get();
      if (!thread) {
        return c.json({ error: { code: "not_found", message: "Thread not found" } }, 404);
      }

      const messageRows = db.select({
        id: emails.id,
        providerMessageId: emails.providerMessageId,
        fromAddress: emails.fromAddress,
        fromName: emails.fromName,
        toRecipients: emails.toRecipients,
        ccRecipients: emails.ccRecipients,
        bccRecipients: emails.bccRecipients,
        subject: emails.subject,
        snippet: emails.snippet,
        bodyText: emails.bodyText,
        bodyHtml: emails.bodyHtml,
        receivedAt: emails.receivedAt,
        isRead: emails.isRead,
        isStarred: emails.isStarred,
        isDraft: emails.isDraft,
        humanSignal: emails.humanSignal,
        labelName: labels.name,
      }).from(emails)
        .leftJoin(emailLabels, eq(emailLabels.emailId, emails.id))
        .leftJoin(labels, eq(labels.id, emailLabels.labelId))
        .where(and(eq(emails.threadId, thread.id), eq(emails.accountId, account.id)))
        .orderBy(asc(emails.receivedAt), asc(emails.createdAt), asc(emails.id))
        .all();
      const attachments = db.select().from(emailAttachments)
        .innerJoin(emails, eq(emails.id, emailAttachments.emailId))
        .where(and(eq(emails.threadId, thread.id), eq(emails.accountId, account.id)))
        .all();

      const labelsByMessage = new Map<string, string[]>();
      const messagesById = new Map<string, typeof messageRows[number]>();
      for (const row of messageRows) {
        messagesById.set(row.id, row);
        const names = labelsByMessage.get(row.id) ?? [];
        if (row.labelName) names.push(row.labelName);
        labelsByMessage.set(row.id, names);
      }
      const attachmentsByMessage = new Map<string, Array<{ id: string; filename: string; mimeType: string; size: number }>>();
      for (const { email_attachments: attachment } of attachments) {
        const values = attachmentsByMessage.get(attachment.emailId) ?? [];
        values.push({ id: attachment.id, filename: attachment.filename, mimeType: attachment.mimeType, size: attachment.size });
        attachmentsByMessage.set(attachment.emailId, values);
      }

      const messages = [...messagesById.values()].map((message) => {
        const bodyHtml = sanitizeProviderHtml(message.bodyHtml);
        return {
          id: message.id,
          provider: "gmail" as const,
          providerMessageId: message.providerMessageId,
          from: { name: message.fromName, email: message.fromAddress ?? "unknown@invalid" },
          to: parseContacts(message.toRecipients),
          cc: parseContacts(message.ccRecipients),
          bcc: parseContacts(message.bccRecipients),
          subject: message.subject ?? "",
          snippet: message.snippet ?? "",
          receivedAt: (message.receivedAt ?? new Date(0)).toISOString(),
          unread: !message.isRead,
          labels: labelsByMessage.get(message.id) ?? [],
          bodyText: message.bodyText ?? htmlToText(bodyHtml),
          bodyHtml,
          attachments: attachmentsByMessage.get(message.id) ?? [],
        };
      });
      const participants = dedupeContacts(messages.flatMap((message) => [message.from, ...message.to, ...message.cc, ...message.bcc]));
      const allLabels = [...new Set(messages.flatMap((message) => message.labels))];
      const signals = [...messagesById.values()].map((message) => message.humanSignal).filter((value): value is number => value !== null);

        return jsonWithSchema(c, threadDetailSchema, {
        account: toMailAccount(account),
        thread: {
          id: thread.id,
          provider: "gmail",
          providerThreadId: thread.providerThreadId,
          subject: thread.subject ?? "",
          latestReceivedAt: (thread.latestReceivedAt ?? new Date(0)).toISOString(),
          messageCount: thread.messageCount,
          labels: allLabels,
          participants,
          readState: thread.isRead ? "read" : "unread",
          attention: {
            hasUnread: messages.some((message) => message.unread),
            hasStarred: [...messagesById.values()].some((message) => message.isStarred),
            hasDraft: [...messagesById.values()].some((message) => message.isDraft),
            humanSignal: signals.length ? Math.max(...signals) : null,
          },
        },
        messages,
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
      let account: ConnectedAccount | undefined;

      try {
        account = getConnectedAccount(db, auth.userId);

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

        syncStatuses.set(account.id, { state: "syncing", error: null });
        let result = await syncPage(db, { accountId: account.id, pageSize: 25 });
        let pages = 1;
        let emailCount = result.emailCount;
        let threadCount = result.threadCount;
        let labelCount = result.labelCount;
        let contactCount = result.contactCount;
        while (result.nextCursor && pages < 20) {
          result = await syncPage(db, { accountId: account.id, pageSize: 25 });
          pages += 1;
          emailCount += result.emailCount;
          threadCount += result.threadCount;
          labelCount += result.labelCount;
          contactCount += result.contactCount;
        }
        syncStatuses.delete(account.id);
        return c.json({ ...result, emailCount, threadCount, labelCount, contactCount, pages }, 200);
      } catch (error) {
        console.error("Gmail sync failed", {
          userId: auth.userId,
          error,
        });

        const publicError = toPublicSyncError(error);
        if (account?.id) {
          syncStatuses.set(account.id, { state: "error", error: publicError.message });
        }

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
  accessTokenEncrypted: string | null;
  refreshTokenEncrypted: string | null;
  lastSyncedAt: Date | null;
};

function getConnectedAccount(db: ReturnType<typeof createDatabaseClient>["db"], userId: string): ConnectedAccount | undefined {
  return getConnectedAccounts(db, userId)[0];
}

function getConnectedAccountById(
  db: ReturnType<typeof createDatabaseClient>["db"],
  userId: string,
  accountId: string,
): ConnectedAccount | undefined {
  return getConnectedAccounts(db, userId).find((account) => account.id === accountId);
}

function getConnectedAccounts(db: ReturnType<typeof createDatabaseClient>["db"], userId: string): ConnectedAccount[] {
  return db.select({
    id: oauthAccounts.id,
    providerEmail: oauthAccounts.providerEmail,
    displayName: users.displayName,
    accessTokenEncrypted: oauthAccounts.accessTokenEncrypted,
    refreshTokenEncrypted: oauthAccounts.refreshTokenEncrypted,
    lastSyncedAt: oauthAccounts.lastSyncedAt,
  })
    .from(oauthAccounts)
    .innerJoin(users, eq(users.id, oauthAccounts.userId))
    .where(and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, "gmail")))
    .all();
}

function toMailAccount(account: ConnectedAccount) {
  return {
    id: account.id,
    provider: "gmail" as const,
    email: account.providerEmail,
    displayName: account.displayName ?? account.providerEmail.split("@")[0] ?? account.providerEmail,
  };
}

const providerHtmlPolicy: sanitizeHtml.IOptions = {
  allowedTags: ["a", "b", "blockquote", "br", "code", "div", "em", "i", "li", "ol", "p", "pre", "span", "strong", "ul"],
  allowedAttributes: { a: ["href", "title"] },
  allowedSchemes: ["http", "https", "mailto"],
  disallowedTagsMode: "discard",
};

function sanitizeProviderHtml(value: string | null): string | null {
  if (value === null) return null;
  return sanitizeHtml(value, providerHtmlPolicy) || null;
}

function htmlToText(value: string | null): string | null {
  if (value === null) return null;
  const text = sanitizeHtml(value, { allowedTags: [], allowedAttributes: {} }).replace(/\s+/g, " ").trim();
  return text || null;
}

function dedupeContacts(contacts: Array<{ name: string | null; email: string }>) {
  const unique = new Map<string, { name: string | null; email: string }>();
  for (const contact of contacts) {
    if (!contact.email || contact.email === "unknown@invalid") continue;
    const key = contact.email.toLowerCase();
    const prior = unique.get(key);
    if (!prior || (!prior.name && contact.name)) unique.set(key, contact);
  }
  return [...unique.values()];
}

function parseContacts(value: string | null) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((contact): contact is { name: string | null; email: string } =>
      typeof contact === "object" && contact !== null &&
      (typeof contact.name === "string" || contact.name === null) && typeof contact.email === "string",
    );
  } catch {
    return [];
  }
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
