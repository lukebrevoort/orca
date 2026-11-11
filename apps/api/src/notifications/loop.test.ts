import { test, expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { notificationFixture } from "./fixture.ts";
import { clearMobilePushTestEnv, setMobilePushTestEnv } from "../mobile-push/test-helpers.ts";
import type { ImportantNotificationClaimResponse } from "@orca/shared";
async function fixture(run: (f: Awaited<ReturnType<typeof notificationFixture>>) => Promise<void>) {
  setMobilePushTestEnv(); const f = await notificationFixture();
  try { await run(f); } finally { f.sqlite.close(); clearMobilePushTestEnv(); }
}
async function claim(f: Awaited<ReturnType<typeof notificationFixture>>, revision = 1, operationId: string = randomUUID(), id = "browser") {
  const response = await f.request(`/v1/notifications/installations/${id}/claim`, { channel: "open_app", expectedRevision: revision, operationId, permission: "granted" }, "POST");
  expect(response.status).toBe(200); return await response.json() as ImportantNotificationClaimResponse;
}
test("BRE-455 real authenticated browser feed claims important automated archived arrivals and records constructor reports", () => fixture(async f => {
  expect((await f.adopt()).status).toBe(200);
  await f.fresh("automated-important");
  const proof = f.sqlite.query("SELECT evidence,important_at_arrival FROM important_notification_arrivals WHERE message_id='gmail:a:automated-important'").get();
  expect(proof).toEqual({ evidence: "gmail_smtp_metadata", important_at_arrival: 1 });
  const result = await claim(f);
  expect(result.notifications).toHaveLength(1);
  const envelope = result.notifications[0]!;
  expect(envelope.threadId).toBe("gmail:a:conversation"); expect(envelope.body).toBe("Open Orca to read this message.");
  const retry = await claim(f, 1, result.operationId); expect(retry).toEqual(result);
  expect((await claim(f)).notifications).toHaveLength(0);
  const report = { operationId: result.operationId, notificationIds: [envelope.id], outcome: "constructed" };
  for (let i = 0; i < 2; i++) { const response = await f.request("/v1/notifications/installations/browser/report", report, "POST"); expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ reported: 1, displayConfirmed: false }); }
  expect((await claim(f, 1, result.operationId)).notifications).toHaveLength(0);
  expect(f.sqlite.query("SELECT state,count(*) n FROM important_notification_web_deliveries GROUP BY state").all()).toEqual([{ state: "constructed", n: 1 }]);
}));
test("BRE-455 old mark before first scan, human unreviewed/not-important, unknown direction and read arrivals stay quiet", () => fixture(async f => {
  await f.adopt();
  await f.persist(f.message("old", "old")); await f.important("gmail:a:old");
  await f.persist(f.human("human-unreviewed", "human"));
  await f.persist(f.human("human-not-important", "human-not")); await f.important("gmail:a:human-not", "not_important");
  await f.fresh("known");
  await f.persist(f.message("unknown", "conversation", { payload: { headers: [{ name: "From", value: "alias@example.com" }] } }));
  await f.persist(f.message("read", "conversation", { labelIds: [] }));
  f.sqlite.query("UPDATE emails SET is_read=1 WHERE id='gmail:a:known'").run();
  expect((await claim(f)).notifications).toHaveLength(0);
  expect(f.sqlite.query("SELECT count(*) n FROM important_notification_arrivals WHERE evidence='unknown'").get()).toEqual({ n: 1 });
  // A later sync with perfect-looking trace cannot upgrade the unknown arrival.
  await f.persist(f.message("unknown", "conversation")); expect((await claim(f)).notifications).toHaveLength(0);
}));
test("BRE-455 persistent cooldown suppresses arrivals permanently and allows exact fifteen-minute boundary", () => fixture(async f => {
  await f.adopt(); await f.fresh("first"); expect((await claim(f)).notifications).toHaveLength(1);
  const firstTime = f.state.now;
  f.state.now = firstTime + 899000; await f.persist(f.message("suppressed", "conversation")); expect((await claim(f)).notifications).toHaveLength(0);
  f.state.now = firstTime + 900000; expect((await claim(f)).notifications).toHaveLength(0);
  await f.persist(f.message("boundary", "conversation")); expect((await claim(f)).notifications).toHaveLength(1);
}));
test("BRE-455 identical save retains fresh pending, disable/re-enable and new accounts do not replay backlog", () => fixture(async f => {
  await f.adopt(); await f.fresh("pending");
  expect((await f.adopt("open_app", "browser", 1)).status).toBe(200);
  expect((await claim(f, 2)).notifications).toHaveLength(1);
  expect((await f.adopt("open_app", "browser", 2, { enabled: false })).status).toBe(200);
  f.state.now += 1000; await f.persist(f.message("while-disabled", "conversation"));
  expect((await f.adopt("open_app", "browser", 3)).status).toBe(200);
  expect((await claim(f, 4)).notifications).toHaveLength(0);
}));
test("BRE-455 correction, lease expiry, permission and stale generations prevent claim retry/report reuse", () => fixture(async f => {
  await f.adopt(); await f.fresh("queued"); const first = await claim(f); expect(first.notifications).toHaveLength(1);
  await f.important("gmail:a:conversation", "not_important");
  expect((await claim(f, 1, first.operationId)).notifications).toHaveLength(0);
  const report = await f.request("/v1/notifications/installations/browser/report", { operationId: first.operationId, notificationIds: [first.notifications[0]!.id], outcome: "constructed" }, "POST"); expect(report.status).toBe(409);
  await f.important("gmail:a:conversation"); f.state.now += 901000; await f.persist(f.message("expired", "conversation")); const second = await claim(f); expect(second.notifications).toHaveLength(1);
  f.state.now += 30001; expect((await claim(f, 1, second.operationId)).notifications).toHaveLength(0);
  await f.adopt("open_app", "browser", 1, { permission: "denied" });
  expect((await f.request("/v1/notifications/installations/browser/claim", { channel: "open_app", expectedRevision: 2, operationId: randomUUID(), permission: "granted" }, "POST")).status).toBe(409);
}));
test("BRE-455 authorization, foreign scopes, operation conflicts and malformed/oversized bodies fail closed", () => fixture(async f => {
  const noAuth = await f.app.request("/v1/notifications/installations/browser?channel=open_app"); expect(noAuth.status).toBe(401);
  const initial = await f.request("/v1/notifications/installations/browser?channel=open_app"); expect(initial.status).toBe(200); expect((await initial.json()).policy).toBeNull();
  expect(f.sqlite.query("SELECT count(*) n FROM important_notification_installations").get()).toEqual({ n: 0 });
  const command = f.command(); expect((await f.request("/v1/notifications/installations/browser", command)).status).toBe(200);
  expect((await f.request("/v1/notifications/installations/browser", { ...command, enabled: false })).status).toBe(409);
  expect((await f.request("/v1/notifications/installations/browser", f.command(1, { accountIds: ["foreign"] }))).status).toBe(404);
  expect((await f.request("/v1/notifications/installations/browser", f.command(1, { accountIds: ["a", "a"] }))).status).toBe(400);
  expect((await f.request("/v1/notifications/installations/browser?channel=open_app", undefined, "GET", f.other.token)).status).toBe(404);
  expect((await f.request("/v1/notifications/installations/browser", f.command(1, { accountIds: ["x".repeat(33000)] }))).status).toBe(413);
  const receipt = await f.request(`/v1/notifications/operations/${command.operationId}`); expect(receipt.status).toBe(200);
  await f.adopt("open_app", "browser", 1, { enabled: false });
  const retry = await f.request("/v1/notifications/installations/browser", command); expect(retry.status).toBe(200); expect(await retry.json()).toMatchObject({ status: "superseded", appliedRevision: 1, current: { revision: 2, policy: { enabled: false } } });
}));

