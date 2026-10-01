import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { createSession } from "./auth/session-store.ts";
import { createDatabaseClient } from "./db/client.ts";
import { messageDrafts, oauthAccounts, users } from "./db/schema.ts";
import { createApp } from "./index.ts";
import type { GmailTransport } from "./providers/gmail/transport.ts";

for (const mirrorOutcome of ["success", "failure"] as const) {
  test(`a late draft mirror ${mirrorOutcome} cannot change a sent receipt`, async () => {
    const previousSecret = process.env.SESSION_SECRET;
    const previousEncryption = process.env.TOKEN_ENCRYPTION_KEY;
    process.env.SESSION_SECRET = "late-draft-mirror-test-secret-at-least-32-characters";
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 34).toString("base64");
    const directory = mkdtempSync(join(tmpdir(), "orca-late-draft-mirror-"));
    const databasePath = join(directory, "test.sqlite");
    const { db, sqlite } = createDatabaseClient(databasePath);
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });
    const mirrorStarted = Promise.withResolvers<void>();
    const mirrorRelease = Promise.withResolvers<void>();
    let sendCalls = 0;
    const transport: GmailTransport = {
      async saveDraft() {
        mirrorStarted.resolve();
        await mirrorRelease.promise;
        if (mirrorOutcome === "failure") throw new Error("Delayed draft mirror failed");
        return { providerDraftId: "provider-draft", providerMessageId: "draft-message", providerThreadId: "draft-thread" };
      },
      async deleteDraft() {},
      async send() {
        sendCalls += 1;
        return { providerMessageId: "sent-message", providerThreadId: "sent-thread" };
      },
    };
    try {
      db.insert(users).values({ id: "owner", email: "owner@example.com" }).run();
      db.insert(oauthAccounts).values({
        id: "account", userId: "owner", provider: "gmail", providerId: "provider-owner",
        providerEmail: "owner@example.com", scope: "https://www.googleapis.com/auth/gmail.compose",
      }).run();
      const session = await createSession(db, "owner");
      const headers = { cookie: `orca_session=${session.token}`, "content-type": "application/json" };
      const app = createApp({ dbFactory: () => createDatabaseClient(databasePath), gmailTransport: transport });
      const createdResponse = await app.request("/v1/drafts?accountId=account", {
        method: "POST", headers,
        body: JSON.stringify({ to: [{ name: null, email: "recipient@example.com" }], subject: "Compose before mirror completes" }),
      });
      assert.equal(createdResponse.status, 201);
      const draft = await createdResponse.json();
      await mirrorStarted.promise;
      const send = () => app.request(`/v1/drafts/${draft.id}/send?accountId=account`, {
        method: "POST", headers, body: JSON.stringify({ revision: draft.revision, idempotencyKey: "late-mirror-send-key" }),
      });
      const firstResponse = await send();
      assert.equal(firstResponse.status, 200);
      const receipt = await firstResponse.json();
      assert.equal(receipt.status, "sent");
      const storedReceipt = db.select().from(messageDrafts).where(eq(messageDrafts.id, draft.id)).get()!;

      mirrorRelease.resolve();
      // Drain the mirror promise and its database write before checking replay.
      await new Promise((resolve) => setTimeout(resolve, 0));

      const replayResponse = await send();
      assert.equal(replayResponse.status, 200);
      assert.deepEqual(await replayResponse.json(), receipt);
      assert.deepEqual(db.select().from(messageDrafts).where(eq(messageDrafts.id, draft.id)).get(), storedReceipt);
      assert.equal(sendCalls, 1);
    } finally {
      mirrorRelease.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      sqlite.close();
      rmSync(directory, { recursive: true, force: true });
      if (previousSecret === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = previousSecret;
      if (previousEncryption === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
      else process.env.TOKEN_ENCRYPTION_KEY = previousEncryption;
    }
  });
}
