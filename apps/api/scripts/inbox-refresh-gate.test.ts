import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { InboxRefreshGate } from "./inbox-refresh-gate.ts";

const options = { keepAliveMs: 5, deadlineMs: 200 };

test("only the first request can claim a gate, including after release", async () => {
  const gate = new InboxRefreshGate(options);
  try {
    assert.equal(gate.claim(), true);
    assert.equal(gate.claim(), false);
    const response = await gate.hold(Response.json({ inbox: [] }));
    assert.equal(await gate.waitForStart(), true);
    await assert.rejects(gate.hold(Response.json({ inbox: [] })), /exactly once/);
    assert.equal(gate.release(), true);
    assert.equal(gate.release(), false);
    assert.equal(gate.claim(), false);
    assert.equal(gate.pending, false);
    assert.equal(gate.terminalReason, "explicit");
    assert.equal(await gate.waitForStart(), false);
    assert.deepEqual(await response.json(), { inbox: [] });
  } finally { gate.cancel(); }
});

test("emits whitespace repeatedly, preserving original bytes/status and security/cache headers", async () => {
  const gate = new InboxRefreshGate(options);
  try {
    gate.claim();
    const original = '{"inbox": ["synthetic ✓"]}\n';
    const response = await gate.hold(new Response(original, {
      status: 201, statusText: "Fixture Created", headers: {
        "Content-Type": "application/json", "Content-Length": "999", "Content-Encoding": "gzip",
        "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
      },
    }));
    assert.equal(response.status, 201);
    assert.equal(response.statusText, "Fixture Created");
    assert.equal(response.headers.get("content-type"), "application/json");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.has("content-length"), false);
    assert.equal(response.headers.has("content-encoding"), false);
    const reader = response.body!.getReader();
    assert.deepEqual((await reader.read()).value, new Uint8Array([32]));
    assert.deepEqual((await reader.read()).value, new Uint8Array([32]));
    gate.release();
    let remainder = "";
    const decoder = new TextDecoder();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      remainder += decoder.decode(chunk.value, { stream: true });
    }
    assert.equal(remainder.trimStart(), original);
    assert.deepEqual(JSON.parse(remainder), { inbox: ["synthetic ✓"] });
  } finally { gate.cancel(); }
});

test("JSON decoding stays pending through keepalives until explicit release", async () => {
  const gate = new InboxRefreshGate(options);
  try {
    gate.claim();
    const response = await gate.hold(Response.json({ inbox: [] }));
    let settled = false;
    const decoded = response.json().finally(() => { settled = true; });
    await delay(25);
    assert.equal(settled, false);
    gate.release();
    assert.deepEqual(await decoded, { inbox: [] });
    await delay(20); // A leaked heartbeat would enqueue into a closed stream and throw.
    assert.equal(gate.terminalReason, "explicit");
  } finally { gate.cancel(); }
});

test("deadline errors incomplete JSON and invalidates past starts", async () => {
  const gate = new InboxRefreshGate({ ...options, deadlineMs: 30 });
  gate.claim();
  const response = await gate.hold(Response.json({ inbox: [] }));
  assert.equal(await gate.waitForStart(), true);
  await assert.rejects(response.json(), /expired/);
  assert.equal(await gate.finished, "expired");
  assert.equal(gate.pending, false);
  assert.equal(gate.release(), false);
  assert.equal(await gate.waitForStart(), false);
  await delay(20); // No further heartbeat emissions after error.
});

test("unclaimed expiry and cancellation unblock waiters without a historical start", async () => {
  const expired = new InboxRefreshGate({ ...options, deadlineMs: 10 });
  assert.equal(await expired.waitForStart(), false);
  assert.equal(expired.terminalReason, "expired");
  assert.equal(expired.claim(), false);
  const cancelled = new InboxRefreshGate(options);
  const waiting = cancelled.waitForStart();
  cancelled.cancel();
  assert.equal(await waiting, false);
  assert.equal(cancelled.terminalReason, "cancelled");
});

for (const cancellation of ["reader", "signal", "pre-aborted"] as const) {
  test(`${cancellation} cancellation stops all timers and rejects release`, async () => {
    const gate = new InboxRefreshGate({ ...options, deadlineMs: 40 });
    const abort = new AbortController();
    gate.claim();
    if (cancellation === "pre-aborted") abort.abort();
    if (cancellation === "pre-aborted") {
      await assert.rejects(gate.hold(Response.json({ inbox: [] }), abort.signal), /cancelled/);
    } else {
      const response = await gate.hold(Response.json({ inbox: [] }), abort.signal);
      if (cancellation === "reader") await response.body!.cancel();
      else {
        const decoded = response.json();
        abort.abort();
        await assert.rejects(decoded, /cancelled/);
      }
    }
    assert.equal(await gate.finished, "cancelled");
    assert.equal(gate.pending, false);
    assert.equal(await gate.waitForStart(), false);
    assert.equal(gate.release(), false);
    await delay(60); // Past the deadline: no emission into a cancelled stream or changed reason.
    assert.equal(gate.terminalReason, "cancelled");
  });
}

test("unsuccessful responses pass through without changing status/body", async () => {
  const gate = new InboxRefreshGate(options);
  gate.claim();
  const original = new Response("fixture unavailable", { status: 503 });
  assert.equal(await gate.hold(original), original);
  assert.equal(await original.text(), "fixture unavailable");
  assert.equal(await gate.waitForStart(), false);
});

test("rejects unbounded timings", () => {
  for (const bad of [0, -1, NaN, Infinity, 5_001]) {
    assert.throws(() => new InboxRefreshGate({ keepAliveMs: bad }), RangeError);
  }
  assert.throws(() => new InboxRefreshGate({ deadlineMs: 120_001 }), RangeError);
});


test("a stalled source body is cancelled at the deadline without blocking hold", async () => {
  let cancelled = false;
  const source = new Response(new ReadableStream({
    cancel() { cancelled = true; },
  }));
  const gate = new InboxRefreshGate({ ...options, deadlineMs: 15 });
  gate.claim();
  await assert.rejects(gate.hold(source), /expired/);
  assert.equal(cancelled, true);
  assert.equal(await gate.waitForStart(), false);
  assert.equal(gate.terminalReason, "expired");
});
