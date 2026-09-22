import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { classifyApnsResponse, createApnsTransport } from "./apns.ts";
import { loadMobilePushConfig } from "./config.ts";

describe("APNs configuration and response handling", () => {
  test("disables delivery without throwing for absent, partial, or malformed credentials", async () => {
    const absent = loadMobilePushConfig({});
    assert.deepEqual({ configured: absent.configured, reason: absent.disabledReason }, { configured: false, reason: "APNs credentials are not configured" });
    const partial = loadMobilePushConfig({ APNS_TEAM_ID: "ABCDEFGHIJ" });
    assert.equal(partial.configured, false);
    assert.equal(partial.disabledReason, "APNs credentials are incomplete");
    const malformed = loadMobilePushConfig({ APNS_TEAM_ID: "bad", APNS_KEY_ID: "KLMNOPQRST", APNS_BUNDLE_ID: "com.orca.app", APNS_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\ntest" });
    assert.equal(malformed.configured, false);
    const result = await createApnsTransport(absent).send({ token: "aa", environment: "sandbox", payload: {}, apnsId: crypto.randomUUID(), collapseId: "thread" });
    assert.equal(result.outcome, "retry");
  });

  test("accepts a complete token-auth configuration and bounds scheduler settings", () => {
    const config = loadMobilePushConfig({
      APNS_TEAM_ID: "ABCDEFGHIJ",
      APNS_KEY_ID: "KLMNOPQRST",
      APNS_BUNDLE_ID: "com.orca.app",
      APNS_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\ntest\\n-----END PRIVATE KEY-----",
      MOBILE_PUSH_INTERVAL_MS: "1",
      MOBILE_PUSH_BATCH_SIZE: "9999",
      MOBILE_PUSH_STALE_DAYS: "30",
      MOBILE_PUSH_MAX_ATTEMPTS: "5",
    });
    assert.equal(config.configured, true);
    assert.equal(config.privateKey?.includes("\n"), true);
    assert.equal(config.intervalMs, 15_000);
    assert.equal(config.batchSize, 100);
    assert.equal(config.staleDeviceMs, 30 * 86_400_000);
    assert.equal(config.maxAttempts, 5);
  });

  test("distinguishes retryable, permanent, and token-invalidating APNs responses", () => {
    assert.deepEqual(classifyApnsResponse(200, {}), { outcome: "success", status: 200 });
    assert.deepEqual(classifyApnsResponse(410, { reason: "Unregistered", timestamp: 42 }), { outcome: "invalid_token", status: 410, reason: "Unregistered", invalidatedAt: 42 });
    assert.deepEqual(classifyApnsResponse(400, { reason: "BadDeviceToken" }), { outcome: "invalid_token", status: 400, reason: "BadDeviceToken", invalidatedAt: null });
    assert.deepEqual(classifyApnsResponse(503, { reason: "ServiceUnavailable" }, "7"), { outcome: "retry", status: 503, reason: "ServiceUnavailable", retryAfterMs: 7_000 });
    assert.deepEqual(classifyApnsResponse(403, { reason: "ExpiredProviderToken" }), { outcome: "retry", status: 403, reason: "ExpiredProviderToken" });
    assert.deepEqual(classifyApnsResponse(400, { reason: "PayloadEmpty" }), { outcome: "permanent", status: 400, reason: "PayloadEmpty" });
  });
});
