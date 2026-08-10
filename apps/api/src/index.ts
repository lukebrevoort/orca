import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
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
  createMessageDraftSchema,
  deliveryResultSchema,
  gmailLabelMigrationSchema,
  importGmailLabelsSchema,
  createPinSchema,
  createReminderSchema,
  createSenderAttentionRuleSchema,
  inboxQuerySchema,
  inboxResponseSchema,
  mailAccountPageSchema,
  mailAccountSchema,
  messageDraftSchema,
  pinFilterSchema,
  resolveSenderAttentionSchema,
  resolvedSenderAttentionSchema,
  pinSchema,
  reminderSchema,
  reminderViewSettingsSchema,
  senderAttentionRuleSchema,
  syncStatusSchema,
  sendMessageDraftSchema,
  threadDetailSchema,
  threadQuerySchema,
  updateAttentionViewSettingSchema,
  updateCollectionSchema,
  updatePinSchema,
  updateReminderSchema,
  updateMessageDraftSchema,
  updateSenderAttentionRuleSchema,
  updateUserPreferencesSchema,
  userPreferencesSchema,
} from "@orca/shared";

import { createGmailAuthApp } from "./auth/gmail/routes.ts";
import { detectGmailCapabilities } from "./auth/gmail/capabilities.ts";
import { requireAuth, type AuthVariables } from "./auth/middleware.ts";
import { getServerConfig } from "./config/server.ts";
import { createDatabaseClient } from "./db/client.ts";
import { attentionViewSettings, collections, collectionThreads, emailAttachments, emailLabels, emails, gmailLabelCollectionImports, gmailLabelMigrations, labels, messageDrafts, oauthAccounts, pins, reminderViewSettings, senderAttentionRules, threadReminders, threads, userPreferences, users } from "./db/schema.ts";
import { GmailSyncError, syncGmailAccountPage } from "./providers/gmail/sync.ts";
import { deleteGmailDraft, mirrorGmailDraft, type GmailDraftMirrorInput, type GmailDraftMirrorResult } from "./providers/gmail/drafts.ts";
import { createGmailTransport, GmailTransportError, type GmailTransport } from "./providers/gmail/transport.ts";
import { handleFeedbackRequest } from "./feedback.ts";
import { createLinearFeedbackSubmitter } from "./integrations/linear.ts";

const serverConfig = getServerConfig();
const linearFeedbackSubmitter = createLinearFeedbackSubmitter();

type CreateAppOptions = {
  dbFactory?: typeof createDatabaseClient;
  syncPage?: typeof syncGmailAccountPage;
  gmailTransport?: GmailTransport;
  now?: () => Date;
  mirrorDraft?: (db: Database, input: GmailDraftMirrorInput) => Promise<GmailDraftMirrorResult>;
  deleteProviderDraft?: (db: Database, accountId: string, providerDraftId: string) => Promise<void>;
};

type SyncStatusRecord = { state: "syncing" | "error"; error: string | null };

const defaultViewSettings = [
  { behavior: "notify", displayName: "Notify", icon: "bell", color: "#dc2626", position: 0 },
  { behavior: "focus", displayName: "Focus", icon: "sparkles", color: "#2563eb", position: 1 },
  { behavior: "normal", displayName: "Normal", icon: "inbox", color: "#64748b", position: 2 },
  { behavior: "quiet", displayName: "Quiet", icon: "moon", color: "#7c3aed", position: 3 },
  { behavior: "hidden", displayName: "Hidden", icon: "eye-off", color: "#475569", position: 4 },
] as const;

const defaultInboxLimit = 100;

const collectionColors = ["#70867d", "#a87360", "#6c8195", "#83728d", "#a18757", "#6d716f"] as const;

