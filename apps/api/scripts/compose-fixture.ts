/** Loopback-only browser + real API/SQLite writing fixture. No provider network calls.
 * Build web first, then: bun apps/api/scripts/compose-fixture.ts
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { MessageDraft } from "@orca/shared";
import sharp from "sharp";

const latencyFixture = process.argv.includes("--image-latency");
const imageFixture = process.argv.includes("--images") || latencyFixture;
const imagePort = Number(process.env.ORCA_IMAGE_WEB_PORT ?? 48117);
const imageHtml = (updated: boolean) => `<p>${updated ? "Updated synthetic newsletter." : "Synthetic image newsletter."}</p><img alt="Synthetic PNG" src="https://images.example.invalid/${updated ? "banner-v2.png" : "banner.png"}"><img alt="Synthetic JPEG" src="https://images.example.invalid/photo.jpg">`;
if (imageFixture && (!Number.isInteger(imagePort) || imagePort < 1024 || imagePort > 65535)) throw new Error("Invalid synthetic image fixture port");
if (imageFixture) process.env.WEB_ORIGIN = `http://127.0.0.1:${imagePort}`;
const directory = mkdtempSync(join(tmpdir(), "orca-compose-fixture-"));
process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
process.env.DATABASE_PATH = join(directory, "mail.sqlite");
process.env.SESSION_SECRET = "synthetic-compose-fixture-secret-not-a-production-key";
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 27).toString("base64");
delete process.env.APNS_KEY_ID;
delete process.env.APNS_PRIVATE_KEY;
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
  db.insert(threads).values({ id: `${accountId}-thread`, accountId, providerThreadId: `${accountId}-provider-thread`, subject: `${accountId} account conversation`, latestReceivedAt: now, messageCount: 1, isRead: true }).run();
  db.insert(emails).values({ id: `${accountId}-message`, accountId, threadId: `${accountId}-thread`, providerMessageId: `${accountId}-provider-message`, fromName: "Maya", fromAddress: "maya@example.com", subject: `${accountId} account conversation`, snippet: "Could you send me your latest writing notes?", bodyText: "Could you send me your latest writing notes?", toRecipients: JSON.stringify([{ name: null, email: `${accountId}@example.com` }]), ccRecipients: "[]", bccRecipients: "[]", references: "[]", internetMessageId: `<${accountId}@example.com>`, receivedAt: now, internalDate: now, isRead: true, humanSignal: 9, humanClassification: "likely_human", humanClassificationReasons: "[]" }).run();
  db.insert(emailLabels).values({ id: `${accountId}-label`, emailId: `${accountId}-message`, labelId: `${accountId}-inbox` }).run();
}
if (imageFixture) {
  db.update(threads).set({ subject: "Synthetic image newsletter" }).where(eq(threads.id, "first-thread")).run();
  db.update(emails).set({ subject: "Synthetic image newsletter", snippet: "A synthetic newsletter with two images.", bodyText: "A synthetic newsletter with two images.", bodyHtml: imageHtml(false) }).where(eq(emails.id, "first-message")).run();
  const earlier = new Date(now.getTime() - 60_000);
  db.insert(threads).values({ id: "first-other-thread", accountId: "first", providerThreadId: "first-other-provider-thread", subject: "Second synthetic conversation", latestReceivedAt: earlier, messageCount: 1, isRead: true }).run();
  db.insert(emails).values({ id: "first-other-message", accountId: "first", threadId: "first-other-thread", providerMessageId: "first-other-message", fromName: "Jordan", fromAddress: "jordan@example.com", subject: "Second synthetic conversation", snippet: "An image that waits for cancellation.", bodyText: "An image that waits for cancellation.", bodyHtml: '<p>A separate synthetic message.</p><img alt="Slow synthetic image" src="https://images.example.invalid/slow.png">', toRecipients: JSON.stringify([{name:null,email:"first@example.com"}]), ccRecipients:"[]", bccRecipients:"[]", references:"[]", receivedAt:earlier, internalDate:earlier, isRead:true, humanSignal:9, humanClassification:"likely_human", humanClassificationReasons:"[]" }).run();
  db.insert(emailLabels).values({ id:"first-other-label", emailId:"first-other-message", labelId:"first-inbox" }).run();
}
const session = await createSession(db, userId);
sqlite.close();
const deliveries: Array<{ accountId: string; draft: MessageDraft }> = [];
let outcome: "sent" | "ambiguous" = "sent";
const imageCounts = { png: 0, jpeg: 0, slow: 0, cancelled: 0 };
const latencyScenarios = {
  small: [150, 150], many: Array<number>(12).fill(150),
  slowFirst: [2500, 150, 150, 150], slowLastFailure: [150, 150, 150, 2500],
};
let latencyScenario: keyof typeof latencyScenarios = "small";
let latencyActive = 0, latencyMaxActive = 0;
let latencyEvents: Array<{index:number; start:number; end:number; failed:boolean}> = [];
const latencyAttempts = new Map<number,number>();
const png = imageFixture ? readFileSync(resolve(import.meta.dir, "../src/mail/images/fixtures/landscape.png")) : Buffer.alloc(0);
const jpeg = imageFixture ? await sharp({ create: { width: 320, height: 120, channels: 3, background: { r: 67, g: 128, b: 174 } } }).jpeg().toBuffer() : Buffer.alloc(0);
const app = createApp({ dbFactory: () => createDatabaseClient(), ...(imageFixture ? { downloadMessageImage: async (url: URL, signal: AbortSignal) => {
  if (latencyFixture && url.hostname === "images.example.invalid" && /^\/latency\/\d+\.(png|jpg)$/.test(url.pathname)) {
    const index = Number(url.pathname.split("/")[2]!.split(".")[0]);
    const delays = latencyScenarios[latencyScenario];
    if (index >= delays.length) throw new Error("Invalid synthetic image index");
    const attempt = (latencyAttempts.get(index) ?? 0) + 1; latencyAttempts.set(index, attempt);
    const event = {index, start:performance.now(), end:0, failed:false}; latencyEvents.push(event);
    latencyActive++; latencyMaxActive = Math.max(latencyMaxActive, latencyActive);
    try {
      await new Promise<void>((resolve,reject)=>{
        const timer=setTimeout(()=>{signal.removeEventListener("abort",abort);resolve();},delays[index]);
        const abort=()=>{clearTimeout(timer);reject(new Error("Synthetic cancellation"));};
        signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();
      });
      if (latencyScenario === "slowLastFailure" && index === delays.length - 1 && attempt === 1) throw new Error("Synthetic transient failure");
      return index % 2 ? jpeg : png;
    } catch(error) { event.failed=true;throw error; }
    finally { event.end=performance.now();latencyActive--; }
  }
  if (["https://images.example.invalid/banner.png", "https://images.example.invalid/banner-v2.png"].includes(url.href)) { imageCounts.png++; return png; }
  if (url.href === "https://images.example.invalid/photo.jpg") { imageCounts.jpeg++; if (imageCounts.jpeg === 1) throw new Error("Synthetic transient failure"); return jpeg; }
  if (url.href === "https://images.example.invalid/slow.png") {
    imageCounts.slow++;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 8000);
      const abort = () => { clearTimeout(timer); imageCounts.cancelled++; reject(new Error("Synthetic cancellation")); };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    return png;
  }
  throw new Error("Unexpected synthetic image");
} } : {}), providerRegistry: new ProviderRegistry([{
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
const server = Bun.serve({ hostname: "127.0.0.1", port: imageFixture ? imagePort : 0, async fetch(request) {
  const url = new URL(request.url);
  // Synthetic fixture login only; this server binds loopback and contains no real data.
  if (url.pathname === "/__fixture/login") return new Response(null, { status: 302, headers: { "set-cookie": `orca_session=${session.token}; HttpOnly; Path=/; SameSite=Lax`, location: "/" } });
  if (url.pathname.startsWith("/__fixture/")) {
    if (!request.headers.get("cookie")?.split(";").some(value => value.trim() === `orca_session=${session.token}`)) return new Response(null, { status: 401 });
    if (url.pathname === "/__fixture/deliveries" && request.method === "GET") return Response.json(deliveries);
    if (latencyFixture && url.pathname === "/__fixture/image-latency" && request.method === "POST") {
      if(latencyActive) return new Response(null,{status:409});
      const value=await request.json() as {scenario?:string};
      if(!value.scenario || !(value.scenario in latencyScenarios)) return new Response(null,{status:400});
      latencyScenario=value.scenario as keyof typeof latencyScenarios;
      latencyEvents=[];latencyMaxActive=0;latencyAttempts.clear();
      const html=`<p>Synthetic latency newsletter.</p>`+latencyScenarios[latencyScenario].map((_,index)=>`<img alt="Synthetic image ${index+1}" src="https://images.example.invalid/latency/${index}.${index%2?'jpg':'png'}">`).join("");
      const client=createDatabaseClient();try {client.db.update(emails).set({bodyHtml:html}).where(eq(emails.id,"first-message")).run();}finally{client.sqlite.close();}
      return new Response(null,{status:204});
    }
    if (latencyFixture && url.pathname === "/__fixture/image-timings" && request.method === "GET") return Response.json({scenario:latencyScenario,events:latencyEvents,active:latencyActive,maxActive:latencyMaxActive});
    if (imageFixture && url.pathname === "/__fixture/image-counts" && request.method === "GET") return Response.json(imageCounts);
    if (imageFixture && url.pathname === "/__fixture/image-source" && request.method === "POST") {
      const client = createDatabaseClient();
      try { client.db.update(emails).set({ bodyHtml: imageHtml(true) }).where(eq(emails.id, "first-message")).run(); }
      finally { client.sqlite.close(); }
      return new Response(null, { status: 204 });
    }
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
