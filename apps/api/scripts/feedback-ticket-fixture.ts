/** Disposable loopback fixture. All feedback delivery is synthetic; no live mail or Linear. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Hono } from "hono";

const directory = mkdtempSync(join(tmpdir(), "orca-feedback-fixture-"));
process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
for (const key of Object.keys(process.env)) {
  if (/^(LINEAR_|GOOGLE_|GMAIL_|MICROSOFT_|OUTLOOK_|APNS_|MCP_)/.test(key)) delete process.env[key];
}
process.env.DATABASE_PATH = join(directory, "feedback.sqlite");
process.env.SESSION_SECRET = "synthetic-feedback-fixture-secret-not-a-production-key";
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 27).toString("base64");
process.env.NODE_ENV = "production";
let app: Hono;
const tokens: string[] = [];
let outcome = "failure";
const deliveries: Array<{ issueId: string; title: string; message: string }> = [];
const webRoot = resolve(import.meta.dir, "../../web/dist");
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/__fixture/login") {
    const user = url.searchParams.get("user") === "second" ? 1 : 0;
    return new Response(null, { status: 302, headers: { "set-cookie": `orca_session=${tokens[user]}; HttpOnly; Path=/; SameSite=Lax`, location: "/settings" } });
  }
  if (url.pathname.startsWith("/__fixture/")) {
    if (!tokens.some(token => request.headers.get("cookie")?.split(";").some(value => value.trim() === `orca_session=${token}`))) return new Response(null, { status: 401 });
    if (url.pathname === "/__fixture/deliveries") return Response.json(deliveries);
    if (url.pathname === "/__fixture/delivery" && request.method === "POST") {
      const body = await request.json() as { outcome?: string };
      if (!["success", "failure", "ambiguous"].includes(body.outcome ?? "")) return new Response(null, { status: 400 });
      outcome = body.outcome!;
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 404 });
  }
  if (url.pathname.startsWith("/v1/") || url.pathname === "/health") return app.fetch(request);
  const path = resolve(webRoot, `.${url.pathname}`);
  if (path !== webRoot && !path.startsWith(`${webRoot}${sep}`)) return new Response(null, { status: 404 });
  const file = Bun.file(path);
  return new Response(await file.exists() && path !== webRoot ? file : Bun.file(join(webRoot, "index.html")));
} });
process.env.WEB_ORIGIN = `http://127.0.0.1:${server.port}`;
const { createDatabaseClient } = await import("../src/db/client.ts");
const { users, oauthAccounts } = await import("../src/db/schema.ts");
const { createSession } = await import("../src/auth/session-store.ts");
const { createApp } = await import("../src/index.ts");
const { ProviderRegistry } = await import("../src/providers/registry.ts");
const { gmailProvider } = await import("../src/providers/gmail/provider.ts");
const { db, sqlite } = createDatabaseClient();
migrate(db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });
for (const name of ["first", "second"]) {
  const userId = `feedback-${name}`;
  db.insert(users).values({ id: userId, email: `${name}@example.com`, displayName: `Fixture ${name}`, authenticatedAt: new Date(), onboardingCompletedAt: new Date() }).run();
  db.insert(oauthAccounts).values({ id: userId, userId, provider: "gmail", providerId: userId, providerEmail: `${name}@example.com`, scope: "https://www.googleapis.com/auth/gmail.readonly" }).run();
  tokens.push((await createSession(db, userId)).token);
}
sqlite.close();
app = createApp({ dbFactory: () => createDatabaseClient(), providerRegistry: new ProviderRegistry([{
    ...gmailProvider,
    createOAuthApp: () => new Hono(),
    async syncPage() { return { nextCursor: null, emailCount: 0, threadCount: 0, labelCount: 0, contactCount: 0 }; },
  }]),
  feedbackTicketOwnerUserId: "feedback-first",
  feedbackTicketDelivery: async (report, { issueId }) => {
    if (outcome === "failure") throw new Error("Synthetic Linear unavailable");
    if (!deliveries.some(item => item.issueId === issueId)) deliveries.push({ issueId, title: report.title, message: report.description });
    if (outcome === "ambiguous") throw new Error("Synthetic response lost after ticket creation");
    return { identifier: `BRE-FIXTURE-${deliveries.findIndex(item => item.issueId === issueId) + 1}`, url: `https://linear.app/fixture/issue/${issueId}` };
  },
});
const metadataPath = join(directory, "connection.json");
writeFileSync(metadataPath, JSON.stringify({ url: process.env.WEB_ORIGIN, directory }), { mode: 0o600 });
console.log(metadataPath);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { server.stop(true); process.exit(0); });