test("BRE-455 exact-sender inheritance uses all retained participants and conversation override wins", () => fixture(async f => {
  const { previewImportance, mutateImportance } = await import("../importance/store.ts");
  await f.adopt(); await f.persist(f.message("sender-seed", "participants"));
  const preview = previewImportance(f.sqlite, { userId: "u", accountId: "a" }, { accountId: "a", address: "receipt@example.net", choice: "important" }, f.state.now);
  mutateImportance(f.sqlite, { userId: "u", accountId: "a" }, { accountId: "a", target: { kind: "sender", address: "receipt@example.net" }, choice: "important", expectedRevision: 0, operationId: randomUUID(), confirmation: preview.confirmation }, f.state.now);
  f.state.now += 1000;
  const human = f.human("new-other-participant", "participants"); human.payload!.headers!.find(h => h.name === "From")!.value = "Other person <other@example.net>";
  await f.persist(human);
  expect((await claim(f)).notifications).toHaveLength(1);
  await f.important("gmail:a:participants", "not_important");
  f.state.now += 901000; await f.persist(f.message("overridden", "participants"));
  expect((await claim(f)).notifications).toHaveLength(0);
  expect(f.sqlite.query("SELECT effective,participant_count FROM importance_thread_state WHERE thread_id='gmail:a:participants'").get()).toEqual({ effective: "not_important", participant_count: 2 });
}));

