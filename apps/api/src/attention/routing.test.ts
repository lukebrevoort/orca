import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { AttentionRoutingChange, AttentionRoutingState, AttentionRoutingTarget } from "@orca/shared";
import { createDatabaseClient } from "../db/client.ts";
import { emails, oauthAccounts, senderAttentionRules, threads, users } from "../db/schema.ts";
import { createApp } from "../index.ts";
import { createSession } from "../auth/session-store.ts";
import { createAttentionRouting } from "./routing.ts";
import { createMailboxReader } from "../mailbox/read.ts";
import { createOrganization } from "../organization/module.ts";
import { createSqliteOrganizationRepository } from "../organization/sqlite-repository.ts";
const folders: string[] = [];
const original = { SESSION_SECRET: process.env.SESSION_SECRET, TOKEN_ENCRYPTION_KEY: process.env.TOKEN_ENCRYPTION_KEY };
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});
async function setup() {
  process.env.SESSION_SECRET = "attention-routing-test-session-secret-long-enough";
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString("base64");
  const directory = mkdtempSync(join(tmpdir(), "orca-routing-")); folders.push(directory);
  const path = join(directory, "test.sqlite"); const client = createDatabaseClient(path);
  migrate(client.db, { migrationsFolder: resolve(import.meta.dir, "../../drizzle") });
  client.db.insert(users).values([{ id: "owner", email: "owner@example.com" }, { id: "other", email: "other@example.com" }]).run();
  client.db.insert(oauthAccounts).values(["a", "b", "private"].map(id => ({ id, userId: id === "private" ? "other" : "owner", provider: "gmail" as const, providerId: id, providerEmail: `${id}@example.com` }))).run();
  function message(id: string, accountId = "a", address = "maya@example.com", threadId = id) {
    client.db.insert(threads).values({ id: threadId, accountId, providerThreadId: threadId, messageCount: 1 }).onConflictDoNothing().run();
    client.db.insert(emails).values({ id, accountId, threadId, providerMessageId: id, fromAddress: address, fromName: "Maya", receivedAt: new Date(1000 + Number(id.replace(/\D/g, "")) * 1000), bodyText: "hello" }).run();
  }
  message("m1"); message("m2"); message("m3", "a", "unruled@elsewhere.com"); message("m4", "b"); message("m5", "private");
  const session = await createSession(client.db, "owner");
  const app = createApp({ dbFactory: () => createDatabaseClient(path) });
  const headers = { cookie: `orca_session=${session.token}`, "content-type": "application/json" };
  const request = (url: string, method = "GET", body?: unknown) => app.request(url, { headers, method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const state = async (accountId = "a", query = "") => {
    const response = await request(`/v1/attention/routing?accountId=${accountId}${query}`);
    expect(response.status).toBe(200); return await response.json() as AttentionRoutingState;
  };
  const save = async (target: AttentionRoutingTarget, behavior: AttentionRoutingChange["behavior"], accountId = "a", revision?: number) => {
    const response = await request(`/v1/attention/routing?accountId=${accountId}`, "PUT", { target, behavior, expectedRevision: revision ?? (await state(accountId)).revision });
    expect(response.status).toBe(200); return await response.json() as { state: AttentionRoutingState; undo: AttentionRoutingChange };
  };
  return { ...client, path, app, request, state, save, message };
}
const sender = { scope: "sender", address: "maya@example.com" } as const;
const conversation = { scope: "conversation", threadId: "m1" } as const;
const account = { scope: "account" } as const;

test("public routing persists to mailbox, thread reader and Organization after reopen, including future matching mail", async () => {
  const f = await setup();
  expect((await f.state()).selection.effective).toMatchObject({ behavior: "normal", source: "fallback", destination: "inbox" });
  await f.save(sender, "quiet");
  f.message("m6");
  f.sqlite.close();
  const reopened = createDatabaseClient(f.path);
  const reader = createMailboxReader(reopened.sqlite);
  const first = reader.read({ authorization: { userId: "owner", accountIds: ["a"] }, query: { view: "quiet", limit: 1 } }).response;
  expect(first.counts.attention).toMatchObject({ normal: 1, quiet: 3, all: 4 });
  expect(first.messages.map(m => m.id)).toEqual(["m6"]);
  const second = reader.read({ authorization: { userId: "owner", accountIds: ["a"] }, query: { view: "quiet", limit: 1, cursor: first.nextCursor! } }).response;
  expect(second.messages.map(m => m.id)).toEqual(["m2"]);
  expect(reader.read({ authorization: { userId: "owner", accountIds: ["b"] }, query: { limit: 10 } }).response.messages[0]?.attentionBehavior).toBe("normal");
  const detail = await f.request("/v1/threads/m1?accountId=a"); expect(detail.status).toBe(200);
  expect(await detail.json()).toMatchObject({ thread: { attention: { attentionBehavior: "quiet" } }, messages: [{ attentionBehavior: "quiet" }] });
  const organization = createOrganization(createSqliteOrganizationRepository(reopened.db)).query({ scope: { actor: { type: "human", id: "owner" }, workspaceId: "owner", accountIds: ["a"] }, query: { accountIds: ["a"], attention: "quiet", classification: "all", limit: 1 } });
  expect(organization.threads).toHaveLength(1);
  expect(organization.threads[0]?.organization.attentionBehavior).toBe("quiet");
  reopened.sqlite.close();
});

test("conversation > exact sender > advanced domain > explicit default > Inbox; resets and Undo restore inheritance", async () => {
  const f = await setup();
  await f.save(account, "quiet");
  f.db.insert(senderAttentionRules).values({ id: "domain", accountId: "a", scope: "domain", value: "example.com", behavior: "hidden", source: "user_choice" }).run();
  expect((await f.state("a", "&address=maya@example.com")).selection).toMatchObject({ explicitBehavior: null, effective: { behavior: "hidden", source: "domain", destination: null } });
  await f.save(sender, "normal");
  const override = await f.save(conversation, "quiet");
  expect(override.state.selection).toMatchObject({ explicitBehavior: "quiet", effective: { source: "conversation" }, inherited: { behavior: "normal", source: "sender" } });
  await f.save(sender, "focus");
  expect((await f.state("a", "&threadId=m1")).selection.effective.behavior).toBe("quiet");
  expect((await f.request("/v1/attention/routing?accountId=a", "PUT", override.undo)).status).toBe(409);
  const reset = await f.save(conversation, null);
  expect(reset.state.selection.effective).toMatchObject({ behavior: "focus", source: "sender", destination: null });
  const undone = await f.request("/v1/attention/routing?accountId=a", "PUT", reset.undo);
  expect(undone.status).toBe(200);
  expect((await undone.json()).state.selection.effective.source).toBe("conversation");
  await f.save(conversation, null); await f.save(sender, null);
  expect((await f.state("a", "&threadId=m1")).selection.effective.source).toBe("domain");
  expect((await f.state("a", "&address=unruled@elsewhere.com")).selection.effective.source).toBe("account");
  await f.save(account, null);
  expect((await f.state("a", "&address=unruled@elsewhere.com")).selection.effective).toMatchObject({ behavior: "normal", source: "fallback" });
  f.sqlite.close();
});

test("unknown and foreign account/thread reject; normalized sender choices stay account-scoped", async () => {
  const f = await setup();
  for (const accountId of ["missing", "private"]) {
    expect((await f.request(`/v1/attention/routing?accountId=${accountId}`)).status).toBe(404);
    expect((await f.request(`/v1/attention/routing?accountId=${accountId}`, "PUT", { expectedRevision: 0, target: sender, behavior: "quiet" })).status).toBe(404);
  }
  for (const threadId of ["missing", "m4", "m5"]) {
    expect((await f.request(`/v1/attention/routing?accountId=a&threadId=${threadId}`)).status).toBe(404);
    expect((await f.request("/v1/attention/routing?accountId=a", "PUT", { expectedRevision: 0, target: { scope: "conversation", threadId }, behavior: "quiet" })).status).toBe(404);
  }
  await f.save({ scope: "sender", address: " MAYA@EXAMPLE.COM " }, "quiet");
  expect((await f.state()).senders[0]?.value).toBe("maya@example.com");
  expect((await f.state("b")).senders).toEqual([]);
  expect((await f.app.request("/v1/attention/routing?accountId=a")).status).toBe(401);
  expect((await f.request("/v1/attention/routing?accountId=a", "PUT", { expectedRevision: 1, target: conversation, behavior: "hidden" })).status).toBe(400);
  f.sqlite.close();
});

test("stale first-create and update across connections reject; legacy CRUD/batch invalidate guarded saves", async () => {
  const f = await setup(); const second = createDatabaseClient(f.path);
  const one = createAttentionRouting(f.db, "owner"), two = createAttentionRouting(second.db, "owner");
  const revision = two.read("a").revision;
  one.save("a", { expectedRevision: revision, target: sender, behavior: "quiet" });
  expect(() => two.save("a", { expectedRevision: revision, target: sender, behavior: "normal" })).toThrow("changed elsewhere");
  const update = two.read("a").revision;
  two.save("a", { expectedRevision: update, target: sender, behavior: "normal" });
  expect(() => one.save("a", { expectedRevision: update, target: sender, behavior: "quiet" })).toThrow("changed elsewhere");
  const beforeLegacy = await f.state();
  const legacy = await f.request("/v1/attention/rules/batch", "POST", { targets: [{ accountId: "a", address: sender.address }], behavior: "quiet" });
  expect(legacy.status).toBe(200);
  expect((await f.request("/v1/attention/routing?accountId=a", "PUT", { expectedRevision: beforeLegacy.revision, target: account, behavior: "quiet" })).status).toBe(409);
  const rule = (await f.state()).senders[0]!;
  let old = (await f.state()).revision;
  expect((await f.request(`/v1/attention/rules/${rule.id}?accountId=a`, "PATCH", { behavior: "focus" })).status).toBe(200);
  expect((await f.state()).revision).toBeGreaterThan(old);
  old = (await f.state()).revision;
  expect((await f.request(`/v1/attention/rules/${rule.id}?accountId=a`, "DELETE")).status).toBe(204);
  expect((await f.state()).revision).toBeGreaterThan(old);
  const create = await f.request("/v1/attention/rules?accountId=b", "POST", { scope: "address", value: sender.address, behavior: "hidden", source: "user_choice" });
  expect(create.status).toBe(200);
  expect((await f.state("a")).senders).toEqual([]);
  expect((await f.request(`/v1/attention/resolve?accountId=b&address=${sender.address}`)).status).toBe(200);
  f.sqlite.close(); second.sqlite.close();
});

test("bounded known-sender search isolates accounts, normalizes duplicates and never writes rules", async () => {
  const f = await setup();
  const response = await f.request("/v1/attention/senders?accountId=a&query=maya"); expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ accountId: "a", candidates: [{ address: "maya@example.com", name: "Maya" }, { address: "unruled@elsewhere.com", name: "Maya" }], truncated: false });
  expect((await f.request("/v1/attention/senders?accountId=private")).status).toBe(404);
  expect((await f.state()).revision).toBe(0);
  f.sqlite.close();
});

