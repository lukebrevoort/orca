import { test, expect, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { threadReadPageSchema } from "@orca/shared";
import { createSession } from "./auth/session-store.ts";
import { createDatabaseClient } from "./db/client.ts";
import * as schema from "./db/schema.ts";
import { createApp } from "./index.ts";
import { readThreadPage } from "./thread-read-page.ts";

test("recovery pages advance across oversized messages and preserve scoped keyset ordering", async () => {
  const oldSecret = process.env.SESSION_SECRET, oldKey = process.env.TOKEN_ENCRYPTION_KEY;
  process.env.SESSION_SECRET = "thread-page-test-session-secret-long-enough";
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");
  const dir = mkdtempSync(join(tmpdir(), "orca-thread-page-"));
  const path = join(dir, "test.sqlite");
  const { db, sqlite } = createDatabaseClient(path);
  try {
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });
    const plan = sqlite.query("explain query plan select case when octet_length(id) <= 1024 then id else null end as id from emails where account_id = ? and thread_id = ? and received_at is ? and created_at = ? and id > (select id from emails where rowid = ?) order by emails.received_at desc, emails.created_at desc, emails.id asc limit 21").all("a", "t", 1, 1, 1) as Array<{ detail: string }>;
    expect(plan.map(row => row.detail).join(" ")).toContain("received_at=? AND created_at=? AND id>?");
    expect(plan.map(row => row.detail).join(" ")).not.toContain("TEMP B-TREE");
    db.insert(schema.users).values([{ id: "user", email: "user@example.com" }, { id: "other-user", email: "other@example.com" }]).run();
    db.insert(schema.oauthAccounts).values([{ id: "account", userId: "user", provider: "gmail", providerId: "account", providerEmail: "user@example.com" }, { id: "account2", userId: "other-user", provider: "gmail", providerId: "account2", providerEmail: "other@example.com" }]).run();
    db.insert(schema.threads).values([{ id: "thread", accountId: "account", providerThreadId: "thread", messageCount: 45 }, { id: "other", accountId: "account", providerThreadId: "other" }]).run();
    db.insert(schema.emails).values(Array.from({ length: 45 }, (_, i) => ({
      id: `m${String(i).padStart(2, "0")}${i === 19 ? "x".repeat(2048) : ""}`, accountId: "account", threadId: "thread", providerMessageId: `m${i}`,
      fromAddress: "sender@example.com", subject: "Hello", bodyText: i === 23 ? "x".repeat(2 * 1024 * 1024 + 1) : `body ${i}`,
      bodyHtml: i === 22 ? "<p>safe<img src=\"https://example.com/track\"></p>" : null,
      receivedAt: i >= 40 ? null : new Date(1000), createdAt: new Date(1000),
    }))).run();
    const largeIdRow = (sqlite.query("select rowid as row from emails where provider_message_id = 'm19'").get() as { row: number }).row;
    sqlite.query("update emails set subject = ? where id = 'm00'").run("é".repeat(1024 * 1024 + 1));
    sqlite.query("update emails set body_text = ? where id = 'm24'").run("\0é");
    sqlite.query("update emails set body_html = ? where id = 'm25'").run("<p>" + "x".repeat(2 * 1024 * 1024));
    db.insert(schema.emailAttachments).values({ id: "file", emailId: "m22", providerAttachmentId: "file", filename: "x".repeat(2 * 1024 * 1024 + 1), mimeType: "text/plain", size: 1 }).run();
    const session = await createSession(db, "user");
    const otherSession = await createSession(db, "other-user");
    const app = createApp({ dbFactory: () => createDatabaseClient(path) });
    const headers = { cookie: `orca_session=${session.token}` };
    const fetchPage = async (cursor?: string, thread = "thread") => {
      const query = new URLSearchParams({ accountId: "account" }); if (cursor) query.set("cursor", cursor);
      const res = await app.request(`/v1/threads/${thread}/messages?${query}`, { headers });
      return { res, value: res.status === 200 ? threadReadPageSchema.parse(await res.json()) : null };
    };
    const first = await fetchPage(); expect(first.res.status).toBe(200); expect(first.value!.entries.length).toBe(20); expect(first.value!.newer).toBeNull();
    const cursorPayload = Buffer.from(first.value!.earlier!.split(".")[0]!, "base64url").toString("utf8");
    expect(cursorPayload).not.toContain("user"); expect(cursorPayload).not.toContain("account"); expect(cursorPayload).not.toContain("thread");
    expect(first.value!.entries[0]?.kind).toBe("unavailable");
    expect(first.value!.entries[19]).toEqual({ kind: "unavailable", id: `row:${largeIdRow}` });
    const second = await fetchPage(first.value!.earlier!); expect(second.value!.entries.length).toBe(20);
    expect(second.value!.entries.find(x => x.id === "m23")?.kind).toBe("unavailable");
    expect(second.value!.entries.find(x => x.id === "m25")?.kind).toBe("unavailable");
    const unicode = second.value!.entries.find(x => x.id === "m24");
    expect(unicode?.kind === "message" && unicode.bodyText).toBe("\0é");
    const html = second.value!.entries.find(x => x.id === "m22");
    expect(html?.kind === "message" && html.bodyHtml).not.toContain("https://example.com/track");
    const third = await fetchPage(second.value!.earlier!); expect(third.value!.entries.length).toBe(5); expect(third.value!.earlier).toBeNull();
    const all = [...first.value!.entries, ...second.value!.entries, ...third.value!.entries];
    expect(all.map(x => x.id)).toEqual(Array.from({ length: 45 }, (_, i) => i === 19 ? `row:${largeIdRow}` : `m${String(i).padStart(2, "0")}`));
    expect((await fetchPage(third.value!.newer!)).value!.entries.map(x => x.id)).toEqual(second.value!.entries.map(x => x.id));
    // Non-ordering sync/read changes do not invalidate or loop a cursor.
    sqlite.run("update emails set is_read = 1 where id = 'm01'");
    expect((await fetchPage(first.value!.earlier!)).value!.entries.map(x => x.id)).toEqual(second.value!.entries.map(x => x.id));
    expect((await fetchPage(first.value!.earlier!, "other")).res.status).toBe(400);
    expect((await app.request(`/v1/threads/thread/messages?accountId=account&cursor=${encodeURIComponent(first.value!.earlier!)}`, { headers: { cookie: `orca_session=${otherSession.token}` } })).status).toBe(404);
    expect((await fetchPage(first.value!.earlier!.slice(0, -1) + "!" )).res.status).toBe(400);
    const cursorParts = first.value!.earlier!.split(".");
    const alteredSignature = (cursorParts[1]![0] === "A" ? "B" : "A") + cursorParts[1]!.slice(1);
    expect((await fetchPage(`${cursorParts[0]}.${alteredSignature}`)).res.status).toBe(400);
    expect((await app.request("/v1/threads/thread/messages?accountId=account")).status).toBe(401);
    expect((await app.request("/v1/threads/thread/messages?accountId=missing", { headers })).status).toBe(404);
    for (let i = 1; i <= 5; i++) sqlite.query("update emails set body_text = ? where id = ?").run("x".repeat(1024 * 1024), `m${String(i).padStart(2, "0")}`);
    let cursor: string | undefined;
    const seen: string[] = [];
    do {
      const next = await fetchPage(cursor);
      expect(next.res.status).toBe(200);
      const page = next.value!;
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(16 * 1024 * 1024);
      seen.push(...page.entries.map(entry => entry.id));
      cursor = page.earlier ?? undefined;
      expect(seen.length).toBeLessThanOrEqual(45);
    } while (cursor);
    expect(seen.length).toBe(45); expect(new Set(seen).size).toBe(45);
    const writer = createDatabaseClient(path);
    const query = sqlite.query.bind(sqlite);
    let wrote = false;
    const spy = spyOn(sqlite, "query").mockImplementation(((sql: string) => {
      if (!wrote && sql.startsWith("select from_address")) {
        wrote = true;
        writer.sqlite.query("update emails set body_text = ? where id = 'm01'").run("x".repeat(2 * 1024 * 1024 + 1));
      }
      return query(sql);
    }) as typeof sqlite.query);
    try {
      const snapshot = readThreadPage(sqlite, { user: "user", account: "account", thread: "thread" });
      expect(wrote).toBe(true);
      expect(snapshot.entries.find(entry => entry.id === "m01")?.kind).toBe("message");
      expect((await fetchPage()).value!.entries.find(entry => entry.id === "m01")?.kind).toBe("unavailable");
    } finally { spy.mockRestore(); writer.sqlite.close(); }
    const sync = createDatabaseClient(path);
    try { sync.sqlite.query("delete from emails where rowid = ?").run(largeIdRow); } finally { sync.sqlite.close(); }
    expect((await fetchPage(first.value!.earlier!)).res.status).toBe(400);
  } finally {
    sqlite.close(); rmSync(dir, { recursive: true, force: true });
    if (oldSecret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = oldSecret;
    if (oldKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY; else process.env.TOKEN_ENCRYPTION_KEY = oldKey;
  }
});
