import { afterEach, expect, test } from "bun:test";
import { organizationLaneApplyResponseSchema } from "@orca/shared";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { AttentionRoutingChange, AttentionRoutingState, AttentionRoutingTarget } from "@orca/shared";
import { createDatabaseClient } from "../db/client.ts";
import { emails, oauthAccounts, senderAttentionRules, threads, users } from "../db/schema.ts";
import { createApp } from "../index.ts";
import { createSession } from "../auth/session-store.ts";
import { createAttentionRouting } from "../attention/routing.ts";
import { createMailboxReader } from "../mailbox/read.ts";
import { createOrganization } from "../organization/module.ts";
import { createSqliteOrganizationRepository } from "../organization/sqlite-repository.ts";
import { createDestinations } from "./service.ts";
import { readThreadDestination } from "./resolution.ts";
import { sql } from "drizzle-orm";
const folders: string[] = [];
const original = { SESSION_SECRET: process.env.SESSION_SECRET, TOKEN_ENCRYPTION_KEY: process.env.TOKEN_ENCRYPTION_KEY };
afterEach(() => {
    for (const folder of folders.splice(0))
        rmSync(folder, { recursive: true, force: true });
    for (const [key, value] of Object.entries(original)) {
        if (value === undefined)
            delete process.env[key];
        else
            process.env[key] = value;
    }
});
async function setup() {
    process.env.SESSION_SECRET = "attention-routing-test-session-secret-long-enough";
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString("base64");
    const directory = mkdtempSync(join(tmpdir(), "orca-routing-"));
    folders.push(directory);
    const path = join(directory, "test.sqlite");
    const client = createDatabaseClient(path);
    migrate(client.db, { migrationsFolder: resolve(import.meta.dir, "../../drizzle") });
    client.db.insert(users).values([{ id: "owner", email: "owner@example.com" }, { id: "other", email: "other@example.com" }]).run();
    client.db.insert(oauthAccounts).values(["a", "b", "private"].map(id => ({ id, userId: id === "private" ? "other" : "owner", provider: "gmail" as const, providerId: id, providerEmail: `${id}@example.com` }))).run();
    function message(id: string, accountId = "a", address = "maya@example.com", threadId = id) {
        client.db.insert(threads).values({ id: threadId, accountId, providerThreadId: threadId, messageCount: 1 }).onConflictDoNothing().run();
        client.db.insert(emails).values({ id, accountId, threadId, providerMessageId: id, fromAddress: address, fromName: "Maya", receivedAt: new Date(1000 + Number(id.replace(/\D/g, "")) * 1000), bodyText: "hello" }).run();
    }
    message("m1");
    message("m2");
    message("m3", "a", "unruled@elsewhere.com");
    message("m4", "b");
    message("m5", "private");
    const session = await createSession(client.db, "owner");
    const app = createApp({ dbFactory: () => createDatabaseClient(path) });
    const headers = { cookie: `orca_session=${session.token}`, "content-type": "application/json" };
    const request = (url: string, method = "GET", body?: unknown) => app.request(url, { headers, method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const state = async (accountId = "a", query = "") => {
        const response = await request(`/v1/attention/routing?accountId=${accountId}${query}`);
        expect(response.status).toBe(200);
        return await response.json() as AttentionRoutingState;
    };
    const save = async (target: AttentionRoutingTarget, behavior: AttentionRoutingChange["behavior"], accountId = "a", revision?: number) => {
        const response = await request(`/v1/attention/routing?accountId=${accountId}`, "PUT", { target, behavior, expectedRevision: revision ?? (await state(accountId)).revision });
        expect(response.status).toBe(200);
        return await response.json() as {
            state: AttentionRoutingState;
            undo: AttentionRoutingChange;
        };
    };
    return { ...client, path, app, request, state, save, message };
}
const sender = { scope: "sender", address: "maya@example.com" } as const;
const conversation = { scope: "conversation", threadId: "m1" } as const;
const account = { scope: "account" } as const;
function service(f: Awaited<ReturnType<typeof setup>>) { return createDestinations(f.db, "owner"); }
function add(f: Awaited<ReturnType<typeof setup>>, name = "Clients") { const s = service(f); return s.create({ expectedRevision: s.list().revision, name }).state.destinations.find(d => d.name === name)!; }
function route(f: Awaited<ReturnType<typeof setup>>, target: AttentionRoutingTarget, destinationId: string | null, accountId = "a") { const s = service(f); return s.save(accountId, { expectedRevision: s.list().revision, target, destinationId }); }
test("fresh catalog is Inbox only; GET is read-only; stable names, collision validation, ordering and notification intent", async () => {
    const f = await setup(), s = service(f), initial = s.list();
    expect(initial.destinations.map(d => d.name)).toEqual(["Inbox"]);
    const changes = f.sqlite.query("select total_changes() n").get();
    s.list();
    s.read("a");
    expect(f.sqlite.query("select total_changes() n").get()).toEqual(changes);
    const clients = add(f);
    expect(() => add(f, " clients ")).toThrow("already exists");
    const updated = s.update(clients.id, { expectedRevision: s.list().revision, name: "Customers", position: 0, notificationPreference: "notify" });
    expect(updated.state.destinations[0]).toMatchObject({ id: clients.id, name: "Customers", delivery: "proposal_only", notificationPreference: "notify" });
    expect(s.list().fallbackDestinationId).toBe(initial.fallbackDestinationId);
    expect((await f.request("/v1/destinations")).status).toBe(200);
    f.sqlite.close();
});
test("sender destination applies to current/future mail, SQL pages/counts, reader and Organization across accounts", async () => {
    const f = await setup(), s = service(f), clients = add(f);
    route(f, sender, clients.id);
    f.message("m6");
    const reader = createMailboxReader(f.sqlite), q = { destinationId: clients.id, limit: 1 };
    const page = reader.read({ authorization: { userId: "owner", accountIds: ["a"] }, query: q }).response;
    expect(page.messages.map(m => m.id)).toEqual(["m6"]);
    expect(page.counts.attention.all).toBe(3);
    const next = reader.read({ authorization: { userId: "owner", accountIds: ["a"] }, query: { ...q, cursor: page.nextCursor! } }).response;
    expect(next.messages.map(m => m.id)).toEqual(["m2"]);
    expect(s.list().destinations.find(d => d.id === clients.id)?.counts).toEqual({ total: 3, unread: 3 });
    expect(s.read("b", sender).selection.effective.destinationId).not.toBe(clients.id);
    const detail = await f.request("/v1/threads/m1?accountId=a");
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ thread: { attention: { destination: { destinationId: clients.id } } }, messages: [{ destination: { destinationId: clients.id } }] });
    const o = createOrganization(createSqliteOrganizationRepository(f.db)).query({ scope: { actor: { type: "human", id: "owner" }, workspaceId: "owner", accountIds: ["a"] }, query: { accountIds: ["a"], laneIds: [clients.id], limit: 20 } });
    expect(o.threads.length).toBe(3);
    expect(o.threads.every(t => t.organization.lanePlacement.primaryLaneId === clients.id)).toBe(true);
    route(f, sender, null);
    expect(() => reader.read({ authorization: { userId: "owner", accountIds: ["a"] }, query: { ...q, cursor: page.nextCursor! } })).toThrow("cursor");
    f.sqlite.close();
});
test("legacy conversation beats new sender; reset reveals inheritance; guarded Undo and legacy writes invalidate", async () => {
    const f = await setup(), s = service(f), clients = add(f);
    await f.save(conversation, "quiet");
    const quiet = s.read("a", conversation).selection.effective.destinationId;
    route(f, sender, clients.id);
    expect(s.read("a", conversation).selection.effective.destinationId).toBe(quiet);
    const reset = route(f, conversation, null);
    expect(reset.state.selection.effective.destinationId).toBe(clients.id);
    s.save("a", reset.undo);
    expect(s.read("a", conversation).selection.effective.destinationId).toBe(quiet);
    const undo = route(f, conversation, clients.id).undo;
    await f.save(account, "quiet");
    expect(() => s.save("a", undo)).toThrow("changed");
    expect(s.read("a").senders).toContainEqual({ scope: "address", value: "maya@example.com", destinationId: clients.id, source: "user_choice", editable: true });
    route(f, sender, null);
    expect(s.read("a").senders).toEqual([]);
    f.sqlite.close();
});
test("ownership, retired targets and safe retirement reject references without deleting mail", async () => {
    const f = await setup(), s = service(f), clients = add(f), spare = add(f, "Spare");
    expect(() => s.read("private")).toThrow("not found");
    expect(() => s.read("a", { scope: "conversation", threadId: "m5" })).toThrow("not found");
    const foreign = createDestinations(f.db, "other").create({ expectedRevision: createDestinations(f.db, "other").list().revision, name: "Private" }).state.destinations.find(d => d.name === "Private")!;
    expect(() => route(f, sender, foreign.id)).toThrow("not found");
    route(f, sender, clients.id);
    expect(() => s.retire(clients.id, { expectedRevision: s.list().revision, reassignToDestinationId: spare.id })).toThrow("Move conversations");
    s.retire(spare.id, { expectedRevision: s.list().revision, reassignToDestinationId: clients.id });
    expect(() => route(f, sender, spare.id)).toThrow("not found");
    expect(f.sqlite.query("select count(*) n from emails").get()).toEqual({ n: 5 });
    f.sqlite.close();
});
test("explicit sender beats advanced placement; safety lock freezes actual effective destination", async () => {
    const f = await setup(), s = service(f), clients = add(f), advanced = add(f, "Advanced");
    f.db.run(sql `update organization_thread_lane_states set primary_lane_id=${advanced.id},placement_source='lane_policy' where account_id='a' and thread_id='m1'`);
    route(f, sender, clients.id);
    expect(readThreadDestination(f.db, "owner", "a", "m1")?.destinationId).toBe(clients.id);
    const repo = createSqliteOrganizationRepository(f.db), org = createOrganization(repo), p = repo.lanes!.getSnapshot("owner", ["a"]).placements.find(p => p.threadId === "m1")!;
    org.apply({ scope: { actor: { type: "human", id: "owner" }, workspaceId: "owner", accountIds: ["a", "b"] }, command: { id: "lock", idempotencyKey: "lock", expectedWorkspaceRevision: s.list().revision, actions: [{ kind: "set_thread_safety_lock", accountId: "a", threadId: "m1", locked: true, reason: "Protect", expectedThreadRevision: p.revision }] } });
    route(f, sender, advanced.id);
    expect(readThreadDestination(f.db, "owner", "a", "m1")).toMatchObject({ destinationId: clients.id, locked: true });
    expect(() => route(f, conversation, advanced.id)).toThrow("protected");
    const locked = repo.lanes!.getSnapshot("owner", ["a"]);
    const unlockInput = { scope: { actor: { type: "human" as const, id: "owner" }, workspaceId: "owner", accountIds: ["a", "b"] }, command: { id: "unlock", idempotencyKey: "unlock", expectedWorkspaceRevision: locked.configuration.workspaceRevision, actions: [{ kind: "set_thread_safety_lock" as const, accountId: "a", threadId: "m1", locked: false, reason: "Release", expectedThreadRevision: locked.placements.find(p => p.threadId === "m1")!.revision }] } };
    const unlocked = organizationLaneApplyResponseSchema.parse(org.apply(unlockInput));
    expect(unlocked.placements[0]).toMatchObject({ primaryLaneId: advanced.id, destination: { destinationId: advanced.id, source: "sender", locked: false } });
    expect(org.apply(unlockInput)).toEqual(unlocked);
    expect(repo.lanes!.getSnapshot("owner", ["a"]).placements.find(p => p.threadId === "m1")).toEqual(unlocked.placements[0]);
    f.sqlite.close();
});
test("lock preserves advanced candidate across sender reset, database reopen and unlock", async () => {
    const f = await setup(), clients = add(f), advanced = add(f, "Advanced");
    f.db.run(sql`update organization_thread_lane_states set primary_lane_id=${advanced.id},placement_source='lane_policy',source_id='advanced-policy',reason='Advanced A' where account_id='a' and thread_id='m1'`);
    route(f, sender, clients.id);
    const scope = { actor: { type: "human" as const, id: "owner" }, workspaceId: "owner", accountIds: ["a"] };
    const lock = (db: typeof f.db, locked: boolean) => {
        const repo = createSqliteOrganizationRepository(db);
        const snapshot = repo.lanes!.getSnapshot("owner", ["a"]);
        return createOrganization(repo).apply({ scope, command: { id: locked ? "freeze" : "unfreeze", idempotencyKey: locked ? "freeze" : "unfreeze", expectedWorkspaceRevision: snapshot.configuration.workspaceRevision, actions: [{ kind: "set_thread_safety_lock", accountId: "a", threadId: "m1", locked, reason: "Protect", expectedThreadRevision: snapshot.placements.find(p => p.threadId === "m1")!.revision }] } });
    };
    lock(f.db, true);
    const audit = f.sqlite.query("select before_json,after_json from organization_change_actions where change_id='freeze' and resource_family='thread'").get() as { before_json: string; after_json: string };
    expect(JSON.parse(audit.before_json).placement).toMatchObject({ primaryLaneId: advanced.id, evidence: { sourceId: "advanced-policy", reason: "Advanced A" } });
    expect(JSON.parse(audit.after_json)).toMatchObject({ placement: { primaryLaneId: clients.id, evidence: { winningSource: "safety_lock", sourceId: clients.id } }, lowerCandidate: { primaryLaneId: advanced.id, evidence: { sourceId: "advanced-policy", reason: "Advanced A" } } });
    route(f, sender, null);
    expect(() => createOrganization(createSqliteOrganizationRepository(f.db)).apply({ scope: { ...scope, accountIds: ["b"] }, command: { id: "retire-locked", idempotencyKey: "retire-locked", expectedWorkspaceRevision: service(f).list().revision, actions: [{ kind: "update_lane", laneId: clients.id, retired: true, expectedRevision: clients.revision }] } })).toThrow("referenced");
    f.sqlite.close();
    const reopened = createDatabaseClient(f.path);
    try {
        expect(readThreadDestination(reopened.db, "owner", "a", "m1")).toMatchObject({ destinationId: clients.id, locked: true });
        expect(createDestinations(reopened.db, "owner").read("a", conversation).selection.effective).toMatchObject({ destinationId: clients.id, locked: true });
        lock(reopened.db, false);
        expect(readThreadDestination(reopened.db, "owner", "a", "m1")).toMatchObject({ destinationId: advanced.id, source: "advanced", locked: false });
        expect(createSqliteOrganizationRepository(reopened.db).lanes!.getSnapshot("owner", ["a"]).placements.find(p => p.threadId === "m1")).toMatchObject({ primaryLaneId: advanced.id, evidence: { winningSource: "lane_policy", sourceId: "advanced-policy", reason: "Advanced A" } });
    } finally { reopened.sqlite.close(); }
});
for (const target of [sender, account]) test(`manual reset apply and replay match canonical ${target.scope} destination reads`, async () => {
    const f = await setup(), clients = add(f), manual = add(f, "Manual");
    route(f, target, clients.id);
    route(f, conversation, manual.id);
    const repo = createSqliteOrganizationRepository(f.db), org = createOrganization(repo);
    const snapshot = repo.lanes!.getSnapshot("owner", ["a"]);
    const input = { scope: { actor: { type: "human" as const, id: "owner" }, workspaceId: "owner", accountIds: ["a"] }, command: { id: "reset", idempotencyKey: "reset", expectedWorkspaceRevision: snapshot.configuration.workspaceRevision, actions: [{ kind: "set_thread_manual_override" as const, accountId: "a", threadId: "m1", laneId: null, reason: "Inherit", expectedThreadRevision: snapshot.placements.find(p => p.threadId === "m1")!.revision }] } };
    const response = organizationLaneApplyResponseSchema.parse(org.apply(input));
    expect(response.placements[0]).toMatchObject({ primaryLaneId: clients.id, destination: { destinationId: clients.id, source: target.scope } });
    expect(org.apply(input)).toEqual(response);
    expect(repo.lanes!.getSnapshot("owner", ["a"]).placements.find(p => p.threadId === "m1")).toEqual(response.placements[0]);
    const query = org.query({ scope: input.scope, query: { accountIds: ["a"], laneIds: [clients.id], limit: 20 } });
    expect(query.threads.find(t => t.id === "m1")?.organization.lanePlacement.primaryLaneId).toBe(clients.id);
    const detail = await f.request("/v1/threads/m1?accountId=a");
    expect(await detail.json()).toMatchObject({ thread: { attention: { destination: { destinationId: clients.id } } } });
    const page = createMailboxReader(f.sqlite).read({ authorization: { userId: "owner", accountIds: ["a"] }, query: { destinationId: clients.id, limit: 20 } }).response;
    expect(page.messages.find(m => m.id === "m1")?.destination?.destinationId).toBe(clients.id);
    const audit = f.sqlite.query("select after_json from organization_change_actions where change_id='reset' and resource_family='thread'").get() as { after_json: string };
    expect(JSON.parse(audit.after_json).lowerCandidate.primaryLaneId).toBe(service(f).list().fallbackDestinationId);
    f.sqlite.close();
});
test("destination filtering paginates beyond 100 and rejects changed filters or stale concurrent writes", async () => {
    const f = await setup(), s = service(f), clients = add(f);
    route(f, sender, clients.id);
    f.db.transaction(() => { for (let i = 10; i < 135; i++)
        f.message(`m${i}`); });
    const reader = createMailboxReader(f.sqlite), query = { destinationId: clients.id, limit: 100 };
    const first = reader.read({ authorization: { userId: "owner" }, query }).response;
    const second = reader.read({ authorization: { userId: "owner" }, query: { ...query, cursor: first.nextCursor! } }).response;
    expect(first.messages.length).toBe(100);
    expect(second.messages.length).toBe(27);
    expect(second.nextCursor).toBeNull();
    expect(first.counts.attention.all).toBe(127);
    expect(new Set([...first.messages, ...second.messages].map(m => m.id)).size).toBe(127);
    expect(() => reader.read({ authorization: { userId: "owner" }, query: { ...query, destinationId: s.list().fallbackDestinationId, cursor: first.nextCursor! } })).toThrow("cursor");
    const other = createDatabaseClient(f.path), otherService = createDestinations(other.db, "owner"), old = s.list().revision;
    s.update(clients.id, { expectedRevision: old, name: "Customers" });
    expect(() => otherService.create({ expectedRevision: old, name: "Concurrent" })).toThrow("changed");
    expect(() => reader.read({ authorization: { userId: "owner" }, query: { ...query, cursor: first.nextCursor! } })).toThrow("cursor");
    expect(otherService.read("a", sender).selection.effective.destinationId).toBe(clients.id);
    other.sqlite.close();
    f.sqlite.close();
});
test("SQL resolution and inherited selection agree through account, sender, conversation and legacy transitions", async () => {
    const f = await setup(), s = service(f), clients = add(f);
    const matches = () => expect(readThreadDestination(f.db, "owner", "a", "m1")).toMatchObject(s.read("a", conversation).selection.effective);
    matches();
    route(f, account, clients.id);
    matches();
    await f.save(sender, "hidden");
    matches();
    route(f, sender, s.list().fallbackDestinationId);
    matches();
    route(f, conversation, clients.id);
    matches();
    route(f, conversation, null);
    matches();
    route(f, sender, null);
    matches();
    route(f, account, null);
    matches();
    const q = s.list().legacyDestinationIds.hidden!;
    const hidden = createMailboxReader(f.sqlite).read({ authorization: { userId: "owner" }, query: { destinationId: q, limit: 100 } }).response;
    expect(hidden.messages).toHaveLength(0); // Explicit sender reset suppresses old hidden placement, without deleting mail.
    expect(f.sqlite.query("select count(*) n from emails").get()).toEqual({ n: 5 });
    f.sqlite.close();
});
test("populated pre-0042 upgrade preserves custom fallback identity and legacy conversation choices", () => {
    const directory = mkdtempSync(join(tmpdir(), "orca-destination-upgrade-"));
    folders.push(directory);
    const oldFolder = join(directory, "migrations");
    mkdirSync(join(oldFolder, "meta"), { recursive: true });
    const source = resolve(import.meta.dir, "../../drizzle");
    const journal = JSON.parse(readFileSync(join(source, "meta/_journal.json"), "utf8"));
    journal.entries = journal.entries.filter((e: {
        idx: number;
    }) => e.idx < 42);
    writeFileSync(join(oldFolder, "meta/_journal.json"), JSON.stringify(journal));
    for (const e of journal.entries)
        copyFileSync(join(source, e.tag + ".sql"), join(oldFolder, e.tag + ".sql"));
    const f = createDatabaseClient(join(directory, "upgrade.sqlite"));
    migrate(f.db, { migrationsFolder: oldFolder });
    f.db.insert(users).values({ id: "owner", email: "owner@example.com" }).run();
    f.db.insert(oauthAccounts).values({ id: "a", userId: "owner", provider: "gmail", providerId: "a", providerEmail: "a@example.com" }).run();
    f.db.insert(threads).values({ id: "t", accountId: "a", providerThreadId: "t" }).run();
    f.db.insert(emails).values({ id: "m", accountId: "a", threadId: "t", providerMessageId: "m", fromAddress: "maya@example.com" }).run();
    const fallback = f.sqlite.query("select fallback_lane_id id from organization_workspace_lane_settings where workspace_id='owner'").get() as {
        id: string;
    };
    f.sqlite.query("update organization_lanes set name='Personal desk' where workspace_id='owner' and id=?").run(fallback.id);
    createAttentionRouting(f.db, "owner").save("a", { expectedRevision: 0, target: { scope: "conversation", threadId: "t" }, behavior: "quiet" });
    // Both historical lock forms must keep their existing visible destination.
    f.db.insert(threads).values([{ id: "locked-lower", accountId: "a", providerThreadId: "locked-lower" }, { id: "locked-manual", accountId: "a", providerThreadId: "locked-manual" }]).run();
    f.sqlite.query("insert into organization_lanes(workspace_id,id,name,position,default_policy_id) select workspace_id,'old-manual','Old manual',99,default_policy_id from organization_lanes where workspace_id='owner' and id=?").run(fallback.id);
    f.sqlite.exec("update organization_thread_lane_states set safety_locked=1,safety_lock_actor_id='owner',safety_lock_actor_type='human',safety_lock_reason='Legacy protection' where thread_id in ('locked-lower','locked-manual')");
    f.sqlite.exec("update organization_thread_lane_states set manual_override_lane_id='old-manual',manual_override_actor_id='owner',manual_override_actor_type='human',manual_override_reason='Manual',manual_override_at=1 where thread_id='locked-manual'");
    migrate(f.db, { migrationsFolder: source });
    for (const [threadId, destinationId] of [["locked-lower", fallback.id], ["locked-manual", "old-manual"]]) {
        expect(readThreadDestination(f.db, "owner", "a", threadId!)).toMatchObject({ destinationId, locked: true });
        expect(createDestinations(f.db, "owner").read("a", { scope: "conversation", threadId: threadId! }).selection.effective).toMatchObject({ destinationId, locked: true });
        expect(f.sqlite.query("select safety_lock_lane_id id from organization_thread_lane_states where thread_id=?").get(threadId!)).toEqual({ id: destinationId });
    }
    const s = createDestinations(f.db, "owner"), catalog = s.list();
    expect(catalog.fallbackDestinationId).toBe(fallback.id);
    expect(catalog.destinations.every(d => d.color === "#70867d")).toBe(true);
    expect(catalog.destinations.find(d => d.isFallback)?.name).toBe("Personal desk");
    expect(catalog.legacyDestinationIds.quiet).toBeDefined();
    expect(catalog.legacyDestinationIds.hidden).toBeUndefined();
    expect(s.read("a", { scope: "conversation", threadId: "t" }).selection).toMatchObject({ explicitDestinationId: catalog.legacyDestinationIds.quiet, effective: { destinationId: catalog.legacyDestinationIds.quiet, source: "conversation" } });
    expect(f.sqlite.query("select behavior from thread_attention_overrides").get()).toEqual({ behavior: "quiet" });
    expect(f.sqlite.query("pragma foreign_key_check").all()).toEqual([]);
    f.sqlite.close();
});
test("HTTP destination mutations return affected stable ID and enforce validation/authentication", async () => {
    const f = await setup();
    const initial = await (await f.request("/v1/destinations")).json();
    const create = await f.request("/v1/destinations", "POST", { expectedRevision: initial.revision, name: "HTTP Clients" });
    expect(create.status).toBe(200);
    const result = await create.json();
    expect(result.state.destinations.some((d: {
        id: string;
    }) => d.id === result.destinationId)).toBe(true);
    const put = await f.request("/v1/destinations/routing?accountId=a", "PUT", { expectedRevision: result.state.revision, target: sender, destinationId: result.destinationId });
    expect(put.status).toBe(200);
    const inbox = await f.request(`/v1/inbox?destinationId=${result.destinationId}&limit=1`);
    expect(inbox.status).toBe(200);
    expect(await inbox.json()).toMatchObject({ messages: [{ destination: { destinationId: result.destinationId } }], counts: { all: 2 } });
    expect((await f.request("/v1/destinations", "POST", { name: "Missing revision" })).status).toBe(400);
    expect((await f.app.request("/v1/destinations")).status).toBe(401);
    expect((await f.request("/v1/destinations/routing?accountId=private")).status).toBe(404);
    const customQuiet = add(f, "Quiet");
    await f.save(account, "quiet");
    const catalog = service(f).list();
    expect(catalog.legacyDestinationIds.quiet).not.toBe(customQuiet.id);
    expect(new Set(catalog.destinations.map(d => d.name.trim().toLowerCase())).size).toBe(catalog.destinations.length);
    f.sqlite.close();
});

