import { test } from "bun:test";
import assert from "node:assert/strict";
import { createMobilePushTestDb, seedAccount, seedMessage, setMobilePushTestEnv, clearMobilePushTestEnv, testConfig } from "../mobile-push/test-helpers.ts";
import { registerDevice } from "../mobile-push/store.ts";
import { scanAndEnqueue, deliverReady } from "../mobile-push/scheduler.ts";

// Historical red must run on the unchanged legacy dispatcher before implementing adoption.
// This bypasses the absent settings route only to isolate actual dispatch behavior.
test("BRE-455 an adopted Important-only installation must not send an unreviewed human Inbox message", async () => {
  setMobilePushTestEnv();
  const f = createMobilePushTestDb();
  try {
    seedAccount(f.sqlite, "u", "a");
    await registerDevice(f.sqlite, { userId: "u", installationId: "phone", sessionId: "session-u", token: "aa".repeat(32), environment: "sandbox", notificationSelection: { inbox: true, spaceIds: [] }, now: new Date(1000) });
    f.sqlite.query(`INSERT INTO important_notification_installations(user_id,channel,installation_id,session_id,enabled,permission,revision,generation,created_at,updated_at) VALUES('u','apns','phone','session-u',1,'granted',1,1,1000,1000)`).run();
    f.sqlite.query(`INSERT INTO important_notification_accounts VALUES('u','apns','phone','a',1000,0,0)`).run();
    seedMessage(f.sqlite, { id: "human-unreviewed", accountId: "a", createdAt: 2000 });
    const counts = { attempts: 0, deliveries: 0 };
    scanAndEnqueue(f.sqlite, { now: new Date(3000), batchSize: 100 });
    const delivery = await deliverReady(f.sqlite, { now: new Date(3000), batchSize: 100, config: testConfig, transport: { async send() { counts.attempts++; counts.deliveries++; return { outcome: "success", status: 200 }; } } });
    assert.deepEqual({ delivery, ...counts }, { delivery: { delivered: 0, retried: 0, discarded: 0, disabledDevices: 0 }, attempts: 0, deliveries: 0 }, "Human authorship and Inbox placement cannot authorize Important-only delivery");
  } finally { f.sqlite.close(); clearMobilePushTestEnv(); }
});
