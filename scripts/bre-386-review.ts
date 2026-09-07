/** Disposable real SQLite + Hono + Vite reviewer environment. Never opens the user's mailbox DB. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { createDatabaseClient } from "../apps/api/src/db/client";
import { createSession } from "../apps/api/src/auth/session-store";
import { createApp } from "../apps/api/src/index";
import { users, oauthAccounts, threads, emails, humanClassificationOverrides } from "../apps/api/src/db/schema";

process.env.SESSION_SECRET = "bre386-disposable-local-review-session-secret";
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 38).toString("base64");
const directory = mkdtempSync(join(tmpdir(), "orca-bre386-review-"));
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
const api = Bun.serve({ hostname: "127.0.0.1", port: 3086, fetch: (request) => {
  const pathname = new URL(request.url).pathname;
  if (pathname === "/v1/review/fail-next-preference" && request.method === "POST") { failNextPreference = true; return Response.json({ armed: true }); }
  if (pathname === "/v1/review/toggle-list-failure" && request.method === "POST") { failViewList = !failViewList; return Response.json({ failViewList }); }
  if (pathname === "/v1/organization/views" && request.method === "GET" && failViewList) return new Response("Review list unavailable", { status: 503 });
  if (pathname === "/v1/preferences" && request.method === "PATCH" && failNextPreference) { failNextPreference = false; return new Response("Review preference unavailable", { status: 503 }); }
  if (pathname === "/v1/review/fail-next-commit" && request.method === "POST") { failNextCommit = true; return Response.json({ armed: true }); }
  if (pathname === "/v1/organization/views/commit" && failNextCommit) { failNextCommit = false; return Response.json({ error: { code: "review_injected_failure", message: "Reviewer-injected temporary server failure. Retry preserves this draft." } }, { status: 503 }); }
  return app.fetch(request);
} });
const web = await createServer({ configFile: false, root: resolve("apps/web"), plugins: [react()], server: { host: "127.0.0.1", port: 5186, strictPort: true, proxy: { "/v1": "http://127.0.0.1:3086", "/health": "http://127.0.0.1:3086" } } });
await web.listen();
console.log(`BRE-386 scratch database: ${path}\nOpen http://127.0.0.1:5186/v1/review/login\nAdd future mail: curl -X POST http://127.0.0.1:5186/v1/review/future\nStop with Ctrl-C. The scratch database remains available for inspection.`);
process.on("SIGINT", async () => { api.stop(); await web.close(); client.sqlite.close(); process.exit(0); });
