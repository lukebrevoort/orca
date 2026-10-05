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
import { eq } from "drizzle-orm";
import type { AuthVariables } from "../src/auth/middleware.ts";

const readOnly = process.argv.includes("--read-only");
const directory = mkdtempSync(join(tmpdir(), "orca-ios-fixture-"));
process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
process.env.DATABASE_PATH = join(directory, "mail.sqlite");
process.env.SESSION_SECRET = "synthetic-ios-fixture-session-secret-not-a-production-key";
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 19).toString("base64");
// Explicitly disable outbound push even if the caller's environment has keys.
delete process.env.APNS_KEY_ID;
delete process.env.APNS_PRIVATE_KEY;

const { createDatabaseClient } = await import("../src/db/client.ts");
const { users, oauthAccounts, threads, emails, labels, emailLabels, messageDrafts } = await import("../src/db/schema.ts");
const { createMobileSession } = await import("../src/auth/mobile/store.ts");
const { createDestinations } = await import("../src/destinations/service.ts");
const { createApp } = await import("../src/index.ts");
const { ProviderRegistry } = await import("../src/providers/registry.ts");
const { gmailProvider } = await import("../src/providers/gmail/provider.ts");

const { db, sqlite } = createDatabaseClient();
migrate(db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });
const { setMailSearchEnabled } = await import("../src/db/mail-search-index.ts");
setMailSearchEnabled(sqlite, true); // Only this disposable synthetic database.
const now = new Date();
const userId = "ios-fixture-user";
const accountId = "ios-fixture-account";
db.insert(users).values({ id: userId, email: "luke@example.com", displayName: "Luke", authenticatedAt: now, onboardingCompletedAt: now }).run();
db.insert(oauthAccounts).values({ id: accountId, userId, provider: "gmail", providerId: "ios-fixture-provider", providerEmail: "luke@example.com", scope: readOnly ? "https://www.googleapis.com/auth/gmail.readonly" : "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose", lastSyncedAt: now }).run();
db.insert(labels).values({ id: "ios-fixture-inbox", accountId, providerLabelId: "INBOX", name: "INBOX", type: "system" }).run();
const messages = [
  ["Maya Chen", "maya@example.com", "A quieter kind of inbox", "I tried the new reading view this morning. The space around each conversation makes such a difference.\n\nCould we catch up tomorrow about the writing experience?\n\nMaya"],
  ["Jordan Lee", "jordan@example.com", "Friday by the water?", "There is a small place near the harbor I think you would like. Friday, around six?\n\nNo agenda, just a chance to catch up."],
  ["Sofia Martinez", "sofia@example.com", "Notes from our conversation", "Here are the three things I took away: protect people's attention, make writing effortless, and never lose a draft.\n\nThat feels like the right place to start."],
  ["Sam Patel", "sam@example.com", "The first build is ready", "The pieces are coming together. I left some notes on the notification flow and would love your perspective."],
  ["Jordan Lee", "jordan@example.com", "Another note from Jordan", "A second conversation proves sender routing differs from a single-conversation move."],
];
messages.forEach(([name, address, subject, body], i) => {
  const threadId = `ios-fixture-thread-${i + 1}`;
  const messageId = `ios-fixture-message-${i + 1}`;
  const receivedAt = new Date(now.getTime() - i * 45 * 60_000);
  db.insert(threads).values({ id: threadId, accountId, providerThreadId: `provider-thread-${i + 1}`, subject, latestReceivedAt: receivedAt, messageCount: 1, isRead: i > 1 }).run();
  db.insert(emails).values({ id: messageId, accountId, threadId, providerMessageId: `provider-message-${i + 1}`, fromName: name, fromAddress: address, subject, snippet: body!.slice(0, 150), bodyText: i === 1 ? `${body}\n\n${"Synthetic preparation details. ".repeat(12)}\nYour appointment is confirmed with Morgan.` : body, bodyHtml: i === 2 ? `<h2>Notes from our conversation</h2><div style="color:#222">Explicit dark foreground stays readable.</div><div style="background-color:#fff4cf">Explicit pale background keeps readable inherited text.</div>${Array.from({ length: 18 }, (_, paragraph) => `<p>Paragraph ${paragraph + 1}: Protect attention, make writing effortless, and never lose a draft.</p>`).join("")}<p>End of the long reading fixture.</p><img src="https://example.invalid/orca-fixture-tracker.png" alt="Remote image blocked">` : null, toRecipients: JSON.stringify([{ name: "Luke", email: "luke@example.com" }]), ccRecipients: "[]", bccRecipients: "[]", references: "[]", internetMessageId: `<fixture-${i + 1}@example.com>`, receivedAt, internalDate: receivedAt, isRead: i > 1, humanSignal: 9, humanClassification: "likely_human", humanClassificationReasons: "[]" }).run();
  db.insert(emailLabels).values({ id: `ios-fixture-label-${i + 1}`, emailId: messageId, labelId: "ios-fixture-inbox" }).run();
});
// A long earlier reply catches readers that open at the beginning of a thread.
const earlierDate = new Date(now.getTime() - 86_400_000);
db.insert(emails).values({
  id: "ios-fixture-earlier-message", accountId, threadId: "ios-fixture-thread-1",
  providerMessageId: "provider-earlier-message", fromName: "Earlier sender", fromAddress: "earlier@example.com",
  subject: messages[0]![2], snippet: "Earlier conversation context.",
  bodyText: Array.from({ length: 24 }, (_, i) => `Earlier paragraph ${i + 1}: We are exploring a calmer way to read and write mail.`).join("\n\n"),
  toRecipients: JSON.stringify([{ name: "Luke", email: "luke@example.com" }]),
  ccRecipients: "[]", bccRecipients: "[]", references: "[]",
  receivedAt: earlierDate, internalDate: earlierDate, isRead: true,
}).run();
db.update(threads).set({ messageCount: 2 }).where(eq(threads.id, "ios-fixture-thread-1")).run();
// Real workspace destinations make notification selection testable without static UI mocks.
const destinations = createDestinations(db, userId);
for (const name of ["Projects", "Friends"]) {
  destinations.create({ expectedRevision: destinations.list().revision, name });
}
// Match a migrated workspace's Focus mapping, without touching a real mailbox.
const focus = destinations.create({ expectedRevision: destinations.list().revision, name: "Focus" });
sqlite.query("INSERT INTO organization_destination_legacy(workspace_id,behavior,destination_id) VALUES (?, 'focus', ?)").run(userId, focus.destinationId);
const { createOrganizationViews } = await import("../src/organization/views/module.ts");
const { createSqliteOrganizationViewsRepository } = await import("../src/organization/views/sqlite-repository.ts");
const views = createOrganizationViews(createSqliteOrganizationViewsRepository(sqlite));
const viewScope = { workspaceId: userId, accountIds: [accountId], actor: { id: userId, type: "human" as const } };
for (const [name, threadId] of [["Hub notifications", "ios-fixture-thread-2"], ["Empty view", "no-matching-thread"]]) {
  views.create({ scope: viewScope, request: {
    idempotencyKey: `fixture-view-${threadId}`, expectedWorkspaceRevision: views.list({ scope: viewScope }).workspaceRevision,
    name, description: "Mail you can browse without alerts", definition: { revision: 1, accountIds: [accountId], thread: threadId === "no-matching-thread" ? { subjectContains: "No fixture subject matches this" } : { ids: [threadId!] } },
  } });
}
const credential = createMobileSession(db, userId);
sqlite.close();

