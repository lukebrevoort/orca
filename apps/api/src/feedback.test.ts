import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

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
  const RealDate = Date;
  before(() => {
    globalThis.Date = class extends RealDate {
      constructor(value?: string | number | Date) {
        super(value === undefined ? "2026-08-01T22:01:00.000Z" : value);
      }
    } as DateConstructor;
  });
  after(() => { globalThis.Date = RealDate; });
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


const origin = "http://localhost:5173";
const epoch = Date.parse("2030-01-01T00:00:00.000Z");
const day = 24 * 60 * 60 * 1000;
function submit(value: typeof report, time = epoch, onReport?: () => void) {
  return handleFeedbackRequest(new Request("http://localhost:3000/v1/feedback", {
    method: "POST", headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(value),
  }), { allowedOrigin: origin, now: () => new Date(time), onReport });
}
const lookup = getFeedbackReceipt;

describe("feedback bounds", () => {
  for (const [field, cap] of [["id", 128], ["title", 200], ["projectId", 128], ["route", 2048]] as const) {
    test(`${field} accepts its cap and rejects cap plus one`, async () => {
      for (const extra of [0, 1]) {
        const value = "x".repeat(cap + extra);
        const input = { ...report, id: `boundary-${field}-${extra}`,
          project: { ...report.project }, context: { ...report.context } };
        if (field === "projectId") input.project.id = value;
        else if (field === "route") input.context.route = value;
        else input[field] = value;
        let calls = 0;
        const response = await submit(input, epoch, () => { calls++; });
        assert.equal(response.status, extra ? 400 : 201);
        assert.equal(response.headers.get("access-control-allow-origin"), origin);
        assert.equal(response.headers.get("vary"), "origin");
        assert.equal(calls, extra ? 0 : 1);
        if (extra) {
          const body = await response.text();
          assert.deepEqual(JSON.parse(body), { error: "Feedback field is too long." });
          assert.equal(body.includes(value), false);
          assert.equal(getFeedbackReceipt(input.id), undefined);
        }
      }
    });
  }
  test("counts UTF-16 code units and rejects huge and markup titles without delivery", async () => {
    // Each astral character occupies two JS string code units; é occupies one.
    for (const [suffix, title, status] of [
      ["astral-fit", "😀".repeat(100), 201],
      ["astral-over", "😀".repeat(100) + "é", 400],
      ["multibyte-fit", "é".repeat(200), 201],
      ["multibyte-over", "é".repeat(201), 400],
      ["huge", "x".repeat(1024 * 1024), 400],
      ["markup", "<script>alert(1)</script>".repeat(20), 400],
    ] as const) {
      const id = `hostile-${suffix}`;
      let calls = 0;
      const response = await submit({ ...report, id, title }, epoch, () => { calls++; });
      assert.equal(response.status, status);
      assert.equal(calls, status === 201 ? 1 : 0);
      if (status === 400) {
        assert.deepEqual(await response.json(), { error: "Feedback field is too long." });
        assert.equal(getFeedbackReceipt(id), undefined);
      }
    }
  });
  test("preserves the validator's empty title rejection", async () => {
    let calls = 0;
    const response = await submit({ ...report, id: "empty-title", title: "" }, epoch, () => { calls++; });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Title and description are required." });
    assert.equal(calls, 0);
    assert.equal(getFeedbackReceipt("empty-title"), undefined);
  });
  test("retains only the newest 500 of 600 receipts", async () => {
    for (let i = 1; i <= 600; i++) {
      assert.equal((await submit({ ...report, id: `count-${i}` }, epoch + day * 2 + i)).status, 201);
    }
    const retained = Array.from({ length: 600 }, (_, i) => i + 1)
      .filter(i => lookup(`count-${i}`, new Date(epoch + day * 2 + 600)));
    assert.deepEqual(retained, Array.from({ length: 500 }, (_, i) => i + 101));
  });
  test("expires at exactly 24 hours and purges expired capacity on insertion", async () => {
    const start = epoch + day * 4;
    await submit({ ...report, id: "ttl-boundary" }, start);
    assert.ok(lookup("ttl-boundary", new Date(start + day - 1)));
    assert.equal(lookup("ttl-boundary", new Date(start + day)), undefined);
    await submit({ ...report, id: "ttl-insert-purge" }, start);
    for (let i = 0; i < 500; i++) {
      assert.equal((await submit({ ...report, id: `fresh-${i}` }, start + day)).status, 201);
    }
    // Use the original timestamp: insertion must have removed this entry already.
    assert.equal(lookup("ttl-insert-purge", new Date(start)), undefined);
    for (let i = 0; i < 500; i++) assert.ok(lookup(`fresh-${i}`, new Date(start + day)));
  });
  test("resubmission refreshes insertion order and receivedAt", async () => {
    const start = epoch + day * 8;
    for (let i = 0; i < 500; i++) await submit({ ...report, id: `refresh-${i}` }, start + i);
    await submit({ ...report, id: "refresh-0" }, start + 500);
    await submit({ ...report, id: "refresh-new" }, start + 501);
    assert.equal(lookup("refresh-1", new Date(start + 501)), undefined);
    assert.equal(lookup("refresh-0", new Date(start + 501))?.receivedAt, new Date(start + 500).toISOString());
    assert.ok(lookup("refresh-2", new Date(start + 501)));
    assert.ok(lookup("refresh-new", new Date(start + 501)));
  });
  test("keeps body size, optional origin, method and disabled controls", async () => {
    const cap = 40 * 1024 * 1024;
    for (const [size, status] of [[cap + 1, 413], [cap - 1, 201]]) {
      const base = { ...report, id: `body-${size}`, description: "" };
      base.description = "x".repeat(size! - JSON.stringify(base).length);
      const body = JSON.stringify(base);
      assert.equal(body.length, size);
      const response = await handleFeedbackRequest(new Request("http://localhost/feedback", { method: "POST", body }), { allowedOrigin: origin });
      assert.equal(response.status, status);
    }
    for (const [method, status] of [["OPTIONS", 204], ["GET", 405]] as const) {
      const response = await handleFeedbackRequest(new Request("http://localhost/feedback", { method, headers: { origin } }), { allowedOrigin: origin });
      assert.equal(response.status, status);
      assert.equal(response.headers.get("access-control-allow-origin"), origin);
    }
    const disabled = await handleFeedbackRequest(new Request("http://localhost/feedback", { method: "POST", body: JSON.stringify(report) }), { enabled: false });
    assert.equal(disabled.status, 404);
  });
});
