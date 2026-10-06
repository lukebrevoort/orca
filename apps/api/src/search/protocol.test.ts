import { expect, test } from "bun:test";
import { mailSearchQuerySchema } from "@orca/shared/mail-search";
import { rankedSearchWorkerReplySchema, rankedSearchWorkerRequestSchema } from "./protocol.ts";

const request = { version: 1, databasePath: "/tmp/fixture.sqlite", authorization: { userId: "user" }, query: { query: "appointment", limit: 50 }, mode: "full", cursorKey: "synthetic-key" };
test("private legacy metadata counts can use 100 while ranked pages stay at 50", () => {
  expect(rankedSearchWorkerRequestSchema.safeParse(request).success).toBe(true);
  expect(rankedSearchWorkerRequestSchema.safeParse({ ...request, query: { ...request.query, limit: 100 } }).success).toBe(false);
  expect(rankedSearchWorkerRequestSchema.safeParse({ ...request, mode: "metadata", exactCounts: true, query: { ...request.query, limit: 100 } }).success).toBe(true);
  expect(rankedSearchWorkerRequestSchema.safeParse({ ...request, exactCounts: true }).success).toBe(false);
  expect(mailSearchQuerySchema.safeParse({ query: "appointment", limit: 100 }).success).toBe(false);
});

test("private protocol requires its version and server-selected authority fields", () => {
  expect(rankedSearchWorkerRequestSchema.safeParse({ ...request, version: 2 }).success).toBe(false);
  expect(rankedSearchWorkerRequestSchema.safeParse({ ...request, mode: undefined }).success).toBe(false);
  expect(rankedSearchWorkerRequestSchema.safeParse({ ...request, cursorKey: undefined }).success).toBe(false);
  expect(rankedSearchWorkerRequestSchema.safeParse({ ...request, expectedEpoch: "a".repeat(64) }).success).toBe(true);
  expect(rankedSearchWorkerRequestSchema.safeParse({ ...request, expectedEpoch: "legacy-server" }).success).toBe(false);
  for (const code of ["search_mode_changed", "search_not_activated"]) {
    expect(rankedSearchWorkerReplySchema.safeParse({ version: 1, ok: false, code, peakRssBytes: null }).success).toBe(true);
  }
  expect(rankedSearchWorkerRequestSchema.safeParse({ ...request, query: { ...request.query, accountId: "a" } }).success).toBe(false);
  expect(rankedSearchWorkerReplySchema.safeParse({ version: 1, ok: false, code: "search_index_updating", peakRssBytes: null }).success).toBe(true);
  expect(rankedSearchWorkerReplySchema.safeParse({ version: 1, ok: false, code: "search_index_updating", peakRssBytes: null, message: "unexpected" }).success).toBe(false);
});
