import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { loadGmailPushConfig } from "./push-config.ts";

describe("Gmail push configuration", () => {
  test("uses safe polling and backfill defaults when push is disabled", () => {
    assert.deepEqual(loadGmailPushConfig({}), {
      topicName: null,
      verificationToken: null,
      syncIntervalMs: 900_000,
      watchRenewalWindowMs: 86_400_000,
      backfillPageSize: 25,
      backfillMaxPages: 100,
    });
  });

  test("requires a full Pub/Sub topic resource name and parses bounded overrides", () => {
    assert.throws(
      () => loadGmailPushConfig({ GMAIL_PUBSUB_TOPIC: "orca-gmail" }),
      /GMAIL_PUBSUB_TOPIC must be a full projects/,
    );
    assert.deepEqual(loadGmailPushConfig({
      GMAIL_PUBSUB_TOPIC: "projects/orca/topics/gmail",
      GMAIL_PUBSUB_VERIFICATION_TOKEN: " secret ",
      GMAIL_SYNC_INTERVAL_MS: "1000",
      GMAIL_WATCH_RENEWAL_WINDOW_MS: "2000",
      GMAIL_BACKFILL_PAGE_SIZE: "10",
      GMAIL_BACKFILL_MAX_PAGES: "3",
    }), {
      topicName: "projects/orca/topics/gmail",
      verificationToken: "secret",
      syncIntervalMs: 1000,
      watchRenewalWindowMs: 2000,
      backfillPageSize: 10,
      backfillMaxPages: 3,
    });
  });
});
