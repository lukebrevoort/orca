import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { eq } from "drizzle-orm";
import { createSession } from "./auth/session-store.ts";
import { createDatabaseClient } from "./db/client.ts";
import { emails, oauthAccounts, threads, users } from "./db/schema.ts";
import { createApp } from "./index.ts";
import { gmailProvider } from "./providers/gmail/provider.ts";
import { ProviderRegistry } from "./providers/registry.ts";

test("explicit draft account scopes reads, writes and delivery without falling back to another account", async () => {
  const previousSecret = process.env.SESSION_SECRET;
  const previousEncryption = process.env.TOKEN_ENCRYPTION_KEY;
  process.env.SESSION_SECRET = "mobile-drafts-test-secret-at-least-32-characters";
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 31).toString("base64");
  const dir = mkdtempSync(join(tmpdir(), "orca-mobile-drafts-"));
  const path = join(dir, "test.sqlite");
  const { db, sqlite } = createDatabaseClient(path);
  migrate(db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });
  try {
    db.insert(users).values([{ id: "owner", email: "owner@example.com" }, { id: "other", email: "other@example.com" }]).run();
    db.insert(oauthAccounts).values([
      { id: "first", userId: "owner", provider: "gmail", providerId: "first", providerEmail: "first@example.com", createdAt: new Date(1) },
      { id: "second", userId: "owner", provider: "gmail", providerId: "second", providerEmail: "second@example.com", createdAt: new Date(2) },
      { id: "foreign", userId: "other", provider: "gmail", providerId: "foreign", providerEmail: "foreign@example.com" },
    ]).run();
    const deliveries: string[] = [];
    const app = createApp({
      dbFactory: () => createDatabaseClient(path),
      providerRegistry: new ProviderRegistry([{
        ...gmailProvider,
        detectCapabilities: () => ({ read: true, draft: false, send: true }),
        createTransport: () => ({
          async saveDraft() { throw new Error("Draft mirroring is disabled in this fixture"); },
          async deleteDraft() {},
          async send(_db, accountId) { deliveries.push(accountId); return { providerMessageId: "sent", providerThreadId: "sent-thread" }; },
        }),
      }]),
    });
    const session = await createSession(db, "owner");
    const headers = { cookie: `orca_session=${session.token}`, "content-type": "application/json" };
    db.insert(threads).values({ id: "second-thread", accountId: "second", providerThreadId: "provider-thread" }).run();
    db.insert(emails).values({ id: "second-message", threadId: "second-thread", accountId: "second", providerMessageId: "provider-message" }).run();
    const readPath = "/v1/threads/second-thread/read?accountId=second";
    assert.equal((await app.request(readPath, { method: "PATCH", headers })).status, 200);
    assert.equal(db.select().from(threads).where(eq(threads.id, "second-thread")).get()!.isRead, true);
    assert.equal((await app.request(readPath, { method: "PATCH", headers, body: JSON.stringify({ isRead: false }) })).status, 200);
    assert.equal(db.select().from(emails).where(eq(emails.id, "second-message")).get()!.isRead, false);
    assert.equal(db.select().from(threads).where(eq(threads.id, "second-thread")).get()!.isRead, false);
    assert.equal((await app.request(readPath, { method: "PATCH", headers, body: JSON.stringify({ isRead: "false" }) })).status, 400);
    assert.equal((await app.request("/v1/threads/second-thread/read?accountId=first", { method: "PATCH", headers })).status, 404);
    for (const [method, route] of [["POST", "/v1/drafts"], ["PATCH", "/v1/drafts/missing"]]) {
      const oversized = await app.request(route!, { method, headers: { ...headers, "content-length": String(36 * 1024 * 1024 + 1) }, body: "{}" });
      assert.equal(oversized.status, 413, `${method} rejects oversized draft bodies before parsing`);
    }
    const create = (account: string) => app.request(`/v1/drafts?accountId=${account}`, {
      method: "POST", headers, body: JSON.stringify({ subject: "Phone draft", to: [{ name: null, email: "recipient@example.com" }] }),
    });
    const result = await create("second");
    assert.equal(result.status, 201);
    const draft = await result.json();
    assert.equal(draft.accountId, "second");
    assert.equal((await (await app.request("/v1/drafts?accountId=first", { headers })).json()).length, 0);
    assert.equal((await (await app.request("/v1/drafts?accountId=second", { headers })).json())[0].id, draft.id);
    for (const account of ["first", "foreign", "missing", ""]) {
      assert.equal((await app.request(`/v1/drafts/${draft.id}?accountId=${account}`, { headers })).status, 404);
      assert.equal((await app.request(`/v1/drafts/${draft.id}?accountId=${account}`, { method: "PATCH", headers, body: JSON.stringify({ revision: 0, subject: "Wrong account" }) })).status, 404);
      assert.equal((await app.request(`/v1/drafts/${draft.id}/send?accountId=${account}`, { method: "POST", headers, body: JSON.stringify({ revision: 0, idempotencyKey: "mobile-send-stable-key" }) })).status, 404);
      assert.equal((await app.request(`/v1/drafts/${draft.id}?accountId=${account}`, { method: "DELETE", headers })).status, 404);
    }
    assert.equal((await create("foreign")).status, 404);
    assert.equal((await create("")).status, 404);
    const update = await app.request(`/v1/drafts/${draft.id}?accountId=second`, { method: "PATCH", headers, body: JSON.stringify({ revision: 0, subject: "Ready" }) });
    assert.equal(update.status, 200);
    const send = () => app.request(`/v1/drafts/${draft.id}/send?accountId=second`, { method: "POST", headers, body: JSON.stringify({ revision: 1, idempotencyKey: "mobile-send-stable-key" }) });
    assert.equal((await (await send()).json()).status, "sent");
    assert.equal((await (await send()).json()).status, "sent");
    assert.deepEqual(deliveries, ["second"]);
    const deletable = await (await create("second")).json();
    assert.equal((await app.request(`/v1/drafts/${deletable.id}?accountId=second`, { method: "DELETE", headers })).status, 204);
  } finally {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
    if (previousSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSecret;
    if (previousEncryption === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = previousEncryption;
  }
});
