import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { createMobileSession, revokeMobileSession } from "../auth/mobile/store.ts";
import { createDestinations } from "../destinations/service.ts";
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
    await registerDevice(client.sqlite, { userId: "user-a", sessionId: "session-user-a", installationId: "phone-a", token: tokenA, environment: "sandbox", notificationSelection: { inbox: true, spaceIds: [] }, now: new Date(2_000) });
    await registerDevice(client.sqlite, { userId: "user-b", sessionId: "session-user-b", installationId: "phone-b", token: tokenB, environment: "production", notificationSelection: { inbox: true, spaceIds: [] }, now: new Date(2_000) });
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

  test("uses actual Inbox routing instead of provider labels or Human Signal", async () => {
    const client = createMobilePushTestDb();
    seedAccount(client.sqlite, "user", "account");
    await registerDevice(client.sqlite, { userId: "user", sessionId: "session-user", installationId: "phone", token: tokenA, environment: "sandbox", notificationSelection: { inbox: true, spaceIds: [] }, now: new Date(1_000) });
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
    assert.deepEqual([...sent].sort(), ["thread-archive", "thread-bulk", "thread-human"]);

    await registerDevice(client.sqlite, { userId: "user", sessionId: "session-user", installationId: "phone", token: tokenA, environment: "sandbox", notificationSelection: { inbox: true, spaceIds: [] }, now: new Date(3_100) });
    seedMessage(client.sqlite, { id: "new-bulk", accountId: "account", createdAt: 3_200, classification: "automated_or_bulk" });
    await runMobilePushCycle({ dbFactory: () => createMobilePushTestDbConnection(client.path), config: testConfig, transport, now: () => new Date(3_300) });
    assert.deepEqual([...sent].sort(), ["thread-archive", "thread-bulk", "thread-human", "thread-new-bulk"]);

    await registerDevice(client.sqlite, { userId: "user", sessionId: "session-user", installationId: "phone", token: tokenA, environment: "sandbox", notificationSelection: { inbox: false, spaceIds: [] }, now: new Date(3_400) });
    seedMessage(client.sqlite, { id: "while-off", accountId: "account", createdAt: 3_500 });
    await registerDevice(client.sqlite, { userId: "user", sessionId: "session-user", installationId: "phone", token: tokenA, environment: "sandbox", notificationSelection: { inbox: true, spaceIds: [] }, now: new Date(4_000) });
    seedMessage(client.sqlite, { id: "late-off-backfill", accountId: "account", createdAt: 4_050, receivedAt: 3_500 });
    seedMessage(client.sqlite, { id: "after-enable", accountId: "account", createdAt: 4_100 });
    await runMobilePushCycle({ dbFactory: () => createMobilePushTestDbConnection(client.path), config: testConfig, transport, now: () => new Date(4_200) });
    assert.deepEqual([...sent].sort(), ["thread-after-enable", "thread-archive", "thread-bulk", "thread-human", "thread-new-bulk"]);
    client.sqlite.close();
  });

  test("notifies selected Spaces outside Inbox, ignores unselected Spaces, and deduplicates overlap", { timeout: 30_000 }, async () => {
    const client = createMobilePushTestDb();
    try {
      seedAccount(client.sqlite, "spaces-user", "spaces-account");
      const destinations = createDestinations(client.db, "spaces-user");
      const projects = destinations.create({ expectedRevision: destinations.list().revision, name: "Projects" }).state.destinations.find(({ name }) => name === "Projects")!;
      const friends = destinations.create({ expectedRevision: destinations.list().revision, name: "Friends" }).state.destinations.find(({ name }) => name === "Friends")!;
      await registerDevice(client.sqlite, { userId: "spaces-user", sessionId: "session-spaces-user", installationId: "phone", token: tokenA,
        environment: "sandbox", notificationSelection: { inbox: false, spaceIds: [`destination:${projects.id}`] }, now: new Date(1_000) });
      seedMessage(client.sqlite, { id: "project", accountId: "spaces-account", createdAt: 2_000, inbox: false, classification: "automated_or_bulk" });
      seedMessage(client.sqlite, { id: "friend", accountId: "spaces-account", createdAt: 2_100 });
      seedMessage(client.sqlite, { id: "inbox-only", accountId: "spaces-account", createdAt: 2_200 });
      destinations.save("spaces-account", { expectedRevision: destinations.list().revision, target: { scope: "conversation", threadId: "thread-project" }, destinationId: projects.id });
      destinations.save("spaces-account", { expectedRevision: destinations.list().revision, target: { scope: "conversation", threadId: "thread-friend" }, destinationId: friends.id });
      assert.equal(scanAndEnqueue(client.sqlite, { now: new Date(2_500), batchSize: 100 }).enqueued, 1);
      assert.deepEqual(client.sqlite.query("SELECT message_id AS id FROM mobile_push_outbox").all(), [{ id: "project" }]);

      client.sqlite.query("INSERT INTO collections (id,account_id,name,color,position,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
        .run("overlap-collection", "spaces-account", "Overlap", "#123456", 0, 1, 2_600, 2_600);
      await registerDevice(client.sqlite, { userId: "spaces-user", sessionId: "session-spaces-user", installationId: "phone", token: tokenA,
        environment: "sandbox", notificationSelection: { inbox: true, spaceIds: ["collection:overlap-collection"] }, now: new Date(2_700) });
      seedMessage(client.sqlite, { id: "overlap", accountId: "spaces-account", createdAt: 3_000 });
      client.sqlite.query("INSERT INTO collection_threads (id,collection_id,thread_id,created_at) VALUES (?,?,?,?)")
        .run("overlap-membership", "overlap-collection", "thread-overlap", 3_000);
      assert.equal(scanAndEnqueue(client.sqlite, { now: new Date(3_100), batchSize: 100 }).enqueued, 1);
      assert.equal((client.sqlite.query("SELECT count(*) AS count FROM mobile_push_outbox WHERE message_id='overlap'").get() as { count: number }).count, 1);

      client.sqlite.query(`INSERT INTO organization_views
        (workspace_id,id,name,description,color,position,definition,skip_inbox,revision,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run("spaces-user", "launch-view", "Launch", "", "#654321", 0,
          JSON.stringify({ revision: 1, thread: { subjectContains: "launch" } }), 0, 1, 3_200, 3_200);
      await registerDevice(client.sqlite, { userId: "spaces-user", sessionId: "session-spaces-user", installationId: "phone", token: tokenA,
        environment: "sandbox", notificationSelection: { inbox: false, spaceIds: ["view:launch-view"] }, now: new Date(3_300) });
      seedMessage(client.sqlite, { id: "view-match", accountId: "spaces-account", createdAt: 3_400, inbox: false });
      seedMessage(client.sqlite, { id: "view-miss", accountId: "spaces-account", createdAt: 3_500, inbox: false });
      client.sqlite.query("UPDATE threads SET subject=? WHERE id=?").run("Launch review", "thread-view-match");
      client.sqlite.query("UPDATE threads SET subject=? WHERE id=?").run("Routine review", "thread-view-miss");
      assert.equal(scanAndEnqueue(client.sqlite, { now: new Date(3_600), batchSize: 100 }).enqueued, 1);
      assert.equal((client.sqlite.query("SELECT count(*) AS count FROM mobile_push_outbox WHERE message_id='view-match'").get() as { count: number }).count, 1);
      assert.equal((client.sqlite.query("SELECT count(*) AS count FROM mobile_push_outbox WHERE message_id='view-miss'").get() as { count: number }).count, 0);
    } finally { client.sqlite.close(); }
  });

  test("rechecks current mail and Space eligibility under the delivery lease", { timeout: 30_000 }, async () => {
    const client = createMobilePushTestDb();
    try {
      seedAccount(client.sqlite, "recheck-user", "recheck-account");
      const destinations = createDestinations(client.db, "recheck-user");
      const outsideInbox = destinations.create({ expectedRevision: destinations.list().revision, name: "Outside Inbox" }).state.destinations.find(({ name }) => name === "Outside Inbox")!;
      client.sqlite.query("INSERT INTO collections (id,account_id,name,color,position,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
        .run("selected-collection", "recheck-account", "Selected", "#123456", 0, 1, 1_000, 1_000);
      await registerDevice(client.sqlite, { userId: "recheck-user", sessionId: "session-recheck-user", installationId: "phone", token: tokenA,
        environment: "sandbox", notificationSelection: { inbox: true, spaceIds: ["collection:selected-collection"] }, now: new Date(1_000) });
      for (const [id, createdAt] of [["deleted-space", 2_000], ["became-read", 2_100], ["became-sent", 2_200]] as const) {
        seedMessage(client.sqlite, { id, accountId: "recheck-account", createdAt });
        client.sqlite.query("INSERT INTO collection_threads (id,collection_id,thread_id,created_at) VALUES (?,?,?,?)")
          .run(`membership-${id}`, "selected-collection", `thread-${id}`, createdAt);
      }
      destinations.save("recheck-account", { expectedRevision: destinations.list().revision,
        target: { scope: "conversation", threadId: "thread-deleted-space" }, destinationId: outsideInbox.id });
      assert.equal(scanAndEnqueue(client.sqlite, { now: new Date(2_500), batchSize: 100 }).enqueued, 3);
      client.sqlite.query("DELETE FROM collections WHERE id=?").run("selected-collection");
      client.sqlite.query("UPDATE emails SET is_read=1 WHERE id=?").run("became-read");
      client.sqlite.query("INSERT INTO email_labels (id,email_id,label_id,created_at) VALUES (?,?,?,?)")
        .run("sent-after-enqueue", "became-sent", "sent-recheck-account", 2_600);
      let sends = 0;
      const delivered = await deliverReady(client.sqlite, { now: new Date(3_000), batchSize: 100, config: testConfig,
        transport: { async send() { sends += 1; return { outcome: "success", status: 200 }; } } });
      assert.equal(sends, 0);
      assert.equal(delivered.discarded, 3);
      assert.deepEqual(client.sqlite.query("SELECT DISTINCT last_error AS error FROM mobile_push_outbox").all(), [{ error: "message_no_longer_eligible" }]);
    } finally { client.sqlite.close(); }
  });

  test("retries transient failures with backoff and succeeds later", async () => {
    const client = createMobilePushTestDb();
    seedAccount(client.sqlite, "user", "account");
    await registerDevice(client.sqlite, { userId: "user", sessionId: "session-user", installationId: "phone", token: tokenA, environment: "sandbox", notificationSelection: { inbox: true, spaceIds: [] }, now: new Date(1_000) });
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
    await registerDevice(client.sqlite, { userId: "user", sessionId: "session-user", installationId: "phone", token: tokenA, environment: "sandbox", notificationSelection: { inbox: true, spaceIds: [] }, now: new Date(1_000) });
    seedMessage(client.sqlite, { id: "message", accountId: "account", createdAt: 2_000 });
    await runMobilePushCycle({
      dbFactory: () => createMobilePushTestDbConnection(client.path), config: testConfig, now: () => new Date(3_000),
      transport: { async send() { await registerDevice(client.sqlite, { userId: "user", sessionId: "session-user", installationId: "phone", token: tokenB, environment: "sandbox", notificationSelection: { inbox: true, spaceIds: [] }, now: new Date(3_000) }); return { outcome: "invalid_token", status: 410, reason: "Unregistered", invalidatedAt: 2_500 }; } },
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
    await registerDevice(client.sqlite, { userId: "user", sessionId: "session-user", installationId: "old-phone", token: tokenC, environment: "sandbox", notificationSelection: { inbox: true, spaceIds: [] }, now: new Date(1_000) });
    const config = { ...testConfig, staleDeviceMs: 1_000 };
    const result = await runMobilePushCycle({ dbFactory: () => createMobilePushTestDbConnection(client.path), config, transport: { async send() { return { outcome: "success", status: 200 }; } }, now: () => new Date(3_000) });
    assert.equal(result.staleDevicesRemoved, 1);
    assert.equal((client.sqlite.query("SELECT count(*) AS count FROM mobile_push_devices").get() as { count: number }).count, 0);
    client.sqlite.close();
  });

  test("suppresses queued and future pushes after the bound session is revoked or expired", async () => {
    const client = createMobilePushTestDb();
    seedAccount(client.sqlite, "user", "account");
    await registerDevice(client.sqlite, { userId: "user", sessionId: "session-user", installationId: "phone", token: tokenA, environment: "sandbox", notificationSelection: { inbox: true, spaceIds: [] }, now: new Date(1_000) });
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

  test("preference changes invalidate queued alerts, including off then on before delivery", async () => {
    const client = createMobilePushTestDb();
    try {
      seedAccount(client.sqlite, "mode-user", "mode-account");
      const device = { userId: "mode-user", sessionId: "session-mode-user", installationId: "phone", token: tokenA, environment: "sandbox" as const };
      await registerDevice(client.sqlite, { ...device, notificationSelection: { inbox: true, spaceIds: [] }, now: new Date(1_000) });
      seedMessage(client.sqlite, { id: "queued-bulk", accountId: "mode-account", createdAt: 2_000, classification: "automated_or_bulk" });
      assert.equal(scanAndEnqueue(client.sqlite, { now: new Date(2_500), batchSize: 100 }).enqueued, 1);
      await registerDevice(client.sqlite, { ...device, notificationSelection: { inbox: false, spaceIds: [] }, now: new Date(2_600) });
      await registerDevice(client.sqlite, { ...device, notificationSelection: { inbox: true, spaceIds: [] }, now: new Date(2_700) });
      let sends = 0;
      const transport: ApnsTransport = { async send() { sends += 1; return { outcome: "success", status: 200 }; } };
      await deliverReady(client.sqlite, { now: new Date(3_000), batchSize: 100, config: testConfig, transport });
      assert.equal(sends, 0);
    } finally { client.sqlite.close(); }
  });

  test("uses the production mobile session checker before scan and queued delivery", async () => {
    const client = createMobilePushTestDb();
    try {
      seedAccount(client.sqlite, "mobile-user", "mobile-account");
      const session = createMobileSession(client.db, "mobile-user", new Date(1_000));
      await registerDevice(client.sqlite, { userId: "mobile-user", sessionId: session.sessionId, installationId: "mobile-phone", token: tokenA, environment: "sandbox", notificationSelection: { inbox: true, spaceIds: [] }, now: new Date(1_000) });
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
    await registerDevice(client.sqlite, { userId: "user-a", sessionId: "session-user-a", installationId: "phone-a", token: tokenA, environment: "sandbox", notificationSelection: { inbox: true, spaceIds: [] }, now: new Date(1_000) });
    seedMessage(client.sqlite, { id: "a-message", accountId: "account-a", createdAt: 2_000 });
    assert.equal(scanAndEnqueue(client.sqlite, { now: new Date(2_500), batchSize: 100 }).enqueued, 1);
    await registerDevice(client.sqlite, { userId: "user-b", sessionId: "session-user-b", installationId: "phone-b", token: tokenA, environment: "sandbox", notificationSelection: { inbox: true, spaceIds: [] }, now: new Date(3_000) });
    assert.deepEqual(client.sqlite.query("SELECT user_id AS userId,installation_id AS installationId FROM mobile_push_devices").all(), [{ userId: "user-b", installationId: "phone-b" }]);
    assert.equal((client.sqlite.query("SELECT count(*) AS count FROM mobile_push_outbox").get() as { count: number }).count, 0);
    client.sqlite.close();
  });

  test("uses a fresh lease timestamp for every serial delivery claim", async () => {
    const client = createMobilePushTestDb();
    try {
      seedAccount(client.sqlite, "lease-user", "lease-account");
      await registerDevice(client.sqlite, { userId: "lease-user", sessionId: "session-lease-user", installationId: "phone", token: tokenA, environment: "sandbox", notificationSelection: { inbox: true, spaceIds: [] }, now: new Date(1_000) });
      seedMessage(client.sqlite, { id: "first", accountId: "lease-account", createdAt: 2_000 });
      seedMessage(client.sqlite, { id: "second", accountId: "lease-account", createdAt: 2_100 });
      scanAndEnqueue(client.sqlite, { now: new Date(2_500), batchSize: 100 });

      let currentTime = 3_000;
      let releaseSecond!: () => void;
      let secondStarted!: () => void;
      const secondStartedPromise = new Promise<void>((resolve) => { secondStarted = resolve; });
      const secondReleasePromise = new Promise<void>((resolve) => { releaseSecond = resolve; });
      let workerOneCalls = 0;
      let workerTwoCalls = 0;
      const workerOne = deliverReady(client.sqlite, {
        now: () => new Date(currentTime), batchSize: 2, config: testConfig,
        transport: { async send() {
          workerOneCalls += 1;
          if (workerOneCalls === 1) {
            currentTime += 31_000;
          } else {
            secondStarted();
            await secondReleasePromise;
          }
          return { outcome: "success", status: 200 };
        } },
      });
      await secondStartedPromise;
      const workerTwo = await deliverReady(client.sqlite, {
        now: () => new Date(currentTime), batchSize: 2, config: testConfig,
        transport: { async send() { workerTwoCalls += 1; return { outcome: "success", status: 200 }; } },
      });
      releaseSecond();
      const workerOneResult = await workerOne;

      assert.equal(workerOneCalls, 2);
      assert.equal(workerTwoCalls, 0);
      assert.equal(workerTwo.delivered, 0);
      assert.equal(workerOneResult.delivered, 2);
    } finally { client.sqlite.close(); }
  });

  test("does not let a stale lease owner overwrite the current owner's completion", async () => {
    const client = createMobilePushTestDb();
    try {
      seedAccount(client.sqlite, "fence-user", "fence-account");
      await registerDevice(client.sqlite, { userId: "fence-user", sessionId: "session-fence-user", installationId: "phone", token: tokenA, environment: "sandbox", notificationSelection: { inbox: true, spaceIds: [] }, now: new Date(1_000) });
      seedMessage(client.sqlite, { id: "message", accountId: "fence-account", createdAt: 2_000 });
      scanAndEnqueue(client.sqlite, { now: new Date(2_500), batchSize: 100 });

      let currentTime = 3_000;
      let releaseStale!: () => void;
      let staleStarted!: () => void;
      const staleStartedPromise = new Promise<void>((resolve) => { staleStarted = resolve; });
      const staleReleasePromise = new Promise<void>((resolve) => { releaseStale = resolve; });
      const staleWorker = deliverReady(client.sqlite, {
        now: () => new Date(currentTime), batchSize: 1, config: testConfig,
        transport: { async send() {
          staleStarted();
          await staleReleasePromise;
          return { outcome: "retry", status: 503, reason: "stale response" };
        } },
      });
      await staleStartedPromise;
      currentTime += 31_000;
      const currentWorker = await deliverReady(client.sqlite, {
        now: () => new Date(currentTime), batchSize: 1, config: testConfig,
        transport: { async send() { return { outcome: "success", status: 200 }; } },
      });
      releaseStale();
      const staleResult = await staleWorker;

      assert.equal(currentWorker.delivered, 1);
      assert.deepEqual(staleResult, { delivered: 0, retried: 0, discarded: 0, disabledDevices: 0 });
      assert.deepEqual(client.sqlite.query("SELECT state,attempt_count AS attempts,last_status AS status,last_error AS error FROM mobile_push_outbox").get(),
        { state: "sent", attempts: 1, status: 200, error: null });
    } finally { client.sqlite.close(); }
  });

  test("scans newly committed mail by insertion order across accounts", async () => {
    const client = createMobilePushTestDb();
    try {
      seedAccount(client.sqlite, "order-user", "order-account-a");
      client.sqlite.query("INSERT INTO oauth_accounts (id,user_id,provider,provider_email,provider_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
        .run("order-account-b", "order-user", "gmail", "order-b@example.com", "provider-order-account-b", 1, 1);
      client.sqlite.query("INSERT INTO labels (id,account_id,provider_label_id,name,type,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
        .run("inbox-order-account-b", "order-account-b", "INBOX", "Inbox", "system", 1, 1);
      await registerDevice(client.sqlite, { userId: "order-user", sessionId: "session-order-user", installationId: "phone", token: tokenA, environment: "sandbox", notificationSelection: { inbox: true, spaceIds: [] }, now: new Date(1_000) });

      seedMessage(client.sqlite, { id: "committed-first", accountId: "order-account-a", createdAt: 3_000 });
      assert.equal(scanAndEnqueue(client.sqlite, { now: new Date(4_000), batchSize: 100 }).enqueued, 1);
      // This provider operation began earlier (and therefore has an older
      // created_at) but committed after the device watermark advanced.
      seedMessage(client.sqlite, { id: "committed-second", accountId: "order-account-b", createdAt: 2_000 });
      assert.equal(scanAndEnqueue(client.sqlite, { now: new Date(4_100), batchSize: 100 }).enqueued, 1);
      assert.deepEqual(client.sqlite.query("SELECT message_id AS messageId FROM mobile_push_outbox ORDER BY created_at,id").all(),
        [{ messageId: "committed-first" }, { messageId: "committed-second" }]);
    } finally { client.sqlite.close(); }
  });
});

function createMobilePushTestDbConnection(path: string) {
  // Separate scheduler connections exercise durable state rather than sharing an in-memory unit.
  return requireDatabaseClient(path);
}

import { createDatabaseClient as requireDatabaseClient } from "../db/client.ts";
