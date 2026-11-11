import { test, expect } from "bun:test";
import { notificationFixture } from "./fixture.ts";
import { clearMobilePushTestEnv, setMobilePushTestEnv, testConfig } from "../mobile-push/test-helpers.ts";
import { deliverReady, scanAndEnqueue } from "../mobile-push/scheduler.ts";
import { readDeviceToken } from "../mobile-push/store.ts";
import type { ApnsTransport } from "../mobile-push/apns.ts";
async function fixture(run: (f: Awaited<ReturnType<typeof notificationFixture>>) => Promise<void>) {
  setMobilePushTestEnv(); const f = await notificationFixture();
  try { await run(f); } finally { f.sqlite.close(); clearMobilePushTestEnv(); }
}
const token = "aa".repeat(32);
async function phone(f: Awaited<ReturnType<typeof notificationFixture>>, extra: Record<string, unknown> = {}) {
  return f.request("/v1/mobile/devices/phone", { token, environment: "sandbox", notificationSelection: { inbox: false, spaceIds: [] }, ...extra });
}
function ledger() {
  const attempts: Parameters<ApnsTransport["send"]>[0][] = [];
  return { attempts, transport: { async send(input) { attempts.push(input); return { outcome: "success", status: 200 }; } } as ApnsTransport };
}
const scan = (f: Awaited<ReturnType<typeof notificationFixture>>) => scanAndEnqueue(f.sqlite, { now: new Date(f.state.now), batchSize: 100 });
const deliver = (f: Awaited<ReturnType<typeof notificationFixture>>, transport: ApnsTransport, readToken?: typeof readDeviceToken) => deliverReady(f.sqlite, { now: () => new Date(f.state.now), batchSize: 100, config: testConfig, transport, readToken });
test("BRE-455 actual APNs policy dispatch sends automated Important archived incoming exactly once while U/N/unknown stay quiet", () => fixture(async f => {
  expect((await phone(f)).status).toBe(200); expect((await f.adopt("apns", "phone")).status).toBe(200);
  await f.fresh("automated");
  await f.persist(f.human("human-u", "human")); await f.persist(f.human("human-n", "not")); await f.important("gmail:a:not", "not_important");
  await f.persist(f.message("unknown", "conversation", { payload: { headers: [{ name: "From", value: "alias@example.com" }] } }));
  expect(f.sqlite.query("SELECT human_classification FROM emails WHERE id='gmail:a:automated'").get()).toEqual({ human_classification: "automated_or_bulk" });
  expect(f.sqlite.query("SELECT human_classification FROM emails WHERE id='gmail:a:human-n'").get()).toEqual({ human_classification: "likely_human" });
  expect(scan(f).enqueued).toBe(1); const l = ledger(); expect((await deliver(f, l.transport)).delivered).toBe(1);
  expect(scan(f).enqueued).toBe(0); expect((await deliver(f, l.transport)).delivered).toBe(0); expect(l.attempts).toHaveLength(1);
  expect(l.attempts[0]!.payload).toMatchObject({ version: 1, accountId: "a", threadId: "gmail:a:conversation", aps: { alert: { body: "Open Orca to read this message." } } });
  expect(l.attempts[0]!.payload.aps).not.toHaveProperty("interruption-level");
}));
test("BRE-455 legacy choices survive status/cancel/adoption and older clients cannot downgrade or re-enable", () => fixture(async f => {
  await phone(f, { notificationSelection: { inbox: true, spaceIds: [] } });
  await f.request("/v1/notifications/installations/phone?channel=apns");
  expect(f.sqlite.query("SELECT count(*) n FROM important_notification_installations").get()).toEqual({ n: 0 });
  const adopted = await f.adopt("apns", "phone"); expect((await adopted.json()).current.previousSelection).toEqual({ inbox: true, spaceIds: [] });
  await f.adopt("apns", "phone", 1, { enabled: false });
  await phone(f, { notificationSelection: { inbox: true, spaceIds: [] } });
  const current = await f.request("/v1/notifications/installations/phone?channel=apns"); expect(await current.json()).toMatchObject({ revision: 2, policy: { enabled: false }, previousSelection: { inbox: true, spaceIds: [] }, delivery: { available: false, reason: "disabled" } });
  expect((await (await f.request("/v1/mobile/push/status?installationId=phone")).json()).deliveryEnabled).toBe(false);
  await f.fresh("disabled"); expect(scan(f).enqueued).toBe(0); expect((await deliver(f, ledger().transport)).delivered).toBe(0);
}));
test("BRE-455 correction/read/revoke/account removal during asynchronous decryption prevents provider I/O", async () => {
  for (const change of ["correction", "read", "session", "account", "permission", "token"] as const) await fixture(async f => {
    await phone(f); await f.adopt("apns", "phone"); await f.fresh(`queued-${change}`); expect(scan(f).enqueued).toBe(1);
    const l = ledger();
    const result = await deliver(f, l.transport, async (...args) => {
      const value = await readDeviceToken(...args);
      if (change === "correction") await f.important("gmail:a:conversation", "not_important");
      if (change === "read") f.sqlite.query("UPDATE emails SET is_read=1 WHERE id=?").run(`gmail:a:queued-${change}`);
      if (change === "session") f.sqlite.query("UPDATE sessions SET invalidated_at=? WHERE id=?").run(f.state.now, f.session.sessionId);
      if (change === "account") f.sqlite.query("DELETE FROM oauth_accounts WHERE id='a'").run();
      if (change === "permission") await f.adopt("apns", "phone", 1, { permission: "denied" });
      if (change === "token") await phone(f, { token: "bb".repeat(32) });
      return value;
    });
    expect(l.attempts).toHaveLength(0); expect(result.delivered).toBe(0);
  });
});
test("BRE-455 concurrent workers share one lease and retry with a stable APNs ID", () => fixture(async f => {
  await phone(f); await f.adopt("apns", "phone"); await f.fresh("concurrent"); scan(f);
  const attempts: string[] = [];
  const transport: ApnsTransport = { async send(input) { attempts.push(input.apnsId); await Promise.resolve(); return attempts.length === 1 ? { outcome: "retry", status: 503, reason: "synthetic" } : { outcome: "success", status: 200 }; } };
  const first = await Promise.all([deliver(f, transport), deliver(f, transport)]); expect(attempts).toHaveLength(1); expect(first.reduce((n, r) => n + r.retried, 0)).toBe(1);
  f.state.now += 15000; expect((await deliver(f, transport)).delivered).toBe(1); expect(attempts).toHaveLength(2); expect(attempts[0]).toBe(attempts[1]);
}));
test("BRE-455 unchanged refresh preserves pending; replacement token creates a freshness barrier; deletion retains adoption tombstone", () => fixture(async f => {
  await phone(f); await f.adopt("apns", "phone"); await f.fresh("pending"); scan(f);
  await phone(f); expect((await deliver(f, ledger().transport)).delivered).toBe(1);
  f.state.now += 901000; await f.persist(f.message("old-before-token", "conversation"));
  await phone(f, { token: "bb".repeat(32) }); expect(scan(f).enqueued).toBe(0);
  const current = await (await f.request("/v1/notifications/installations/phone?channel=apns")).json(); expect(current.revision).toBe(2); expect(current.policy.enabled).toBe(true);
  await f.request("/v1/mobile/devices/phone", undefined, "DELETE");
  const removed = await (await f.request("/v1/notifications/installations/phone?channel=apns")).json(); expect(removed.revision).toBe(3); expect(removed.permission).toBe("unavailable");
  await phone(f); expect((await (await f.request("/v1/notifications/installations/phone?channel=apns")).json()).revision).toBe(4); expect(scan(f).enqueued).toBe(0);
}));