test("SQL counts/filter/pagination apply conversation and default before limiting; reset invalidates cursors", async () => {
  const f = await setup();
  await f.save(account, "quiet");
  await f.save(conversation, "normal");
  const read = async (query: string) => {
    const response = await f.request(`/v1/inbox?accountId=a&${query}`);
    expect(response.status).toBe(200); return response.json();
  };
  const inbox = await read("limit=1");
  expect(inbox.messages.map((m: { id: string }) => m.id)).toEqual(["m1"]);
  expect(inbox.counts).toMatchObject({ normal: 1, quiet: 2, all: 3 });
  const quiet = await read("view=quiet&limit=1");
  expect(quiet.messages[0].id).toBe("m3");
  const next = await read(`view=quiet&limit=1&cursor=${encodeURIComponent(quiet.nextCursor)}`);
  expect(next.messages[0].id).toBe("m2");
  await f.save(sender, "hidden");
  expect((await read("limit=1")).messages[0].id).toBe("m1");
  expect((await f.request(`/v1/inbox?accountId=a&view=quiet&limit=1&cursor=${encodeURIComponent(quiet.nextCursor)}`)).status).toBe(400);
  await f.save(conversation, null);
  expect((await read("limit=10")).messages).toHaveLength(0);
  expect((await read("view=hidden&limit=10")).messages).toHaveLength(2);
  const detail = await f.request("/v1/threads/m1?accountId=a");
  expect((await detail.json()).thread.attention.attentionBehavior).toBe("hidden");
  await f.save(sender, null); await f.save(account, null);
  expect((await read("limit=10")).messages).toHaveLength(3);
  f.sqlite.close();
});

