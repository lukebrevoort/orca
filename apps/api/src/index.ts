import { and, asc, desc, eq } from "drizzle-orm";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { validator } from "hono/validator";
import sanitizeHtml from "sanitize-html";
import {
  type AttentionBehavior,
  attentionBehaviorSchema,
  attentionViewSettingSchema,
  authSessionSchema,
  collectionSchema,
  createCollectionSchema,
  createPinSchema,
  createSenderAttentionRuleSchema,
  inboxQuerySchema,
  inboxResponseSchema,
  mailAccountSchema,
  resolveSenderAttentionSchema,
  resolvedSenderAttentionSchema,
  pinSchema,
  senderAttentionRuleSchema,
  syncStatusSchema,
  threadDetailSchema,
  threadQuerySchema,
  updateAttentionViewSettingSchema,
  updateCollectionSchema,
  updatePinSchema,
  updateSenderAttentionRuleSchema,
} from "@orca/shared";

import { createGmailAuthApp } from "./auth/gmail/routes.ts";
import { requireAuth, type AuthVariables } from "./auth/middleware.ts";
import { getServerConfig } from "./config/server.ts";
import { createDatabaseClient } from "./db/client.ts";
import { attentionViewSettings, collections, collectionThreads, emailAttachments, emailLabels, emails, labels, oauthAccounts, pins, senderAttentionRules, threads, users } from "./db/schema.ts";
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

  app.get("/v1/collections", requireAuth({ dbFactory }), (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const account = getConnectedAccount(db, c.get("auth").userId);
      if (!account) return noConnectedAccount(c);
      return c.json(listCollections(db, account.id).map((collection) => collectionSchema.parse(collection)));
    } finally {
      sqlite.close();
    }
  });

  app.post(
    "/v1/collections",
    validator("json", (value, c) => validateJson(c, createCollectionSchema, value)),
    requireAuth({ dbFactory }),
    (c) => {
      const { db, sqlite } = dbFactory();
      try {
        const account = getConnectedAccount(db, c.get("auth").userId);
        if (!account) return noConnectedAccount(c);
        const name = c.req.valid("json").name.trim();
        const id = `collection:${crypto.randomUUID()}`;
        db.insert(collections).values({ id, accountId: account.id, name, position: listCollectionRecords(db, account.id).length }).run();
        return c.json(collectionSchema.parse(listCollections(db, account.id).find((item) => item.id === id)!), 201);
      } catch (error) {
        return organizationConflict(c, error, "A collection with that name already exists");
      } finally {
        sqlite.close();
      }
    },
  );

  app.patch(
    "/v1/collections/:id",
    validator("json", (value, c) => validateJson(c, updateCollectionSchema, value)),
    requireAuth({ dbFactory }),
    (c) => {
      const { db, sqlite } = dbFactory();
      try {
        const account = getConnectedAccount(db, c.get("auth").userId);
        if (!account) return noConnectedAccount(c);
        const current = getCollection(db, account.id, c.req.param("id"));
        if (!current) return c.json({ error: { code: "not_found", message: "Collection not found" } }, 404);
        updateCollectionRecord(db, account.id, current, c.req.valid("json"));
        return jsonWithSchema(c, collectionSchema, listCollections(db, account.id).find((item) => item.id === current.id)!);
      } catch (error) {
        return organizationConflict(c, error, "A collection with that name already exists");
      } finally {
        sqlite.close();
      }
    },
  );

  app.delete("/v1/collections/:id", requireAuth({ dbFactory }), (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const account = getConnectedAccount(db, c.get("auth").userId);
      if (!account) return noConnectedAccount(c);
      const current = getCollection(db, account.id, c.req.param("id"));
      if (!current) return c.json({ error: { code: "not_found", message: "Collection not found" } }, 404);
      db.transaction((tx) => {
        tx.delete(collections).where(eq(collections.id, current.id)).run();
        for (const item of tx.select().from(collections).where(eq(collections.accountId, account.id)).orderBy(asc(collections.position)).all()) {
          if (item.position > current.position) tx.update(collections).set({ position: item.position - 1 }).where(eq(collections.id, item.id)).run();
        }
      });
      return c.body(null, 204);
    } finally {
      sqlite.close();
    }
  });

  app.put("/v1/collections/:id/threads/:threadId", requireAuth({ dbFactory }), (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const account = getConnectedAccount(db, c.get("auth").userId);
      if (!account) return noConnectedAccount(c);
      const collection = getCollection(db, account.id, c.req.param("id"));
      const thread = db.select().from(threads).where(and(eq(threads.accountId, account.id), eq(threads.id, c.req.param("threadId")))).get();
      if (!collection || !thread) return c.json({ error: { code: "not_found", message: "Collection or thread not found" } }, 404);
      db.insert(collectionThreads).values({ id: `collection-thread:${crypto.randomUUID()}`, collectionId: collection.id, threadId: thread.id }).onConflictDoNothing().run();
      return jsonWithSchema(c, collectionSchema, listCollections(db, account.id).find((item) => item.id === collection.id)!);
    } finally {
      sqlite.close();
    }
  });

  app.delete("/v1/collections/:id/threads/:threadId", requireAuth({ dbFactory }), (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const account = getConnectedAccount(db, c.get("auth").userId);
      if (!account) return noConnectedAccount(c);
      const collection = getCollection(db, account.id, c.req.param("id"));
      if (!collection) return c.json({ error: { code: "not_found", message: "Collection not found" } }, 404);
      db.delete(collectionThreads).where(and(eq(collectionThreads.collectionId, collection.id), eq(collectionThreads.threadId, c.req.param("threadId")))).run();
      return c.body(null, 204);
    } finally {
      sqlite.close();
    }
  });

  app.get("/v1/pins", requireAuth({ dbFactory }), (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const account = getConnectedAccount(db, c.get("auth").userId);
      if (!account) return noConnectedAccount(c);
      return c.json(listPins(db, account.id).map(toPin));
    } finally {
      sqlite.close();
    }
  });

  app.post(
    "/v1/pins",
    validator("json", (value, c) => validateJson(c, createPinSchema, value)),
    requireAuth({ dbFactory }),
    (c) => {
      const { db, sqlite } = dbFactory();
      try {
        const account = getConnectedAccount(db, c.get("auth").userId);
        if (!account) return noConnectedAccount(c);
        const input = c.req.valid("json");
        validatePinTarget(db, account.id, input.kind, input.targetId);
        const id = `pin:${crypto.randomUUID()}`;
        db.insert(pins).values({ id, accountId: account.id, kind: input.kind, targetId: input.targetId.trim(), label: input.label.trim(), position: listPins(db, account.id).length }).run();
        return c.json(pinSchema.parse(toPin(db.select().from(pins).where(eq(pins.id, id)).get()!)), 201);
      } catch (error) {
        if (error instanceof OrganizationTargetError) return c.json({ error: { code: "validation_error", message: error.message } }, 400);
        return organizationConflict(c, error, "That item is already pinned");
      } finally {
        sqlite.close();
      }
    },
  );

  app.patch(
    "/v1/pins/:id",
    validator("json", (value, c) => validateJson(c, updatePinSchema, value)),
    requireAuth({ dbFactory }),
    (c) => {
      const { db, sqlite } = dbFactory();
      try {
        const account = getConnectedAccount(db, c.get("auth").userId);
        if (!account) return noConnectedAccount(c);
        const current = getPin(db, account.id, c.req.param("id"));
        if (!current) return c.json({ error: { code: "not_found", message: "Pin not found" } }, 404);
        updatePinRecord(db, account.id, current, c.req.valid("json"));
        return jsonWithSchema(c, pinSchema, toPin(getPin(db, account.id, current.id)!));
      } finally {
        sqlite.close();
      }
    },
  );

  app.delete("/v1/pins/:id", requireAuth({ dbFactory }), (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const account = getConnectedAccount(db, c.get("auth").userId);
      if (!account) return noConnectedAccount(c);
      const current = getPin(db, account.id, c.req.param("id"));
      if (!current) return c.json({ error: { code: "not_found", message: "Pin not found" } }, 404);
      db.transaction((tx) => {
        tx.delete(pins).where(eq(pins.id, current.id)).run();
        for (const item of tx.select().from(pins).where(eq(pins.accountId, account.id)).orderBy(asc(pins.position)).all()) {
          if (item.position > current.position) tx.update(pins).set({ position: item.position - 1 }).where(eq(pins.id, item.id)).run();
        }
      });
      return c.body(null, 204);
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
      const { view } = c.req.valid("query");
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
          humanSignal: emails.humanSignal,
          labelName: labels.name,
        }).from(emails)
          .leftJoin(emailLabels, eq(emailLabels.emailId, emails.id))
          .leftJoin(labels, eq(labels.id, emailLabels.labelId))
          .where(eq(emails.accountId, account.id))
          .orderBy(desc(emails.receivedAt))
          .limit(100)
          .all();
        const byId = new Map<string, { id: string; providerMessageId: string; threadId: string; fromAddress: string | null; fromName: string | null; subject: string | null; snippet: string | null; receivedAt: Date | null; isRead: boolean; humanSignal: number | null; labels: string[] }>();
        for (const row of rows) {
          const message = byId.get(row.id) ?? {
            ...row,
            labels: [],
          };
          if (row.labelName) message.labels.push(row.labelName);
          byId.set(row.id, message);
        }
        const rules = listSenderRules(db, account.id);
        const resolved = [...byId.values()].map((message) => ({
          ...message,
          attentionBehavior: resolveAttentionBehavior(message.fromAddress, rules),
        }));
        const counts = {
          focus: resolved.filter((message) => message.attentionBehavior === "notify" || message.attentionBehavior === "focus").length,
          normal: resolved.filter((message) => message.attentionBehavior === "normal").length,
          quiet: resolved.filter((message) => message.attentionBehavior === "quiet").length,
          hidden: resolved.filter((message) => message.attentionBehavior === "hidden").length,
          all: resolved.length,
        };
        const filtered = resolved.filter((message) => matchesAttentionView(message.attentionBehavior, view));
        const attentionRank = { notify: 0, focus: 1, normal: 2, quiet: 3, hidden: 4 } as const;
        filtered.sort((a, b) => attentionRank[a.attentionBehavior] - attentionRank[b.attentionBehavior]
          || (b.receivedAt?.getTime() ?? 0) - (a.receivedAt?.getTime() ?? 0)
          || a.id.localeCompare(b.id));
        return jsonWithSchema(c, inboxResponseSchema, {
          account: toMailAccount(account),
          messages: filtered.map((message) => ({
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
            attentionBehavior: message.attentionBehavior,
            humanSignal: message.humanSignal,
          })),
          counts,
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
      if (!result.success) return c.json({ error: { code: "validation_error", message: "An accountId is required to read a thread" } }, 400);
      return result.data;
    }),
    requireAuth({ dbFactory }),
    (c) => {
      const { db, sqlite } = dbFactory();
      try {
        const account = getConnectedAccountById(db, c.get("auth").userId, c.req.valid("query").accountId);
        if (!account) return c.json({ error: { code: "not_found", message: "Thread not found" } }, 404);
        const thread = db.select().from(threads)
          .where(and(eq(threads.id, c.req.param("threadId")), eq(threads.accountId, account.id))).get();
        if (!thread) return c.json({ error: { code: "not_found", message: "Thread not found" } }, 404);

        const messageRows = db.select({
          id: emails.id, providerMessageId: emails.providerMessageId, fromAddress: emails.fromAddress, fromName: emails.fromName,
          toRecipients: emails.toRecipients, ccRecipients: emails.ccRecipients, bccRecipients: emails.bccRecipients,
          subject: emails.subject, snippet: emails.snippet, bodyText: emails.bodyText, bodyHtml: emails.bodyHtml,
          receivedAt: emails.receivedAt, isRead: emails.isRead, isStarred: emails.isStarred, isDraft: emails.isDraft,
          humanSignal: emails.humanSignal, labelName: labels.name,
        }).from(emails).leftJoin(emailLabels, eq(emailLabels.emailId, emails.id)).leftJoin(labels, eq(labels.id, emailLabels.labelId))
          .where(and(eq(emails.threadId, thread.id), eq(emails.accountId, account.id)))
          .orderBy(asc(emails.receivedAt), asc(emails.createdAt), asc(emails.id)).all();
        const attachmentRows = db.select().from(emailAttachments).innerJoin(emails, eq(emails.id, emailAttachments.emailId))
          .where(and(eq(emails.threadId, thread.id), eq(emails.accountId, account.id))).all();
        const messagesById = new Map<string, typeof messageRows[number]>();
        const labelsByMessage = new Map<string, string[]>();
        for (const row of messageRows) {
          messagesById.set(row.id, row);
          const names = labelsByMessage.get(row.id) ?? [];
          if (row.labelName) names.push(row.labelName);
          labelsByMessage.set(row.id, names);
        }
        const attachmentsByMessage = new Map<string, Array<{ id: string; filename: string; mimeType: string; size: number }>>();
        for (const { email_attachments: attachment } of attachmentRows) {
          const attachments = attachmentsByMessage.get(attachment.emailId) ?? [];
          attachments.push({ id: attachment.id, filename: attachment.filename, mimeType: attachment.mimeType, size: attachment.size });
          attachmentsByMessage.set(attachment.emailId, attachments);
        }
        const messages = [...messagesById.values()].map((message) => {
          const bodyHtml = sanitizeProviderHtml(message.bodyHtml);
          return {
            id: message.id, provider: "gmail" as const, providerMessageId: message.providerMessageId,
            from: { name: message.fromName, email: message.fromAddress ?? "unknown@invalid" },
            to: parseContacts(message.toRecipients), cc: parseContacts(message.ccRecipients), bcc: parseContacts(message.bccRecipients),
            subject: message.subject ?? "", snippet: message.snippet ?? "", receivedAt: (message.receivedAt ?? new Date(0)).toISOString(),
            unread: !message.isRead, labels: labelsByMessage.get(message.id) ?? [], bodyText: message.bodyText ?? htmlToText(bodyHtml), bodyHtml,
            attachments: attachmentsByMessage.get(message.id) ?? [],
          };
        });
        const sourceMessages = [...messagesById.values()];
        return jsonWithSchema(c, threadDetailSchema, {
          account: toMailAccount(account),
          thread: {
            id: thread.id, provider: "gmail", providerThreadId: thread.providerThreadId, subject: thread.subject ?? "",
            latestReceivedAt: (thread.latestReceivedAt ?? new Date(0)).toISOString(), messageCount: thread.messageCount,
            labels: [...new Set(messages.flatMap((message) => message.labels))],
            participants: dedupeContacts(messages.flatMap((message) => [message.from, ...message.to, ...message.cc, ...message.bcc])),
            readState: thread.isRead ? "read" : "unread",
            attention: {
              hasUnread: messages.some((message) => message.unread), hasStarred: sourceMessages.some((message) => message.isStarred),
              hasDraft: sourceMessages.some((message) => message.isDraft),
              humanSignal: maxHumanSignal(sourceMessages.map((message) => message.humanSignal)),
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

type Database = ReturnType<typeof createDatabaseClient>["db"];
type SenderRuleRecord = typeof senderAttentionRules.$inferSelect;
type ViewSettingRecord = typeof attentionViewSettings.$inferSelect;
type CollectionRecord = typeof collections.$inferSelect;
type PinRecord = typeof pins.$inferSelect;

class OrganizationTargetError extends Error {}

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

function resolveAttentionBehavior(address: string | null, rules: SenderRuleRecord[]): AttentionBehavior {
  const normalized = address?.trim().toLowerCase() ?? "";
  const addressRule = rules.find((rule) => rule.scope === "address" && rule.value === normalized);
  if (addressRule) return attentionBehaviorSchema.parse(addressRule.behavior);
  const domain = normalized.split("@")[1];
  return attentionBehaviorSchema.parse(rules.find((rule) => rule.scope === "domain" && rule.value === domain)?.behavior ?? "normal");
}

function matchesAttentionView(behavior: AttentionBehavior, view?: "focus" | "normal" | "quiet" | "hidden" | "all") {
  if (!view) return behavior !== "quiet" && behavior !== "hidden";
  if (view === "all") return true;
  if (view === "focus") return behavior === "notify" || behavior === "focus";
  return behavior === view;
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

function listCollectionRecords(db: Database, accountId: string) {
  return db.select().from(collections).where(eq(collections.accountId, accountId)).orderBy(asc(collections.position)).all();
}

function listCollections(db: Database, accountId: string) {
  const memberships = db.select({ collectionId: collectionThreads.collectionId, threadId: collectionThreads.threadId })
    .from(collectionThreads).innerJoin(collections, eq(collections.id, collectionThreads.collectionId))
    .where(eq(collections.accountId, accountId)).orderBy(asc(collectionThreads.createdAt), asc(collectionThreads.id)).all();
  const threadIdsByCollection = new Map<string, string[]>();
  for (const membership of memberships) {
    const threadIds = threadIdsByCollection.get(membership.collectionId) ?? [];
    threadIds.push(membership.threadId);
    threadIdsByCollection.set(membership.collectionId, threadIds);
  }
  return listCollectionRecords(db, accountId).map((collection) => ({
    id: collection.id,
    accountId: collection.accountId,
    name: collection.name,
    position: collection.position,
    threadIds: threadIdsByCollection.get(collection.id) ?? [],
    createdAt: collection.createdAt.toISOString(),
    updatedAt: collection.updatedAt.toISOString(),
  }));
}

function getCollection(db: Database, accountId: string, id: string) {
  return db.select().from(collections).where(and(eq(collections.accountId, accountId), eq(collections.id, id))).get();
}

function updateCollectionRecord(db: Database, accountId: string, current: CollectionRecord, input: { name?: string; position?: number }) {
  const records = listCollectionRecords(db, accountId);
  const nextPosition = Math.min(input.position ?? current.position, Math.max(records.length - 1, 0));
  db.transaction((tx) => {
    if (nextPosition !== current.position) {
      tx.update(collections).set({ position: -1 }).where(eq(collections.id, current.id)).run();
      const moving = records.filter((item) => item.id !== current.id && (
        nextPosition < current.position
          ? item.position >= nextPosition && item.position < current.position
          : item.position > current.position && item.position <= nextPosition
      ));
      for (const item of moving.sort((a, b) => nextPosition < current.position ? b.position - a.position : a.position - b.position)) {
        tx.update(collections).set({ position: item.position + (nextPosition < current.position ? 1 : -1) }).where(eq(collections.id, item.id)).run();
      }
    }
    tx.update(collections).set({ name: input.name?.trim() ?? current.name, position: nextPosition, updatedAt: new Date() }).where(eq(collections.id, current.id)).run();
  });
}

function listPins(db: Database, accountId: string) {
  return db.select().from(pins).where(eq(pins.accountId, accountId)).orderBy(asc(pins.position)).all();
}

function getPin(db: Database, accountId: string, id: string) {
  return db.select().from(pins).where(and(eq(pins.accountId, accountId), eq(pins.id, id))).get();
}

function toPin(pin: PinRecord) {
  return pinSchema.parse({
    id: pin.id, accountId: pin.accountId, kind: pin.kind, targetId: pin.targetId, label: pin.label,
    position: pin.position, createdAt: pin.createdAt.toISOString(), updatedAt: pin.updatedAt.toISOString(),
  });
}

function updatePinRecord(db: Database, accountId: string, current: PinRecord, input: { label?: string; position?: number }) {
  const records = listPins(db, accountId);
  const nextPosition = Math.min(input.position ?? current.position, Math.max(records.length - 1, 0));
  db.transaction((tx) => {
    if (nextPosition !== current.position) {
      tx.update(pins).set({ position: -1 }).where(eq(pins.id, current.id)).run();
      const moving = records.filter((item) => item.id !== current.id && (
        nextPosition < current.position
          ? item.position >= nextPosition && item.position < current.position
          : item.position > current.position && item.position <= nextPosition
      ));
      for (const item of moving.sort((a, b) => nextPosition < current.position ? b.position - a.position : a.position - b.position)) {
        tx.update(pins).set({ position: item.position + (nextPosition < current.position ? 1 : -1) }).where(eq(pins.id, item.id)).run();
      }
    }
    tx.update(pins).set({ label: input.label?.trim() ?? current.label, position: nextPosition, updatedAt: new Date() }).where(eq(pins.id, current.id)).run();
  });
}

function validatePinTarget(db: Database, accountId: string, kind: "sender" | "thread" | "view", targetId: string) {
  const target = targetId.trim();
  if (kind === "thread" && !db.select({ id: threads.id }).from(threads).where(and(eq(threads.accountId, accountId), eq(threads.id, target))).get()) {
    throw new OrganizationTargetError("Thread pins must refer to a thread in this account");
  }
  if (kind === "sender" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(target)) {
    throw new OrganizationTargetError("Sender pins must contain an email address");
  }
  if (kind === "view" && !["inbox", "focus", "quiet", "hidden", "all"].includes(target)) {
    throw new OrganizationTargetError("View pins must refer to an Orca attention view");
  }
}

function organizationConflict(c: Context, error: unknown, message: string) {
  if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) {
    return c.json({ error: { code: "conflict", message } }, 409);
  }
  throw error;
}

function getConnectedAccount(db: ReturnType<typeof createDatabaseClient>["db"], userId: string): ConnectedAccount | undefined {
  return getConnectedAccounts(db, userId)[0];
}

function getConnectedAccountById(db: ReturnType<typeof createDatabaseClient>["db"], userId: string, accountId: string) {
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

function sanitizeProviderHtml(value: string | null) {
  return value === null ? null : sanitizeHtml(value, providerHtmlPolicy) || null;
}

function htmlToText(value: string | null) {
  if (value === null) return null;
  const text = sanitizeHtml(value, { allowedTags: [], allowedAttributes: {} }).replace(/\s+/g, " ").trim();
  return text || null;
}

function parseContacts(value: string | null) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((contact): contact is { name: string | null; email: string } =>
      typeof contact === "object" && contact !== null && (typeof contact.name === "string" || contact.name === null) && typeof contact.email === "string",
    ) : [];
  } catch {
    return [];
  }
}

function dedupeContacts(contacts: Array<{ name: string | null; email: string }>) {
  const unique = new Map<string, { name: string | null; email: string }>();
  for (const contact of contacts) {
    if (!contact.email || contact.email === "unknown@invalid") continue;
    const prior = unique.get(contact.email.toLowerCase());
    if (!prior || (!prior.name && contact.name)) unique.set(contact.email.toLowerCase(), contact);
  }
  return [...unique.values()];
}

function maxHumanSignal(signals: Array<number | null>) {
  const values = signals.filter((value): value is number => value !== null);
  return values.length ? Math.max(...values) : null;
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
