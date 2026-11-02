import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Hono } from "hono";
import { createDatabaseClient } from "./db/client.ts";
import { users } from "./db/schema.ts";
import { createSession } from "./auth/session-store.ts";
import { createMobileSession } from "./auth/mobile/store.ts";
import type { AuthVariables } from "./auth/middleware.ts";
import { registerFeedbackTicketRoutes, feedbackTicketId, type FeedbackTicketDelivery } from "./feedback-ticket.ts";

let dir: string, dbPath: string, cookie: string, otherCookie: string;
let savedSecret: string | undefined, savedKey: string | undefined;
const origin = "https://orca.example";
const path = "/v1/feedback/ticket";
const submission = () => ({ id: crypto.randomUUID(), message: "Make feedback easy\nPlease put my report in Linear.", platform: "web" as const });
const receipt = { identifier: "BRE-1", url: "https://linear.app/brevoort/issue/BRE-1" };
function app(deliver: FeedbackTicketDelivery | null = async () => receipt, ownerUserId = "owner") {
  const result = new Hono<{ Variables: AuthVariables }>();
  registerFeedbackTicketRoutes(result, { dbFactory: () => createDatabaseClient(dbPath), allowedOrigin: origin, deliver, ownerUserId });
  return result;
}
function post(body: unknown, as = cookie): RequestInit { return { method: "POST", headers: { cookie: as, origin, "content-type": "application/json" }, body: JSON.stringify(body) }; }
beforeEach(async () => {
  savedSecret = process.env.SESSION_SECRET; savedKey = process.env.TOKEN_ENCRYPTION_KEY;
  process.env.SESSION_SECRET = "feedback-test-session-secret-long-enough";
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 6).toString("base64");
  dir = mkdtempSync(join(tmpdir(), "orca-feedback-")); dbPath = join(dir, "fixture.sqlite");
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
test("authentication and origin are required; availability is private", async () => {
  const a = app();
  expect((await a.request(path)).status).toBe(401);
  expect((await a.request(path, post(submission(), ""))).status).toBe(401);
  for (const originValue of [undefined, "https://evil.example", "null"]) {
    const headers: Record<string, string> = { cookie }; if (originValue) headers.origin = originValue;
    expect((await a.request(path, { method: "POST", headers, body: JSON.stringify(submission()) })).status).toBe(403);
  }
  const available = await a.request(path, { headers: { cookie } });
  expect(available.headers.get("cache-control")).toBe("no-store"); expect(await available.json()).toEqual({ available: true });
});
test("only explicitly configured owner may send into the personal Linear workspace", async () => {
  let calls = 0; const delivery: FeedbackTicketDelivery = async () => { calls++; return receipt; };
  for (const a of [app(delivery, ""), app(delivery, "other")]) {
    expect(await (await a.request(path, { headers: { cookie } })).json()).toEqual({ available: false });
    expect((await a.request(path, post(submission()))).status).toBe(403);
  }
  expect(await (await app(delivery).request(path, { headers: { cookie: otherCookie } })).json()).toEqual({ available: false });
  expect((await app(delivery).request(path, post(submission(), otherCookie))).status).toBe(403);
  expect(calls).toBe(0);
});
test("unconfigured delivery is not success and no app queue is created", async () => {
  const a = app(null); expect(await (await a.request(path, { headers: { cookie } })).json()).toEqual({ available: false });
  expect((await a.request(path, post(submission()))).status).toBe(503);
  const { sqlite } = createDatabaseClient(dbPath);
  expect(sqlite.query("SELECT name FROM sqlite_master WHERE name = 'feedback_queue'").all()).toEqual([]); sqlite.close();
});
test("successful ticket derives title and sends only explicit message plus platform", async () => {
  let received: Parameters<FeedbackTicketDelivery>[0] | undefined;
  const input = submission(); const a = app(async report => { received = report; return receipt; });
  const result = await a.request(path, post(input)); expect(result.status).toBe(201); expect(await result.json()).toEqual(receipt);
  expect(received?.title).toBe("Make feedback easy"); expect(received?.description).toBe(input.message);
  expect(received?.attachments).toEqual([]); expect(received?.elements).toEqual([]); expect(received?.state).toBeUndefined();
  expect(received?.id).not.toBe(input.id);
  expect(received?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
test("concurrent duplicate requests coalesce; exact retry gets stable provider ID across app restarts", async () => {
  let calls = 0; const ids: string[] = [];
  const deliver: FeedbackTicketDelivery = async (_report, options) => { ids.push(options.issueId); calls++; await new Promise(resolve => setTimeout(resolve, 10)); return receipt; };
  const input = submission(); const a = app(deliver);
  const responses = await Promise.all([a.request(path, post(input)), a.request(path, post(input))]);
  expect(responses.map(r => r.status)).toEqual([201, 201]); expect(calls).toBe(1);
  expect((await app(deliver).request(path, post(input))).status).toBe(201); expect(ids[0]).toBe(ids[1]);
  expect(feedbackTicketId("other", input)).not.toBe(ids[0]);
  expect(feedbackTicketId("owner", { ...input, message: "Different" })).not.toBe(ids[0]);
});
test("provider failure is never reported as queued/sent and exact retries preserve ID", async () => {
  const ids: string[] = []; let calls = 0;
  const delivery: FeedbackTicketDelivery = async (_report, options) => { ids.push(options.issueId); if (++calls === 1) throw new Error("private token detail"); return receipt; };
  const input = submission(); const first = await app(delivery).request(path, post(input)); expect(first.status).toBe(502);
  expect(JSON.stringify(await first.json())).not.toContain("private token detail");
  expect(await (await app(delivery).request(path, post(input))).json()).toEqual(receipt); expect(ids[0]).toBe(ids[1]);
});
test("malformed, oversized and implicit capture/destination fields are rejected", async () => {
  for (const body of [{ ...submission(), id: "bad" }, { ...submission(), message: " " }, { ...submission(), message: "x".repeat(10001) }, { ...submission(), route: "/?message=secret" }, { ...submission(), teamId: "other-team" }]) {
    expect((await app().request(path, post(body))).status).toBe(400);
  }
  expect((await app().request(path, post({ ...submission(), message: "x".repeat(70_000) }))).status).toBe(413);
  expect((await app().request(path, { method: "POST", headers: { cookie, origin }, body: "{" })).status).toBe(400);
});
test("native owner bearer works without Origin; pending cookie cannot send", async () => {
  const { db, sqlite } = createDatabaseClient(dbPath); const native = createMobileSession(db, "owner");
  db.insert(users).values({ id: "pending", email: "pending-test@orca.invalid" }).run();
  const pending = await createSession(db, "pending"); sqlite.close();
  expect((await app().request(path, { method: "POST", headers: { authorization: `Bearer ${native.accessToken}`, "content-type": "application/json" }, body: JSON.stringify({ ...submission(), platform: "ios" }) })).status).toBe(201);
  expect((await app().request(path, post(submission(), `orca_session=${pending.token}`))).status).toBe(401);
});
test("only validated Linear receipts count as success", async () => {
  for (const url of ["https://evil.example/issue/1", "javascript:alert(1)", "http://linear.app/issue/1", "https://secret@linear.app/issue/1", "https://linear.app.evil.example/issue/1"]) {
    expect((await app(async () => ({ ...receipt, url })).request(path, post(submission()))).status).toBe(502);
  }
});
test("unique requests have bounded concurrency and release admission after completion", async () => {
  const releases: Array<() => void> = [];
  const a = app(async () => { await new Promise<void>(resolve => releases.push(resolve)); return receipt; });
  const requests = Array.from({ length: 4 }, () => a.request(path, post(submission())));
  // Auth and bounded-body admission must finish before checking the fifth call.
  while (releases.length < 4) await new Promise(resolve => setTimeout(resolve, 1));
  expect((await a.request(path, post(submission()))).status).toBe(429);
  releases.forEach(release => release());
  expect((await Promise.all(requests)).every(response => response.status === 201)).toBe(true);
  const next = a.request(path, post(submission()));
  while (releases.length < 5) await new Promise(resolve => setTimeout(resolve, 1));
  releases[4]!(); expect((await next).status).toBe(201);
});
