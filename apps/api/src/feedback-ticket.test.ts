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
import { registerFeedbackTicketRoutes, feedbackTicketId, validFeedbackAttachment, type FeedbackTicketDelivery } from "./feedback-ticket.ts";

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
  expect((await app().request(path, post({ ...submission(), message: "x".repeat(29 * 1024 * 1024) }))).status).toBe(413);
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

const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function media(bytes = pngBytes, mimeType = "image/png", name = "screenshot.png") {
  return { id: crypto.randomUUID(), name, mimeType, size: bytes.length, dataUrl: `data:${mimeType};base64,${bytes.toString("base64")}` };
}
test("optional reviewed media reaches delivery; content changes identity and empty array keeps text-only identity", async () => {
  const input = submission(); const file = media(); let received: Parameters<FeedbackTicketDelivery>[0] | undefined;
  const response = await app(async report => { received = report; return receipt; }).request(path, post({ ...input, attachments: [file] }));
  expect(response.status).toBe(201); expect(received?.attachments).toEqual([{ id: file.id, name: file.name, mimeType: file.mimeType, dataUrl: file.dataUrl, source: "upload" }]);
  expect(feedbackTicketId("owner", { ...input, attachments: [] })).toBe(feedbackTicketId("owner", input));
  expect(received!.id).not.toBe(feedbackTicketId("owner", input));
  expect(feedbackTicketId("owner", { ...input, attachments: [{ ...file, mimeType: "image/png", dataUrl: file.dataUrl + "A" }] })).not.toBe(received!.id);
});
test("strict media bounds and signatures reject malformed content before provider access", async () => {
  let calls = 0; const a = app(async () => { calls++; return receipt; }); const file = media();
  const invalid = [
    { ...file, mimeType: "image/svg+xml", dataUrl: "data:image/svg+xml;base64,PHN2Zy8+" },
    { ...file, dataUrl: "data:image/png;base64,PHN2Zy8+", size: 6 },
    { ...file, dataUrl: "data:image/jpeg;base64," + pngBytes.toString("base64") },
    { ...file, size: file.size + 1 }, { ...file, dataUrl: file.dataUrl + "\n" },
    { ...file, dataUrl: file.dataUrl.replace("=", "!") }, { ...file, name: "../secret.png" },
    { ...file, name: "private\nname.png" }, { ...file, dataUrl: "https://example.com/file.png" },
    { ...file, size: 10 * 1024 * 1024 + 1 }, { ...file, size: 0 },
  ];
  for (const candidate of invalid) expect((await a.request(path, post({ ...submission(), attachments: [candidate] }))).status).toBe(400);
  expect((await a.request(path, post({ ...submission(), attachments: [file, file] }))).status).toBe(400);
  expect((await a.request(path, post({ ...submission(), attachments: Array.from({ length: 4 }, () => media()) }))).status).toBe(400);
  expect((await a.request(path, post({ ...submission(), attachments: Array.from({ length: 3 }, () => ({ ...media(), size: 7 * 1024 * 1024 })) }))).status).toBe(400);
  expect(calls).toBe(0);
});
test("supported image/video container signatures pass; mismatched brands do not", async () => {
  const iso = (brand: string) => { const bytes = Buffer.alloc(24); bytes.writeUInt32BE(24); bytes.write("ftyp", 4); bytes.write(brand, 8); return bytes; };
  for (const [bytes, mime] of [[pngBytes, "image/png"], [Buffer.from([255, 216, 255, 1]), "image/jpeg"], [Buffer.from("RIFF0000WEBPdata"), "image/webp"], [iso("isom"), "video/mp4"], [iso("qt  "), "video/quicktime"], [Buffer.concat([Buffer.from([26, 69, 223, 163]), Buffer.from("webm")]), "video/webm"]] as const) {
    expect((await app().request(path, post({ ...submission(), attachments: [media(bytes, mime)] }))).status).toBe(201);
  }
  expect((await app().request(path, post({ ...submission(), attachments: [media(iso("qt  "), "video/mp4")] }))).status).toBe(400);
});
test("10 MiB image boundary is admitted without losing bytes", async () => {
  const bytes = Buffer.alloc(10 * 1024 * 1024); pngBytes.copy(bytes);
  let decodedSize = 0;
  const result = await app(async report => { decodedSize = Buffer.from(report.attachments[0]!.dataUrl.split(",")[1]!, "base64").length; return receipt; })
    .request(path, post({ ...submission(), attachments: [media(bytes)] }));
  expect(result.status).toBe(201); expect(decodedSize).toBe(bytes.length);
});


test("MP4 signatures recognize registered newer and compatible ftyp brands without trusting the MIME label", () => {
  const container = (major: string, compatible: string[] = []) => {
    const bytes = Buffer.alloc(16 + 4 * compatible.length);
    bytes.writeUInt32BE(bytes.length); bytes.write("ftyp", 4); bytes.write(major, 8);
    compatible.forEach((brand, index) => bytes.write(brand, 16 + 4 * index));
    return bytes;
  };
  for (const brand of ["iso7", "iso8", "iso9", "isoa", "isob", "isoc", "mp71", "av01"]) {
    expect(validFeedbackAttachment({ ...media(container(brand)), mimeType: "video/mp4", dataUrl: `data:video/mp4;base64,${container(brand).toString("base64")}` })).toBe(true);
  }
  const compatible = container("test", ["iso8", "mp41"]);
  expect(validFeedbackAttachment({ ...media(compatible, "video/mp4"), mimeType: "video/mp4" })).toBe(true);
  const unknown = container("test", ["nope"]);
  expect(validFeedbackAttachment({ ...media(unknown, "video/mp4"), mimeType: "video/mp4" })).toBe(false);
  // An accepted string elsewhere in the file or in the minor-version word is
  // not a compatible-brand declaration.
  const outside = Buffer.concat([container("test"), Buffer.from("iso9")]);
  expect(validFeedbackAttachment({ ...media(outside, "video/mp4"), mimeType: "video/mp4" })).toBe(false);
  const minor = container("test"); minor.write("mp71", 12);
  expect(validFeedbackAttachment({ ...media(minor, "video/mp4"), mimeType: "video/mp4" })).toBe(false);
  const malformed = container("iso9"); malformed.writeUInt32BE(17);
  expect(validFeedbackAttachment({ ...media(malformed, "video/mp4"), mimeType: "video/mp4" })).toBe(false);
  const oversizedHeader = container("iso9", Array(1024).fill("iso9"));
  expect(validFeedbackAttachment({ ...media(oversizedHeader, "video/mp4"), mimeType: "video/mp4" })).toBe(false);
});
