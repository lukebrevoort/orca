import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createDatabaseClient } from "../db/client.ts";
import { users, oauthAccounts, threads, emails } from "../db/schema.ts";
import { createSession } from "../auth/session-store.ts";
import { createApp } from "../index.ts";

const dirs: string[] = [];
const oldSecret = process.env.SESSION_SECRET;
const oldKey = process.env.TOKEN_ENCRYPTION_KEY;
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); if (oldSecret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = oldSecret; if (oldKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY; else process.env.TOKEN_ENCRYPTION_KEY = oldKey; });
test("waiting endpoint requires authentication and scopes the estimate to an owned account", async () => {
  process.env.SESSION_SECRET = "waiting-route-test-session-secret-long-enough";
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString("base64");
  const dir = mkdtempSync(join(tmpdir(), "orca-waiting-")); dirs.push(dir);
  const path = join(dir, "db.sqlite"), client = createDatabaseClient(path);
  migrate(client.db, { migrationsFolder: resolve(import.meta.dir, "../../drizzle") });
  client.db.insert(users).values([{ id: "owner", email: "owner@example.test" }, { id: "other", email: "other@example.test" }]).run();
  client.db.insert(oauthAccounts).values(["a", "b", "private"].map(id => ({ id, userId: id === "private" ? "other" : "owner", provider: "gmail" as const, providerId: id, providerEmail: `${id}@example.test` }))).run();
  const now = new Date("2026-11-05T00:00:00Z");
  for (const id of ["a", "b", "private"]) {
    client.db.insert(threads).values({ id, accountId: id, providerThreadId: id }).run();
    client.db.insert(emails).values({ id, accountId: id, threadId: id, providerMessageId: id, fromAddress: `${id}@example.test`, subject: `subject-${id}`, bodyText: "private-body", receivedAt: new Date(now.getTime() - 4 * 86400000), humanClassificationReasons: "[]" }).run();
  }
  const session = await createSession(client.db, "owner");
  const app = createApp({ dbFactory: () => createDatabaseClient(path), now: () => now });
  expect((await app.request("/v1/summary/waiting?accountId=a")).status).toBe(401);
  const headers = { cookie: `orca_session=${session.token}` };
  expect((await app.request("/v1/summary/waiting", { headers })).status).toBe(400);
  for (const id of ["private", "missing"]) expect((await app.request(`/v1/summary/waiting?accountId=${id}`, { headers })).status).toBe(404);
  const response = await app.request("/v1/summary/waiting?accountId=a", { headers });
  expect(response.status).toBe(200);
  const result = await response.json() as { accountId: string; waitingOn: { source: { messageId: string }; title: string }[] };
  expect(result.accountId).toBe("a"); expect(result.waitingOn.map(item => item.source.messageId)).toEqual(["a"]);
  expect(JSON.stringify(result)).not.toContain("private-body"); expect(JSON.stringify(result)).not.toContain("subject-b");
  client.sqlite.close();
});
