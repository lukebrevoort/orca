import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { bodyLimit, readBoundedRequestBody } from "./request-body.ts";

export function streamedRequest(path: string, chunks: Uint8Array[], headers: Record<string, string> = {}, method = "POST") {
  const state = { reads: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.reads++;
      const chunk = chunks.shift();
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel() { state.cancelled = true; },
  }, { highWaterMark: 0 });
  return { request: new Request(`http://localhost${path}`, { method, headers, body: stream }), state };
}

for (const declared of [undefined, "1", "nonsense"]) {
  test(`actual byte overflow cancels without consuming the tail (Content-Length=${declared})`, async () => {
    const { request, state } = streamedRequest("/", [new Uint8Array(8), new Uint8Array(1), new Uint8Array(100)], declared === undefined ? {} : { "content-length": declared });
    assert.equal(await readBoundedRequestBody(request, 8), null);
    assert.deepEqual(state, { reads: 2, cancelled: true });
    assert.equal(request.body!.locked, false);
  });
}

test("declared oversized body cancels without any read", async () => {
  const { request, state } = streamedRequest("/", [new Uint8Array(100)], { "content-length": "9" });
  assert.equal(await readBoundedRequestBody(request, 8), null);
  assert.deepEqual(state, { reads: 0, cancelled: true });
});

test("byte boundary preserves multibyte UTF-8 split across chunks and parser semantics", async () => {
  const bytes = new TextEncoder().encode('{"value":"é😀"}');
  const app = new Hono().post("/", bodyLimit({ maxSize: bytes.length }), async c => c.json(await c.req.json()));
  const { request } = streamedRequest("/", [bytes.subarray(0, 12), bytes.subarray(12)], { "content-type": "application/json", "content-length": "1" });
  const response = await app.fetch(request);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { value: "é😀" });
  const overflow = streamedRequest("/", [bytes, new Uint8Array(1), new Uint8Array(100)], { "content-type": "application/json" });
  assert.equal((await app.fetch(overflow.request)).status, 413);
  assert.deepEqual(overflow.state, { reads: 2, cancelled: true });
});

test("failed reads cancel and release the reader", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ pull() { throw new Error("read failure"); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
  const request = new Request("http://localhost/", { method: "POST", body: stream });
  await assert.rejects(readBoundedRequestBody(request, 8), /read failure/);
  assert.equal(stream.locked, false);
  // A stream that already errored cannot invoke its underlying cancel callback.
  assert.equal(cancelled, false);
});
