import { test, expect } from "bun:test";
import { notificationFixture } from "./fixture.ts";
import { setMobilePushTestEnv, clearMobilePushTestEnv } from "../mobile-push/test-helpers.ts";
import { createApp } from "../index.ts";
import { createDatabaseClient } from "../db/client.ts";
import { scanAndEnqueue, deliverReady } from "../mobile-push/scheduler.ts";
import { testConfig } from "../mobile-push/test-helpers.ts";
test("BRE-455/BRE-464 real authenticated nonempty account disconnect cascades queued deliveries without recreating revisions", async () => {
  setMobilePushTestEnv(); const f = await notificationFixture();
  try {
    await f.request("/v1/mobile/devices/phone", { token: "aa".repeat(32), environment: "sandbox", notificationSelection: { inbox: false, spaceIds: [] } });
    await f.adopt("apns", "phone"); await f.fresh("disconnect-queued"); expect(scanAndEnqueue(f.sqlite, { now: new Date(f.state.now), batchSize: 100 }).enqueued).toBe(1);
    const app = createApp({ dbFactory: () => createDatabaseClient(f.path) });
    const headers = { cookie: `orca_session=${f.session.token}` };
    expect((await app.request("/v1/accounts/foreign", { method: "DELETE", headers })).status).toBe(404);
    expect((await app.request("/v1/accounts/a", { method: "DELETE", headers })).status).toBe(204);
    for (const table of ["mailbox_revisions", "important_notification_accounts", "important_notification_arrivals", "mobile_push_outbox"]) {
      expect(f.sqlite.query(`SELECT count(*) n FROM ${table} WHERE account_id='a'`).get()).toEqual({ n: 0 });
    }
    expect(f.sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
    let attempts = 0;
    await deliverReady(f.sqlite, { now: new Date(f.state.now), batchSize: 100, config: testConfig, transport: { async send() { attempts++; return { outcome: "success", status: 200 }; } } }); expect(attempts).toBe(0);
    f.sqlite.query("INSERT INTO oauth_accounts(id,user_id,provider,provider_id,provider_email) VALUES('a','u','gmail','recreated','u@example.com')").run();
    const current = await (await f.request("/v1/notifications/installations/phone?channel=apns")).json(); expect(current.policy.accountIds).toEqual([]); expect(current.delivery.available).toBe(false);
  } finally { f.sqlite.close(); clearMobilePushTestEnv(); }
});
