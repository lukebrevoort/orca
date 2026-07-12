import { and, asc, desc, eq } from "drizzle-orm";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { validator } from "hono/validator";
import {
  attentionBehaviorSchema,
  attentionViewSettingSchema,
  authSessionSchema,
  createSenderAttentionRuleSchema,
  inboxQuerySchema,
  inboxResponseSchema,
  mailAccountSchema,
  resolveSenderAttentionSchema,
  resolvedSenderAttentionSchema,
  senderAttentionRuleSchema,
  syncStatusSchema,
  updateAttentionViewSettingSchema,
  updateSenderAttentionRuleSchema,
} from "@orca/shared";

import { createGmailAuthApp } from "./auth/gmail/routes.ts";
import { requireAuth, type AuthVariables } from "./auth/middleware.ts";
import { getServerConfig } from "./config/server.ts";
import { createDatabaseClient } from "./db/client.ts";
import { attentionViewSettings, emailLabels, emails, labels, oauthAccounts, senderAttentionRules, users } from "./db/schema.ts";
import { GmailSyncError, syncGmailAccountPage } from "./providers/gmail/sync.ts";

const serverConfig = getServerConfig();

type CreateAppOptions = {
  dbFactory?: typeof createDatabaseClient;
  syncPage?: typeof syncGmailAccountPage;
};

type SyncStatusRecord = { state: "syncing" | "error"; error: string | null };