test("lookup bounds response, escapes search literals, and returns only the chosen account", async () => {
  const f = await setup();
  for (let i = 10; i < 45; i++) f.message(`m${i}`, "a", `sender${i}@example.com`);
  f.message("m99", "b", "private-to-b@example.com");
  const result = await (await f.request("/v1/attention/senders?accountId=a")).json();
  expect(result.candidates).toHaveLength(30); expect(result.truncated).toBe(true);
  expect(JSON.stringify(result)).not.toContain("private-to-b");
  const literal = await (await f.request("/v1/attention/senders?accountId=a&query=%25")).json();
  expect(literal.candidates).toEqual([]);
  f.sqlite.close();
});

test("conversation override covers all senders and future replies; reset exposes each message's inherited rule", async () => {
  const f = await setup();
  await f.save(sender, "quiet");
  await f.save(conversation, "normal");
  f.message("m8", "a", "another@elsewhere.com", "m1");
  let detail = await (await f.request("/v1/threads/m1?accountId=a")).json();
  expect(detail.messages.map((m: { attentionBehavior: string }) => m.attentionBehavior)).toEqual(["normal", "normal"]);
  expect((await f.state("a", "&threadId=m1")).selection.effective.source).toBe("conversation");
  await f.save(conversation, null);
  detail = await (await f.request("/v1/threads/m1?accountId=a")).json();
  expect(detail.messages.map((m: { attentionBehavior: string }) => m.attentionBehavior)).toEqual(["quiet", "normal"]);
  expect(detail.thread.attention.attentionBehavior).toBe("normal");
  expect((await f.state("a", "&threadId=m1")).selection.effective.behavior).toBe("normal");
  f.sqlite.close();
});

test("reader canonical sender orders missing dates after epoch-zero and pre-epoch mail", async () => {
  const f = await setup();
  f.message("m7", "a", "undated@example.com", "m1");
  f.sqlite.query("UPDATE emails SET received_at = NULL WHERE id = 'm7'").run();
  await f.save({ scope: "sender", address: "undated@example.com" }, "hidden");
  await f.save(sender, "quiet");
  for (const timestamp of [0, -1000]) {
    f.sqlite.query("UPDATE emails SET received_at = ? WHERE id = 'm1'").run(timestamp);
    expect((await f.state("a", "&threadId=m1")).selection.effective.behavior).toBe("quiet");
    expect(await (await f.request("/v1/threads/m1?accountId=a")).json()).toMatchObject({ thread: { attention: { attentionBehavior: "quiet" } } });
  }
  f.sqlite.close();
});
