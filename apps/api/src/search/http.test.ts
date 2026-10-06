import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createDatabaseClient } from "../db/client.ts";
import { users, oauthAccounts, threads, emails } from "../db/schema.ts";
import { createSession } from "../auth/session-store.ts";
import { createApp } from "../index.ts";
import { prepareSyntheticSearchIndex } from "./test-support.ts";
import { disableSearch } from "./indexing/admin.ts";
import { mailSearchCapabilitiesSchema } from "@orca/shared/mail-search";
const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

test("indexed HTTP search is authorized, full-index ranked, paged and explicitly unavailable before readiness", async () => {
  const previous = { session: process.env.SESSION_SECRET, encryption: process.env.TOKEN_ENCRYPTION_KEY };
  process.env.SESSION_SECRET = "synthetic-search-http-session-secret-only";
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 29).toString("base64");
  const directory = mkdtempSync(join(tmpdir(), "orca-search-http-")); directories.push(directory);
  const path = join(directory, "mail.sqlite");
  const { db, sqlite } = createDatabaseClient(path);
  try {
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../../drizzle") });
    db.insert(users).values([{ id: "owner", email: "owner@example.test" }, { id: "foreign", email: "foreign@example.test" }]).run();
    db.insert(oauthAccounts).values([
      { id: "owned", userId: "owner", provider: "gmail", providerId: "owned", providerEmail: "owned@example.test" },
      { id: "other", userId: "foreign", provider: "gmail", providerId: "other", providerEmail: "other@example.test" },
    ]).run();
    for (let i = 0; i < 13; i++) {
      const id = `message-${String(i).padStart(2, "0")}`; const accountId = i === 12 ? "other" : "owned";
      db.insert(threads).values({ id: `thread-${id}`, accountId, providerThreadId: id }).run();
      db.insert(emails).values({ id, accountId, threadId: `thread-${id}`, providerMessageId: id,
        fromAddress: "studio@example.test", fromName: "Studio", subject: i === 0 ? "Appointment confirmation" : "Older saved note",
        snippet: "Synthetic record", bodyText: "Appointment confirmation with AI update, literal 50% code_a.", receivedAt: new Date("2020-01-01T00:00:00Z") }).run();
    }
    const app = createApp({ dbFactory: () => createDatabaseClient(path) });
    const session = await createSession(db, "owner"); const headers = { cookie: `orca_session=${session.token}` };
    expect((await app.request("/v1/mail/search?query=appointment")).status).toBe(401);
    const inactive = await app.request("/v1/mail/search?query=AI", { headers });
    expect(inactive.status).toBe(503); expect((await inactive.json()).error.code).toBe("search_not_activated");
    expect((await app.request("/v1/mail/search/capabilities")).status).toBe(401);
    const capabilitiesResponse = await app.request("/v1/mail/search/capabilities", { headers });
    expect(capabilitiesResponse.headers.get("Cache-Control")).toBe("private, no-store");
    const initial = mailSearchCapabilitiesSchema.parse(await capabilitiesResponse.json());
    expect(initial).toMatchObject({ version: 1, mode: "legacy-metadata", ownerId: "owner", coverage: "stored-metadata", semantics: "legacy-substring-v1" });
    const expectedLegacy = { ...headers, "X-Orca-Expected-Search-Mode": initial.mode, "X-Orca-Expected-Search-Epoch": initial.epoch };
    const short = await app.request("/v1/inbox?query=o&view=all&classification=all&limit=1", { headers: expectedLegacy });
    expect(short.status).toBe(200); expect(short.headers.get("X-Orca-Search-Mode")).toBe(initial.mode); expect(short.headers.get("X-Orca-Search-Epoch")).toBe(initial.epoch);
    const shortFirst = await short.json(); expect(shortFirst.counts.attention.all).toBe(12); expect(shortFirst.nextCursor).toBeTruthy();
    const shortNext = await app.request(`/v1/inbox?query=o&view=all&classification=all&limit=1&cursor=${encodeURIComponent(shortFirst.nextCursor)}`, { headers: expectedLegacy });
    expect(shortNext.status).toBe(200); expect((await shortNext.json()).messages[0].id).not.toBe(shortFirst.messages[0].id);
    for (const incomplete of [{ "X-Orca-Expected-Search-Mode": initial.mode }, { "X-Orca-Expected-Search-Epoch": initial.epoch }, { "X-Orca-Expected-Search-Mode": initial.mode, "X-Orca-Expected-Search-Epoch": "legacy-server" }] as Record<string, string>[]) {
      const mismatch = await app.request("/v1/inbox?query=o&cursor=invalid&limit=invalid", { headers: { ...headers, ...incomplete } });
      expect(mismatch.status).toBe(409); expect((await mismatch.json()).error.code).toBe("search_mode_changed");
    }
    expect((await app.request("/v1/inbox?view=all", { headers })).status).toBe(200);
    prepareSyntheticSearchIndex(sqlite);
    const active = mailSearchCapabilitiesSchema.parse(await (await app.request("/v1/mail/search/capabilities", { headers })).json());
    expect(active.mode).toBe("indexed"); expect(active.epoch).not.toBe(initial.epoch);
    const staleMode = await app.request("/v1/mail/search?query=AI&cursor=invalid", { headers: expectedLegacy });
    expect(staleMode.status).toBe(409); expect((await staleMode.json()).error.code).toBe("search_mode_changed");
    const response = await app.request("/v1/mail/search?query=confirmation+appointment", { headers });
    expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("X-Orca-Search-Mode")).toBe("indexed"); expect(response.headers.get("X-Orca-Search-Epoch")).toBe(active.epoch);
    const first = await response.json(); expect(first.messages).toHaveLength(10); expect(first.messages[0].id).toBe("message-00");
    expect(first.counts).toBeUndefined(); expect(first.continuation).toBe("matches");
    const second = await (await app.request(`/v1/mail/search?query=confirmation+appointment&cursor=${encodeURIComponent(first.nextCursor)}`, { headers })).json();
    expect(second.messages).toHaveLength(2); expect(second.nextCursor).toBeNull();
    expect(new Set([...first.messages, ...second.messages].map((row: { id: string }) => row.id)).size).toBe(12);
    expect([...first.messages, ...second.messages].every((row: { accountId: string }) => row.accountId === "owned")).toBe(true);
    const legacy = await (await app.request("/v1/inbox?classification=all&view=all&query=appointment", { headers })).json();
    expect(legacy.messages).toHaveLength(1); expect(legacy.counts.attention.all).toBe(1);
    for (const invalid of ["query=AI", "query=" + Array.from({ length: 17 }, (_, i) => `term${i}`).join("+"), "query=appointment&limit=51", "query=appointment&searchBodyText=false"]) {
      expect((await app.request(`/v1/mail/search?${invalid}`, { headers })).status).toBe(400);
    }
    expect((await app.request("/v1/mail/search?query=absent&accountId=other", { headers })).status).toBe(404);
    expect((await app.request("/v1/mail/search?query=absent&collectionId=missing", { headers })).status).toBe(404);
    expect((await app.request("/v1/mail/search?query=AI+update", { headers })).status).toBe(200);
    expect((await app.request(`/v1/mail/search?query=confirmation+appointment&view=focus&cursor=${encodeURIComponent(first.nextCursor)}`, { headers })).status).toBe(409);
    sqlite.exec("UPDATE emails SET body_text='New canonical body' WHERE id='message-01'");
    const updating = await app.request("/v1/mail/search?query=appointment", { headers });
    expect(updating.status).toBe(503); expect((await updating.json()).error.code).toBe("search_index_updating");
    expect((await app.request("/v1/inbox?view=all", { headers })).status).toBe(200);
    expect((await app.request("/v1/inbox?view=all&query=appointment", { headers })).status).toBe(200);
    sqlite.exec("UPDATE emails SET subject='Appointment changed' WHERE id='message-01'");
    const laggedMetadata = await app.request("/v1/inbox?view=all&query=appointment", { headers });
    expect(laggedMetadata.status).toBe(503); expect((await laggedMetadata.json()).error.code).toBe("search_index_updating");
    expect((await (await app.request("/v1/mail/search/capabilities", { headers })).json()).mode).toBe("indexed");
    disableSearch(sqlite, "Synthetic deliberate rollback");
    const rollback = await app.request("/v1/inbox?view=all&query=AI", { headers });
    expect(rollback.status).toBe(200); expect(rollback.headers.get("X-Orca-Search-Mode")).toBe("legacy-metadata");
    expect(rollback.headers.get("X-Orca-Search-Epoch")).not.toBe(initial.epoch);
    expect((await (await app.request("/v1/mail/search?query=appointment", { headers })).json()).error.code).toBe("search_not_activated");
    sqlite.exec("ALTER TABLE mail_search_control RENAME TO unavailable_search_control");
    try {
      const browsing = await app.request("/v1/inbox?view=all&classification=all", { headers });
      expect(browsing.status).toBe(200); expect((await browsing.json()).counts.attention.all).toBe(12);
      // Explicit blank query parameters retain the original validation error.
      expect((await app.request("/v1/inbox?query=", { headers })).status).toBe(400);
      const unavailableText = await app.request("/v1/inbox?view=all&query=appointment", { headers });
      expect(unavailableText.status).toBe(503); expect((await unavailableText.json()).error.code).toBe("search_index_unavailable");
    } finally { sqlite.exec("ALTER TABLE unavailable_search_control RENAME TO mail_search_control"); }
  } finally {
    sqlite.close();
    if (previous.session === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = previous.session;
    if (previous.encryption === undefined) delete process.env.TOKEN_ENCRYPTION_KEY; else process.env.TOKEN_ENCRYPTION_KEY = previous.encryption;
  }
});