const defaultViewSettings = [
  { behavior: "notify", displayName: "Notify", icon: "bell", color: "#dc2626", position: 0 },
  { behavior: "focus", displayName: "Focus", icon: "sparkles", color: "#2563eb", position: 1 },
  { behavior: "normal", displayName: "Normal", icon: "inbox", color: "#64748b", position: 2 },
  { behavior: "quiet", displayName: "Quiet", icon: "moon", color: "#7c3aed", position: 3 },
  { behavior: "hidden", displayName: "Hidden", icon: "eye-off", color: "#475569", position: 4 },
] as const;

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

  app.get("/v1/attention/rules", requireAuth({ dbFactory }), (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const account = getConnectedAccount(db, c.get("auth").userId);
      if (!account) return noConnectedAccount(c);
      return c.json(listSenderRules(db, account.id).map(toSenderRule));
    } finally {
      sqlite.close();
    }
  });

  app.post(
    "/v1/attention/rules",
    validator("json", (value, c) => validateJson(c, createSenderAttentionRuleSchema, value)),
    requireAuth({ dbFactory }),
    (c) => {
      const { db, sqlite } = dbFactory();
      try {
        const account = getConnectedAccount(db, c.get("auth").userId);
        if (!account) return noConnectedAccount(c);
        const input = normalizeRuleInput(c.req.valid("json"));
        const id = `sender-rule:${crypto.randomUUID()}`;
        db.insert(senderAttentionRules).values({ id, accountId: account.id, ...input }).run();
        return jsonWithSchema(c, senderAttentionRuleSchema, toSenderRule(getSenderRule(db, account.id, id)!));
      } catch (error) {
        return uniqueRuleError(c, error);
      } finally {
        sqlite.close();
      }
    },
  );

  app.patch(
    "/v1/attention/rules/:id",
    validator("json", (value, c) => validateJson(c, updateSenderAttentionRuleSchema, value)),
    requireAuth({ dbFactory }),
    (c) => {
      const { db, sqlite } = dbFactory();
      try {
        const account = getConnectedAccount(db, c.get("auth").userId);
        if (!account) return noConnectedAccount(c);
        const existing = getSenderRule(db, account.id, c.req.param("id"));
        if (!existing) return c.json({ error: { code: "not_found", message: "Sender rule was not found" } }, 404);
        const input = normalizeRuleInput({ ...existing, ...c.req.valid("json") });
        db.update(senderAttentionRules).set({ ...input, updatedAt: new Date() })
          .where(and(eq(senderAttentionRules.accountId, account.id), eq(senderAttentionRules.id, existing.id))).run();
        return jsonWithSchema(c, senderAttentionRuleSchema, toSenderRule(getSenderRule(db, account.id, existing.id)!));
      } catch (error) {
        return uniqueRuleError(c, error);
      } finally {
        sqlite.close();
      }
    },
  );

  app.delete("/v1/attention/rules/:id", requireAuth({ dbFactory }), (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const account = getConnectedAccount(db, c.get("auth").userId);
      if (!account) return noConnectedAccount(c);
      const existing = getSenderRule(db, account.id, c.req.param("id"));
      if (!existing) return c.json({ error: { code: "not_found", message: "Sender rule was not found" } }, 404);
      db.delete(senderAttentionRules).where(eq(senderAttentionRules.id, existing.id)).run();
      return c.body(null, 204);
    } finally {
      sqlite.close();
    }
  });

  app.get(
    "/v1/attention/resolve",
    validator("query", (value, c) => validateJson(c, resolveSenderAttentionSchema, value)),
    requireAuth({ dbFactory }),
    (c) => {
      const { db, sqlite } = dbFactory();
      try {
        const account = getConnectedAccount(db, c.get("auth").userId);
        if (!account) return noConnectedAccount(c);
        const address = c.req.valid("query").address.toLowerCase();
        const domain = address.split("@")[1]!;
        const rule = db.select().from(senderAttentionRules).where(and(
          eq(senderAttentionRules.accountId, account.id),
          eq(senderAttentionRules.scope, "address"),
          eq(senderAttentionRules.value, address),
        )).get() ?? db.select().from(senderAttentionRules).where(and(
          eq(senderAttentionRules.accountId, account.id),
          eq(senderAttentionRules.scope, "domain"),
          eq(senderAttentionRules.value, domain),
        )).get();
        return jsonWithSchema(c, resolvedSenderAttentionSchema, {
          behavior: rule?.behavior ?? "normal",
          rule: rule ? toSenderRule(rule) : null,
        });
      } finally {
        sqlite.close();
      }
    },
  );

  app.get("/v1/attention/view-settings", requireAuth({ dbFactory }), (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const account = getConnectedAccount(db, c.get("auth").userId);
      if (!account) return noConnectedAccount(c);
      ensureViewSettings(db, account.id);
      return c.json(listViewSettings(db, account.id).map(toViewSetting));
    } finally {
      sqlite.close();
    }
  });

  app.patch(
    "/v1/attention/view-settings/:behavior",
    validator("json", (value, c) => validateJson(c, updateAttentionViewSettingSchema, value)),
    requireAuth({ dbFactory }),
    (c) => {
      const behavior = attentionBehaviorSchema.safeParse(c.req.param("behavior"));
      if (!behavior.success) return c.json({ error: { code: "validation_error", message: "Unknown attention behavior" } }, 400);
      const { db, sqlite } = dbFactory();
      try {
        const account = getConnectedAccount(db, c.get("auth").userId);
        if (!account) return noConnectedAccount(c);
        ensureViewSettings(db, account.id);
        const current = db.select().from(attentionViewSettings).where(and(eq(attentionViewSettings.accountId, account.id), eq(attentionViewSettings.behavior, behavior.data))).get()!;
        const input = c.req.valid("json");
        updateViewSetting(db, account.id, current, input);
        const updated = db.select().from(attentionViewSettings).where(eq(attentionViewSettings.id, current.id)).get()!;
        return jsonWithSchema(c, attentionViewSettingSchema, toViewSetting(updated));
      } finally {
        sqlite.close();
      }
    },
  );

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

type Database = ReturnType<typeof createDatabaseClient>["db"];
type SenderRuleRecord = typeof senderAttentionRules.$inferSelect;
type ViewSettingRecord = typeof attentionViewSettings.$inferSelect;

function validateJson<T>(c: Context, schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } } }, value: unknown) {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  return c.json({
    error: {
      code: "validation_error",
      message: "Invalid request data",
      issues: result.error.issues.map((issue) => ({ path: issue.path.join(".") || "body", message: issue.message })),
    },
  }, 400);
}

function noConnectedAccount(c: Context) {
  return c.json({ error: { code: "not_found", message: "No Gmail account is connected" } }, 404);
}

