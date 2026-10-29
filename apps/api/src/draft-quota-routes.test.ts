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

test("draft byte quota rejects growth but permits shrinking an over-cap account", async () => {
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
    await run({ sqlite, request: (method, suffix, body, account = "account") => app.request(`/v1/drafts${suffix}?accountId=${account}`, {
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
