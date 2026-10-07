import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { decodeSearchCursor, encodeSearchCursor } from "./cursor.ts";

const key = "synthetic-cursor-counts-key";
const binding = "a".repeat(64);
const position = { tier: 1, after: "9007199254740993" };
const counts = {
  attention: { all: 12, focus: 2, normal: 5, quiet: 3, hidden: 2 },
  classification: { all: 12, likely_human: 4, automated_or_bulk: 5, uncertain: 2, unclassified: 1 },
};
function signed(value: unknown) {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${payload}.${createHmac("sha256", key).update(`orca-ranked-search-v3:${payload}`).digest("base64url")}`;
}

test("count continuations retain lossless positions, strict totals and the existing cursor size bound", () => {
  const cursor = encodeSearchCursor({ ...position, counts }, binding, key);
  expect(cursor.length).toBeLessThanOrEqual(2_048);
  expect(decodeSearchCursor(cursor, binding, key)).toEqual({ ...position, counts });
  expect(decodeSearchCursor(encodeSearchCursor(position, binding, key), binding, key)).toEqual(position);
  expect(() => decodeSearchCursor(cursor, "b".repeat(64), key)).toThrow("changed");
  expect(() => decodeSearchCursor(cursor, binding, "another-key")).toThrow("invalid");
  const [payload, mac] = cursor.split(".");
  const altered = JSON.parse(Buffer.from(payload!, "base64url").toString());
  altered.counts.attention.all++;
  expect(() => decodeSearchCursor(`${Buffer.from(JSON.stringify(altered)).toString("base64url")}.${mac}`, binding, key)).toThrow("invalid");
});

test("signed malformed totals cannot be reused as exact counts", () => {
  const invalid = [null, [], {}, { ...counts, extra: 1 },
    { ...counts, attention: { ...counts.attention, all: -1 } },
    { ...counts, attention: { ...counts.attention, normal: 0.5 } },
    { ...counts, attention: { ...counts.attention, normal: Number.MAX_SAFE_INTEGER + 1 } },
    { ...counts, attention: { ...counts.attention, normal: 13 } },
    { ...counts, attention: { ...counts.attention, normal: 6 } },
    { ...counts, attention: { ...counts.attention, normal: 4 } },
    { ...counts, classification: { ...counts.classification, all: 13 } },
    { ...counts, classification: { ...counts.classification, extra: 0 } },
  ];
  for (const value of invalid) {
    expect(() => decodeSearchCursor(signed({ version: 3, binding, ...position, counts: value }), binding, key)).toThrow("invalid");
  }
});