test("destination color persists through authority, stale writes, rename/reorder and database reopen", async () => {
    const f = await setup(), s = service(f);
    const initial = s.list();
    expect(initial.destinations[0]?.color).toBe("#70867d");
    const created = s.create({ expectedRevision: initial.revision, name: "Clients", color: "#648ac4" });
    const id = created.destinationId;
    route(f, sender, id);
    const before = s.list().revision;
    s.update(id, { expectedRevision: before, name: "Partners", color: "#c7788c" });
    expect(() => s.update(id, { expectedRevision: before, color: "#459c98" })).toThrow("changed");
    const revision = s.list().revision;
    const invalid = await f.request(`/v1/destinations/${id}`, "PATCH", { expectedRevision: revision, color: "url(evil)" });
    expect(invalid.status).toBe(400);
    expect(s.list().revision).toBe(revision);
    s.update(id, { expectedRevision: revision, name: "Partners renamed", position: 0 });
    expect(s.list().destinations[0]).toMatchObject({ id, name: "Partners renamed", color: "#c7788c" });
    const repo = createSqliteOrganizationRepository(f.db);
    expect(repo.lanes!.getSnapshot("owner", []).configuration.lanes.find(l => l.id === id)?.color).toBe("#c7788c");
    const audit = f.sqlite.query("select before_json,after_json from organization_change_actions where resource_family='lane' and resource_id=? and action_kind='update_lane' order by rowid").all(id) as { before_json: string; after_json: string }[];
    expect(audit.some(a => JSON.parse(a.before_json).color === "#648ac4" && JSON.parse(a.after_json).color === "#c7788c")).toBe(true);
    f.sqlite.close();
    const reopened = createDatabaseClient(f.path);
    try {
        const restored = createDestinations(reopened.db, "owner");
        expect(restored.list().destinations.find(d => d.id === id)?.color).toBe("#c7788c");
        expect(restored.read("a", sender).selection.effective.destinationId).toBe(id);
        expect(restored.read("b", sender).selection.effective.destinationId).not.toBe(id);
    } finally { reopened.sqlite.close(); }
});
