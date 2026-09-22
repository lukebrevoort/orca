import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { createMobileSession, revokeMobileSession } from "../auth/mobile/store.ts";
import { isMobilePushSessionActive } from "../mobile-session-policy.ts";
import type { ApnsTransport } from "./apns.ts";
import { deliverReady, runMobilePushCycle, scanAndEnqueue } from "./scheduler.ts";
import { registerDevice } from "./store.ts";
import { clearMobilePushTestEnv, createMobilePushTestDb, seedAccount, seedMessage, setMobilePushTestEnv, testConfig } from "./test-helpers.ts";

const tokenA = "aa".repeat(32);
const tokenB = "bb".repeat(32);
const tokenC = "cc".repeat(32);

beforeEach(setMobilePushTestEnv);
afterEach(clearMobilePushTestEnv);

describe("mobile push scheduler", () => {
  test("isolates users, suppresses registration backfill, and deduplicates repeated scans", async () => {
    const client = createMobilePushTestDb();
    seedAccount(client.sqlite, "user-a", "account-a");
    seedAccount(client.sqlite, "user-b", "account-b");
    seedMessage(client.sqlite, { id: "old-a", accountId: "account-a", createdAt: 1_000 });
    seedMessage(client.sqlite, { id: "old-b", accountId: "account-b", createdAt: 1_000 });
    await registerDevice(client.sqlite, { userId: "user-a", sessionId: "session-user-a", installationId: "phone-a", token: tokenA, environment: "sandbox", notificationMode: "all", now: new Date(2_000) });
    await registerDevice(client.sqlite, { userId: "user-b", sessionId: "session-user-b", installationId: "phone-b", token: tokenB, environment: "production", notificationMode: "all", now: new Date(2_000) });
    seedMessage(client.sqlite, { id: "late-backfill-a", accountId: "account-a", createdAt: 2_500, receivedAt: 1_500 });
    seedMessage(client.sqlite, { id: "new-a", accountId: "account-a", createdAt: 3_000 });
    seedMessage(client.sqlite, { id: "new-b", accountId: "account-b", createdAt: 3_000 });
    const sent: Array<{ token: string; accountId: unknown }> = [];
    const transport: ApnsTransport = { async send(request) { sent.push({ token: request.token, accountId: request.payload.accountId }); return { outcome: "success", status: 200 }; } };

    const first = await runMobilePushCycle({ dbFactory: () => createMobilePushTestDbConnection(client.path), config: testConfig, transport, now: () => new Date(4_000) });
    const second = await runMobilePushCycle({ dbFactory: () => createMobilePushTestDbConnection(client.path), config: testConfig, transport, now: () => new Date(5_000) });

    assert.equal(first.enqueued, 2);
    assert.equal(first.delivered, 2);
    assert.equal(second.enqueued, 0);
    assert.deepEqual(sent.sort((a, b) => a.token.localeCompare(b.token)), [
      { token: tokenA, accountId: "account-a" },
      { token: tokenB, accountId: "account-b" },
    ]);
    const payloads = client.sqlite.query("SELECT payload_json AS payload FROM mobile_push_outbox ORDER BY account_id").all() as Array<{ payload: string }>;
    assert.equal(payloads.every(({ payload }) => {
      const parsed = JSON.parse(payload) as { aps: { alert: { title: string; body: string } }; accountId: string; threadId: string };
      return parsed.aps.alert.title === "New email" && parsed.aps.alert.body === "You have a new message in Orca."
        && Object.keys(parsed).sort().join(",") === "accountId,aps,threadId,version";
    }), true);
    client.sqlite.close();
  });

  test("honors human, all, and off modes while excluding read, draft, sent, and archived mail", async () => {
    const client = createMobilePushTestDb();
    seedAccount(client.sqlite, "user", "account");
    await registerDevice(client.sqlite, { userId: "user", sessionId: "session-user", installationId: "phone", token: tokenA, environment: "sandbox", notificationMode: "human", now: new Date(1_000) });
    seedMessage(client.sqlite, { id: "human", accountId: "account", createdAt: 2_000, classification: "likely_human" });
    seedMessage(client.sqlite, { id: "bulk", accountId: "account", createdAt: 2_100, classification: "automated_or_bulk" });
    seedMessage(client.sqlite, { id: "read", accountId: "account", createdAt: 2_200, read: true });
    seedMessage(client.sqlite, { id: "draft", accountId: "account", createdAt: 2_300, draft: true });
    seedMessage(client.sqlite, { id: "sent", accountId: "account", createdAt: 2_400, sent: true });
    seedMessage(client.sqlite, { id: "archive", accountId: "account", createdAt: 2_500, inbox: false });
    seedMessage(client.sqlite, { id: "quiet", accountId: "account", createdAt: 2_600 });
    client.sqlite.query("INSERT INTO thread_attention_overrides (account_id,thread_id,behavior) VALUES (?,?,?)")
      .run("account", "thread-quiet", "quiet");
    const sent: string[] = [];
    const transport: ApnsTransport = { async send(request) { sent.push(String(request.payload.threadId)); return { outcome: "success", status: 200 }; } };
    await runMobilePushCycle({ dbFactory: () => createMobilePushTestDbConnection(client.path), config: testConfig, transport, now: () => new Date(3_000) });
    assert.deepEqual(sent, ["thread-human"]);

    await registerDevice(client.sqlite, { userId: "user", sessionId: "session-user", installationId: "phone", token: tokenA, environment: "sandbox", notificationMode: "all", now: new Date(3_100) });
    seedMessage(client.sqlite, { id: "new-bulk", accountId: "account", createdAt: 3_200, classification: "automated_or_bulk" });
    await runMobilePushCycle({ dbFactory: () => createMobilePushTestDbConnection(client.path), config: testConfig, transport, now: () => new Date(3_300) });
    assert.deepEqual(sent, ["thread-human", "thread-new-bulk"]);

    await registerDevice(client.sqlite, { userId: "user", sessionId: "session-user", installationId: "phone", token: tokenA, environment: "sandbox", notificationMode: "off", now: new Date(3_400) });
    seedMessage(client.sqlite, { id: "while-off", accountId: "account", createdAt: 3_500 });
    await registerDevice(client.sqlite, { userId: "user", sessionId: "session-user", installationId: "phone", token: tokenA, environment: "sandbox", notificationMode: "human", now: new Date(4_000) });
    seedMessage(client.sqlite, { id: "late-off-backfill", accountId: "account", createdAt: 4_050, receivedAt: 3_500 });
    seedMessage(client.sqlite, { id: "after-enable", accountId: "account", createdAt: 4_100 });
    await runMobilePushCycle({ dbFactory: () => createMobilePushTestDbConnection(client.path), config: testConfig, transport, now: () => new Date(4_200) });
    assert.deepEqual(sent, ["thread-human", "thread-new-bulk", "thread-after-enable"]);
    client.sqlite.close();
  });

  test("retries transient failures with backoff and succeeds later", async () => {
    const client = createMobilePushTestDb();
    seedAccount(client.sqlite, "user", "account");
    await registerDevice(client.sqlite, { userId: "user", sessionId: "session-user", installationId: "phone", token: tokenA, environment: "sandbox", notificationMode: "all", now: new Date(1_000) });
    seedMessage(client.sqlite, { id: "message", accountId: "account", createdAt: 2_000 });
    let calls = 0;
    const transport: ApnsTransport = { async send() { calls += 1; return calls === 1 ? { outcome: "retry", status: 503, reason: "ServiceUnavailable" } : { outcome: "success", status: 200 }; } };
    await runMobilePushCycle({ dbFactory: () => createMobilePushTestDbConnection(client.path), config: testConfig, transport, now: () => new Date(3_000) });
    let row = client.sqlite.query("SELECT state,attempt_count AS attempts,available_at AS availableAt FROM mobile_push_outbox").get() as { state: string; attempts: number; availableAt: number };
    assert.deepEqual(row, { state: "pending", attempts: 1, availableAt: 18_000 });
    await runMobilePushCycle({ dbFactory: () => createMobilePushTestDbConnection(client.path), config: testConfig, transport, now: () => new Date(18_000) });
    row = client.sqlite.query("SELECT state,attempt_count AS attempts,available_at AS availableAt FROM mobile_push_outbox").get() as typeof row;
    assert.equal(row.state, "sent");
    assert.equal(row.attempts, 2);
    client.sqlite.close();
  });

  test("disables invalid tokens but cannot disable a concurrently refreshed registration", async () => {
    const client = createMobilePushTestDb();
    seedAccount(client.sqlite, "user", "account");
    await registerDevice(client.sqlite, { userId: "user", sessionId: "session-user", installationId: "phone", token: tokenA, environment: "sandbox", notificationMode: "all", now: new Date(1_000) });
    seedMessage(client.sqlite, { id: "message", accountId: "account", createdAt: 2_000 });
    await runMobilePushCycle({
      dbFactory: () => createMobilePushTestDbConnection(client.path), config: testConfig, now: () => new Date(3_000),
      transport: { async send() { await registerDevice(client.sqlite, { userId: "user", sessionId: "session-user", installationId: "phone", token: tokenB, environment: "sandbox", notificationMode: "all", now: new Date(3_000) }); return { outcome: "invalid_token", status: 410, reason: "Unregistered", invalidatedAt: 2_500 }; } },
    });
    let device = client.sqlite.query("SELECT generation,disabled_at AS disabledAt FROM mobile_push_devices").get() as { generation: number; disabledAt: number | null };
    assert.deepEqual(device, { generation: 2, disabledAt: null });

    seedMessage(client.sqlite, { id: "message-2", accountId: "account", createdAt: 4_000 });
    await runMobilePushCycle({
      dbFactory: () => createMobilePushTestDbConnection(client.path), config: testConfig, now: () => new Date(5_000),
      transport: { async send() { return { outcome: "invalid_token", status: 400, reason: "BadDeviceToken", invalidatedAt: null }; } },
    });
    device = client.sqlite.query("SELECT generation,disabled_at AS disabledAt FROM mobile_push_devices").get() as typeof device;
    assert.equal(device.generation, 2);
    assert.equal(device.disabledAt, 5_000);
    client.sqlite.close();
  });

  test("removes stale registrations and their outbox rows", async () => {
    const client = createMobilePushTestDb();
    seedAccount(client.sqlite, "user", "account");
    await registerDevice(client.sqlite, { userId: "user", sessionId: "session-user", installationId: "old-phone", token: tokenC, environment: "sandbox", notificationMode: "all", now: new Date(1_000) });
    const config = { ...testConfig, staleDeviceMs: 1_000 };
    const result = await runMobilePushCycle({ dbFactory: () => createMobilePushTestDbConnection(client.path), config, transport: { async send() { return { outcome: "success", status: 200 }; } }, now: () => new Date(3_000) });
    assert.equal(result.staleDevicesRemoved, 1);
    assert.equal((client.sqlite.query("SELECT count(*) AS count FROM mobile_push_devices").get() as { count: number }).count, 0);
    client.sqlite.close();
  });

  test("suppresses queued and future pushes after the bound session is revoked or expired", async () => {
    const client = createMobilePushTestDb();
    seedAccount(client.sqlite, "user", "account");
    await registerDevice(client.sqlite, { userId: "user", sessionId: "session-user", installationId: "phone", token: tokenA, environment: "sandbox", notificationMode: "all", now: new Date(1_000) });
    seedMessage(client.sqlite, { id: "queued", accountId: "account", createdAt: 2_000 });
    assert.equal(scanAndEnqueue(client.sqlite, { now: new Date(2_500), batchSize: 100 }).enqueued, 1);
    client.sqlite.query("UPDATE sessions SET invalidated_at=? WHERE id=?").run(2_600, "session-user");
    let sends = 0;
    const delivery = await deliverReady(client.sqlite, { now: new Date(3_000), batchSize: 100, config: testConfig, transport: { async send() { sends += 1; return { outcome: "success", status: 200 }; } } });
    assert.equal(delivery.discarded, 1);
    assert.equal(sends, 0);
    seedMessage(client.sqlite, { id: "after-revoke", accountId: "account", createdAt: 4_000 });
    assert.equal(scanAndEnqueue(client.sqlite, { now: new Date(4_100), batchSize: 100 }).enqueued, 0);
    client.sqlite.query("UPDATE sessions SET invalidated_at=NULL, expires_at=? WHERE id=?").run(4_000, "session-user");
    assert.equal(scanAndEnqueue(client.sqlite, { now: new Date(4_100), batchSize: 100 }).enqueued, 0);
    client.sqlite.close();
  });

  test("uses the production mobile session checker before scan and queued delivery", async () => {
    const client = createMobilePushTestDb();
    try {
      seedAccount(client.sqlite, "mobile-user", "mobile-account");
      const session = createMobileSession(client.db, "mobile-user", new Date(1_000));
      await registerDevice(client.sqlite, { userId: "mobile-user", sessionId: session.sessionId, installationId: "mobile-phone", token: tokenA, environment: "sandbox", notificationMode: "all", now: new Date(1_000) });
      seedMessage(client.sqlite, { id: "mobile-queued", accountId: "mobile-account", createdAt: 2_000 });
      assert.equal(scanAndEnqueue(client.sqlite, { now: new Date(2_500), batchSize: 100, isSessionActive: isMobilePushSessionActive }).enqueued, 1);
      revokeMobileSession(client.db, session.sessionId, "mobile-user", new Date(2_600));
      let sends = 0;
      const result = await deliverReady(client.sqlite, { now: new Date(3_000), batchSize: 100, config: testConfig, isSessionActive: isMobilePushSessionActive, transport: { async send() { sends += 1; return { outcome: "success", status: 200 }; } } });
      assert.equal(result.discarded, 1);
      assert.equal(sends, 0);
      seedMessage(client.sqlite, { id: "mobile-after-revoke", accountId: "mobile-account", createdAt: 4_000 });
      assert.equal(scanAndEnqueue(client.sqlite, { now: new Date(4_100), batchSize: 100, isSessionActive: isMobilePushSessionActive }).enqueued, 0);
    } finally { client.sqlite.close(); }
  });

  test("atomically reassigns a token on account switch and removes the former owner's outbox", async () => {
    const client = createMobilePushTestDb();
    seedAccount(client.sqlite, "user-a", "account-a");
    seedAccount(client.sqlite, "user-b", "account-b");
    await registerDevice(client.sqlite, { userId: "user-a", sessionId: "session-user-a", installationId: "phone-a", token: tokenA, environment: "sandbox", notificationMode: "all", now: new Date(1_000) });
    seedMessage(client.sqlite, { id: "a-message", accountId: "account-a", createdAt: 2_000 });
    assert.equal(scanAndEnqueue(client.sqlite, { now: new Date(2_500), batchSize: 100 }).enqueued, 1);
    await registerDevice(client.sqlite, { userId: "user-b", sessionId: "session-user-b", installationId: "phone-b", token: tokenA, environment: "sandbox", notificationMode: "all", now: new Date(3_000) });
    assert.deepEqual(client.sqlite.query("SELECT user_id AS userId,installation_id AS installationId FROM mobile_push_devices").all(), [{ userId: "user-b", installationId: "phone-b" }]);
    assert.equal((client.sqlite.query("SELECT count(*) AS count FROM mobile_push_outbox").get() as { count: number }).count, 0);
    client.sqlite.close();
  });
});

function createMobilePushTestDbConnection(path: string) {
  // Separate scheduler connections exercise durable state rather than sharing an in-memory unit.
  return requireDatabaseClient(path);
}

import { createDatabaseClient as requireDatabaseClient } from "../db/client.ts";
