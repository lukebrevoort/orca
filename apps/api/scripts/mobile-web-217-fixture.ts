/** Loopback-only browser + real API/SQLite writing fixture. No provider network calls.
 * Build web first, then: bun apps/api/scripts/compose-fixture.ts
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Hono } from "hono";
import type { MessageDraft } from "@orca/shared";

const directory = mkdtempSync(join(tmpdir(), "orca-compose-fixture-"));
process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
process.env.DATABASE_PATH = join(directory, "mail.sqlite");
process.env.SESSION_SECRET = "synthetic-compose-fixture-secret-not-a-production-key";
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 27).toString("base64");
delete process.env.APNS_KEY_ID;
delete process.env.APNS_PRIVATE_KEY;
// Enforce the synthetic fixture boundary even if a route starts using fetch later.
globalThis.fetch = (() => { throw new Error("Network fetch disabled in synthetic screenshot fixture"); }) as typeof fetch;
const { createDatabaseClient } = await import("../src/db/client.ts");
const { users, oauthAccounts, threads, emails, labels, emailLabels } = await import("../src/db/schema.ts");
const { createSession } = await import("../src/auth/session-store.ts");
const { createApp } = await import("../src/index.ts");
const { ProviderRegistry } = await import("../src/providers/registry.ts");
const { gmailProvider } = await import("../src/providers/gmail/provider.ts");
const { GmailTransportError } = await import("../src/providers/gmail/transport.ts");
const { db, sqlite } = createDatabaseClient();
migrate(db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });
const now = new Date();
const userId = "compose-fixture-user";
db.insert(users).values({ id: userId, email: "first@example.com", authenticatedAt: now, onboardingCompletedAt: now }).run();
for (const [index, accountId] of ["first", "second"].entries()) {
  db.insert(oauthAccounts).values({ id: accountId, userId, provider: "gmail", providerId: accountId, providerEmail: `${accountId}@example.com`, scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose", createdAt: new Date(index + 1), lastSyncedAt: now }).run();
  db.insert(labels).values({ id: `${accountId}-inbox`, accountId, providerLabelId: "INBOX", name: "INBOX", type: "system" }).run();
  db.insert(threads).values({ id: `${accountId}-thread`, accountId, providerThreadId: `${accountId}-provider-thread`, subject: `${accountId} account conversation`, latestReceivedAt: new Date(now.getTime() - 86400000), messageCount: 1, isRead: true }).run();
  db.insert(emails).values({ id: `${accountId}-message`, accountId, threadId: `${accountId}-thread`, providerMessageId: `${accountId}-provider-message`, fromName: "Maya", fromAddress: "maya@example.com", subject: `${accountId} account conversation`, snippet: "Could you send me your latest writing notes?", bodyText: "Could you send me your latest writing notes?", toRecipients: JSON.stringify([{ name: null, email: `${accountId}@example.com` }]), ccRecipients: "[]", bccRecipients: "[]", references: "[]", internetMessageId: `<${accountId}@example.com>`, receivedAt: new Date(now.getTime() - 86400000), internalDate: new Date(now.getTime() - 86400000), isRead: true, humanSignal: 9, humanClassification: "likely_human", humanClassificationReasons: "[]" }).run();
  db.insert(emailLabels).values({ id: `${accountId}-label`, emailId: `${accountId}-message`, labelId: `${accountId}-inbox` }).run();
}

// Additional wholly synthetic mail for PR217 mobile-web visual evidence.
const visualMessages = [
  ["Maya Chen", "maya@example.com", "A quieter place to write", "I took a look at the new direction. The calmer inbox makes it much easier to see what needs a reply."],
  ["Noah Williams", "noah@example.com", "Coffee and a quick catch-up?", "Are you free Thursday afternoon? There is a little place near the studio I think you would like."],
  ["Avery Patel", "avery@example.com", "A few thoughts on the latest design", "The type feels great on a smaller screen. I left a few notes about the spacing and the compose controls."],
  ["Sofia Rodriguez", "sofia@example.com", "Weekend plans", "The weather looks good for a walk by the water. Let me know if Saturday morning works for you."],
  ["Jordan Lee and the community design working group", "jordan@example.com", "Review notes with a longer subject to check wrapping on the smallest phone widths", "Here is a deliberately longer preview with enough words to verify the two-line snippet treatment without crowding the action controls at the bottom of each row."],
  ["Eli Morgan", "eli@example.com", "The photos from Sunday", "These made me smile. Sending a few favorites from our afternoon outside."],
  ["Harper Kim", "harper@example.com", "See you next week", "Thanks for making time. I will send over a short agenda before we meet."],
  ["Alex Rivera", "alex@example.com", "One more idea", "Could we leave a little more room around the message? I think it will make the reading experience feel even calmer."],
];
for (const [index, [name, address, subject, snippet]] of visualMessages.entries()) {
  const id = `visual-${index}`;
  const receivedAt = new Date(now.getTime() - index * 42 * 60 * 1000);
  db.insert(threads).values({ id: `${id}-thread`, accountId: "first", providerThreadId: `${id}-provider-thread`, subject, latestReceivedAt: receivedAt, messageCount: 1, isRead: index > 2 }).run();
  db.insert(emails).values({ id, accountId: "first", threadId: `${id}-thread`, providerMessageId: `${id}-provider-message`, fromName: name, fromAddress: address, subject, snippet, bodyText: snippet, toRecipients: JSON.stringify([{ name: "Alex", email: "first@example.com" }]), ccRecipients: "[]", bccRecipients: "[]", references: "[]", internetMessageId: `<${id}@example.com>`, receivedAt, internalDate: receivedAt, isRead: index > 2, humanSignal: 9, humanClassification: "likely_human", humanClassificationReasons: "[]" }).run();
  db.insert(emailLabels).values({ id: `${id}-label`, emailId: id, labelId: "first-inbox" }).run();
}

const session = await createSession(db, userId);
sqlite.close();
const deliveries: Array<{ accountId: string; draft: MessageDraft }> = [];
let outcome: "sent" | "ambiguous" = "sent";
const app = createApp({ dbFactory: () => createDatabaseClient(), providerRegistry: new ProviderRegistry([{
  ...gmailProvider,
  createOAuthApp: () => new Hono(),
  async syncPage() { return { nextCursor: null, emailCount: 0, threadCount: 0, labelCount: 0, contactCount: 0 }; },
  createTransport: () => ({
    async saveDraft(_db, _account, draft) { return { providerDraftId: `fixture-${draft.id}` }; },
    async deleteDraft() {},
    async send(_db, accountId, draft) {
      deliveries.push({ accountId, draft });
      if (outcome === "ambiguous") throw new GmailTransportError("Synthetic lost provider response", "ambiguous", false);
      return { providerMessageId: `sent-${draft.id}`, providerThreadId: draft.context?.providerThreadId ?? `sent-thread-${draft.id}` };
    },
  }),
}]) });
const webRoot = resolve(import.meta.dir, "../../web/dist");
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const url = new URL(request.url);
  // Synthetic fixture login only; this server binds loopback and contains no real data.
  if (url.pathname === "/__fixture/login") return new Response(null, { status: 302, headers: { "set-cookie": `orca_session=${session.token}; HttpOnly; Path=/; SameSite=Lax`, location: "/" } });
  if (url.pathname.startsWith("/__fixture/")) {
    if (!request.headers.get("cookie")?.split(";").some(value => value.trim() === `orca_session=${session.token}`)) return new Response(null, { status: 401 });
    if (url.pathname === "/__fixture/deliveries" && request.method === "GET") return Response.json(deliveries);
    if (url.pathname === "/__fixture/outcome" && request.method === "POST") {
      const value = await request.json() as { outcome?: string };
      if (value.outcome !== "sent" && value.outcome !== "ambiguous") return new Response(null, { status: 400 });
      outcome = value.outcome; return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 404 });
  }
  if (url.pathname.startsWith("/v1/") || url.pathname === "/health") return app.fetch(request);
  const path = resolve(webRoot, `.${url.pathname}`);
  if (path !== webRoot && !path.startsWith(`${webRoot}${sep}`)) return new Response(null, { status: 404 });
  const file = Bun.file(path);
  return new Response(await file.exists() && path !== webRoot ? file : Bun.file(join(webRoot, "index.html")));
} });
const metadata = { url: `http://127.0.0.1:${server.port}`, token: session.token, directory };
const metadataPath = join(directory, "connection.json");
writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), { mode: 0o600 });
console.log(metadataPath);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { server.stop(true); process.exit(0); });