export function createApp(options: CreateAppOptions = {}): Hono<{
  Variables: AuthVariables;
}> {
  const dbFactory = options.dbFactory ?? createDatabaseClient;
  const syncPage = options.syncPage ?? syncGmailAccountPage;
  const gmailTransport = options.gmailTransport ?? createGmailTransport();
  const now = options.now ?? (() => new Date());
  const mirrorDraft = options.mirrorDraft ?? mirrorGmailDraft;
  const deleteProviderDraft = options.deleteProviderDraft ?? deleteGmailDraft;
  const syncStatuses = new Map<string, SyncStatusRecord>();
  const draftMirrorJobs = new Set<string>();

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

  app.all("/v1/feedback", (c) => handleFeedbackRequest(c.req.raw, {
    allowedOrigin: serverConfig.webOrigin,
    enabled: process.env.NODE_ENV !== "production",
    onReport: linearFeedbackSubmitter,
  }));

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
        onboardingCompletedAt: user.onboardingCompletedAt?.toISOString() ?? null,
      });
    } finally {
      sqlite.close();
    }
  });

  app.post("/v1/auth/onboarding/complete", requireAuth({ dbFactory }), (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const userId = c.get("auth").userId;
      const updated = db.update(users)
        .set({ onboardingCompletedAt: now() })
        .where(eq(users.id, userId))
        .returning({ id: users.id })
        .get();
      if (!updated) {
        return c.json({ error: { code: "unauthorized", message: "Authentication required" } }, 401);
      }
      return c.json({ ok: true });
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

  app.get("/v1/accounts", requireAuth({ dbFactory }), (c) => {
    const { db, sqlite } = dbFactory();
    try {
      return jsonWithSchema(c, mailAccountPageSchema, {
        items: getUnifiedInboxAccounts(db, c.get("auth").userId).map(toMailAccount),
        nextCursor: null,
      });
    } finally {
      sqlite.close();
    }
  });

  app.delete("/v1/accounts/:id", requireAuth({ dbFactory }), (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const deleted = db.delete(oauthAccounts)
        .where(and(eq(oauthAccounts.id, c.req.param("id")), eq(oauthAccounts.userId, c.get("auth").userId)))
        .returning({ id: oauthAccounts.id })
        .get();
      if (!deleted) {
        return c.json({ error: { code: "not_found", message: "Connected account not found" } }, 404);
      }
      syncStatuses.delete(deleted.id);
      return c.body(null, 204);
    } finally {
      sqlite.close();
    }
  });

  app.get("/v1/preferences", requireAuth({ dbFactory }), (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const preference = db.select().from(userPreferences).where(eq(userPreferences.userId, c.get("auth").userId)).get();
      return jsonWithSchema(c, userPreferencesSchema, preference ?? { signature: "", composeFormat: "plain", replyBehavior: "reply", notifyByDefault: false });
    } finally { sqlite.close(); }
  });

  app.patch("/v1/preferences", validator("json", (value, c) => validateJson(c, updateUserPreferencesSchema, value)), requireAuth({ dbFactory }), (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const input = c.req.valid("json");
      const userId = c.get("auth").userId;
      const current = db.select().from(userPreferences).where(eq(userPreferences.userId, userId)).get();
      const next = { signature: current?.signature ?? "", composeFormat: current?.composeFormat ?? "plain", replyBehavior: current?.replyBehavior ?? "reply", notifyByDefault: current?.notifyByDefault ?? false, ...input };
      db.insert(userPreferences).values({ userId, ...next, updatedAt: now() }).onConflictDoUpdate({ target: userPreferences.userId, set: { ...next, updatedAt: now() } }).run();
      return jsonWithSchema(c, userPreferencesSchema, next);
    } finally { sqlite.close(); }
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

  app.get("/v1/gmail-label-migration", requireAuth({ dbFactory }), (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const account = getConnectedAccount(db, c.get("auth").userId);
      if (!account) return noConnectedAccount(c);
      return jsonWithSchema(c, gmailLabelMigrationSchema, getGmailLabelMigration(db, account));
    } finally {
      sqlite.close();
    }
  });

  app.post("/v1/gmail-label-migration/skip", requireAuth({ dbFactory }), (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const account = getConnectedAccount(db, c.get("auth").userId);
      if (!account) return noConnectedAccount(c);
      const current = db.select().from(gmailLabelMigrations).where(eq(gmailLabelMigrations.accountId, account.id)).get();
      if (current?.status !== "completed") {
        const timestamp = now();
        db.insert(gmailLabelMigrations).values({ accountId: account.id, status: "skipped", updatedAt: timestamp })
          .onConflictDoUpdate({ target: gmailLabelMigrations.accountId, set: { status: "skipped", completedAt: null, updatedAt: timestamp } }).run();
      }
      return jsonWithSchema(c, gmailLabelMigrationSchema, getGmailLabelMigration(db, account));
    } finally {
      sqlite.close();
    }
  });

  app.post(
    "/v1/gmail-label-migration/import",
    validator("json", (value, c) => validateJson(c, importGmailLabelsSchema, value)),
    requireAuth({ dbFactory }),
    (c) => {
      const { db, sqlite } = dbFactory();
      try {
        const account = getConnectedAccount(db, c.get("auth").userId);
        if (!account) return noConnectedAccount(c);
        if (!account.lastSyncedAt) {
          return c.json({ error: { code: "sync_incomplete", message: "Gmail must finish its initial sync before labels can be imported" } }, 409);
        }
        const current = db.select().from(gmailLabelMigrations).where(eq(gmailLabelMigrations.accountId, account.id)).get();
        if (current?.status === "completed") {
          return jsonWithSchema(c, gmailLabelMigrationSchema, getGmailLabelMigration(db, account));
        }

        const selectedIds = [...new Set(c.req.valid("json").labelIds)];
        const userLabels = db.select().from(labels).where(and(eq(labels.accountId, account.id), eq(labels.type, "user"))).all();
        const selectedLabels = selectedIds.map((id) => userLabels.find((label) => label.id === id));
        if (selectedLabels.some((label) => !label)) {
          return c.json({ error: { code: "validation_error", message: "Only user-created labels from this Gmail account can be imported" } }, 400);
        }

        const timestamp = now();
        const existingNames = new Set(db.select({ name: collections.name }).from(collections).where(eq(collections.accountId, account.id)).all().map((item) => item.name));
        let position = listCollectionRecords(db, account.id).length;
        db.transaction((tx) => {
          selectedLabels.forEach((label, index) => {
            if (!label) return;
            const name = uniqueImportedCollectionName(label.name, existingNames);
            const collectionId = `collection:${crypto.randomUUID()}`;
            tx.insert(collections).values({ id: collectionId, accountId: account.id, name, color: collectionColors[index % collectionColors.length], position }).run();
            position += 1;
            existingNames.add(name);
            tx.insert(gmailLabelCollectionImports).values({ labelId: label.id, collectionId }).onConflictDoNothing().run();
            const memberships = tx.select({ threadId: emails.threadId }).from(emailLabels)
              .innerJoin(emails, eq(emails.id, emailLabels.emailId)).where(eq(emailLabels.labelId, label.id)).all();
            for (const threadId of new Set(memberships.map((membership) => membership.threadId))) {
              tx.insert(collectionThreads).values({ id: `collection-thread:${crypto.randomUUID()}`, collectionId, threadId }).onConflictDoNothing().run();
            }
          });
          tx.insert(gmailLabelMigrations).values({ accountId: account.id, status: "completed", completedAt: timestamp, updatedAt: timestamp })
            .onConflictDoUpdate({ target: gmailLabelMigrations.accountId, set: { status: "completed", completedAt: timestamp, updatedAt: timestamp } }).run();
        });
        return jsonWithSchema(c, gmailLabelMigrationSchema, getGmailLabelMigration(db, account));
      } finally {
        sqlite.close();
      }
    },
  );

  app.post(
    "/v1/collections",
    validator("json", (value, c) => validateJson(c, createCollectionSchema, value)),
    requireAuth({ dbFactory }),
    (c) => {
      const { db, sqlite } = dbFactory();
      try {
        const account = getConnectedAccount(db, c.get("auth").userId);
        if (!account) return noConnectedAccount(c);
        const input = c.req.valid("json");
        const name = input.name.trim();
        const id = `collection:${crypto.randomUUID()}`;
        db.insert(collections).values({ id, accountId: account.id, name, color: input.color ?? "#70867d", position: listCollectionRecords(db, account.id).length }).run();
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

  app.get("/v1/reminders/view-settings", requireAuth({ dbFactory }), (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const account = getConnectedAccount(db, c.get("auth").userId);
      if (!account) return noConnectedAccount(c);
      return jsonWithSchema(c, reminderViewSettingsSchema, getReminderViewSettings(db, account.id));
    } finally { sqlite.close(); }
  });

  app.patch("/v1/reminders/view-settings", validator("json", (value, c) => validateJson(c, reminderViewSettingsSchema, value)), requireAuth({ dbFactory }), (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const account = getConnectedAccount(db, c.get("auth").userId);
      if (!account) return noConnectedAccount(c);
      const setting = c.req.valid("json");
      db.insert(reminderViewSettings).values({ accountId: account.id, displayName: setting.displayName })
        .onConflictDoUpdate({ target: reminderViewSettings.accountId, set: { displayName: setting.displayName, updatedAt: now() } }).run();
      return jsonWithSchema(c, reminderViewSettingsSchema, getReminderViewSettings(db, account.id));
    } finally { sqlite.close(); }
  });

  app.get("/v1/reminders", requireAuth({ dbFactory }), (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const account = getConnectedAccount(db, c.get("auth").userId);
      if (!account) return noConnectedAccount(c);
      resurfaceDueReminders(db, account.id, now());
      const records = db.select().from(threadReminders).where(eq(threadReminders.accountId, account.id)).orderBy(asc(threadReminders.scheduledFor), asc(threadReminders.id)).all();
      return c.json(records.map(toReminder));
    } finally { sqlite.close(); }
  });

  app.post("/v1/reminders", validator("json", (value, c) => validateJson(c, createReminderSchema, value)), requireAuth({ dbFactory }), (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const account = getConnectedAccount(db, c.get("auth").userId);
      if (!account) return noConnectedAccount(c);
      const input = c.req.valid("json");
      const scheduledFor = validateReminderTime(c, input.scheduledFor, input.timezone, now());
      if (!scheduledFor) return c.json({ error: { code: "validation_error", message: "Choose a future time in a valid timezone" } }, 400);
      const thread = db.select().from(threads).where(and(eq(threads.id, input.threadId), eq(threads.accountId, account.id))).get();
      if (!thread) return c.json({ error: { code: "not_found", message: "Thread not found" } }, 404);
      const existing = db.select().from(threadReminders).where(and(eq(threadReminders.accountId, account.id), eq(threadReminders.threadId, input.threadId), eq(threadReminders.status, "scheduled"))).get();
      const id = existing?.id ?? `reminder:${crypto.randomUUID()}`;
      db.insert(threadReminders).values({ id, accountId: account.id, threadId: input.threadId, scheduledFor, timezone: input.timezone, notify: input.notify ?? false, status: "scheduled" })
        .onConflictDoUpdate({ target: threadReminders.id, set: { scheduledFor, timezone: input.timezone, notify: input.notify ?? false, status: "scheduled", resurfacedAt: null, completedAt: null, cancelledAt: null, updatedAt: now() } }).run();
      return jsonWithSchema(c, reminderSchema, toReminder(db.select().from(threadReminders).where(eq(threadReminders.id, id)).get()!));
    } finally { sqlite.close(); }
  });

  app.patch("/v1/reminders/:id", validator("json", (value, c) => validateJson(c, updateReminderSchema, value)), requireAuth({ dbFactory }), (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const account = getConnectedAccount(db, c.get("auth").userId);
      if (!account) return noConnectedAccount(c);
      const record = db.select().from(threadReminders).where(and(eq(threadReminders.id, c.req.param("id")), eq(threadReminders.accountId, account.id))).get();
      if (!record) return c.json({ error: { code: "not_found", message: "Reminder not found" } }, 404);
      const input = c.req.valid("json");
      const timezone = input.timezone ?? record.timezone;
      const scheduledFor = input.scheduledFor ? validateReminderTime(c, input.scheduledFor, timezone, now()) : record.scheduledFor;
      if (!scheduledFor) return c.json({ error: { code: "validation_error", message: "Choose a future time in a valid timezone" } }, 400);
      db.update(threadReminders).set({ scheduledFor, timezone, notify: input.notify ?? record.notify, status: "scheduled", resurfacedAt: null, completedAt: null, cancelledAt: null, updatedAt: now() }).where(eq(threadReminders.id, record.id)).run();
      return jsonWithSchema(c, reminderSchema, toReminder(db.select().from(threadReminders).where(eq(threadReminders.id, record.id)).get()!));
    } finally { sqlite.close(); }
  });

  app.post("/v1/reminders/:id/done", requireAuth({ dbFactory }), (c) => updateReminderTerminal(c, dbFactory, now, "completed"));
  app.delete("/v1/reminders/:id", requireAuth({ dbFactory }), (c) => updateReminderTerminal(c, dbFactory, now, "cancelled"));

  app.get("/v1/drafts", requireAuth({ dbFactory }), (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const account = getConnectedAccount(db, c.get("auth").userId);
      if (!account) return noConnectedAccount(c);
      const drafts = db.select().from(messageDrafts)
        .where(eq(messageDrafts.accountId, account.id))
        .orderBy(desc(messageDrafts.updatedAt), asc(messageDrafts.id)).all();
      for (const draft of drafts) {
        if (draft.providerSyncStatus === "pending") scheduleDraftMirror(draft.id, draft.revision);
      }
      return c.json(drafts.map(toMessageDraft));
    } finally { sqlite.close(); }
  });

  app.post("/v1/drafts", validator("json", (value, c) => validateJson(c, createMessageDraftSchema, value)), requireAuth({ dbFactory }), async (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const account = getConnectedAccount(db, c.get("auth").userId);
      if (!account) return noConnectedAccount(c);
      const id = crypto.randomUUID();
      const input = c.req.valid("json");
      if (!hasMeaningfulDraftContent(input)) {
        return c.json({
          error: {
            code: "validation_error",
            message: "A draft is created after you add a recipient, subject, message, or attachment",
            retryable: false,
          },
        }, 400);
      }
      const mirrorsToProvider = detectGmailCapabilities(account.scope).draft;
      db.insert(messageDrafts).values({
        id,
        accountId: account.id,
        ...draftStorage(input),
        providerSyncStatus: mirrorsToProvider ? "pending" : "not_applicable",
      }).run();
      if (mirrorsToProvider) scheduleDraftMirror(id, 0);
      return c.json(messageDraftSchema.parse(toMessageDraft(getMessageDraft(db, account.id, id)!)), 201);
    } finally { sqlite.close(); }
  });

  app.get("/v1/drafts/:id", requireAuth({ dbFactory }), (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const account = getConnectedAccount(db, c.get("auth").userId);
      if (!account) return noConnectedAccount(c);
      const draft = getMessageDraft(db, account.id, c.req.param("id"));
      if (!draft) return noDraft(c);
      if (draft.providerSyncStatus === "pending") scheduleDraftMirror(draft.id, draft.revision);
      return jsonWithSchema(c, messageDraftSchema, toMessageDraft(draft));
    } finally { sqlite.close(); }
  });

  app.patch("/v1/drafts/:id", validator("json", (value, c) => validateJson(c, updateMessageDraftSchema, value)), requireAuth({ dbFactory }), async (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const account = getConnectedAccount(db, c.get("auth").userId);
      if (!account) return noConnectedAccount(c);
      const draft = getMessageDraft(db, account.id, c.req.param("id"));
      if (!draft) return noDraft(c);
      const update = c.req.valid("json");
      if (draft.revision !== update.revision) return staleDraft(c, draft.revision);
      if (draft.deliveryStatus !== "draft") {
        return c.json({ error: { code: "ambiguous_delivery", message: "A draft that has begun delivery cannot be edited", retryable: false } }, 409);
      }
      const current = toMessageDraft(draft);
      const content = createMessageDraftSchema.parse({
        to: update.to ?? current.to,
        cc: update.cc ?? current.cc,
        bcc: update.bcc ?? current.bcc,
        subject: update.subject ?? current.subject,
        body: update.body ?? current.body,
        context: update.context ?? current.context,
        attachments: update.attachments ?? current.attachments,
      });
      const mirrorsToProvider = detectGmailCapabilities(account.scope).draft;
      const result = db.update(messageDrafts).set({
        ...draftStorage(content),
        revision: sql`${messageDrafts.revision} + 1`,
        providerSyncStatus: mirrorsToProvider ? "pending" : "not_applicable",
        providerSyncError: null,
        updatedAt: now(),
      })
        .where(and(
          eq(messageDrafts.id, draft.id),
          eq(messageDrafts.accountId, account.id),
          eq(messageDrafts.revision, update.revision),
          eq(messageDrafts.deliveryStatus, "draft"),
          isNull(messageDrafts.sendIdempotencyKey),
        ))
        .returning({ id: messageDrafts.id }).get();
      if (!result) {
        const latest = getMessageDraft(db, account.id, draft.id);
        if (!latest) return noDraft(c);
        if (latest.revision !== update.revision) return staleDraft(c, latest.revision);
        return deliveryStarted(c);
      }
      if (mirrorsToProvider) scheduleDraftMirror(draft.id, update.revision + 1);
      return jsonWithSchema(c, messageDraftSchema, toMessageDraft(getMessageDraft(db, account.id, draft.id)!));
    } finally { sqlite.close(); }
  });

  app.delete("/v1/drafts/:id", requireAuth({ dbFactory }), async (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const account = getConnectedAccount(db, c.get("auth").userId);
      if (!account) return noConnectedAccount(c);
      const draft = getMessageDraft(db, account.id, c.req.param("id"));
      if (!draft) return noDraft(c);
      if (draft.deliveryStatus !== "draft" || draft.sendIdempotencyKey !== null) return deliveryStarted(c);
      if (draft.providerDraftId && detectGmailCapabilities(account.scope).draft) {
        try {
          await deleteProviderDraft(db, account.id, draft.providerDraftId);
        } catch {
          db.update(messageDrafts).set({
            providerSyncStatus: "failed",
            providerSyncError: "Gmail could not discard its mirrored copy. Try again.",
            updatedAt: now(),
          }).where(and(eq(messageDrafts.id, draft.id), eq(messageDrafts.accountId, account.id))).run();
          return c.json({
            error: {
              code: "provider_rejected",
              message: "Gmail could not discard its mirrored copy. The Orca draft was kept so you can retry.",
              retryable: true,
            },
          }, 502);
        }
      }
      const deleted = db.delete(messageDrafts)
        .where(and(
          eq(messageDrafts.id, draft.id),
          eq(messageDrafts.accountId, account.id),
          eq(messageDrafts.deliveryStatus, "draft"),
          isNull(messageDrafts.sendIdempotencyKey),
        ))
        .returning({ id: messageDrafts.id }).get();
      if (!deleted) {
        const latest = getMessageDraft(db, account.id, draft.id);
        return latest ? deliveryStarted(c) : noDraft(c);
      }
      return c.body(null, 204);
    } finally { sqlite.close(); }
  });

  function scheduleDraftMirror(draftId: string, revision: number) {
    if (draftMirrorJobs.has(draftId)) return;
    draftMirrorJobs.add(draftId);
    queueMicrotask(async () => {
      const { db, sqlite } = dbFactory();
      let nextRevision: number | null = null;
      try {
        const draft = db.select().from(messageDrafts).where(and(
          eq(messageDrafts.id, draftId),
          eq(messageDrafts.revision, revision),
          eq(messageDrafts.deliveryStatus, "draft"),
        )).get();
        if (!draft) return;
        const content = createMessageDraftSchema.parse({
          to: parseDraftJson(draft.toRecipients, []),
          cc: parseDraftJson(draft.ccRecipients, []),
          bcc: parseDraftJson(draft.bccRecipients, []),
          subject: draft.subject,
          body: { text: draft.bodyText, html: draft.bodyHtml },
          context: parseDraftJson(draft.context, null),
          attachments: parseDraftJson(draft.attachments, []),
        });
        try {
          const mirrored = await mirrorDraft(db, {
            accountId: draft.accountId,
            content,
            providerDraftId: draft.providerDraftId,
          });
          const updated = db.update(messageDrafts).set({
            providerDraftId: mirrored.providerDraftId,
            providerMessageId: mirrored.providerMessageId,
            providerThreadId: mirrored.providerThreadId,
            providerSyncStatus: "synced",
            providerSyncError: null,
            updatedAt: now(),
          }).where(and(eq(messageDrafts.id, draft.id), eq(messageDrafts.revision, revision)))
            .returning({ id: messageDrafts.id }).get();
          if (!updated) {
            // A newer local revision arrived while Gmail was creating the
            // provider draft. Carry that provider ID forward so the next job
            // updates the same Gmail draft instead of creating an orphan.
            db.update(messageDrafts).set({
              providerDraftId: mirrored.providerDraftId,
              providerMessageId: mirrored.providerMessageId,
              providerThreadId: mirrored.providerThreadId,
            }).where(and(eq(messageDrafts.id, draft.id), isNull(messageDrafts.providerDraftId))).run();
          }
        } catch (error) {
          db.update(messageDrafts).set({
            providerSyncStatus: "failed",
            providerSyncError: error instanceof Error ? error.message : "Gmail could not mirror this draft",
            updatedAt: now(),
          }).where(and(eq(messageDrafts.id, draft.id), eq(messageDrafts.revision, revision))).run();
        }
        const latest = db.select({
          revision: messageDrafts.revision,
          providerSyncStatus: messageDrafts.providerSyncStatus,
        }).from(messageDrafts).where(eq(messageDrafts.id, draftId)).get();
        if (latest?.providerSyncStatus === "pending") nextRevision = latest.revision;
      } finally {
        sqlite.close();
        draftMirrorJobs.delete(draftId);
        if (nextRevision !== null) scheduleDraftMirror(draftId, nextRevision);
      }
    });
  }

  app.post("/v1/drafts/:id/send", validator("json", (value, c) => validateJson(c, sendMessageDraftSchema, value)), requireAuth({ dbFactory }), async (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const account = getConnectedAccount(db, c.get("auth").userId);
      if (!account) return noConnectedAccount(c);
      const draft = getMessageDraft(db, account.id, c.req.param("id"));
      if (!draft) return noDraft(c);
      const command = c.req.valid("json");
      if (draft.revision !== command.revision) return staleDraft(c, draft.revision);
      if (draft.sendIdempotencyKey) {
        if (draft.sendIdempotencyKey !== command.idempotencyKey) {
          return c.json({ error: { code: "ambiguous_delivery", message: "This draft already has a delivery command; inspect its status before retrying", retryable: false } }, 409);
        }
        return jsonWithSchema(c, deliveryResultSchema, toDeliveryResult(draft));
      }
      if (!detectGmailCapabilities(account.scope).send) {
        return c.json({ error: { code: "missing_capability", message: "The connected Gmail account has read-only access and cannot deliver mail", retryable: false } }, 501);
      }
      if (toMessageDraft(draft).attachments.some((attachment) => !attachment.contentBase64)) {
        return c.json({ error: { code: "provider_rejected", message: "Attachments must finish uploading before this message can be delivered", retryable: false } }, 409);
      }
      const reserved = db.update(messageDrafts).set({ deliveryStatus: "sending", sendIdempotencyKey: command.idempotencyKey, updatedAt: now() })
        .where(and(eq(messageDrafts.id, draft.id), eq(messageDrafts.accountId, account.id), eq(messageDrafts.revision, command.revision), isNull(messageDrafts.sendIdempotencyKey), eq(messageDrafts.deliveryStatus, "draft")))
        .returning({ id: messageDrafts.id }).get();
      if (!reserved) return jsonWithSchema(c, deliveryResultSchema, toDeliveryResult(getMessageDraft(db, account.id, draft.id)!));
      const sending = toMessageDraft(getMessageDraft(db, account.id, draft.id)!);
      try {
        const provider = await gmailTransport.send(db, account.id, sending);
        db.update(messageDrafts).set({ deliveryStatus: "sent", providerMessageId: provider.providerMessageId, providerThreadId: provider.providerThreadId, updatedAt: now() }).where(eq(messageDrafts.id, draft.id)).run();
      } catch (error) {
        const transport = asTransportError(error);
        db.update(messageDrafts).set({ deliveryStatus: transport.kind === "rejected" || transport.kind === "auth" ? "rejected" : "ambiguous", updatedAt: now() }).where(eq(messageDrafts.id, draft.id)).run();
      }
      return jsonWithSchema(c, deliveryResultSchema, toDeliveryResult(getMessageDraft(db, account.id, draft.id)!));
    } finally { sqlite.close(); }
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
      const { cursor, limit = defaultInboxLimit, view } = c.req.valid("query");
      const { db, sqlite } = dbFactory();
      try {
        const accounts = getUnifiedInboxAccounts(db, c.get("auth").userId);
        if (accounts.length === 0) {
          return c.json({ error: { code: "not_found", message: "No mail account is connected" } }, 404);
        }

        const resolved: ResolvedInboxMessage[] = [];
        for (const account of accounts) {
          const rows = db.select({
            id: emails.id,
            accountId: emails.accountId,
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
            .orderBy(desc(emails.receivedAt), asc(emails.id), asc(labels.name))
            .all();
          const byId = new Map<string, InboxDatabaseMessage>();
          for (const row of rows) {
            const message = byId.get(row.id) ?? {
              id: row.id,
              accountId: row.accountId,
              providerMessageId: row.providerMessageId,
              threadId: row.threadId,
              fromAddress: row.fromAddress,
              fromName: row.fromName,
              subject: row.subject,
              snippet: row.snippet,
              receivedAt: row.receivedAt,
              isRead: row.isRead,
              humanSignal: row.humanSignal,
              labels: [],
            };
            if (row.labelName && !message.labels.includes(row.labelName)) message.labels.push(row.labelName);
            byId.set(row.id, message);
          }

          const rules = listSenderRules(db, account.id);
          for (const message of byId.values()) {
            resolved.push({
              ...message,
              provider: account.provider,
              attentionBehavior: resolveAttentionBehavior(message.fromAddress, rules),
            });
          }
        }

        const counts = {
          focus: resolved.filter((message) => message.attentionBehavior === "notify" || message.attentionBehavior === "focus").length,
          normal: resolved.filter((message) => message.attentionBehavior === "normal").length,
          quiet: resolved.filter((message) => message.attentionBehavior === "quiet").length,
          hidden: resolved.filter((message) => message.attentionBehavior === "hidden").length,
          all: resolved.length,
        };
        const filtered = resolved.filter((message) => matchesAttentionView(message.attentionBehavior, view));
        filtered.sort(compareInboxMessages);
        const cursorTarget = decodeInboxCursor(cursor);
        const cursorIndex = cursorTarget
          ? filtered.findIndex((message) => message.id === cursorTarget.id && (!cursorTarget.accountId || message.accountId === cursorTarget.accountId))
          : -1;
        const start = cursorIndex >= 0 ? cursorIndex + 1 : 0;
        const page = filtered.slice(start, start + limit);
        const lastMessage = page.at(-1);
        return jsonWithSchema(c, inboxResponseSchema, {
          accounts: accounts.map(toMailAccount),
          messages: page.map((message) => ({
            id: message.id,
            accountId: message.accountId,
            provider: message.provider,
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
          nextCursor: lastMessage && start + page.length < filtered.length
            ? encodeInboxCursor(lastMessage)
            : null,
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
          internetMessageId: emails.internetMessageId, references: emails.references,
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
            id: message.id, accountId: account.id, provider: "gmail" as const, providerMessageId: message.providerMessageId,
            from: { name: message.fromName, email: message.fromAddress ?? "unknown@invalid" },
            to: parseContacts(message.toRecipients), cc: parseContacts(message.ccRecipients), bcc: parseContacts(message.bccRecipients),
            subject: message.subject ?? "", snippet: message.snippet ?? "", receivedAt: (message.receivedAt ?? new Date(0)).toISOString(),
            unread: !message.isRead, labels: labelsByMessage.get(message.id) ?? [], bodyText: message.bodyText ?? htmlToText(bodyHtml), bodyHtml,
            internetMessageId: message.internetMessageId, references: parseDraftJson(message.references, []),
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

  app.patch(
    "/v1/threads/:threadId/read",
    validator("query", (value, c) => {
      const result = threadQuerySchema.safeParse(value);
      if (!result.success) return c.json({ error: { code: "validation_error", message: "An accountId is required to mark a thread as read" } }, 400);
      return result.data;
    }),
    requireAuth({ dbFactory }),
    (c) => {
      const { db, sqlite } = dbFactory();
      try {
        const account = getConnectedAccountById(db, c.get("auth").userId, c.req.valid("query").accountId);
        if (!account) return noConnectedAccount(c);
        const thread = db.select().from(threads)
          .where(and(eq(threads.id, c.req.param("threadId")), eq(threads.accountId, account.id))).get();
        if (!thread) return c.json({ error: { code: "not_found", message: "Thread not found" } }, 404);
        db.update(emails)
          .set({ isRead: true, updatedAt: now() })
          .where(and(eq(emails.threadId, thread.id), eq(emails.accountId, account.id)))
          .run();
        db.update(threads)
          .set({ isRead: true, updatedAt: now() })
          .where(eq(threads.id, thread.id))
          .run();
        return c.json({ ok: true });
      } finally {
        sqlite.close();
      }
    },
  );

  app.route("/v1/auth/gmail", createGmailAuthApp({ dbFactory }));

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
  provider: "gmail" | "outlook";
  providerEmail: string;
  displayName: string | null;
  accessTokenEncrypted: string | null;
  refreshTokenEncrypted: string | null;
  lastSyncedAt: Date | null;
  scope: string | null;
};

type InboxDatabaseMessage = {
  id: string;
  accountId: string;
  providerMessageId: string;
  threadId: string;
  fromAddress: string | null;
  fromName: string | null;
  subject: string | null;
  snippet: string | null;
  receivedAt: Date | null;
  isRead: boolean;
  humanSignal: number | null;
  labels: string[];
};

type ResolvedInboxMessage = InboxDatabaseMessage & {
  provider: ConnectedAccount["provider"];
  attentionBehavior: AttentionBehavior;
};

type InboxCursor = Pick<ResolvedInboxMessage, "accountId" | "id">;

type Database = ReturnType<typeof createDatabaseClient>["db"];
type SenderRuleRecord = typeof senderAttentionRules.$inferSelect;
type ViewSettingRecord = typeof attentionViewSettings.$inferSelect;
type CollectionRecord = typeof collections.$inferSelect;
type PinRecord = typeof pins.$inferSelect;
type ReminderRecord = typeof threadReminders.$inferSelect;
type MessageDraftRecord = typeof messageDrafts.$inferSelect;

class OrganizationTargetError extends Error {}

function validateJson<T>(c: Context, schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } } }, value: unknown) {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const attachmentLimit = result.error.issues.some((issue) => issue.message.includes("Attachments exceed the 25 MB delivery limit"));
  return c.json({
    error: {
      code: attachmentLimit ? "attachment_limit" : "validation_error",
      message: attachmentLimit ? "Attachments exceed the 25 MB delivery limit" : "Invalid request data",
      ...(attachmentLimit ? { retryable: false } : {}),
      issues: result.error.issues.map((issue) => ({ path: issue.path.join(".") || "body", message: issue.message })),
    },
  }, 400);
}

function noConnectedAccount(c: Context) {
  return c.json({ error: { code: "not_found", message: "No Gmail account is connected" } }, 404);
}

function noDraft(c: Context) {
  return c.json({ error: { code: "not_found", message: "Draft not found" } }, 404);
}

function staleDraft(c: Context, currentRevision: number) {
  return c.json({
    error: {
      code: "stale_draft",
      message: "This draft changed somewhere else. Reload it before saving again.",
      retryable: true,
      currentRevision,
    },
  }, 409);
}

function deliveryStarted(c: Context) {
  return c.json({
    error: {
      code: "ambiguous_delivery",
      message: "A draft with a reserved delivery command cannot be changed or discarded",
      retryable: false,
    },
  }, 409);
}

function asTransportError(error: unknown) {
  return error instanceof GmailTransportError
    ? error
    : new GmailTransportError("The delivery outcome could not be confirmed", "ambiguous", true);
}

function transportError(c: Context, error: unknown) {
  const transport = asTransportError(error);
  const code = transport.kind === "ambiguous" ? "ambiguous_delivery" : "provider_rejected";
  const status = transport.kind === "auth" ? 401 : transport.kind === "rate_limit" ? 429 : transport.kind === "ambiguous" ? 503 : 422;
  return c.json({ error: { code, message: transport.message, retryable: transport.retryable } }, status);
}

function getMessageDraft(db: Database, accountId: string, id: string) {
  return db.select().from(messageDrafts)
    .where(and(eq(messageDrafts.id, id), eq(messageDrafts.accountId, accountId))).get();
}

function draftStorage(input: ReturnType<typeof createMessageDraftSchema.parse>) {
  return {
    toRecipients: JSON.stringify(input.to),
    ccRecipients: JSON.stringify(input.cc),
    bccRecipients: JSON.stringify(input.bcc),
    subject: input.subject,
    bodyText: input.body.text,
    bodyHtml: sanitizeOutboundHtml(input.body.html),
    context: input.context ? JSON.stringify(input.context) : null,
    attachments: JSON.stringify(input.attachments),
  };
}

function hasMeaningfulDraftContent(input: ReturnType<typeof createMessageDraftSchema.parse>) {
  return input.to.length + input.cc.length + input.bcc.length > 0
    || Boolean(input.subject.trim())
    || Boolean(input.body.text.trim())
    || Boolean(input.body.html?.trim())
    || input.attachments.length > 0;
}

function toMessageDraft(draft: MessageDraftRecord): ReturnType<typeof messageDraftSchema.parse> {
  return messageDraftSchema.parse({
    id: draft.id,
    accountId: draft.accountId,
    to: parseDraftJson(draft.toRecipients, []),
    cc: parseDraftJson(draft.ccRecipients, []),
    bcc: parseDraftJson(draft.bccRecipients, []),
    subject: draft.subject,
    body: { text: draft.bodyText, html: draft.bodyHtml },
    context: parseDraftJson(draft.context, null),
    attachments: parseDraftJson(draft.attachments, []),
    revision: draft.revision,
    deliveryStatus: draft.deliveryStatus,
    providerSyncStatus: draft.providerSyncStatus,
    providerSyncError: draft.providerSyncError,
    providerDraftId: draft.providerDraftId,
    providerMessageId: draft.providerMessageId,
    providerThreadId: draft.providerThreadId,
    createdAt: draft.createdAt.toISOString(),
    updatedAt: draft.updatedAt.toISOString(),
  });
}

function parseDraftJson(value: string | null, fallback: unknown) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function toDeliveryResult(draft: MessageDraftRecord) {
  const error = draft.deliveryStatus === "rejected"
    ? { code: "provider_rejected" as const, message: "The provider rejected this delivery", retryable: false }
    : draft.deliveryStatus === "ambiguous"
      ? { code: "ambiguous_delivery" as const, message: "The provider outcome could not be confirmed", retryable: false }
      : null;
  return {
    draftId: draft.id,
    status: draft.deliveryStatus as "draft" | "queued" | "sending" | "sent" | "rejected" | "ambiguous",
    providerMessageId: draft.providerMessageId,
    providerThreadId: draft.providerThreadId,
    error,
  };
}

function getReminderViewSettings(db: Database, accountId: string) {
  const setting = db.select().from(reminderViewSettings).where(eq(reminderViewSettings.accountId, accountId)).get();
  return { displayName: setting?.displayName ?? "Later" };
}

function isValidTimeZone(timezone: string) {
  try { Intl.DateTimeFormat(undefined, { timeZone: timezone }); return true; } catch { return false; }
}

function validateReminderTime(_c: Context, isoTime: string, timezone: string, currentTime: Date) {
  const scheduledFor = new Date(isoTime);
  if (!isValidTimeZone(timezone) || Number.isNaN(scheduledFor.getTime()) || scheduledFor.getTime() <= currentTime.getTime()) return null;
  return scheduledFor;
}

function toReminder(reminder: ReminderRecord) {
  return {
    id: reminder.id, accountId: reminder.accountId, threadId: reminder.threadId,
    scheduledFor: reminder.scheduledFor.toISOString(), timezone: reminder.timezone, notify: reminder.notify,
    status: reminder.status as "scheduled" | "resurfaced" | "completed" | "cancelled",
    resurfacedAt: reminder.resurfacedAt?.toISOString() ?? null,
    completedAt: reminder.completedAt?.toISOString() ?? null,
    cancelledAt: reminder.cancelledAt?.toISOString() ?? null,
    createdAt: reminder.createdAt.toISOString(), updatedAt: reminder.updatedAt.toISOString(),
  };
}

function resurfaceDueReminders(db: Database, accountId: string, currentTime: Date) {
  db.update(threadReminders).set({ status: "resurfaced", resurfacedAt: currentTime, updatedAt: currentTime })
    .where(and(eq(threadReminders.accountId, accountId), eq(threadReminders.status, "scheduled"), sql`${threadReminders.scheduledFor} <= ${currentTime.getTime()}`)).run();
}

function updateReminderTerminal(
  c: Context<{ Variables: AuthVariables }>,
  dbFactory: typeof createDatabaseClient,
  now: () => Date,
  status: "completed" | "cancelled",
) {
  const { db, sqlite } = dbFactory();
  try {
    const account = getConnectedAccount(db, c.get("auth").userId);
    if (!account) return noConnectedAccount(c);
    const reminderId = c.req.param("id");
    if (!reminderId) return c.json({ error: { code: "not_found", message: "Reminder not found" } }, 404);
    const record = db.select().from(threadReminders).where(and(eq(threadReminders.id, reminderId), eq(threadReminders.accountId, account.id))).get();
    if (!record) return c.json({ error: { code: "not_found", message: "Reminder not found" } }, 404);
    if (record.status !== status) {
      const timestamp = now();
      db.update(threadReminders).set({ status, completedAt: status === "completed" ? timestamp : record.completedAt, cancelledAt: status === "cancelled" ? timestamp : record.cancelledAt, updatedAt: timestamp }).where(eq(threadReminders.id, record.id)).run();
    }
    const updated = db.select().from(threadReminders).where(eq(threadReminders.id, record.id)).get()!;
    return status === "cancelled" ? c.body(null, 204) : jsonWithSchema(c, reminderSchema, toReminder(updated));
  } finally { sqlite.close(); }
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

const inboxAttentionRank = { notify: 0, focus: 1, normal: 2, quiet: 3, hidden: 4 } as const;

function compareInboxMessages(a: ResolvedInboxMessage, b: ResolvedInboxMessage) {
  return inboxAttentionRank[a.attentionBehavior] - inboxAttentionRank[b.attentionBehavior]
    || (b.receivedAt?.getTime() ?? 0) - (a.receivedAt?.getTime() ?? 0)
    || a.accountId.localeCompare(b.accountId)
    || a.id.localeCompare(b.id);
}

function encodeInboxCursor(message: InboxCursor) {
  return Buffer.from(JSON.stringify(message), "utf8").toString("base64url");
}

function decodeInboxCursor(value: string | undefined): InboxCursor | null {
  if (!value) return null;

  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<InboxCursor>;
    if (typeof parsed.accountId === "string" && parsed.accountId.length > 0 && typeof parsed.id === "string" && parsed.id.length > 0) {
      return { accountId: parsed.accountId, id: parsed.id };
    }
  } catch {
    // Keep accepting legacy opaque cursors. They cannot select a page unless
    // they identify a returned message, but they remain safe to retry.
  }

  return { accountId: "", id: value };
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

function getGmailLabelMigration(db: Database, account: ConnectedAccount) {
  const userLabels = db.select().from(labels)
    .where(and(eq(labels.accountId, account.id), eq(labels.type, "user")))
    .orderBy(asc(labels.name), asc(labels.id)).all();
  const importedLabelIds = new Set(db.select({ labelId: gmailLabelCollectionImports.labelId }).from(gmailLabelCollectionImports)
    .innerJoin(labels, eq(labels.id, gmailLabelCollectionImports.labelId))
    .where(eq(labels.accountId, account.id)).all().map((item) => item.labelId));
  const membershipRows = db.select({ labelId: emailLabels.labelId, threadId: emails.threadId }).from(emailLabels)
    .innerJoin(emails, eq(emails.id, emailLabels.emailId))
    .where(eq(emails.accountId, account.id)).all();
  const threadIdsByLabel = new Map<string, Set<string>>();
  for (const membership of membershipRows) {
    const threadIds = threadIdsByLabel.get(membership.labelId) ?? new Set<string>();
    threadIds.add(membership.threadId);
    threadIdsByLabel.set(membership.labelId, threadIds);
  }
  const migration = db.select().from(gmailLabelMigrations).where(eq(gmailLabelMigrations.accountId, account.id)).get();
  return {
    status: migration?.status ?? "pending",
    ready: account.lastSyncedAt !== null,
    labels: userLabels.map((label) => ({
      id: label.id,
      name: label.name,
      threadCount: threadIdsByLabel.get(label.id)?.size ?? 0,
      imported: importedLabelIds.has(label.id),
    })),
    completedAt: migration?.completedAt?.toISOString() ?? null,
  };
}

function uniqueImportedCollectionName(labelName: string, existingNames: Set<string>) {
  const base = labelName.trim().slice(0, 80) || "Imported label";
  if (!existingNames.has(base)) return base;
  const suffix = " (Gmail)";
  const gmailName = `${base.slice(0, 80 - suffix.length)}${suffix}`;
  if (!existingNames.has(gmailName)) return gmailName;
  let sequence = 2;
  while (sequence < 10_000) {
    const numberedSuffix = ` (Gmail ${sequence})`;
    const candidate = `${base.slice(0, 80 - numberedSuffix.length)}${numberedSuffix}`;
    if (!existingNames.has(candidate)) return candidate;
    sequence += 1;
  }
  throw new Error("Could not create a unique Collection name for the Gmail label");
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
    color: collection.color,
    position: collection.position,
    threadIds: threadIdsByCollection.get(collection.id) ?? [],
    createdAt: collection.createdAt.toISOString(),
    updatedAt: collection.updatedAt.toISOString(),
  }));
}

function getCollection(db: Database, accountId: string, id: string) {
  return db.select().from(collections).where(and(eq(collections.accountId, accountId), eq(collections.id, id))).get();
}

function updateCollectionRecord(db: Database, accountId: string, current: CollectionRecord, input: { name?: string; color?: string; position?: number }) {
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
    tx.update(collections).set({ name: input.name?.trim() ?? current.name, color: input.color ?? current.color, position: nextPosition, updatedAt: new Date() }).where(eq(collections.id, current.id)).run();
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

function validatePinTarget(db: Database, accountId: string, kind: "sender" | "thread" | "view" | "filter", targetId: string) {
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
  if (kind === "filter") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(target);
    } catch {
      throw new OrganizationTargetError("Filter pins must contain a valid filter definition");
    }
    if (!pinFilterSchema.safeParse(parsed).success) {
      throw new OrganizationTargetError("Filter pins must contain a supported filter definition");
    }
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
  return selectConnectedAccounts(db, userId, "gmail");
}

function getUnifiedInboxAccounts(db: ReturnType<typeof createDatabaseClient>["db"], userId: string): ConnectedAccount[] {
  return selectConnectedAccounts(db, userId);
}

function selectConnectedAccounts(
  db: ReturnType<typeof createDatabaseClient>["db"],
  userId: string,
  provider?: ConnectedAccount["provider"],
): ConnectedAccount[] {
  const ownership = provider
    ? and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, provider))
    : eq(oauthAccounts.userId, userId);
  return db.select({
    id: oauthAccounts.id,
    provider: oauthAccounts.provider,
    providerEmail: oauthAccounts.providerEmail,
    displayName: users.displayName,
    accessTokenEncrypted: oauthAccounts.accessTokenEncrypted,
    refreshTokenEncrypted: oauthAccounts.refreshTokenEncrypted,
    lastSyncedAt: oauthAccounts.lastSyncedAt,
    scope: oauthAccounts.scope,
  })
    .from(oauthAccounts)
    .innerJoin(users, eq(users.id, oauthAccounts.userId))
    .where(ownership)
    .orderBy(asc(oauthAccounts.createdAt), asc(oauthAccounts.id))
    .all() as ConnectedAccount[];
}

function toMailAccount(account: ConnectedAccount) {
  return {
    id: account.id,
    provider: account.provider,
    email: account.providerEmail,
    displayName: account.displayName ?? account.providerEmail.split("@")[0] ?? account.providerEmail,
    capabilities: account.provider === "gmail"
      ? detectGmailCapabilities(account.scope)
      : { read: true, draft: false, send: false },
  };
}

const providerHtmlPolicy: sanitizeHtml.IOptions = {
  allowedTags: [
    "a", "abbr", "address", "article", "aside", "b", "blockquote", "br", "caption",
    "cite", "code", "col", "colgroup", "dd", "del", "details", "div", "dl", "dt",
    "em", "fieldset", "figcaption", "figure", "footer", "h1", "h2", "h3", "h4",
    "h5", "h6", "header", "hr", "i", "img", "ins", "legend", "li", "main", "mark",
    "nav", "ol", "p", "pre", "s", "section", "small", "span", "strong", "sub",
    "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "time", "tr",
    "u", "ul",
  ],
  allowedAttributes: {
    a: ["href", "title", "target", "rel", "name"],
    img: ["src", "alt", "width", "height", "title"],
    td: ["colspan", "rowspan", "align", "valign", "width", "height", "style"],
    th: ["colspan", "rowspan", "align", "valign", "width", "height", "style"],
    table: ["border", "cellpadding", "cellspacing", "width", "align", "style"],
    col: ["width", "style"],
    colgroup: ["width", "span", "style"],
    tr: ["align", "valign", "style"],
    div: ["align", "style", "data-email-preheader"],
    p: ["align", "style"],
    span: ["style"],
    "*": ["class", "style"],
  },
  allowedSchemes: ["http", "https", "mailto", "cid"],
  disallowedTagsMode: "discard",
  exclusiveFilter: (frame) => {
    if (frame.tag !== "div") return false;
    if (frame.attribs["data-email-preheader"] === "true") return true;
    const style = frame.attribs.style ?? "";
    const hasHiddenStyle = /(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0)/i.test(style);
    const hasZeroSize = /(?:height|max-height|width|max-width)\s*:\s*0(?:px)?/i.test(style);
    return hasHiddenStyle && hasZeroSize;
  },
  allowedStyles: {
    "*": {
      "margin": [/.*/],
      "margin-top": [/.*/],
      "margin-right": [/.*/],
      "margin-bottom": [/.*/],
      "margin-left": [/.*/],
      "padding": [/.*/],
      "padding-top": [/.*/],
      "padding-right": [/.*/],
      "padding-bottom": [/.*/],
      "padding-left": [/.*/],
      "width": [/.*/],
      "height": [/.*/],
      "max-width": [/.*/],
      "max-height": [/.*/],
      "min-width": [/.*/],
      "min-height": [/.*/],
      "text-align": [/.*/],
      "visibility": [/.*/],
      "opacity": [/.*/],
      "overflow": [/.*/],
      "overflow-x": [/.*/],
      "overflow-y": [/.*/],
      "vertical-align": [/.*/],
      "font-family": [/.*/],
      "font-size": [/.*/],
      "font-weight": [/.*/],
      "font-style": [/.*/],
      "line-height": [/.*/],
      "letter-spacing": [/.*/],
      "text-decoration": [/.*/],
      "text-transform": [/.*/],
      "border": [/.*/],
      "border-top": [/.*/],
      "border-right": [/.*/],
      "border-bottom": [/.*/],
      "border-left": [/.*/],
      "border-radius": [/.*/],
      "border-collapse": [/.*/],
      "border-spacing": [/.*/],
      "display": [/.*/],
      "float": [/.*/],
      "white-space": [/.*/],
      "word-break": [/.*/],
      "overflow-wrap": [/.*/],
      "table-layout": [/.*/],
    },
  },
  transformTags: {
    a: (_tagName, attributes) => ({
      tagName: "a",
      attribs: { ...attributes, target: "_blank", rel: "noopener noreferrer" },
    }),
  },
};

function sanitizeProviderHtml(value: string | null) {
  return value === null ? null : sanitizeHtml(value, providerHtmlPolicy) || null;
}

function sanitizeOutboundHtml(value: string | null) {
  return sanitizeProviderHtml(value);
}

function htmlToText(value: string | null) {
  if (value === null) return null;
  const visibleHtml = sanitizeProviderHtml(value);
  if (visibleHtml === null) return null;
  const text = sanitizeHtml(visibleHtml, { allowedTags: [], allowedAttributes: {} }).replace(/\s+/g, " ").trim();
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
