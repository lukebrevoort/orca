/**
 * Isolated, loopback-only iOS integration server. Never reads the user's database
 * or calls a mail provider. Stop with Ctrl-C; its temporary mailbox is removed.
 * Run: bun apps/api/scripts/mobile-fixture.ts
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Hono } from "hono";
import type { AuthVariables } from "../src/auth/middleware.ts";

const directory = mkdtempSync(join(tmpdir(), "orca-ios-fixture-"));
process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
process.env.DATABASE_PATH = join(directory, "mail.sqlite");
process.env.SESSION_SECRET = "synthetic-ios-fixture-session-secret-not-a-production-key";
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 19).toString("base64");
// Explicitly disable outbound push even if the caller's environment has keys.
delete process.env.APNS_KEY_ID;
delete process.env.APNS_PRIVATE_KEY;

const { createDatabaseClient } = await import("../src/db/client.ts");
const { users, oauthAccounts, threads, emails, labels, emailLabels } = await import("../src/db/schema.ts");
const { createMobileSession } = await import("../src/auth/mobile/store.ts");
const { createApp } = await import("../src/index.ts");
const { ProviderRegistry } = await import("../src/providers/registry.ts");
const { gmailProvider } = await import("../src/providers/gmail/provider.ts");

const { db, sqlite } = createDatabaseClient();
migrate(db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });
const now = new Date();
const userId = "ios-fixture-user";
const accountId = "ios-fixture-account";
db.insert(users).values({ id: userId, email: "luke@example.com", displayName: "Luke", authenticatedAt: now, onboardingCompletedAt: now }).run();
db.insert(oauthAccounts).values({ id: accountId, userId, provider: "gmail", providerId: "ios-fixture-provider", providerEmail: "luke@example.com", scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose", lastSyncedAt: now }).run();
db.insert(labels).values({ id: "ios-fixture-inbox", accountId, providerLabelId: "INBOX", name: "INBOX", type: "system" }).run();
const messages = [
  ["Maya Chen", "maya@example.com", "A quieter kind of inbox", "I tried the new reading view this morning. The space around each conversation makes such a difference.\n\nCould we catch up tomorrow about the writing experience?\n\nMaya"],
  ["Jordan Lee", "jordan@example.com", "Friday by the water?", "There is a small place near the harbor I think you would like. Friday, around six?\n\nNo agenda, just a chance to catch up."],
  ["Sofia Martinez", "sofia@example.com", "Notes from our conversation", "Here are the three things I took away: protect people's attention, make writing effortless, and never lose a draft.\n\nThat feels like the right place to start."],
  ["Sam Patel", "sam@example.com", "The first build is ready", "The pieces are coming together. I left some notes on the notification flow and would love your perspective."],
];
messages.forEach(([name, address, subject, body], i) => {
  const threadId = `ios-fixture-thread-${i + 1}`;
  const messageId = `ios-fixture-message-${i + 1}`;
  const receivedAt = new Date(now.getTime() - i * 45 * 60_000);
  db.insert(threads).values({ id: threadId, accountId, providerThreadId: `provider-thread-${i + 1}`, subject, latestReceivedAt: receivedAt, messageCount: 1, isRead: i > 1 }).run();
  db.insert(emails).values({ id: messageId, accountId, threadId, providerMessageId: `provider-message-${i + 1}`, fromName: name, fromAddress: address, subject, snippet: body!.slice(0, 150), bodyText: body, bodyHtml: i === 2 ? `<h2>Notes from our conversation</h2><div style="color:#222">Explicit dark foreground stays readable.</div><div style="background-color:#fff4cf">Explicit pale background keeps readable inherited text.</div>${Array.from({ length: 18 }, (_, paragraph) => `<p>Paragraph ${paragraph + 1}: Protect attention, make writing effortless, and never lose a draft.</p>`).join("")}<p>End of the long reading fixture.</p><img src="https://example.invalid/orca-fixture-tracker.png" alt="Remote image blocked">` : null, toRecipients: JSON.stringify([{ name: "Luke", email: "luke@example.com" }]), ccRecipients: "[]", bccRecipients: "[]", references: "[]", internetMessageId: `<fixture-${i + 1}@example.com>`, receivedAt, internalDate: receivedAt, isRead: i > 1, humanSignal: 9, humanClassification: "likely_human", humanClassificationReasons: "[]" }).run();
  db.insert(emailLabels).values({ id: `ios-fixture-label-${i + 1}`, emailId: messageId, labelId: "ios-fixture-inbox" }).run();
});
const credential = createMobileSession(db, userId);
sqlite.close();

const sent: Array<{ accountId: string; draftId: string; subject: string }> = [];
const app = createApp({
  dbFactory: () => createDatabaseClient(),
  providerRegistry: new ProviderRegistry([{
    ...gmailProvider,
    createOAuthApp: () => new Hono<{ Variables: AuthVariables }>(),
    detectCapabilities: () => ({ read: true, draft: true, send: true }),
    async syncPage() { return { nextCursor: null, emailCount: 0, threadCount: 0, labelCount: 0, contactCount: 0 }; },
    createTransport: () => ({
      async saveDraft(_db, _account, draft) { return { providerDraftId: `fixture-${draft.id}` }; },
      async deleteDraft() {},
      async send(_db, account, draft) {
        sent.push({ accountId: account, draftId: draft.id, subject: draft.subject });
        writeFileSync(join(directory, "deliveries.json"), JSON.stringify(sent, null, 2), { mode: 0o600 });
        return { providerMessageId: `fixture-sent-${draft.id}`, providerThreadId: `fixture-thread-${draft.id}` };
      },
    }),
  }]),
});
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
const metadata = { apiURL: `http://127.0.0.1:${server.port}`, accessToken: credential.accessToken, userId, accountId, directory };
const metadataPath = join(directory, "connection.json");
writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), { mode: 0o600 });
console.log(`iOS fixture API: ${metadata.apiURL}`);
console.log(`Synthetic connection details: ${metadataPath}`);
console.log("Only fixture data is used. Provider send and draft operations are simulated.");
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  server.stop(true);
  rmSync(directory, { recursive: true, force: true });
  process.exit(0);
});
