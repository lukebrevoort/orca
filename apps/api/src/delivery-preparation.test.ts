import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createMessageDraftSchema } from "@orca/shared";

import { encryptSecret } from "./auth/gmail/crypto.ts";
import { createSession } from "./auth/session-store.ts";
import { createDatabaseClient } from "./db/client.ts";
import { oauthAccounts, users } from "./db/schema.ts";
import { createApp } from "./index.ts";
import { GmailApiError } from "./providers/gmail/client.ts";
import { gmailProvider } from "./providers/gmail/provider.ts";
import { createGmailTransport } from "./providers/gmail/transport.ts";
import { ProviderRegistry } from "./providers/registry.ts";

for (const failure of ["credentials", "token_refresh", "threading", "mime", "dispatch"] as const) {
  test(`${failure} failure preserves the delivery boundary and replay safety`, async () => {
    const previousSecret = process.env.SESSION_SECRET;
    const previousEncryption = process.env.TOKEN_ENCRYPTION_KEY;
    const previousClientId = process.env.GMAIL_CLIENT_ID;
    const previousClientSecret = process.env.GMAIL_CLIENT_SECRET;
    process.env.SESSION_SECRET = "delivery-preparation-test-secret-at-least-32-characters";
    const encryptionKey = Buffer.alloc(32, 35).toString("base64");
    process.env.TOKEN_ENCRYPTION_KEY = encryptionKey;
    if (failure === "token_refresh") {
      // Force a local refresh-configuration failure before any token HTTP call.
      process.env.GMAIL_CLIENT_ID = "";
      process.env.GMAIL_CLIENT_SECRET = "";
    }
    const directory = mkdtempSync(join(tmpdir(), "orca-delivery-preparation-"));
    const databasePath = join(directory, "test.sqlite");
    const { db, sqlite } = createDatabaseClient(databasePath);
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });
    let failing = true;
    let sendCalls = 0;
    const transport = createGmailTransport({
      async getMessage() {
        if (failing && failure === "threading") throw new GmailApiError("Synthetic metadata outage", 503);
        return {
          id: "source-message", threadId: "provider-thread",
          payload: { headers: [{ name: "Message-ID", value: "<source@example.com>" }] },
        };
      },
      async createDraft() { throw new Error("Mirroring is disabled in this fixture"); },
      async updateDraft() { throw new Error("Mirroring is disabled in this fixture"); },
      async deleteDraft() { throw new Error("Provider deletion is disabled in this fixture"); },
      async sendMessage() {
        sendCalls += 1;
        if (failing && failure === "dispatch") throw new GmailApiError("Synthetic uncertain send response", 503);
        return { id: "sent-message", threadId: "sent-thread" };
      },
    });
    try {
      db.insert(users).values({ id: "owner", email: "owner@example.com" }).run();
      db.insert(oauthAccounts).values({
        id: "account", userId: "owner", provider: "gmail", providerId: "provider-owner",
        providerEmail: "owner@example.com", scope: "https://www.googleapis.com/auth/gmail.compose",
        accessTokenEncrypted: failure === "credentials"
          ? "invalid-synthetic-ciphertext" : encryptSecret("synthetic-access-token", encryptionKey),
        refreshTokenEncrypted: failure === "token_refresh" ? encryptSecret("synthetic-refresh-token", encryptionKey) : null,
        tokenExpiry: failure === "token_refresh" ? new Date(0) : new Date(Date.now() + 3_600_000),
      }).run();
      const session = await createSession(db, "owner");
      const headers = { cookie: `orca_session=${session.token}`, "content-type": "application/json" };
      const app = createApp({
        dbFactory: () => createDatabaseClient(databasePath),
        gmailTransport: transport,
        providerRegistry: new ProviderRegistry([{
          ...gmailProvider, detectCapabilities: () => ({ read: true, draft: false, send: true }),
        }]),
      });
      const content = createMessageDraftSchema.parse({
        to: [{ name: null, email: "recipient@example.com" }],
        // A single word can pass the subject-length schema while exceeding the
        // MIME line limit once the Subject header prefix is included.
        subject: failure === "mime" ? "x".repeat(998) : "Prepared reply",
        body: { text: "Preserve this writing", html: null },
        context: failure === "threading" ? {
          kind: "reply", threadId: "local-thread", messageId: "local-message",
          providerMessageId: "source-message", providerThreadId: "provider-thread",
          inReplyTo: null, references: [],
        } : null,
      });
      const create = (input = content) => app.request("/v1/drafts?accountId=account", {
        method: "POST", headers, body: JSON.stringify(input),
      });
      const createdResponse = await create();
      assert.equal(createdResponse.status, 201);
      const draft = await createdResponse.json();
      const send = (draftId: string, key: string) => app.request(`/v1/drafts/${draftId}/send?accountId=account`, {
        method: "POST", headers, body: JSON.stringify({ revision: 0, idempotencyKey: key }),
      });
      const originalKey = `preparation-${failure}-original`;
      const response = await send(draft.id, originalKey);
      assert.equal(response.status, 200);
      const receipt = await response.json();
      assert.equal(receipt.status, failure === "dispatch" ? "ambiguous" : "rejected");
      assert.equal(sendCalls, failure === "dispatch" ? 1 : 0);

      // Provider recovery never silently retries the reserved original draft.
      failing = false;
      db.update(oauthAccounts).set({
        accessTokenEncrypted: encryptSecret("recovered-synthetic-token", encryptionKey),
        tokenExpiry: new Date(Date.now() + 3_600_000),
      })
        .where(eq(oauthAccounts.id, "account")).run();
      const replay = await send(draft.id, originalKey);
      assert.equal(replay.status, 200);
      assert.deepEqual(await replay.json(), receipt);
      assert.equal((await send(draft.id, `${originalKey}-changed`)).status, 409);
      assert.equal(sendCalls, failure === "dispatch" ? 1 : 0);

      if (failure !== "dispatch") {
        // A deliberate edit-copy action creates a new draft and delivery key.
        // No such copy is created for an uncertain post-dispatch outcome.
        const copyResponse = await create({ ...content, subject: "Prepared reply" });
        assert.equal(copyResponse.status, 201);
        const copy = await copyResponse.json();
        const copyKey = `preparation-${failure}-copy`;
        assert.equal((await (await send(copy.id, copyKey)).json()).status, "sent");
        assert.equal((await (await send(copy.id, copyKey)).json()).status, "sent");
        assert.equal(sendCalls, 1);
      }
    } finally {
      sqlite.close();
      rmSync(directory, { recursive: true, force: true });
      if (previousSecret === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = previousSecret;
      if (previousEncryption === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
      else process.env.TOKEN_ENCRYPTION_KEY = previousEncryption;
      if (previousClientId === undefined) delete process.env.GMAIL_CLIENT_ID;
      else process.env.GMAIL_CLIENT_ID = previousClientId;
      if (previousClientSecret === undefined) delete process.env.GMAIL_CLIENT_SECRET;
      else process.env.GMAIL_CLIENT_SECRET = previousClientSecret;
    }
  });
}