test("BRE-455 real opaque mobile-session adoption and revocation use mobile_sessions, not browser cookies", () => fixture(async f => {
  const { createMobileSession, revokeMobileSession } = await import("../auth/mobile/store.ts");
  const mobile = createMobileSession(f.db, "u");
  const request = (path: string, body: unknown) => f.app.request(path, { method: "PUT", headers: { authorization: `Bearer ${mobile.accessToken}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  expect((await request("/v1/mobile/devices/mobile-phone", { token, environment: "sandbox", notificationSelection: { inbox: false, spaceIds: [] } })).status).toBe(200);
  expect((await request("/v1/notifications/installations/mobile-phone", f.command(0, { channel: "apns" }))).status).toBe(200);
  await f.fresh("mobile-first"); expect(scan(f).enqueued).toBe(1); const l = ledger(); expect((await deliver(f, l.transport)).delivered).toBe(1);
  f.state.now += 901000; await f.persist(f.message("mobile-revoked", "conversation")); expect(scan(f).enqueued).toBe(1);
  revokeMobileSession(f.db, mobile.sessionId, "u", new Date(f.state.now)); expect((await deliver(f, l.transport)).delivered).toBe(0); expect(l.attempts).toHaveLength(1);
}));

test("BRE-455 a fresh Important arrival after moving outside Inbox ignores placement and legacy selection", () => fixture(async f => {
  const { createDestinations } = await import("../destinations/service.ts");
  await phone(f); await f.adopt("apns", "phone");
  await f.persist(f.message("old", "moved")); await f.important("gmail:a:moved");
  const destinations = createDestinations(f.db, "u");
  const quiet = destinations.create({ expectedRevision: destinations.list().revision, name: "Quiet archive" }).destinationId;
  destinations.save("a", { expectedRevision: destinations.list().revision, target: { scope: "conversation", threadId: "gmail:a:moved" }, destinationId: quiet });
  f.state.now += 1000; await f.persist(f.message("fresh-moved", "moved"));
  expect(f.sqlite.query("SELECT destination_id FROM organization_effective_destinations WHERE account_id='a' AND thread_id='gmail:a:moved'").get()).toEqual({ destination_id: quiet });
  expect(scan(f).enqueued).toBe(1); const l = ledger(); expect((await deliver(f, l.transport)).delivered).toBe(1); expect(l.attempts).toHaveLength(1);
}));

test("BRE-455 obsolete legacy selected Space does not block adopted token refresh or change saved intent", () => fixture(async f => {
  f.sqlite.query("INSERT INTO collections(id,account_id,name,color,position,revision,created_at,updated_at) VALUES('legacy','a','Legacy','#123456',0,1,1,1)").run();
  expect((await phone(f, { notificationSelection: { inbox: false, spaceIds: ["collection:legacy"] } })).status).toBe(200);
  await f.adopt("apns", "phone");
  f.sqlite.query("DELETE FROM collections WHERE id='legacy'").run();
  expect((await phone(f, { notificationSelection: { inbox: false, spaceIds: ["collection:legacy"] } })).status).toBe(200);
  const current = await (await f.request("/v1/notifications/installations/phone?channel=apns")).json();
  expect(current.revision).toBe(1); expect(current.policy.enabled).toBe(true); expect(current.previousSelection).toEqual({ inbox: false, spaceIds: ["collection:legacy"] });
}));

test("BRE-455 configuration loss and token decryption failure cannot start provider I/O or leave unbounded token retries", async () => {
  for (const failure of ["configuration", "decryption"]) await fixture(async f => {
    await phone(f); await f.adopt("apns", "phone"); await f.fresh(`queued-${failure}`); expect(scan(f).enqueued).toBe(1);
    const l = ledger(), config = { ...testConfig };
    const result = await deliverReady(f.sqlite, { now: new Date(f.state.now), batchSize: 100, config, transport: l.transport, readToken: async (...args) => {
      if (failure === "decryption") throw Error("synthetic decryption failure");
      const value = await readDeviceToken(...args); config.configured = false; return value;
    } });
    expect(l.attempts).toHaveLength(0); expect(result.discarded).toBe(1);
    expect(f.sqlite.query("SELECT state FROM mobile_push_outbox").get()).toEqual({ state: "dead" });
  });
});
