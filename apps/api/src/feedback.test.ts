import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { getFeedbackReceipt, handleFeedbackRequest } from "./feedback.ts";

const report = {
  schemaVersion: 1,
  id: "feedback-test-1",
  project: { id: "orca", name: "Orca", environment: "development" },
  kind: "bug",
  severity: "normal",
  title: "The button feels quiet",
  description: "The test report should never expose its token.",
  context: {
    url: "http://localhost:5173/dev/inbox",
    route: "/dev/inbox",
    title: "Orca",
    userAgent: "test",
    viewport: { width: 1200, height: 800, pixelRatio: 1 },
    locale: "en-US",
    timezone: "America/Denver",
    capturedAt: "2026-08-01T22:00:00.000Z",
  },
  elements: [],
  state: { token: "do-not-store", theme: "dark" },
  metadata: { source: "test" },
  attachments: [],
};

describe("feedback receipt handler", () => {
  test("accepts same-origin reports, redacts state, and returns a receipt", async () => {
    let receivedState: unknown;
    const response = await handleFeedbackRequest(
      new Request("http://localhost:3000/v1/feedback", {
        method: "POST",
        headers: { origin: "http://localhost:5173", "content-type": "application/json" },
        body: JSON.stringify(report),
      }),
      {
        allowedOrigin: "http://localhost:5173",
        now: () => new Date("2026-08-01T22:01:00.000Z"),
        onReport: (received) => { receivedState = received.state; },
      },
    );

    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), {
      result: {
        id: "feedback-test-1",
        title: "The button feels quiet",
      },
    });
    assert.deepEqual(receivedState, { token: "[REDACTED]", theme: "dark" });
    assert.deepEqual(getFeedbackReceipt("feedback-test-1"), {
      id: "feedback-test-1",
      projectId: "orca",
      title: "The button feels quiet",
      route: "/dev/inbox",
      receivedAt: "2026-08-01T22:01:00.000Z",
    });
  });

  test("returns the external delivery link when a report handler provides one", async () => {
    const response = await handleFeedbackRequest(
      new Request("http://localhost:3000/v1/feedback", {
        method: "POST",
        headers: { origin: "http://localhost:5173", "content-type": "application/json" },
        body: JSON.stringify({ ...report, id: "feedback-test-delivery-1" }),
      }),
      {
        allowedOrigin: "http://localhost:5173",
        onReport: () => ({
          identifier: "BRE-201",
          url: "https://linear.app/brevoort/issue/BRE-201/feedback-button-delayed",
        }),
      },
    );

    assert.deepEqual(await response.json(), {
      result: {
        id: "feedback-test-delivery-1",
        title: "The button feels quiet",
        identifier: "BRE-201",
        url: "https://linear.app/brevoort/issue/BRE-201/feedback-button-delayed",
      },
    });
  });

  test("rejects cross-origin and malformed reports", async () => {
    const crossOrigin = await handleFeedbackRequest(
      new Request("http://localhost:3000/v1/feedback", { method: "POST", headers: { origin: "https://example.com" }, body: "{}" }),
      { allowedOrigin: "http://localhost:5173" },
    );
    assert.equal(crossOrigin.status, 403);

    const malformed = await handleFeedbackRequest(
      new Request("http://localhost:3000/v1/feedback", { method: "POST", body: "{}" }),
      { allowedOrigin: "http://localhost:5173" },
    );
    assert.equal(malformed.status, 400);
  });
});
