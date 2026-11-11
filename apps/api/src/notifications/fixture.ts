// Synthetic test/fixture helpers only. No provider credentials or network access.
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { createMobilePushTestDb, seedAccount, testConfig } from "../mobile-push/test-helpers.ts";
import { createNotificationApp } from "./routes.ts";
import { registerMobilePushRoutes } from "../mobile-push/routes.ts";
import { createDatabaseClient } from "../db/client.ts";
import { createSession } from "../auth/session-store.ts";
import { persistGmailMessages } from "../providers/gmail/sync.ts";
import type { GmailMessage } from "../providers/gmail/types.ts";
import type { AuthVariables } from "../auth/middleware.ts";
export async function notificationFixture() {
  const f = createMobilePushTestDb();
  seedAccount(f.sqlite, "u", "a");
  seedAccount(f.sqlite, "v", "foreign");
  const state = { now: Date.parse("2026-11-11T09:00:00Z") };
  const session = await createSession(f.db, "u"), other = await createSession(f.db, "v");
  const dbFactory = () => createDatabaseClient(f.path);
  const app = new Hono<{ Variables: AuthVariables }>();
  registerMobilePushRoutes(app, { dbFactory, config: testConfig, now: () => new Date(state.now) });
  app.route("/", createNotificationApp({ dbFactory, config: testConfig, now: () => new Date(state.now) }));
  const request = (path: string, body?: unknown, method = body ? "PUT" : "GET", token = session.token) => app.request(path, { method, headers: { cookie: `orca_session=${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const command = (revision = 0, extra: Record<string, unknown> = {}) => ({ channel: "open_app", policyVersion: 1, enabled: true, accountIds: ["a"], permission: "granted", expectedRevision: revision, operationId: randomUUID(), ...extra });
  const adopt = (channel = "open_app", id = "browser", revision = 0, extra: Record<string, unknown> = {}) => request(`/v1/notifications/installations/${id}`, command(revision, { channel, ...extra }));
  async function persist(message: GmailMessage, accountId = "a") {
    return persistGmailMessages(f.db, { accountId, accountEmail: accountId === "a" ? "u@example.com" : "v@example.com", gmailMessages: [message], labelList: [{ id: "UNREAD", name: "Unread" }, { id: "INBOX", name: "Inbox" }, { id: "SENT", name: "Sent" }], now: new Date(state.now), propagationTrigger: "push", propagationOptions: { enabled: false } });
  }
  // Use the real revisioned importance writer; never modify materialized projections.
  async function important(threadId: string, choice: "important" | "not_important" | null = "important", accountId = "a") {
    const { mutateImportance } = await import("../importance/store.ts");
    const current = f.sqlite.query("SELECT revision FROM importance_choices WHERE account_id=? AND kind='conversation' AND target=?").get(accountId, threadId) as { revision: number } | null;
    return mutateImportance(f.sqlite, { userId: "u", accountId }, { accountId, target: { kind: "conversation", threadId }, choice, expectedRevision: current?.revision ?? 0, operationId: randomUUID() }, state.now);
  }
  function message(id: string, thread = `thread-${id}`, extra: Partial<GmailMessage> = {}): GmailMessage {
    return { id, threadId: thread, internalDate: String(state.now), labelIds: ["UNREAD"], payload: { headers: [
      { name: "Delivered-To", value: "u@example.com" }, { name: "Received", value: `from mail.example.net (mail.example.net [192.0.2.1]) by mx.google.com with ESMTPS id abc for <u@example.com>; ${new Date(state.now).toUTCString()}` },
      { name: "Auto-Submitted", value: "auto-generated" }, { name: "From", value: "Receipt robot <receipt@example.net>" }, { name: "Subject", value: `Receipt ${id}` },
    ] }, ...extra };
  }
  function human(id: string, thread: string) {
    const value = message(id, thread);
    value.payload!.headers = [...value.payload!.headers!.filter(h => h.name !== "Auto-Submitted"), { name: "To", value: "u@example.com" }];
    return value;
  }
  async function fresh(id: string, thread = "conversation") {
    // Create conversation while disabled/unimportant, choose importance, then
    // insert a genuinely later arrival whose snapshot must already be Important.
    if (!f.sqlite.query("SELECT 1 FROM threads WHERE id=?").get(`gmail:a:${thread}`)) { await persist(message(`seed-${thread}`, thread)); await important(`gmail:a:${thread}`); }
    state.now += 1000;
    await persist(message(id, thread));
  }
  return { ...f, app, request, command, adopt, persist, important, message, human, fresh, state, session, other };
}
