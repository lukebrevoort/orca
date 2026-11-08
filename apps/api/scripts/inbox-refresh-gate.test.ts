import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { InboxRefreshGate, inboxRefreshDeadlines, inboxRefreshScenario, inboxRefreshArmBodyIsEmpty } from "./inbox-refresh-gate.ts";

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
  assert.throws(() => new InboxRefreshGate({ deadlineMs: 360_001 }), RangeError);
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


test("named scenarios have fixed bounded budgets and reject arbitrary duration input", () => {
  assert.deepEqual(inboxRefreshDeadlines, { default: 120_000, controls: 240_000, switch: 360_000 });
  assert.equal(inboxRefreshScenario(new URLSearchParams()), "default");
  for (const scenario of ["default", "controls", "switch"] as const) {
    assert.equal(inboxRefreshScenario(new URLSearchParams({ scenario })), scenario);
    const gate = new InboxRefreshGate({ deadlineMs: inboxRefreshDeadlines[scenario] });
    gate.cancel(); // Never wait minutes in a contract test.
  }
  for (const query of ["scenario=unknown", "scenario=", "scenario=controls&scenario=switch",
    "deadlineMs=360000", "duration=240", "scenario=controls&deadlineMs=240000", "scenario=toString"]) {
    assert.throws(() => inboxRefreshScenario(new URLSearchParams(query)), RangeError);
  }
  for (const bad of [0, -1, NaN, Infinity, 360_001]) {
    assert.throws(() => new InboxRefreshGate({ deadlineMs: bad }), RangeError);
  }
});

test("polling, repeated claims and heartbeat reads cannot renew the armed deadline", async () => {
  const gate = new InboxRefreshGate({ keepAliveMs: 2, deadlineMs: 30 });
  let polling: ReturnType<typeof setInterval> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    gate.claim();
    const response = await gate.hold(Response.json({ inbox: [] }));
    const decoded = assert.rejects(response.json(), /expired/);
    polling = setInterval(() => { gate.claim(); void gate.waitForStart(); }, 1);
    const reason = await Promise.race([
      gate.finished,
      new Promise<never>((_, reject) => { watchdog = setTimeout(() => reject(new Error("Polling renewed deadline")), 500); }),
    ]);
    assert.equal(reason, "expired");
    await decoded;
    assert.equal(await gate.waitForStart(), false);
    assert.equal(gate.release(), false);
  } finally {
    clearInterval(polling);
    clearTimeout(watchdog);
    gate.cancel();
  }
});


test("arm body validation accepts actual empty POSTs including non-null streams", async () => {
  for (const body of [undefined, "", new Uint8Array()]) {
    const request = new Request("http://localhost/arm", { method: "POST", body });
    assert.equal(await inboxRefreshArmBodyIsEmpty(request), true);
  }
  const empty = new Request("http://localhost/arm", { method: "POST", body: "", headers: { "Content-Length": "0" } });
  assert.notEqual(empty.body, null);
  assert.equal(await inboxRefreshArmBodyIsEmpty(empty), true);
});

test("arm body validation rejects content and misleading or invalid lengths", async () => {
  for (const length of [undefined, "0", "1", "-1", "invalid"]) {
    const request = new Request("http://localhost/arm", {
      method: "POST", body: "x", headers: length === undefined ? {} : { "Content-Length": length },
    });
    assert.equal(await inboxRefreshArmBodyIsEmpty(request), false);
  }
});

test("stalled arm bodies time out and are cancelled without affecting an existing gate", async () => {
  const gate = new InboxRefreshGate({ deadlineMs: 200 });
  let cancelled = false;
  const request = new Request("http://localhost/arm", {
    method: "POST", duplex: "half", body: new ReadableStream({ cancel() { cancelled = true; } }),
  } as RequestInit);
  try {
    assert.equal(await inboxRefreshArmBodyIsEmpty(request, 10), false);
    assert.equal(cancelled, true);
    assert.equal(gate.pending, true);
  } finally { gate.cancel(); }
});

test("arm body validation bounds empty chunks and cancels rejected content", async () => {
  for (const nonempty of [false, true]) {
    let cancelled = false;
    let pulls = 0;
    const request = new Request("http://localhost/arm", {
      method: "POST", duplex: "half", body: new ReadableStream({
        pull(controller) { pulls += 1; controller.enqueue(new Uint8Array(nonempty ? [1] : [])); },
        cancel() { cancelled = true; },
      }),
    } as RequestInit);
    assert.equal(await inboxRefreshArmBodyIsEmpty(request), false);
    assert.equal(cancelled, true);
    assert.ok(pulls <= 17);
  }
});
