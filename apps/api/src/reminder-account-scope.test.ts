import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "bun:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createSession } from "./auth/session-store.ts";
import { createDatabaseClient } from "./db/client.ts";
import { oauthAccounts, threadReminders, threads, users } from "./db/schema.ts";
import { createApp } from "./index.ts";

async function fixture(run: (f: {
  request: (path: string, method?: string, body?: unknown, authenticated?: boolean) => Promise<Response>;
  db: ReturnType<typeof createDatabaseClient>["db"];
  advance: () => void;
}) => Promise<void>) {
  const previousSecret = process.env.SESSION_SECRET;
  const previousKey = process.env.TOKEN_ENCRYPTION_KEY;
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.SESSION_SECRET = "synthetic-reminder-session-secret-long-enough";
  const dir = mkdtempSync(join(tmpdir(), "orca-reminder-scope-"));
  const dbPath = join(dir, "test.sqlite");
  const { db, sqlite } = createDatabaseClient(dbPath);
  let clock = new Date("2026-10-15T12:00:00Z");
  try {
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });
    db.insert(users).values([{ id: "owner", email: "owner@example.com" }, { id: "foreign", email: "foreign@example.com" }]).run();
    db.insert(oauthAccounts).values([
      { id: "first", userId: "owner", provider: "gmail", providerId: "first", providerEmail: "first@example.com", createdAt: new Date(1) },
      { id: "second", userId: "owner", provider: "gmail", providerId: "second", providerEmail: "second@example.com", createdAt: new Date(2) },
      { id: "foreign", userId: "foreign", provider: "gmail", providerId: "foreign", providerEmail: "foreign@example.com" },
      { id: "outlook", userId: "owner", provider: "outlook", providerId: "outlook", providerEmail: "outlook@example.com" },
    ]).run();
    for (const id of ["first", "second", "foreign", "outlook"]) {
      db.insert(threads).values({ id: `thread-${id}`, accountId: id, providerThreadId: "same-provider-thread-id" }).run();
      db.insert(threadReminders).values({ id: `reminder-${id}`, accountId: id, threadId: `thread-${id}`, scheduledFor: new Date("2026-10-16T12:00:00Z"), timezone: "UTC", status: "scheduled" }).run();
    }
    const session = await createSession(db, "owner");
    const app = createApp({ dbFactory: () => createDatabaseClient(dbPath), now: () => clock });
    await run({ db, advance: () => { clock = new Date("2026-10-17T12:00:00Z"); }, request: (path, method = "GET", body, authenticated = true) => app.request(path, {
      method, headers: { ...(authenticated ? { cookie: `orca_session=${session.token}` } : {}), "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }) });
  } finally {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
    if (previousSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSecret;
    if (previousKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = previousKey;
  }
}
const input = (threadId: string) => ({ threadId, scheduledFor: "2026-10-18T12:00:00.000Z", timezone: "UTC", notify: true });

test("reminders create against the thread's owned Gmail account, including the second account", async () => fixture(async ({ request, db }) => {
  for (const account of ["first", "second"]) {
    const response = await request("/v1/reminders", "POST", input(`thread-${account}`));
    assert.equal(response.status, 200, `create on ${account} account`);
    const reminder = await response.json();
    assert.equal(reminder.accountId, account);
    assert.equal(reminder.id, `reminder-${account}`, "rescheduling preserves the existing identity");
    assert.equal(reminder.notify, true);
  }
  assert.equal(db.select().from(threadReminders).all().length, 4);
}));

test("reminders list and resurface both owned Gmail accounts without touching other accounts", async () => fixture(async ({ request, db, advance }) => {
  const before = await (await request("/v1/reminders")).json();
  assert.deepEqual(before.map((r: { id: string }) => r.id), ["reminder-first", "reminder-second"]);
  advance();
  const due = await (await request("/v1/reminders")).json();
  assert.equal(due.length, 2);
  for (const reminder of due) {
    assert.equal(reminder.status, "resurfaced");
    assert.equal(reminder.resurfacedAt, "2026-10-17T12:00:00.000Z");
  }
  for (const record of db.select().from(threadReminders).all().filter((r) => ["foreign", "outlook"].includes(r.accountId))) {
    assert.equal(record.status, "scheduled");
    assert.equal(record.resurfacedAt, null);
  }
}));

test("second-account reminders can be snoozed, completed, and cancelled by their owner", async () => fixture(async ({ request }) => {
  const patch = await request("/v1/reminders/reminder-second", "PATCH", { scheduledFor: "2026-10-18T12:00:00.000Z", notify: true });
  assert.equal(patch.status, 200);
  assert.equal((await patch.json()).accountId, "second");
  const done = await request("/v1/reminders/reminder-second/done", "POST");
  assert.equal(done.status, 200);
  assert.equal((await done.json()).status, "completed");
  assert.equal((await request("/v1/reminders/reminder-second", "DELETE")).status, 204);
  assert.equal((await request("/v1/reminders/reminder-second", "DELETE")).status, 204);
}));

test("reminder mutations reject foreign, unsupported-provider, missing, and unauthenticated targets without writes", async () => fixture(async ({ request, db }) => {
  const original = db.select().from(threadReminders).all();
  for (const id of ["foreign", "outlook", "missing"]) {
    assert.equal((await request("/v1/reminders", "POST", input(`thread-${id}`))).status, 404);
    assert.equal((await request(`/v1/reminders/reminder-${id}`, "PATCH", { notify: true })).status, 404);
    assert.equal((await request(`/v1/reminders/reminder-${id}/done`, "POST")).status, 404);
    assert.equal((await request(`/v1/reminders/reminder-${id}`, "DELETE")).status, 404);
  }
  for (const [path, method, body] of [["/v1/reminders", "GET"], ["/v1/reminders", "POST", input("thread-second")], ["/v1/reminders/reminder-second", "PATCH", { notify: true }], ["/v1/reminders/reminder-second/done", "POST"], ["/v1/reminders/reminder-second", "DELETE"]] as const) {
    assert.equal((await request(path, method, body, false)).status, 401);
  }
  assert.deepEqual(db.select().from(threadReminders).all(), original);
}));
