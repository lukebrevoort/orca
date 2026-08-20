import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { createSession } from "./auth/session-store.ts";
import { createDatabaseClient } from "./db/client.ts";
import { emails, messageDrafts, oauthAccounts, threads, users } from "./db/schema.ts";
import { createApp } from "./index.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
  delete process.env.SESSION_SECRET;
  delete process.env.TOKEN_ENCRYPTION_KEY;
});

describe("POST /v1/threads/:threadId/reply-brief", () => {
  test("requires explicit authenticated invocation and never creates or changes a compose draft", async () => {
    process.env.SESSION_SECRET = "reply-brief-session-secret-that-is-long-enough";
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 21).toString("base64");
    const directory = mkdtempSync(join(tmpdir(), "orca-reply-brief-route-"));
    tempDirs.push(directory);
    const dbPath = join(directory, "reply-brief.sqlite");
    const { db, sqlite } = createDatabaseClient(dbPath);
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });
    db.insert(users).values([
      { id: "user-1", email: "me@example.com", displayName: "Me" },
      { id: "user-2", email: "other@example.com", displayName: "Other" },
    ]).run();
    db.insert(oauthAccounts).values([
      { id: "account-1", userId: "user-1", provider: "gmail", providerId: "provider-account-1", providerEmail: "me@example.com", scope: "https://www.googleapis.com/auth/gmail.readonly" },
      { id: "account-2", userId: "user-2", provider: "gmail", providerId: "provider-account-2", providerEmail: "other@example.com", scope: "https://www.googleapis.com/auth/gmail.readonly" },
    ]).run();
    db.insert(threads).values([
      { id: "thread-1", accountId: "account-1", providerThreadId: "provider-thread-1", subject: "Project review", latestReceivedAt: new Date("2026-08-19T17:45:00.000Z"), messageCount: 1 },
      { id: "thread-2", accountId: "account-2", providerThreadId: "provider-thread-2", subject: "Private thread", latestReceivedAt: new Date("2026-08-19T17:45:00.000Z"), messageCount: 1 },
    ]).run();
    db.insert(emails).values([
      { id: "message-1", accountId: "account-1", threadId: "thread-1", providerMessageId: "provider-message-1", fromAddress: "maya@example.com", fromName: "Maya", toRecipients: JSON.stringify([{ name: "Me", email: "me@example.com" }]), subject: "Project review", snippet: "Can we meet Friday?", bodyText: "Can we meet Friday at 10:00 AM for 30 minutes?", receivedAt: new Date("2026-08-19T17:45:00.000Z") },
      { id: "message-2", accountId: "account-2", threadId: "thread-2", providerMessageId: "provider-message-2", fromAddress: "private@example.com", subject: "Private thread", snippet: "Private", bodyText: "Private", receivedAt: new Date("2026-08-19T17:45:00.000Z") },
    ]).run();
    db.insert(messageDrafts).values({ id: "draft-1", accountId: "account-1", subject: "Human-owned draft", bodyText: "The human wrote this." }).run();
    const session = await createSession(db, "user-1");
    const draftBefore = db.select().from(messageDrafts).all();
    sqlite.close();

    const availabilityInvocation: { current: { userId: string; threadId: string } | null } = { current: null };
    const app = createApp({
      dbFactory: () => createDatabaseClient(dbPath),
      now: () => new Date("2026-08-19T18:01:00.000Z"),
      replyBriefAvailability: async ({ userId, thread }) => {
        availabilityInvocation.current = { userId, threadId: thread.thread.id };
        return null;
      },
    });
    const request = {
      trigger: "user_invoked",
      accountId: "account-1",
      provider: "gmail",
      threadId: "thread-1",
      selectedMessageIds: ["message-1"],
      requestedAt: "2026-08-19T18:01:00.000Z",
      userTimeZone: "America/Denver",
      authorizedContext: ["calendar_availability"],
    };

    expect((await app.request("/v1/threads/thread-1/reply-brief?accountId=account-1", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) })).status).toBe(401);

    const headers = { cookie: `orca_session=${session.token}`, "content-type": "application/json" };
    const response = await app.request("/v1/threads/thread-1/reply-brief?accountId=account-1", { method: "POST", headers, body: JSON.stringify(request) });
    expect(response.status).toBe(200);
    const brief = await response.json();
    expect(brief.status).toBe("partial");
    expect(brief.availabilityContext.status).toBe("unavailable");
    expect(brief.humanAuthorship).toEqual({ owner: "human", guidanceOnly: true, composerMutation: "none", composerStartsBlank: true });
    expect(brief.capabilities.writeActions).toEqual([]);
    const invocation = availabilityInvocation.current;
    if (!invocation) throw new Error("calendar availability was not invoked");
    expect(invocation).toEqual({ userId: "user-1", threadId: "thread-1" });

    const background = await app.request("/v1/threads/thread-1/reply-brief?accountId=account-1", {
      method: "POST", headers, body: JSON.stringify({ ...request, trigger: "background_sync" }),
    });
    expect(background.status).toBe(400);
    const otherAccount = await app.request("/v1/threads/thread-2/reply-brief?accountId=account-2", {
      method: "POST", headers, body: JSON.stringify({ ...request, accountId: "account-2", threadId: "thread-2", selectedMessageIds: ["message-2"] }),
    });
    expect(otherAccount.status).toBe(404);

    const verify = createDatabaseClient(dbPath);
    expect(verify.db.select().from(messageDrafts).all()).toEqual(draftBefore);
    verify.sqlite.close();
  });
});
