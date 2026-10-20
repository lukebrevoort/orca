import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createSession } from "./auth/session-store.ts";
import { encryptSecret } from "./auth/gmail/crypto.ts";
import { createDatabaseClient } from "./db/client.ts";
import { messageDrafts, oauthAccounts, users } from "./db/schema.ts";
import { createApp } from "./index.ts";
import { createGmailTransport } from "./providers/gmail/transport.ts";
import { GmailApiError } from "./providers/gmail/client.ts";

for (const priorId of [null, "deleted-copy"]) {
 test(`editing during provider draft creation/recovery reuses its ID (prior ID ${priorId})`, async () => {
  const previousSecret = process.env.SESSION_SECRET;
  const previousKey = process.env.TOKEN_ENCRYPTION_KEY;
  const key = Buffer.alloc(32, 38).toString("base64");
  process.env.SESSION_SECRET = "synthetic-review-session-secret-at-least-32-chars";
  process.env.TOKEN_ENCRYPTION_KEY = key;
  const directory = mkdtempSync(join(tmpdir(), "orca-review-recovery-race-"));
  const databasePath = join(directory, "fixture.sqlite");
  const { db, sqlite } = createDatabaseClient(databasePath);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const updates: string[] = [];
  const creates: string[] = [];
  try {
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });
    db.insert(users).values({ id: "owner", email: "owner@example.test" }).run();
    db.insert(oauthAccounts).values({ id: "account", userId: "owner", provider: "gmail", providerId: "owner",
      providerEmail: "owner@example.test", scope: "https://www.googleapis.com/auth/gmail.compose",
      accessTokenEncrypted: encryptSecret("synthetic-token", key), tokenExpiry: new Date(Date.now() + 3_600_000) }).run();
    db.insert(messageDrafts).values({ id: "local", accountId: "account", providerDraftId: priorId,
      providerSyncStatus: "pending", subject: "Revision zero", bodyText: "Original writing",
      toRecipients: JSON.stringify([{ name: null, email: "recipient@example.test" }]) }).run();
    const transport = createGmailTransport({
      async updateDraft(input) {
        updates.push(input.draftId);
        if (input.draftId === "deleted-copy") throw new GmailApiError("Synthetic missing copy", 404);
        return { id: input.draftId, message: { id: "updated-message", threadId: "thread" } };
      },
      async createDraft() {
        const id = `replacement-${creates.length + 1}`;
        creates.push(id);
        if (creates.length === 1) { started.resolve(); await release.promise; }
        return { id, message: { id: `message-${id}`, threadId: "thread" } };
      },
      async deleteDraft() { assert.fail("No deletion permitted in fixture"); },
      async sendMessage() { assert.fail("No delivery permitted in fixture"); },
    });
    const app = createApp({ dbFactory: () => createDatabaseClient(databasePath), gmailTransport: transport });
    const session = await createSession(db, "owner");
    const headers = { cookie: `orca_session=${session.token}`, "content-type": "application/json" };
    const initial = await app.request("/v1/drafts/local?accountId=account", { headers });
    assert.equal(initial.status, 200);
    await Promise.race([started.promise, new Promise((_, reject) => setTimeout(() => reject(new Error("recovery did not start")), 2000))]);
    const edited = await app.request("/v1/drafts/local?accountId=account", {
      method: "PATCH", headers, body: JSON.stringify({ revision: 0, subject: "Revision one", body: { text: "Latest local writing", html: null } }),
    });
    assert.equal(edited.status, 200);
    assert.equal((await edited.json()).revision, 1);
    release.resolve();
    for (let i = 0; i < 100; i++) {
      const row = db.select().from(messageDrafts).where(eq(messageDrafts.id, "local")).get()!;
      if (row.providerSyncStatus === "synced") break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const final = db.select().from(messageDrafts).where(eq(messageDrafts.id, "local")).get()!;
    console.log(JSON.stringify({ updates, creates, finalProviderDraftId: final.providerDraftId,
      finalRevision: final.revision, finalSubject: final.subject, finalSyncStatus: final.providerSyncStatus }));
    assert.equal(final.providerSyncStatus, "synced", "newest revision completes provider synchronization");
    assert.equal(final.revision, 1);
    assert.equal(final.subject, "Revision one");
    assert.equal(final.bodyText, "Latest local writing");
    assert.equal(final.providerDraftId, "replacement-1");
    assert.equal(creates.length, 1, "recovery must not orphan a provider draft when writing advances");
    assert.deepEqual(updates, priorId ? ["deleted-copy", "replacement-1"] : ["replacement-1"]);
  } finally {
    release.resolve();
    await new Promise(resolve => setTimeout(resolve, 20));
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
    if (previousSecret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = previousSecret;
    if (previousKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY; else process.env.TOKEN_ENCRYPTION_KEY = previousKey;
  }
});
}