function normalizeRuleInput(input: { scope: string; value: string; behavior: string; source: string }) {
  return createSenderAttentionRuleSchema.parse({
    scope: input.scope,
    value: input.value.trim().toLowerCase(),
    behavior: input.behavior,
    source: input.source,
  });
}

function toSenderRule(rule: SenderRuleRecord) {
  return {
    id: rule.id,
    accountId: rule.accountId,
    scope: rule.scope,
    value: rule.value,
    behavior: rule.behavior,
    source: rule.source,
    createdAt: rule.createdAt.toISOString(),
    updatedAt: rule.updatedAt.toISOString(),
  };
}

function getSenderRule(db: Database, accountId: string, id: string) {
  return db.select().from(senderAttentionRules).where(and(
    eq(senderAttentionRules.accountId, accountId),
    eq(senderAttentionRules.id, id),
  )).get();
}

function listSenderRules(db: Database, accountId: string) {
  return db.select().from(senderAttentionRules)
    .where(eq(senderAttentionRules.accountId, accountId))
    .orderBy(asc(senderAttentionRules.scope), asc(senderAttentionRules.value)).all();
}

function uniqueRuleError(c: Context, error: unknown) {
  if (error instanceof Error && error.name === "ZodError") {
    return c.json({ error: { code: "validation_error", message: "Invalid request data" } }, 400);
  }
  if (error instanceof Error && /UNIQUE constraint failed: sender_attention_rules/.test(error.message)) {
    return c.json({ error: { code: "conflict", message: "A rule already exists for this sender scope" } }, 409);
  }
  throw error;
}

function ensureViewSettings(db: Database, accountId: string) {
  const existing = db.select({ behavior: attentionViewSettings.behavior }).from(attentionViewSettings)
    .where(eq(attentionViewSettings.accountId, accountId)).all();
  const existingBehaviors = new Set(existing.map((setting) => setting.behavior));
  const missing = defaultViewSettings.filter((setting) => !existingBehaviors.has(setting.behavior));
  if (missing.length > 0) {
    db.insert(attentionViewSettings).values(missing.map((setting) => ({
      id: `attention-view:${accountId}:${setting.behavior}`,
      accountId,
      ...setting,
    }))).run();
  }
}

function listViewSettings(db: Database, accountId: string) {
  return db.select().from(attentionViewSettings)
    .where(eq(attentionViewSettings.accountId, accountId))
    .orderBy(asc(attentionViewSettings.position)).all();
}

function toViewSetting(setting: ViewSettingRecord) {
  return {
    behavior: setting.behavior,
    displayName: setting.displayName,
    icon: setting.icon,
    color: setting.color,
    position: setting.position,
  };
}

function updateViewSetting(
  db: Database,
  accountId: string,
  current: ViewSettingRecord,
  input: { displayName?: string; icon?: string; color?: string; position?: number },
) {
  const nextPosition = input.position ?? current.position;
  db.transaction((tx) => {
    if (nextPosition !== current.position) {
      tx.update(attentionViewSettings).set({ position: -1 })
        .where(eq(attentionViewSettings.id, current.id)).run();
      if (nextPosition < current.position) {
        for (let position = current.position - 1; position >= nextPosition; position -= 1) {
          tx.update(attentionViewSettings).set({ position: position + 1 })
            .where(and(eq(attentionViewSettings.accountId, accountId), eq(attentionViewSettings.position, position))).run();
        }
      } else {
        for (let position = current.position + 1; position <= nextPosition; position += 1) {
          tx.update(attentionViewSettings).set({ position: position - 1 })
            .where(and(eq(attentionViewSettings.accountId, accountId), eq(attentionViewSettings.position, position))).run();
        }
      }
    }
    tx.update(attentionViewSettings).set({
      displayName: input.displayName ?? current.displayName,
      icon: input.icon ?? current.icon,
      color: input.color ?? current.color,
      position: nextPosition,
      updatedAt: new Date(),
    }).where(eq(attentionViewSettings.id, current.id)).run();
  });
}

function getConnectedAccount(db: ReturnType<typeof createDatabaseClient>["db"], userId: string): ConnectedAccount | undefined {
  return getConnectedAccounts(db, userId)[0];
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