const sent: Array<{ accountId: string; draftId: string; subject: string }> = [];
let sendEnabled = !readOnly;
let accountsUnavailable = false;
let sendRequests = 0;
const app = createApp({
  dbFactory: () => createDatabaseClient(),
  providerRegistry: new ProviderRegistry([{
    ...gmailProvider,
    createOAuthApp: () => new Hono<{ Variables: AuthVariables }>(),
    detectCapabilities: () => ({ read: true, draft: sendEnabled, send: sendEnabled }),
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
const routingRequests: unknown[] = [];
// Hold one real inbox response so UI tests can inspect the refreshing layout.
// This control exists only in this loopback fixture server, never the API app.
type RefreshGate = {
  started: Promise<void>;
  markStarted: () => void;
  released: Promise<void>;
  release: () => void;
  pending: boolean;
};
let refreshGate: RefreshGate | undefined;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const url = new URL(request.url);
  // Authenticated controls exist only inside this disposable loopback fixture.
  // They simulate browser consent and another device completing delivery; no
  // Google/OAuth request, persistent grant, or provider delivery is performed.
  if (url.pathname.startsWith("/__fixture/compose/")) {
    if (request.headers.get("Authorization") !== `Bearer ${credential.accessToken}`) return new Response(null, { status: 401 });
    if (request.method === "GET" && url.pathname === "/__fixture/compose/state") {
      return Response.json({ sendEnabled, accountsUnavailable, sendRequests, deliveries: sent.length });
    }
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const raw = await request.text();
    if (raw.length > 4096) return new Response(null, { status: 413 });
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("object required"); }
    catch { return new Response(null, { status: 400 }); }
    if (url.pathname === "/__fixture/compose/capabilities") {
      if (typeof body.sendEnabled !== "boolean" || typeof body.accountsUnavailable !== "boolean") return new Response(null, { status: 400 });
      sendEnabled = body.sendEnabled; accountsUnavailable = body.accountsUnavailable;
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/__fixture/compose/delivery") {
      if (typeof body.draftId !== "string" || !["sending", "ambiguous", "sent", "rejected"].includes(String(body.status))) return new Response(null, { status: 400 });
      const { db, sqlite } = createDatabaseClient();
      try {
        const record = db.select().from(messageDrafts).where(eq(messageDrafts.id, body.draftId)).get();
        if (!record || record.accountId !== accountId) return new Response(null, { status: 404 });
        db.update(messageDrafts).set({ deliveryStatus: String(body.status), sendIdempotencyKey: `fixture-command-${record.id}`, updatedAt: new Date() }).where(eq(messageDrafts.id, record.id)).run();
        return new Response(null, { status: 204 });
      } finally { sqlite.close(); }
    }
    return new Response(null, { status: 404 });
  }
  if (url.pathname === "/v1/accounts" && accountsUnavailable) {
    return Response.json({ error: { code: "fixture_unavailable", message: "Synthetic account refresh failure" } }, { status: 503 });
  }
  if (request.method === "POST" && /^\/v1\/drafts\/[^/]+\/send$/.test(url.pathname)) sendRequests += 1;
  if (url.pathname.startsWith("/__fixture/inbox-refresh/")) {
    if (request.headers.get("Authorization") !== `Bearer ${credential.accessToken}`) {
      return new Response(null, { status: 401 });
    }
    if (request.method === "POST" && url.pathname.endsWith("/arm")) {
      refreshGate?.release();
      let markStarted!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      const released = new Promise<void>((resolve) => { release = resolve; });
      refreshGate = { started, markStarted, released, release, pending: false };
      return new Response(null, { status: 204 });
    }
    if (request.method === "POST" && url.pathname.endsWith("/release")) {
      refreshGate?.release();
      refreshGate = undefined;
      return new Response(null, { status: 204 });
    }
    if (request.method === "GET" && url.pathname.endsWith("/wait")) {
      const gate = refreshGate;
      if (!gate) return new Response(null, { status: 409 });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([gate.started, new Promise<void>((resolve) => { timer = setTimeout(resolve, 5_000); })]);
        return new Response(null, { status: gate.pending ? 204 : 408 });
      } finally { clearTimeout(timer); }
    }
    return new Response(null, { status: 404 });
  }
  if (request.method === "GET" && url.pathname === "/v1/inbox" && !url.searchParams.has("cursor") && refreshGate) {
    const gate = refreshGate;
    gate.pending = true;
    gate.markStarted();
    // Fail open if the test exits before cleanup; remain below the client's 30s timeout.
    const timer = setTimeout(gate.release, 20_000);
    try { await gate.released; }
    finally {
      clearTimeout(timer);
      gate.pending = false;
      if (refreshGate === gate) refreshGate = undefined;
    }
  }
  if (request.method === "PUT" && url.pathname === "/v1/destinations/routing") {
    const body = await request.clone().json();
    const response = await app.fetch(request);
    routingRequests.push({ accountId: url.searchParams.get("accountId"), body, status: response.status });
    writeFileSync(join(directory, "routing-requests.json"), JSON.stringify(routingRequests, null, 2), { mode: 0o600 });
    return response;
  }
  const startedAt = performance.now();
  const response = await app.fetch(request);
  if (request.method === "GET" && url.pathname === "/v1/inbox" && url.searchParams.has("query")) {
    // This server contains only invented fixtures. Keep diagnostic output to
    // query equality, status, IDs, and a code; never log credentials or mail.
    const result = await response.clone().json().catch(() => null) as { messages?: Array<{ id: string }>; error?: { code?: string } } | null;
    console.log(JSON.stringify({ syntheticSearch: true, exactExpectedQuery: url.searchParams.get("query") === "Jordan confirmed", elapsedMs: Math.round(performance.now() - startedAt), status: response.status, ids: result?.messages?.map(message => message.id), errorCode: result?.error?.code }));
  }
  return response;
} });
const metadata = { readOnly, apiURL: `http://127.0.0.1:${server.port}`, accessToken: credential.accessToken, userId, accountId, directory };
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
