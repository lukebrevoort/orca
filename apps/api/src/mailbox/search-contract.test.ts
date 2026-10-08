import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createDatabaseClient } from "../db/client.ts";
import { users, oauthAccounts, threads, emails } from "../db/schema.ts";
import { createSession } from "../auth/session-store.ts";
import { createApp } from "../index.ts";

const originalSecret = process.env.SESSION_SECRET;
const originalKey = process.env.TOKEN_ENCRYPTION_KEY;
const paths: string[] = [];
afterEach(() => {
  if (originalSecret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = originalSecret;
  if (originalKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY; else process.env.TOKEN_ENCRYPTION_KEY = originalKey;
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }); });
async function fixture() {
  process.env.SESSION_SECRET = "synthetic-search-contract-session-secret";
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  const path = mkdtempSync(join(tmpdir(), "orca-search-contract-")); paths.push(path);
  const filename = join(path, "mail.sqlite");
  const { db, sqlite } = createDatabaseClient(filename);
  migrate(db, { migrationsFolder: resolve(import.meta.dir, "../../drizzle") });
  db.insert(users).values([{ id: "owner", email: "owner@example.test" }, { id: "other", email: "other@example.test" }]).run();
  for (const [id, userId] of [["a", "owner"], ["b", "owner"], ["foreign", "other"]]) {
    db.insert(oauthAccounts).values({ id: id!, userId: userId!, provider: "gmail", providerId: id!, providerEmail: `${id}@example.test` }).run();
    db.insert(threads).values({ id: `t-${id}`, accountId: id!, providerThreadId: `t-${id}` }).run();
    db.insert(emails).values({ id: `m-${id}`, accountId: id!, threadId: `t-${id}`, providerMessageId: `m-${id}`, fromAddress: "sender@example.test", subject: "x".repeat(33 * 1024) + " needle", snippet: "visible preview", bodyText: "y".repeat(257 * 1024) + " bodyonly", receivedAt: new Date(1000) }).run();
  }
  const session = await createSession(db, "owner");
  const headers = { cookie: `orca_session=${session.token}` };
  const app = createApp({ dbFactory: () => createDatabaseClient(filename) });
  const request = (query: string) => app.request(`/v1/inbox?view=all&classification=all&${query}`, { headers });
  return { sqlite, app, headers, request };
}

test("explicit metadata remains complete for oversized bodies AND metadata across authorized accounts", async () => {
  const f = await fixture();
  try {
    const response = await f.request("query=needle&searchMode=metadata&limit=1");
    expect(response.status).toBe(200);
    const first = await response.json();
    expect(first.search).toMatchObject({ mode: "metadata", coverage: "stored-metadata", semantics: "legacy-substring-v1", fullBody: "unavailable" });
    expect(first.accounts.map((a: { id: string }) => a.id).sort()).toEqual(["a", "b"]);
    expect(first.counts.attention.all).toBe(2);
    expect(first.messages).toHaveLength(1);
    expect(first.messages[0].subject.endsWith(" needle")).toBe(true);
    expect(first.messages[0].bodyText).toBeUndefined();
    const second = await (await f.request(`query=needle&searchMode=metadata&limit=1&cursor=${encodeURIComponent(first.nextCursor)}`)).json();
    expect(second.messages).toHaveLength(1); expect(second.messages[0].id).not.toBe(first.messages[0].id);
    expect(second.nextCursor).toBeNull(); expect(second.counts.attention.all).toBe(2);
    const body = await (await f.request("query=bodyonly&searchMode=metadata")).json();
    expect(body.messages).toHaveLength(0); expect(body.search.coverage).toBe("stored-metadata");
    expect((await f.request("query=needle&searchMode=metadata&accountId=foreign")).status).toBe(404);
  } finally { f.sqlite.close(); }
});

test("full body requests fail explicitly without metadata results; legacy clients retain their exact envelope", async () => {
  const f = await fixture();
  try {
    const response = await f.request("query=needle&searchMode=full");
    expect(response.status).toBe(503);
    const failure = await response.json();
    expect(failure.error.code).toBe("search_full_body_unavailable");
    expect(failure.error.availableModes).toEqual(["metadata"]);
    expect(failure.messages).toBeUndefined();
    const legacy = await (await f.request("query=needle")).json();
    expect(legacy.search).toBeUndefined(); expect(legacy.messages).toHaveLength(2);
    const oldest = await (await f.app.request("/v1/inbox?view=all&query=needle&limit=1", { headers: f.headers })).json();
    expect(Object.keys(oldest).sort()).toEqual(["accounts", "counts", "freshness", "messages", "nextCursor"]);
    expect(oldest.counts.all).toBe(2); expect(oldest.counts.attention).toBeUndefined();
    const continued = await (await f.request(`query=needle&searchMode=metadata&limit=1&cursor=${encodeURIComponent(oldest.nextCursor)}`)).json();
    expect(continued.messages).toHaveLength(1); expect(continued.messages[0].id).not.toBe(oldest.messages[0].id);
    expect(f.sqlite.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(f.sqlite.query("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
    expect((await f.app.request("/v1/inbox?query=needle&searchMode=full")).status).toBe(401);
    expect((await f.request("query=needle&searchMode=surprise")).status).toBe(400);
  } finally { f.sqlite.close(); }
});

test("canonical metadata reflects updates/deletes and cannot reuse a cursor across an account incarnation", async () => {
  const f = await fixture();
  try {
    const first = await (await f.request("query=needle&searchMode=metadata&limit=1")).json();
    expect(first.nextCursor).toBeString();
    f.sqlite.exec("UPDATE emails SET subject='updated' WHERE id='m-a'");
    const changed = await (await f.request("query=needle&searchMode=metadata")).json();
    expect(changed.messages.map((m: { id: string }) => m.id)).toEqual(["m-b"]);
    expect((await f.request(`query=needle&searchMode=metadata&cursor=${encodeURIComponent(first.nextCursor)}`)).status).toBe(400);
    f.sqlite.exec("DELETE FROM emails WHERE id='m-b'");
    expect((await (await f.request("query=needle&searchMode=metadata")).json()).messages).toHaveLength(0);
    f.sqlite.exec("DELETE FROM oauth_accounts WHERE id='a'; INSERT INTO oauth_accounts(id,user_id,provider,provider_id,provider_email) VALUES('a','other','gmail','reused','reused@example.test')");
    expect((await f.request("query=needle&searchMode=metadata&accountId=a")).status).toBe(404);
    expect(f.sqlite.query("SELECT name FROM sqlite_master WHERE name LIKE 'mail_search_%'").all()).toHaveLength(0);
  } finally { f.sqlite.close(); }
});
