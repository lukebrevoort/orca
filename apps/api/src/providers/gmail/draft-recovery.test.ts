import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { MessageDraft } from "@orca/shared";
import { encryptSecret } from "../../auth/gmail/crypto.ts";
import { createDatabaseClient } from "../../db/client.ts";
import { oauthAccounts, users } from "../../db/schema.ts";
import { GmailApiError, type GmailTransportClient } from "./client.ts";
import { createGmailTransport, GmailTransportError } from "./transport.ts";

for (const status of [404, 401, 403, 429, 500]) {
  test(`draft mirror recovers only a missing provider copy (update status ${status})`, async () => {
    const previousKey = process.env.TOKEN_ENCRYPTION_KEY;
    const key = Buffer.alloc(32, 38).toString("base64");
    process.env.TOKEN_ENCRYPTION_KEY = key;
    const directory = mkdtempSync(join(tmpdir(), "orca-draft-recovery-"));
    const { db, sqlite } = createDatabaseClient(join(directory, "test.sqlite"));
    try {
      migrate(db, { migrationsFolder: resolve(import.meta.dir, "../../../drizzle") });
      db.insert(users).values({ id: "owner", email: "owner@example.test" }).run();
      db.insert(oauthAccounts).values({ id: "account", userId: "owner", provider: "gmail", providerId: "owner",
        providerEmail: "owner@example.test", accessTokenEncrypted: encryptSecret("synthetic-token", key),
        tokenExpiry: new Date(Date.now() + 3_600_000) }).run();
      const draft: MessageDraft = {
        id: "local-draft", accountId: "account", revision: 7,
        to: [{ name: null, email: "recipient@example.test" }], cc: [], bcc: [], subject: "Recovered writing",
        body: { text: "Latest local revision", html: null }, attachments: [],
        context: { kind: "reply", threadId: "local-thread", messageId: "local-source",
          providerMessageId: "source", providerThreadId: "provider-thread", inReplyTo: "<source@example.test>", references: [] },
        providerDraftId: "deleted-copy", providerMessageId: "old-message", providerThreadId: "provider-thread",
        deliveryStatus: "draft", providerSyncStatus: "pending", providerSyncError: null,
        createdAt: "2026-10-20T00:00:00.000Z", updatedAt: "2026-10-20T00:00:00.000Z",
      };
      const updates: Parameters<GmailTransportClient["updateDraft"]>[0][] = [];
      const creates: Parameters<GmailTransportClient["createDraft"]>[0][] = [];
      const transport = createGmailTransport({
        async updateDraft(input) { updates.push(input); throw new GmailApiError("Synthetic update failure", status); },
        async createDraft(input) { creates.push(input); return { id: "replacement", message: { id: "new-message", threadId: "provider-thread" } }; },
        async deleteDraft() { assert.fail("Recovery must not delete mail"); },
        async sendMessage() { assert.fail("Recovery must not send mail"); },
      });
      if (status === 404) {
        const result = await transport.saveDraft(db, "account", draft);
        assert.deepEqual(result, { providerDraftId: "replacement", providerMessageId: "new-message", providerThreadId: "provider-thread" });
        assert.equal(creates.length, 1);
        const { draftId, ...originalInput } = updates[0]!;
        assert.equal(draftId, "deleted-copy");
        assert.deepEqual(creates[0], originalInput, "Replacement retains account token, MIME content and reply thread");
        assert.match(Buffer.from(creates[0]!.raw, "base64url").toString(), /TGF0ZXN0IGxvY2FsIHJldmlzaW9u/);
        assert.equal(draft.revision, 7);
      } else {
        await assert.rejects(transport.saveDraft(db, "account", draft), GmailTransportError);
        assert.equal(creates.length, 0, "Other failures must not create duplicate provider drafts");
      }
      assert.equal(updates.length, 1);
    } finally {
      sqlite.close();
      rmSync(directory, { recursive: true, force: true });
      if (previousKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
      else process.env.TOKEN_ENCRYPTION_KEY = previousKey;
    }
  });
}
