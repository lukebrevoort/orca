import { expect, test } from "bun:test";
import { summaryResponseSchema } from "./summary.ts";
const empty = { accountId: "a", needsYou: [], waitingOn: [], codes: { available: false, items: [] }, draftedReplies: { available: false, items: [] }, routine: { count: 0 }, counts: { needsYou: 0, waitingOn: 0, codes: 0, draftedReplies: 0, routine: 0 } };
test("accepts honest empty summary", () => expect(summaryResponseSchema.safeParse(empty).success).toBe(true));
test("rejects code values, fabricated availability, unknown fields and mismatched counts", () => {
  for (const patch of [{ codes: { available: false, items: [{ code: "123456" }] } }, { codes: { available: true, items: [] } }, { draftedReplies: { available: true, items: [] } }, { secret: "mail" }, { counts: { ...empty.counts, needsYou: 1 } }, { routine: { count: -1 } }]) expect(summaryResponseSchema.safeParse({ ...empty, ...patch }).success).toBe(false);
});
test("requires source and reasons and caps item tiles", () => {
  const item = { source: { messageId: "m", threadId: "t" }, reasons: ["unread"], title: "<script>", snippet: "plain", sender: "a@b.test", receivedAt: "2026-10-01T12:00:00Z" };
  expect(summaryResponseSchema.safeParse({ ...empty, needsYou: [item], counts: { ...empty.counts, needsYou: 1 } }).success).toBe(true);
  for (const bad of [{ ...item, source: {} }, { ...item, reasons: [] }, { ...item, receivedAt: "bad" }, { ...item, unexpected: "mail" }]) expect(summaryResponseSchema.safeParse({ ...empty, needsYou: [bad], counts: { ...empty.counts, needsYou: 1 } }).success).toBe(false);
  expect(summaryResponseSchema.safeParse({ ...empty, needsYou: Array(21).fill(item), counts: { ...empty.counts, needsYou: 21 } }).success).toBe(false);
});
