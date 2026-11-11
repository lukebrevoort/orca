// Isolated subprocess: real scheduler, SQLite policy and production APNs transport.
// Only HTTP/2 network I/O is replaced; real WebCrypto signing is held mid-flight.
import { EventEmitter } from "node:events";
import * as http2 from "node:http2";
import { mock } from "bun:test";
import { generateKeyPair, exportPKCS8 } from "jose";

let requests = 0, connections = 0;
class SyntheticStream extends EventEmitter {
  setTimeout() { return this; }
  close() {}
  end() { queueMicrotask(() => { this.emit("response", { ":status": 200 }); this.emit("end"); }); }
}
class SyntheticSession extends EventEmitter {
  closed = false; destroyed = false;
  unref() {}
  request() { requests++; return new SyntheticStream(); }
  close() { this.closed = true; this.emit("close"); }
}
mock.module("node:http2", () => ({ ...http2, connect() { connections++; return new SyntheticSession(); } }));
const { notificationFixture } = await import("./fixture.ts");
const { createApnsTransport } = await import("../mobile-push/apns.ts");
const { deliverReady, scanAndEnqueue } = await import("../mobile-push/scheduler.ts");
const { setMobilePushTestEnv, clearMobilePushTestEnv, testConfig } = await import("../mobile-push/test-helpers.ts");

const keys = await generateKeyPair("ES256", { extractable: true });
const privateKey = await exportPKCS8(keys.privateKey);
let entered!: () => void, release!: () => void;
const signing = new Promise<void>(resolve => { entered = resolve; });
const held = new Promise<void>(resolve => { release = resolve; });
const nativeSign = crypto.subtle.sign.bind(crypto.subtle);
crypto.subtle.sign = async (algorithm, key, data) => {
  if (key.algorithm.name === "ECDSA") { entered(); await held; }
  return nativeSign(algorithm, key, data);
};
setMobilePushTestEnv();
const f = await notificationFixture();
const config = { ...testConfig, privateKey };
const transport = createApnsTransport(config, { now: () => new Date(f.state.now) });
let timeout: ReturnType<typeof setTimeout> | undefined;
try {
  const registered = await f.request("/v1/mobile/devices/phone", { token: "aa".repeat(32), environment: "sandbox", notificationSelection: { inbox: false, spaceIds: [] } });
  if (registered.status !== 200 || (await f.adopt("apns", "phone")).status !== 200) throw Error("Synthetic registration/adoption failed");
  await f.fresh("signing-arrival");
  if (scanAndEnqueue(f.sqlite, { now: new Date(f.state.now), batchSize: 100 }).enqueued !== 1) throw Error("Expected one actual queued notification");
  const delivery = deliverReady(f.sqlite, { now: () => new Date(f.state.now), batchSize: 1, config, transport });
  await Promise.race([signing, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(Error("Production signing boundary not reached")), 5000); })]);
  clearTimeout(timeout);
  const change = process.argv[2] ?? "correction";
  if (change === "correction") await f.important("gmail:a:conversation", "not_important");
  else if (change === "read") f.sqlite.query("UPDATE emails SET is_read=1 WHERE id='gmail:a:signing-arrival'").run();
  else if (change === "session") f.sqlite.query("UPDATE sessions SET invalidated_at=? WHERE id=?").run(f.state.now, f.session.sessionId);
  else if (change === "account") f.sqlite.query("DELETE FROM oauth_accounts WHERE id='a'").run();
  else if (change === "permission") await f.adopt("apns", "phone", 1, { permission: "denied" });
  else if (change === "token") await f.request("/v1/mobile/devices/phone", { token: "bb".repeat(32), environment: "sandbox", notificationSelection: { inbox: false, spaceIds: [] } });
  else if (change === "configuration") config.configured = false;
  else if (change === "lease") f.state.now += 30_001;
  else if (change === "lease-owner") f.sqlite.query("UPDATE mobile_push_outbox SET lease_owner='replacement-worker'").run();
  else if (change !== "unchanged") throw Error("Unknown synthetic change");
  release();
  const result = await delivery;
  console.log(JSON.stringify({ change, requests, connections, result, outbox: f.sqlite.query("SELECT state,attempt_count,last_error FROM mobile_push_outbox").all(), scope: "real WebCrypto/scheduler/production send, synthetic HTTP2 request boundary, zero provider network" }));
} finally {
  clearTimeout(timeout); release(); transport.close?.(); crypto.subtle.sign = nativeSign;
  f.sqlite.close(); clearMobilePushTestEnv();
}
