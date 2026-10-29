import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createSession } from "./auth/session-store.ts";
import { createDatabaseClient } from "./db/client.ts";
import { oauthAccounts, users } from "./db/schema.ts";
import { createApp } from "./index.ts";

const cap = 200 * 1024 * 1024;
const quotaBody = { error: { code: "draft_quota_exceeded", message: "Draft storage quota exceeded.", retryable: false } };

test("draft routes admit count boundaries, isolate accounts, and preserve rejected content", async () => {
  await fixture(async ({ sqlite, request }) => {
    const insert = sqlite.query("INSERT INTO message_drafts (id, account_id, subject) VALUES (?, 'account', 'original')");
    sqlite.transaction(() => { for (let i = 0; i < 199; i++) insert.run(`draft-${i}`); })();
    assert.equal((await request("POST", "", { subject: "draft 200" })).status, 201);
    const before = sqlite.query("SELECT * FROM message_drafts ORDER BY id").all();
    const rejected = await request("POST", "", { body: { text: "PRIVATE <script>alert(1)</script> 🐋", html: null } });
    assert.equal(rejected.status, 413);
    assert.deepEqual(await rejected.json(), quotaBody);
    assert.deepEqual(sqlite.query("SELECT * FROM message_drafts ORDER BY id").all(), before);
    const stale = await request("PATCH", "/draft-0", { revision: 99, subject: "stale private" });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error.code, "stale_draft");
    assert.deepEqual(sqlite.query("SELECT * FROM message_drafts ORDER BY id").all(), before);
    assert.equal((await request("PATCH", "/draft-0", { revision: 0, subject: "edited at 200" })).status, 200);
    assert.equal((await request("POST", "", { subject: "other account" }, "second")).status, 201);
    assert.equal((await request("POST", "", {})).status, 400);
    assert.equal((await request("PATCH", "/missing", { revision: 0, subject: "missing" })).status, 404);
    sqlite.exec("UPDATE message_drafts SET delivery_status = 'sending' WHERE id = 'draft-1'");
    assert.equal((await request("PATCH", "/draft-1", { revision: 0, subject: "delivery" })).status, 409);
  });
});

test("draft byte quota rejects growth but permits shrinking an over-cap account", { timeout: 60_000 }, async () => {
  await fixture(async ({ sqlite, request }) => {
    // SQLite builds the large synthetic value without a giant request or JS allocation.
    const ballastBytes = cap - 1024;
    sqlite.query("INSERT INTO message_drafts (id, account_id, body_text) VALUES ('ballast', 'account', zeroblob(?))").run(ballastBytes);
    sqlite.exec("INSERT INTO message_drafts (id, account_id, body_text) VALUES ('editable', 'account', 'original')");
    const columns = sqlite.query("PRAGMA table_info(message_drafts)").all() as { name: string }[];
    const projection = columns.map(({ name }) => name === "body_text"
      ? "CASE WHEN id = 'ballast' THEN '<synthetic ballast>' ELSE body_text END AS body_text"
      : `"${name}"`).join(", ");
    const smallRows = () => sqlite.query(`SELECT ${projection} FROM message_drafts ORDER BY id`).all();
    const unchangedBallast = () => assert.equal((sqlite.query("SELECT body_text = zeroblob(?) AS intact FROM message_drafts WHERE id = 'ballast'").get(ballastBytes) as { intact: number }).intact, 1);
    const before = smallRows();
    const largeBody = { text: "PRIVATE 🐋<script>".repeat(300), html: null };
    for (const [method, suffix, body] of [
      ["POST", "", { body: largeBody }],
      ["PATCH", "/editable", { revision: 0, body: largeBody }],
    ] as const) {
      const response = await request(method, suffix, body);
      assert.equal(response.status, 413);
      assert.deepEqual(await response.json(), quotaBody);
      assert.deepEqual(smallRows(), before);
      unchangedBallast();
    }
    sqlite.query("UPDATE message_drafts SET body_text = ? WHERE id = 'editable'").run("x".repeat(2048));
    const stale = await request("PATCH", "/editable", { revision: 99, body: largeBody });
    assert.equal(stale.status, 409, "stale revision takes precedence over byte quota");
    assert.equal((await stale.json()).error.code, "stale_draft");
    assert.equal((await request("PATCH", "/editable", { revision: 0, body: { text: "", html: null } })).status, 200);
    unchangedBallast();
    assert.equal((await request("POST", "", { body: largeBody }, "second")).status, 201);
  });
});

const storedByteExpression = ["to_recipients", "cc_recipients", "bcc_recipients", "subject", "body_text", "body_html", "context", "attachments"]
  .map(column => `COALESCE(length(CAST(${column} AS BLOB)), 0)`).join(" + ");