test("BRE-455 concurrent browser claims and foreign-device reports cannot duplicate or steal envelopes", () => fixture(async f => {
  await f.adopt(); await f.fresh("only-once");
  const claims = await Promise.all([claim(f), claim(f)]); expect(claims.reduce((n, r) => n + r.notifications.length, 0)).toBe(1);
  const owner = claims.find(r => r.notifications.length)!;
  await f.adopt("open_app", "other-browser");
  const foreign = await f.request("/v1/notifications/installations/other-browser/report", { operationId: owner.operationId, notificationIds: [owner.notifications[0]!.id], outcome: "constructed" }, "POST"); expect(foreign.status).toBe(404);
  const changed = await f.request("/v1/notifications/installations/browser/claim", { channel: "open_app", expectedRevision: 9, operationId: owner.operationId, permission: "granted" }, "POST"); expect(changed.status).toBe(409);
  expect(f.sqlite.query("SELECT count(*) n FROM important_notification_web_deliveries").get()).toEqual({ n: 1 });
}));

test("BRE-455 new selected account gets its own boundary and provider thread IDs do not cross-suppress", () => fixture(async f => {
  f.sqlite.query("INSERT INTO oauth_accounts(id,user_id,provider,provider_id,provider_email) VALUES('second','u','gmail','second','u@example.com')").run();
  await f.adopt(); await f.fresh("a-first", "same-provider-thread"); expect((await claim(f)).notifications).toHaveLength(1);
  const { persistGmailMessages } = await import("../providers/gmail/sync.ts");
  const writeSecond = async (id: string) => persistGmailMessages(f.db, { accountId: "second", accountEmail: "u@example.com", gmailMessages: [f.message(id, "same-provider-thread")], labelList: [], now: new Date(f.state.now), propagationTrigger: "push", propagationOptions: { enabled: false } });
  await writeSecond("second-seed"); await f.important("gmail:second:same-provider-thread", "important", "second");
  f.state.now += 1000; await writeSecond("before-selected");
  await f.adopt("open_app", "browser", 1, { accountIds: ["a", "second"] }); expect((await claim(f, 2)).notifications).toHaveLength(0);
  f.state.now += 1000; await writeSecond("after-selected"); const result = await claim(f, 2); expect(result.notifications).toHaveLength(1); expect(result.notifications[0]!.accountId).toBe("second");
}));

test("BRE-455 initially read, corrected-back and read-back arrivals cannot resurrect an interruption", () => fixture(async f => {
  await f.adopt(); await f.fresh("to-correct"); await f.important("gmail:a:conversation", "not_important"); await f.important("gmail:a:conversation");
  expect((await claim(f)).notifications).toHaveLength(0);
  f.state.now += 1000; await f.persist(f.message("read-first", "conversation", { labelIds: [] })); f.sqlite.query("UPDATE emails SET is_read=0 WHERE id='gmail:a:read-first'").run();
  expect((await claim(f)).notifications).toHaveLength(0);
  f.state.now += 1000; await f.persist(f.message("read-back", "conversation")); f.sqlite.query("UPDATE emails SET is_read=1 WHERE id='gmail:a:read-back'").run(); f.sqlite.query("UPDATE emails SET is_read=0 WHERE id='gmail:a:read-back'").run();
  expect((await claim(f)).notifications).toHaveLength(0);
}));

test("BRE-455 stale provider account-email hint preserves ingestion but permanently records unknown arrival evidence", () => fixture(async f => {
  const { persistGmailMessages } = await import("../providers/gmail/sync.ts");
  await f.adopt(); await f.persist(f.message("seed-mismatch", "mismatch")); await f.important("gmail:a:mismatch"); f.state.now += 1000;
  const message = f.message("mismatch", "mismatch");
  await persistGmailMessages(f.db, { accountId: "a", accountEmail: "stale@example.com", gmailMessages: [message], labelList: [], now: new Date(f.state.now), propagationTrigger: "sync", propagationOptions: { enabled: false } });
  expect(f.sqlite.query("SELECT id FROM emails WHERE id='gmail:a:mismatch'").get()).toEqual({ id: "gmail:a:mismatch" });
  expect(f.sqlite.query("SELECT evidence,reason FROM important_notification_arrivals WHERE message_id='gmail:a:mismatch'").get()).toEqual({ evidence: "unknown", reason: "account_metadata_mismatch" });
  expect((await claim(f)).notifications).toHaveLength(0);
  await f.persist(message); expect((await claim(f)).notifications).toHaveLength(0);
}));
