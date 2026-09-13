import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createDatabaseClient } from "../db/client.ts";
import { oauthAccounts, users } from "../db/schema.ts";
import { createAttentionPreferences } from "./preferences.ts";
import { createSession } from "../auth/session-store.ts";
import { createApp } from "../index.ts";
const folders: string[] = [];
const originalSessionSecret = process.env.SESSION_SECRET;
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); if (originalSessionSecret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = originalSessionSecret; });
function setup() {
  const directory = mkdtempSync(join(tmpdir(), "orca-attention-")); folders.push(directory);
  const path = join(directory, "test.sqlite");
  const client = createDatabaseClient(path);
  migrate(client.db, { migrationsFolder: resolve(import.meta.dir, "../../drizzle") });
  client.db.insert(users).values([{ id: "owner", email: "owner@example.com" }, { id: "other", email: "other@example.com" }]).run();
  client.db.insert(oauthAccounts).values(["a", "b", "private"].map(id => ({ id, userId: id === "private" ? "other" : "owner", provider: "gmail" as const, providerId: id, providerEmail: `${id}@example.com` }))).run();
  return { ...client, path };
}
const input = { expectedRevision: 0, defaultChoice: "quiet", senders: [{ address: "  MAYA@example.com ", choice: "notify" }] };
test("preferences persist after reopen, normalize senders, and isolate account ownership", () => {
  const client = setup();
  const preferences = createAttentionPreferences(client.db, "owner");
  expect(preferences.read("a").revision).toBe(0);
  expect(preferences.save("a", input).senders[0]!.address).toBe("maya@example.com");
  expect(preferences.read("b").senders).toEqual([]);
  expect(() => preferences.read("private")).toThrow("not available");
  expect(() => preferences.save("private", input)).toThrow("not available");
  client.sqlite.close();
  const reopened = createDatabaseClient(client.path);
  expect(createAttentionPreferences(reopened.db, "owner").read("a")).toMatchObject({ revision: 1, delivery: "proposal_only", senders: [{ address: "maya@example.com", choice: "notify" }] });
  reopened.sqlite.close();
});
test("stale first-create and update revisions cannot overwrite preferences across connections", () => {
  const client = setup(); const second = createDatabaseClient(client.path);
  const first = createAttentionPreferences(client.db, "owner"); const other = createAttentionPreferences(second.db, "owner");
  expect(other.read("a").revision).toBe(0);
  first.save("a", input);
  expect(() => other.save("a", { ...input, defaultChoice: "notify" })).toThrow("changed elsewhere");
  other.save("a", { ...input, expectedRevision: 1, defaultChoice: "notify" });
  expect(() => first.save("a", { ...input, expectedRevision: 1 })).toThrow("changed elsewhere");
  expect(first.read("a").defaultChoice).toBe("notify");
  client.sqlite.close(); second.sqlite.close();
});
test("invalid and case-insensitive duplicate addresses reject atomically", () => {
  const client = setup(); const preferences = createAttentionPreferences(client.db, "owner");
  expect(() => preferences.save("a", { ...input, senders: [...input.senders, { address: "maya@example.com", choice: "quiet" }] })).toThrow();
  expect(() => preferences.save("a", { ...input, senders: [{ address: "not an email", choice: "notify" }] })).toThrow();
  expect(preferences.read("a").revision).toBe(0);
  client.sqlite.close();
});
test("HTTP requires authentication, checks account ownership, and reports revision conflicts", async () => {
  process.env.SESSION_SECRET ??= "attention-test-session-secret-long-enough";
  const client = setup(); const session = await createSession(client.db, "owner"); client.sqlite.close();
  const app = createApp({ dbFactory: () => createDatabaseClient(client.path) });
  const headers = { cookie: `orca_session=${session.token}`, "content-type": "application/json" };
  expect((await app.request("/v1/attention/preferences?accountId=a")).status).toBe(401);
  expect((await app.request("/v1/attention/preferences?accountId=private", { headers })).status).toBe(403);
  expect((await app.request("/v1/attention/preferences", { headers })).status).toBe(400);
  const save = () => app.request("/v1/attention/preferences?accountId=a", { headers, method: "PUT", body: JSON.stringify(input) });
  expect((await save()).status).toBe(200);
  expect((await save()).status).toBe(409);
});