test("truly over-cap accounts admit shrinking and identical edits but reject growth and creates", { timeout: 60_000 }, async () => {
  await fixture(async ({ sqlite, request }) => {
    const created = await request("POST", "", { body: { text: "original", html: null } });
    assert.equal(created.status, 201);
    const { id } = await created.json();
    sqlite.query("INSERT INTO message_drafts (id, account_id, body_text) VALUES ('ballast', 'account', zeroblob(?))").run(cap + 4096);
    for (const [revision, text] of [[0, "short"], [1, "short"]] as const) {
      assert.equal((await request("PATCH", `/${id}`, { revision, body: { text, html: null } })).status, 200);
    }
    const columns = sqlite.query("PRAGMA table_info(message_drafts)").all() as { name: string }[];
    const projection = columns.map(({ name }) => name === "body_text"
      ? "CASE WHEN id = 'ballast' THEN '<synthetic ballast>' ELSE body_text END AS body_text"
      : `"${name}"`).join(", ");
    const rows = () => sqlite.query(`SELECT ${projection} FROM message_drafts ORDER BY id`).all();
    const before = rows();
    for (const [method, suffix, body] of [
      ["PATCH", `/${id}`, { revision: 2, body: { text: "short!", html: null } }],
      ["POST", "", { subject: "new" }],
    ] as const) {
      const response = await request(method, suffix, body);
      assert.equal(response.status, 413);
      assert.deepEqual(await response.json(), quotaBody);
      assert.deepEqual(rows(), before);
    }
    const stale = await request("PATCH", `/${id}`, { revision: 0, subject: "stale" });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error.code, "stale_draft");
    assert.deepEqual(rows(), before);
    assert.equal((sqlite.query("SELECT body_text = zeroblob(?) AS intact FROM message_drafts WHERE id = 'ballast'").get(cap + 4096) as { intact: number }).intact, 1);
  });
});

for (const method of ["POST", "PATCH"] as const) {
  test(`${method} draft bytes admit the exact cap and reject one byte over`, { timeout: 60_000 }, async () => {
    await fixture(async ({ sqlite, request }) => {
      const body = { subject: "boundary 🐋", body: { text: "probe", html: "<b>safe</b><script>hostile()</script>" } };
      const probe = await request("POST", "", body);
      assert.equal(probe.status, 201);
      const { id: probeId } = await probe.json();
      const { bytes } = sqlite.query(`SELECT ${storedByteExpression} AS bytes FROM message_drafts WHERE id = ?`).get(probeId) as { bytes: number };
      sqlite.query("DELETE FROM message_drafts WHERE id = ?").run(probeId);
      sqlite.query("INSERT INTO message_drafts (id, account_id, body_text) VALUES ('ballast', 'account', zeroblob(?))").run(cap - bytes);
      const ballastOverhead = (sqlite.query(`SELECT ${storedByteExpression} AS bytes FROM message_drafts WHERE id = 'ballast'`).get() as { bytes: number }).bytes - (cap - bytes);
      sqlite.query("UPDATE message_drafts SET body_text = zeroblob(?) WHERE id = 'ballast'").run(cap - bytes - ballastOverhead);
      let editableId = "";
      if (method === "PATCH") {
        const editable = await request("POST", "", { subject: "x" });
        assert.equal(editable.status, 201);
        editableId = (await editable.json()).id;
      }
      const exact = await request(method, method === "PATCH" ? `/${editableId}` : "", method === "PATCH" ? { ...body, revision: 0 } : body);
      assert.equal(exact.status, method === "POST" ? 201 : 200);
      assert.equal((sqlite.query(`SELECT SUM(${storedByteExpression}) AS bytes FROM message_drafts`).get() as { bytes: number }).bytes, cap);
      if (method === "POST") sqlite.query("DELETE FROM message_drafts WHERE id = ?").run((await exact.json()).id);
      else sqlite.query("UPDATE message_drafts SET subject = 'x', body_text = NULL, body_html = NULL WHERE id = ?").run(editableId);
      sqlite.query("UPDATE message_drafts SET body_text = zeroblob(?) WHERE id = 'ballast'").run(cap - bytes - ballastOverhead + 1);
      const before = sqlite.query(`SELECT ${storedByteExpression} AS bytes, revision FROM message_drafts ORDER BY id`).all();
      const over = await request(method, method === "PATCH" ? `/${editableId}` : "", method === "PATCH" ? { ...body, revision: 1 } : body);
      assert.equal(over.status, 413);
      assert.deepEqual(await over.json(), quotaBody);
      assert.deepEqual(sqlite.query(`SELECT ${storedByteExpression} AS bytes, revision FROM message_drafts ORDER BY id`).all(), before);
    });
  });
}

async function fixture(run: (context: {
  sqlite: ReturnType<typeof createDatabaseClient>["sqlite"];
  request: (method: string, suffix: string, body: unknown, account?: string) => Promise<Response>;
}) => Promise<void>) {
  const previousSecret = process.env.SESSION_SECRET;
  const previousEncryption = process.env.TOKEN_ENCRYPTION_KEY;
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 42).toString("base64");
  process.env.SESSION_SECRET = "draft-quota-route-test-secret-at-least-32-characters";
  const dir = mkdtempSync(join(tmpdir(), "orca-draft-quota-"));
  const path = join(dir, "test.sqlite");
  const { db, sqlite } = createDatabaseClient(path);
  try {
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });
    db.insert(users).values({ id: "owner", email: "owner@example.com" }).run();
    db.insert(oauthAccounts).values(["account", "second"].map(id => ({ id, userId: "owner", provider: "gmail" as const, providerId: id, providerEmail: `${id}@example.com` }))).run();
    const session = await createSession(db, "owner");
    const app = createApp({ dbFactory: () => createDatabaseClient(path) });
    await run({ sqlite, request: async (method, suffix, body, account = "account") => app.request(`/v1/drafts${suffix}?accountId=${account}`, {
      method, headers: { cookie: `orca_session=${session.token}`, "content-type": "application/json" }, body: JSON.stringify(body),
    }) });
  } finally {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
    if (previousEncryption === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = previousEncryption;
    if (previousSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSecret;
  }
}
