/** Disposable real SQLite + Hono + Vite reviewer environment. Never opens the user's mailbox DB. */
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { createDatabaseClient } from "../apps/api/src/db/client";
import { createSession } from "../apps/api/src/auth/session-store";
import { createApp } from "../apps/api/src/index";
import { users, oauthAccounts, threads, emails, humanClassificationOverrides } from "../apps/api/src/db/schema";

process.env.SESSION_SECRET = "bre387-disposable-local-review-session-secret";
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 38).toString("base64");
const directory = mkdtempSync(join(tmpdir(), "orca-bre387-review-"));
const path = join(directory, "review.sqlite");
const client = createDatabaseClient(path);
migrate(client.db, { migrationsFolder: resolve("apps/api/drizzle") });
client.db.insert(users).values([{ id: "reviewer", email: "reviewer@example.com", displayName: "Orca reviewer" }, { id: "empty-reviewer", email: "empty@example.com" }]).run();
client.db.insert(oauthAccounts).values([
  { id: "work", userId: "reviewer", provider: "gmail", providerId: "review-work", providerEmail: "work@example.com" },
  { id: "personal", userId: "reviewer", provider: "gmail", providerId: "review-personal", providerEmail: "personal@example.com" },
  { id: "empty-account", userId: "empty-reviewer", provider: "gmail", providerId: "review-empty", providerEmail: "empty@example.com" },
]).run();
function mail(id: string, accountId: string, subject: string, fromAddress: string, snippet: string, human = true) {
  const date = new Date(Date.UTC(2026, 8, 6, 12, 0, 0) - Number(id.replace(/\D/g, "") || 0) * 1000);
  client.db.insert(threads).values({ id, accountId, providerThreadId: id, subject, latestReceivedAt: date, messageCount: 1, isRead: false }).onConflictDoNothing().run();
  client.db.insert(emails).values({ id: `message-${id}`, threadId: id, accountId, providerMessageId: id, fromAddress, fromName: fromAddress.startsWith("maya") ? "Maya Chen" : "Juniper Studio", subject, snippet, bodyText: snippet, receivedAt: date, isRead: false, humanSignal: human ? 8 : 2, humanClassification: human ? "likely_human" : "automated_or_bulk", humanClassificationReasons: JSON.stringify([human ? "direct_recipient" : "list_id_header"]) }).onConflictDoNothing().run();
}
for (let i = 0; i < 112; i++) mail(`work-${i}`, "work", i < 3 ? `Apartment viewing ${i + 1}` : `Project update ${i + 1}`, "maya@example.com", i === 8 ? "An apartment detail appears only in this snippet." : "A personal note about plans and next steps.");
mail("personal-1", "personal", "Apartment weekend", "maya@example.com", "A separate connected account.");
mail("bulk-1", "work", "Furniture catalog", "offers@shop.example", "Apartment furniture ideas.", false);
client.db.insert(humanClassificationOverrides).values({ id: "override-review", accountId: "work", targetType: "message", targetValue: "message-bulk-1", classification: "uncertain", source: "user_choice" }).run();
for (let i = 0; i < 7; i++) mail(`census-${i}`, "work", `Project correction ${i}`, `sender${i}@example.com`, "Seven distinct matching senders beyond one preview page.");
const session = await createSession(client.db, "reviewer");
const secondSession = await createSession(client.db, "reviewer");
const emptySession = await createSession(client.db, "empty-reviewer");
const app = createApp({ dbFactory: () => createDatabaseClient(path) });
app.get("/v1/review/login", (c) => {
  const token = c.req.query("user") === "empty" ? emptySession.token : c.req.query("session") === "second" ? secondSession.token : session.token;
  c.header("set-cookie", `orca_session=${token}; Path=/; HttpOnly; SameSite=Lax`); return c.redirect("/");
});
app.get("/v1/review/inspection", (c) => c.json({
  preferences: client.sqlite.query("SELECT user_id, first_view_guidance_completed_at FROM user_preferences ORDER BY user_id").all(),
  views: client.sqlite.query("SELECT workspace_id,id,name,definition,revision FROM organization_views ORDER BY workspace_id,id").all(),
  emptyMailCount: client.sqlite.query("SELECT count(*) AS count FROM emails WHERE account_id='empty-account'").get(),
}));
app.post("/v1/review/empty-arrival", (c) => { mail("empty-arrival", "empty-account", "Your first real stored message", "colleague@example.com", "Mail has arrived. Reopen Getting started to use the real flow."); return c.json({ inserted: true }); });
app.post("/v1/review/overflow", (c) => { for (let i=0; i<51; i++) mail(`overflow-${i}`, "work", "Overflow census", `overflow${i}@example.com`, "More senders than the safe correction bound."); return c.json({ inserted: 51 }); });
app.post("/v1/review/future", (c) => { mail("future-1", "work", "Project new sender", "new.sender@example.com", "Arrived after the View was saved."); mail("future-2", "work", "Project allowed sender", "maya@example.com", "An allowed sender after saving."); return c.json({ inserted: "future-1" }); });
let failNextCommit = false;
let failNextPreference = false;
let failViewList = false;
if (process.argv.includes("--check")) {
  const results: object[] = [];
  const headers = { cookie: `orca_session=${session.token}`, "content-type": "application/json" };
  const request = async (url: string, body?: unknown, method = body ? "POST" : "GET", expectedStatus = 200) => {
    const response = await app.request(url, { headers, method, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text();
    assert.equal(response.status, expectedStatus, text);
    const value = text ? JSON.parse(text) : null;
    return value;
  };
  const tables = (client.sqlite.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(row => row.name);
  const snapshot = (names: string[]) => Object.fromEntries(names.map(name => [name, client.sqlite.query(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all().map(row => JSON.stringify(row)).sort()]));
  const immutableTables = tables.filter(name => /^(emails|threads|oauth_accounts|email_labels|labels|contacts|human_classification_overrides|sender_attention_rules|attention_view_settings|thread_reminders|reminder_view_settings|collections|collection_threads|pins|message_drafts)$/.test(name) || /organization_(thread_|lane_policies|lanes$|workflow_states|facets$|contexts$|rule)/.test(name));
  const writingBefore = await request("/v1/preferences");
  const before = snapshot(immutableTables);
  const beforePreparation = snapshot(tables);
  let status = "failed";
  try {
    const prepared = await request("/v1/organization/views/prepare", { kind: "selected_senders", source: { kind: "sender_selection", label: "BRE-387 exact stored row" }, identity: { name: "Maya live mail" }, references: [{ accountId: "work", threadId: "work-0", messageId: "message-work-0" }] });
    assert.deepEqual(prepared.draft.definition.sender.addresses, ["maya@example.com"]);
    const { mode, viewId, viewRevision, source, identity, definition, unsupportedClauses } = prepared.draft;
    const preview = await request("/v1/organization/views/preview", { draft: { mode, viewId, viewRevision, source, identity, definition, unsupportedClauses }, page: { limit: 25 } });
    assert.deepEqual(snapshot(tables), beforePreparation, "prepare and preview must not write any table");
    results.push({ scenario: "prepare and preview are read-only before commit", status: "pass", checkedTables: tables });
    const envelope = { draft: preview.draft, expectedRevisions: { workspace: preview.workspaceRevision, view: null }, retryKey: "bre387-route-proof" };
    const saved = await request("/v1/organization/views/commit", envelope);
    const replay = await request("/v1/organization/views/commit", envelope);
    assert.equal(replay.view.id, saved.view.id);
    const reopened = createDatabaseClient(path);
    const stored = reopened.sqlite.query("SELECT id,definition FROM organization_views WHERE id=?").get(saved.view.id) as { id: string; definition: string };
    assert.equal(stored.id, saved.view.id);
    assert.deepEqual(JSON.parse(stored.definition), saved.view.definition);
    reopened.sqlite.close();
    const listed = await request("/v1/organization/views");
    assert.ok(listed.items.some((v: { id: string }) => v.id === saved.view.id));
    assert.deepEqual(snapshot(immutableTables), before, "commit and replay preserve mail, provider, placement, policy, classification and notification data");
    results.push({ scenario: "exact selected row → real preview → commit → identical replay → reopened SQLite → canonical list; mail unchanged", status: "pass", viewId: saved.view.id, definition: saved.view.definition, unchangedTables: immutableTables });
    mail("future-allowed", "work", "Future matching mail", "maya@example.com", "Stored after save");
    mail("future-other", "work", "Future nonmatching mail", "other@example.com", "Stored after save");
    const allItems: Array<{ accountId: string; threadId: string }> = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      assert.ok(++pages <= 100, "saved pagination must terminate");
      const page = await request(`/v1/organization/views/${saved.view.id}/results?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      allItems.push(...page.items); cursor = page.nextCursor;
    } while (cursor);
    assert.ok(allItems.some(item => item.threadId === "future-allowed"));
    assert.ok(!allItems.some(item => item.threadId === "future-other"));
    assert.ok(allItems.every(item => item.accountId === "work"));
    assert.equal(new Set(allItems.map(item => `${item.accountId}/${item.threadId}`)).size, allItems.length);
    results.push({ scenario: "all saved pages include future allowed sender, exclude other sender and personal account; unique composite identities", status: "pass", count: allItems.length });
    const preferences = await request("/v1/preferences?include=first_view_guidance");
    assert.ok(preferences.firstViewGuidanceCompletedAt);
    const other = await (await app.request("/v1/preferences?include=first_view_guidance", { headers: { cookie: `orca_session=${emptySession.token}` } })).json();
    assert.equal(other.firstViewGuidanceCompletedAt, null);
    results.push({ scenario: "canonical completion with independent user isolation", status: "pass" });
    client.db.insert(oauthAccounts).values({ id: "added-later", userId: "reviewer", provider: "gmail", providerId: "added-later", providerEmail: "later@example.com" }).run();
    assert.equal((await request("/v1/preferences?include=first_view_guidance")).firstViewGuidanceCompletedAt, preferences.firstViewGuidanceCompletedAt);
    results.push({ scenario: "account added after completion retains user preference", status: "pass" });
    const emptyCensus = await request("/v1/organization/views/sender-candidates", { draft: { mode, viewId, viewRevision, source, identity, definition: { revision: 1, accountIds: ["work"], thread: { subjectContains: "no-such-subject-bre387" } }, unsupportedClauses: [] }, target: { accountId: "work", threadId: "work-0" } });
    assert.equal(emptyCensus.status, "unavailable"); assert.deepEqual(emptyCensus.addresses, []); assert.deepEqual(emptyCensus.witnessAddresses, []);
    results.push({ scenario: "empty matching sender census fails closed without a partial allowlist", status: "pass" });
    const beforeLifecycle = snapshot(immutableTables);
    const second = await request("/v1/organization/views/prepare", { kind: "typed_definition", source: { kind: "manual", label: "Lifecycle proof" }, identity: { name: "Second View" }, definition: saved.view.definition });
    await request("/v1/organization/views/commit", { draft: second.draft, expectedRevisions: { workspace: second.workspaceRevision, view: null }, retryKey: "bre387-second" });
    let canonical = await request("/v1/organization/views");
    let target = canonical.items.find((v: { id: string }) => v.id === saved.view.id);
    await request(`/v1/organization/views/${target.id}`, { idempotencyKey: "bre387-rename", expectedWorkspaceRevision: canonical.workspaceRevision, expectedRevision: target.revision, patch: { name: "Renamed Maya" } }, "PATCH");
    canonical = await request("/v1/organization/views");
    await request("/v1/organization/views/reorder", { idempotencyKey: "bre387-reorder", expectedWorkspaceRevision: canonical.workspaceRevision, items: [...canonical.items].reverse().map((v: { id: string; revision: number }, position: number) => ({ id: v.id, expectedRevision: v.revision, position })) });
    canonical = await request("/v1/organization/views");
    target = canonical.items.find((v: { id: string }) => v.id === saved.view.id);
    assert.equal(target.name, "Renamed Maya");
    await request(`/v1/organization/views/${target.id}?expectedRevision=${target.revision}&expectedWorkspaceRevision=${canonical.workspaceRevision}&idempotencyKey=bre387-remove`, undefined, "DELETE", 204);
    assert.ok(!(await request("/v1/organization/views")).items.some((v: { id: string }) => v.id === saved.view.id));
    assert.deepEqual(snapshot(immutableTables), beforeLifecycle);
    assert.deepEqual(await request("/v1/preferences"), writingBefore);
    results.push({ scenario: "real rename/reorder/remove retain named mail/provider/placement/policy/classification tables and legacy writing/notification preferences", status: "pass", unchangedTables: immutableTables });
    status = "pass";
  } finally {
    mkdirSync("docs/verification/bre-387", { recursive: true });
    writeFileSync("docs/verification/bre-387/production-results.json", JSON.stringify({ status, harnessSha256: createHash("sha256").update(readFileSync(import.meta.filename)).digest("hex"), testedSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), baseSha: "0e7762cf1977f77151a422963f73e9a10188b866", timestamp: new Date().toISOString(), category: "production-scratch", tool: Bun.version, results }, null, 2) + "\n");
    client.sqlite.close(); rmSync(directory, { recursive: true, force: true });
  }
  process.exit(0);
}
let api: ReturnType<typeof Bun.serve> | undefined;
let web: Awaited<ReturnType<typeof createServer>> | undefined;
async function cleanup() { api?.stop(true); await web?.close(); client.sqlite.close(); rmSync(directory, { recursive: true, force: true }); }
try {
api = Bun.serve({ hostname: "127.0.0.1", port: 3087, fetch: (request) => {
  const pathname = new URL(request.url).pathname;
  if (pathname === "/v1/review/fail-next-preference" && request.method === "POST") { failNextPreference = true; return Response.json({ armed: true }); }
  if (pathname === "/v1/review/toggle-list-failure" && request.method === "POST") { failViewList = !failViewList; return Response.json({ failViewList }); }
  if (pathname === "/v1/organization/views" && request.method === "GET" && failViewList) return new Response("Review list unavailable", { status: 503 });
  if (pathname === "/v1/preferences" && request.method === "PATCH" && failNextPreference) { failNextPreference = false; return new Response("Review preference unavailable", { status: 503 }); }
  if (pathname === "/v1/review/fail-next-commit" && request.method === "POST") { failNextCommit = true; return Response.json({ armed: true }); }
  if (pathname === "/v1/organization/views/commit" && failNextCommit) { failNextCommit = false; return Response.json({ error: { code: "review_injected_failure", message: "Reviewer-injected temporary server failure. Retry preserves this draft." } }, { status: 503 }); }
  return app.fetch(request);
} });
web = await createServer({ configFile: false, root: resolve("apps/web"), plugins: [react()], server: { host: "127.0.0.1", port: 5187, strictPort: true, proxy: { "/v1": "http://127.0.0.1:3087", "/health": "http://127.0.0.1:3087" } } });
await web.listen();
console.log(`BRE-387 scratch database: ${path}\nOpen http://127.0.0.1:5187/v1/review/login\nAdd future mail: curl -X POST http://127.0.0.1:5187/v1/review/future\nStop with Ctrl-C. Only this harness temporary directory is removed on shutdown.`);
} catch (error) { await cleanup(); throw error; }
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, async () => { await cleanup(); process.exit(0); });
