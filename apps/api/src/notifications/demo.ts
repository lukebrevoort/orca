/** Runnable synthetic HTTP/SQLite/APNs-boundary demonstration. No live mail or OS delivery. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import assert from "node:assert/strict";
import { notificationFixture } from "./fixture.ts";
import { setMobilePushTestEnv, clearMobilePushTestEnv, testConfig } from "../mobile-push/test-helpers.ts";
import { scanAndEnqueue, deliverReady } from "../mobile-push/scheduler.ts";

const destination = process.argv[2];
if (!destination?.startsWith("/tmp/bre455-demo-")) throw Error("Provide a fresh /tmp/bre455-demo- directory");
const head = Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim();
assert.equal(Bun.spawnSync(["git", "status", "--porcelain"]).stdout.toString().trim(), "", "Commit candidate before demo");
mkdirSync(destination);
setMobilePushTestEnv(); const f = await notificationFixture();
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: f.app.fetch });
const http: { method: string; path: string; status: number }[] = [];
const attempts: { accountId: unknown; threadId: unknown; apnsId: string }[] = [];
async function request(path: string, body?: unknown, method = body ? "PUT" : "GET") {
  const response = await fetch(new URL(path, server.url), { method, headers: { cookie: `orca_session=${f.session.token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  http.push({ method, path, status: response.status }); assert.equal(response.status, 200);
  return response.json();
}
try {
  const initial = await request("/v1/notifications/installations/browser?channel=open_app"); assert.equal(initial.policy, null);
  await request("/v1/mobile/devices/phone", { token: "aa".repeat(32), environment: "sandbox", notificationSelection: { inbox: false, spaceIds: [] } });
  await request("/v1/notifications/installations/phone", f.command(0, { channel: "apns" }));
  await request("/v1/notifications/installations/browser", f.command());
  await f.fresh("automated-important");
  await f.persist(f.human("human-unreviewed", "u")); await f.persist(f.human("human-not-important", "n")); await f.important("gmail:a:n", "not_important");
  await f.persist(f.message("unknown", "conversation", { payload: { headers: [{ name: "From", value: "alias@example.com" }] } }));
  const scan = scanAndEnqueue(f.sqlite, { now: new Date(f.state.now), batchSize: 100 });
  const delivery = await deliverReady(f.sqlite, { now: new Date(f.state.now), batchSize: 100, config: testConfig, transport: { async send(input) { attempts.push({ accountId: input.payload.accountId, threadId: input.payload.threadId, apnsId: input.apnsId }); return { outcome: "success", status: 200 }; } } });
  assert.equal(attempts.length, 1); assert.equal(delivery.delivered, 1);
  const operationId = randomUUID();
  const claimed = await request("/v1/notifications/installations/browser/claim", { channel: "open_app", expectedRevision: 1, permission: "granted", operationId }, "POST");
  assert.equal(claimed.notifications.length, 1);
  const retried = await request("/v1/notifications/installations/browser/claim", { channel: "open_app", expectedRevision: 1, permission: "granted", operationId }, "POST");
  assert.deepEqual(retried, claimed);
  const report = await request("/v1/notifications/installations/browser/report", { operationId, notificationIds: claimed.notifications.map((n: { id: string }) => n.id), outcome: "constructed" }, "POST");
  assert.equal(report.displayConfirmed, false);
  await f.important("gmail:a:conversation", "not_important");
  f.state.now += 1000; await f.persist(f.message("corrected-future", "conversation"));
  assert.equal(scanAndEnqueue(f.sqlite, { now: new Date(f.state.now), batchSize: 100 }).enqueued, 0);
  const classifications = f.sqlite.query("SELECT id,human_classification FROM emails WHERE id IN ('gmail:a:automated-important','gmail:a:human-unreviewed','gmail:a:human-not-important') ORDER BY id").all();
  const proofCounts = f.sqlite.query("SELECT evidence,reason,count(*) count FROM important_notification_arrivals GROUP BY evidence,reason ORDER BY evidence,reason").all();
  const terminal = f.sqlite.query("SELECT state,count(*) count FROM important_notification_web_deliveries GROUP BY state").all();
  const result = { head, cleanAtStart: true, scope: "Actual loopback TCP HTTP, authenticated Hono, fresh SQLite and persistGmailMessages; injected APNs transport; synthetic client constructor REPORT only, no actual Notification API/OS display", providerNetworkCalls: 0, http, scan, delivery, syntheticApnsAttempts: attempts, browserEnvelopes: claimed.notifications, constructorReport: report, terminal, classifications, proofCounts, laterCorrectedEnqueues: 0 };
  writeFileSync(join(destination, "result.json"), JSON.stringify(result, null, 2) + "\n");
  writeFileSync(join(destination, "manifest.json"), JSON.stringify({ head, files: [{ name: "result.json", sha256: createHash("sha256").update(JSON.stringify(result, null, 2) + "\n").digest("hex") }], externalProviders: "none" }, null, 2) + "\n");
  console.log(JSON.stringify({ head, evidence: destination, httpRequests: http.length, syntheticApnsAttempts: attempts.length, syntheticApnsDeliveries: delivery.delivered, browserEnvelopes: claimed.notifications.length, simulatedConstructorReports: report.reported, realBrowserConstructors: 0, osDisplayConfirmed: false, laterCorrectedEnqueues: 0 }));
} finally { await server.stop(true); f.sqlite.close(); clearMobilePushTestEnv(); }
