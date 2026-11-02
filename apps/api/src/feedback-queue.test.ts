import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Hono } from "hono";
import { createDatabaseClient } from "./db/client.ts";
import { feedbackQueue, users } from "./db/schema.ts";
import { createSession } from "./auth/session-store.ts";
import type { AuthVariables } from "./auth/middleware.ts";
import { registerFeedbackQueueRoutes, feedbackQueueLimit, type FeedbackQueueDelivery } from "./feedback-queue.ts";
import { createMobileSession } from "./auth/mobile/store.ts";

let dir: string, dbPath: string, cookie: string, otherCookie: string;
let clock = Date.now();
let savedSecret: string | undefined, savedKey: string | undefined;
const origin = "https://orca.example";
const path = "/v1/feedback/queue";
const submission = () => ({ id: crypto.randomUUID(), title: "Make feedback easy", description: "Please keep my report in a queue.", kind: "idea", platform: "web", route: "/feedback" });
function app(deliver: FeedbackQueueDelivery | null = null) {
  const result = new Hono<{ Variables: AuthVariables }>();
  registerFeedbackQueueRoutes(result, { dbFactory: () => createDatabaseClient(dbPath), allowedOrigin: origin, deliver, now: () => clock });
  return result;
}
function post(body: unknown, as = cookie): RequestInit { return { method: "POST", headers: { cookie: as, origin, "content-type": "application/json" }, body: JSON.stringify(body) }; }
beforeEach(async () => {
  savedSecret = process.env.SESSION_SECRET; savedKey = process.env.TOKEN_ENCRYPTION_KEY;
  process.env.SESSION_SECRET = "feedback-test-session-secret-long-enough";
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 6).toString("base64");
  dir = mkdtempSync(join(tmpdir(), "orca-feedback-")); dbPath = join(dir, "fixture.sqlite"); clock = Date.now();
  const { db, sqlite } = createDatabaseClient(dbPath);
  migrate(db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });
  db.insert(users).values([{ id: "owner", email: "owner@example.test" }, { id: "other", email: "other@example.test" }]).run();
  cookie = `orca_session=${(await createSession(db, "owner")).token}`;
  otherCookie = `orca_session=${(await createSession(db, "other")).token}`;
  sqlite.close();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedSecret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = savedSecret;
  if (savedKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY; else process.env.TOKEN_ENCRYPTION_KEY = savedKey;
});
test("authentication and origin are required; private queue is never cached", async () => {
  const a = app();
  expect((await a.request(path)).status).toBe(401);
  expect((await a.request(path, post(submission(), ""))).status).toBe(401);
  for (const originValue of [undefined, "https://evil.example", "null"]) {
    const headers: Record<string, string> = { cookie }; if (originValue) headers.origin = originValue;
    expect((await a.request(path, { method: "POST", headers, body: JSON.stringify(submission()) })).status).toBe(403);
  }
  expect((await a.request(path, { headers: { cookie } })).headers.get("cache-control")).toBe("no-store");
});
test("save survives new app/DB connections, is owner-scoped, and duplicate IDs are owner-scoped", async () => {
  const body = submission(); const first = await app().request(path, post(body));
  expect(first.status).toBe(201);
  const result = await first.json(); expect(result.item.status).toBe("queued"); expect(result.deliveryAvailable).toBe(false);
  expect((await (await app().request(path, { headers: { cookie } })).json()).items).toEqual([result.item]);
  expect((await (await app().request(path, { headers: { cookie: otherCookie } })).json()).items).toEqual([]);
  expect((await app().request(`${path}/${body.id}/retry`, post({}, otherCookie))).status).toBe(404);
  expect((await app().request(path, post(body, otherCookie))).status).toBe(201);
});
test("duplicates are acknowledged once; changed content with same ID is a conflict", async () => {
  let deliveries = 0;
  const a = app(async () => { deliveries++; return { identifier: "BRE-1", url: "https://linear.app/brevoort/issue/BRE-1" }; });
  const body = submission();
  const responses = await Promise.all([a.request(path, post(body)), a.request(path, post(body))]);
  expect(responses.map(r => r.status).sort()).toEqual([200, 201]); expect(deliveries).toBe(1);
  expect((await a.request(path, post({ ...body, description: "Different" }))).status).toBe(409);
  expect((await (await a.request(path, { headers: { cookie } })).json()).items).toHaveLength(1);
});
test("failed delivery remains queued; retry uses same server UUID after cooldown and restart", async () => {
  const ids: string[] = []; let calls = 0;
  const deliver: FeedbackQueueDelivery = async (_report, options) => {
    ids.push(options.issueId); if (++calls === 1) throw new Error("private provider failure");
    return { identifier: "BRE-2", url: "https://linear.app/brevoort/issue/BRE-2" };
  };
  const body = submission(); const first = await (await app(deliver).request(path, post(body))).json();
  expect(first.item.status).toBe("queued"); expect(first.item.deliveryError).not.toContain("private");
  await app(deliver).request(`${path}/${body.id}/retry`, post({})); expect(calls).toBe(1);
  clock += 30_001;
  const retried = await (await app(deliver).request(`${path}/${body.id}/retry`, post({}))).json();
  expect(retried.item.status).toBe("delivered"); expect(retried.item.deliveryError).toBeNull();
  expect(ids[0]).toBe(ids[1]); expect(ids[0]).not.toBe(body.id);
  clock += 30_001; await app(deliver).request(`${path}/${body.id}/retry`, post({})); expect(calls).toBe(2);
});
test("malformed, excessive and captured-mail fields are rejected", async () => {
  for (const body of [{ ...submission(), id: "bad" }, { ...submission(), title: " " }, { ...submission(), description: "x".repeat(10001) }, { ...submission(), route: "/?message=secret" }, { ...submission(), state: { mail: "secret" } }]) {
    expect((await app().request(path, post(body))).status).toBe(400);
  }
  expect((await app().request(path, post({ ...submission(), description: "x".repeat(70_000) }))).status).toBe(413);
  expect((await app().request(path, { method: "POST", headers: { cookie, origin }, body: "{" })).status).toBe(400);
});
test("user quota is transactional and does not prevent duplicate acknowledgment or other users", async () => {
  const { db, sqlite } = createDatabaseClient(dbPath); const bodies = Array.from({ length: feedbackQueueLimit }, () => submission());
  db.transaction(tx => { for (const body of bodies) tx.insert(feedbackQueue).values({ ...body, kind: "idea", platform: "web", route: "/feedback", userId: "owner", issueId: crypto.randomUUID(), createdAt: new Date(clock).toISOString() }).run(); }); sqlite.close();
  expect((await app().request(path, post(submission()))).status).toBe(429);
  expect((await app().request(path, post(bodies[0]))).status).toBe(200);
  expect((await app().request(path, post(submission(), otherCookie))).status).toBe(201);
  expect((await (await app().request(path, { headers: { cookie } })).json()).items).toHaveLength(100);
});
test("native bearer can submit without Origin; pending cookie cannot", async () => {
  const { db, sqlite } = createDatabaseClient(dbPath);
  const native = createMobileSession(db, "owner");
  db.insert(users).values({ id: "pending", email: "pending-test@orca.invalid" }).run();
  const pending = await createSession(db, "pending"); sqlite.close();
  const response = await app().request(path, { method: "POST", headers: { authorization: `Bearer ${native.accessToken}`, "content-type": "application/json" }, body: JSON.stringify({ ...submission(), platform: "ios" }) });
  expect(response.status).toBe(201);
  expect((await app().request(path, post(submission(), `orca_session=${pending.token}`))).status).toBe(401);
});
test("simultaneous retries claim once and stale leases recover after process interruption", async () => {
  const body = submission(); await app().request(path, post(body));
  const { db, sqlite } = createDatabaseClient(dbPath);
  db.update(feedbackQueue).set({ leaseUntil: clock + 60_000, lastAttemptAt: clock }).run(); sqlite.close();
  let calls = 0;
  const deliver: FeedbackQueueDelivery = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 10)); return { identifier: "BRE-3", url: "https://linear.app/brevoort/issue/BRE-3" }; };
  const a = app(deliver);
  await a.request(`${path}/${body.id}/retry`, post({})); expect(calls).toBe(0);
  clock += 60_001;
  await Promise.all([a.request(`${path}/${body.id}/retry`, post({})), a.request(`${path}/${body.id}/retry`, post({}))]);
  expect(calls).toBe(1);
});
