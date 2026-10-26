import { expect, test } from "bun:test";
import { summaryResponseSchema } from "@orca/shared";
import { buildSummary, type SummaryInput, type SummaryMessage } from "./rules.ts";
const now = new Date("2026-11-03T17:00:00Z");
const day = 86400000;
function message(id: string, patch: Partial<SummaryMessage> = {}): SummaryMessage {
  return { id, accountId: "a", threadId: id, fromAddress: "friend@example.test", toRecipients: '[{"email":"ME@example.test"}]', subject: "<script>alert(1)</script>", snippet: "<img onerror=evil>", bodyText: "private", receivedAt: new Date(now.getTime() - day), isRead: false, humanSignal: 8, humanClassification: "likely_human", humanClassificationReasons: '["direct_recipient"]', ...patch };
}
function input(messages: SummaryMessage[]): SummaryInput { return { userId: "u", account: { id: "a", userId: "u", providerEmail: "me@example.test" }, messages, events: [], reminders: [] }; }
test("empty response honestly disables unavailable tiles", () => {
  const result = buildSummary(input([]), now);
  expect(summaryResponseSchema.safeParse(result).success).toBe(true);
  expect(result.counts).toEqual({ needsYou: 0, waitingOn: 0, routine: 0, codes: 0, draftedReplies: 0 });
});
test("direct human unread and read latest inbound, deduped; markup stays plain strings", () => {
  const result = buildSummary(input([message("old", { threadId: "t" }), message("new", { threadId: "t", isRead: true, receivedAt: now }), message("cc", { toRecipients: "[]" }), message("badTo", { toRecipients: "{" }), message("score", { humanClassification: "uncertain", humanSignal: 7 }), message("low", { humanClassification: "uncertain", humanSignal: 6 })]), now);
  expect(result.needsYou.map(i => i.source.messageId)).toEqual(["new", "score"]);
  expect(result.needsYou[0]?.title).toBe("<script>alert(1)</script>");
  expect(result.needsYou[0]?.snippet).toBe("<img onerror=evil>");
});
test("account isolation and owner guard", () => {
  expect(buildSummary(input([message("own"), message("sameUserOtherAccount", { accountId: "b" }), message("otherUser", { accountId: "private" })]), now).needsYou.map(i => i.source.messageId)).toEqual(["own"]);
  expect(() => buildSummary({ ...input([]), userId: "other" }, now)).toThrow();
});
test("later reply suppresses need; latest outbound older than three elapsed days waits, From spoofing is treated as outbound", () => {
  const result = buildSummary(input([message("in", { threadId: "t", receivedAt: new Date(now.getTime() - 6 * day) }), message("out", { threadId: "t", fromAddress: "ME@example.test", receivedAt: new Date(now.getTime() - 4 * day) }), message("exact", { fromAddress: "me@example.test", receivedAt: new Date(now.getTime() - 3 * day) }), message("spoof", { fromAddress: "me@example.test", receivedAt: new Date(now.getTime() - 5 * day) })]), now);
  expect(result.needsYou).toEqual([]);
  expect(result.waitingOn.map(i => [i.source.messageId, i.days])).toEqual([["out", 4], ["spoof", 5]]);
});
test("inbound after sent mail removes waiting; malformed classification reasons skip safely", () => {
  const result = buildSummary(input([message("out", { threadId: "t", fromAddress: "me@example.test", receivedAt: new Date(now.getTime() - 4 * day) }), message("reply", { threadId: "t" }), ...["{", "{}", '[1]', '"text"'].map((reasons, i) => message(`bad${i}`, { humanClassificationReasons: reasons }))]), now);
  expect(result.waitingOn).toEqual([]);
  expect(result.needsYou.map(i => i.source.messageId)).toEqual(["reply"]);
});
test("active event and resurfaced reminders contribute, unknown/dismissed/muted/retracted and cancelled excluded", () => {
  const f = input(["new", "seen", "dismissed", "muted", "retracted", "weird", "rem", "cancel", "scheduled"].map(id => message(id, { humanClassification: "unclassified", humanSignal: null })));
  f.events = ["new", "seen", "dismissed", "muted", "retracted", "weird"].map(id => ({ accountId: "a", ownerUserId: "u", messageId: id, threadId: id, lifecycleState: id, title: "event", whyThisMatters: "reason" }));
  f.events.push({ ...f.events[0]!, ownerUserId: "other", messageId: "cancel", threadId: "cancel" }, { ...f.events[0]!, accountId: "b", messageId: "scheduled", threadId: "scheduled" });
  f.reminders = [{ accountId: "a", threadId: "rem", status: "resurfaced" }, { accountId: "a", threadId: "cancel", status: "cancelled" }, { accountId: "a", threadId: "scheduled", status: "scheduled" }];
  expect(buildSummary(f, now).needsYou.map(i => i.source.threadId)).toEqual(["new", "seen", "rem"]);
});
test("10k messages bound routine to 500 and both item tiles to 20; no input mutation", () => {
  const rows = Array.from({ length: 10000 }, (_, i) => message(String(i), { humanClassification: "automated_or_bulk", humanSignal: 1 }));
  expect(buildSummary(input(rows), now).routine.count).toBe(500);
  expect(rows[0]?.id).toBe("0");
  expect(buildSummary(input(rows.map(m => ({ ...m, humanClassification: "likely_human" }))), now).needsYou).toHaveLength(20);
  expect(buildSummary(input(rows.map(m => ({ ...m, fromAddress: "me@example.test", receivedAt: new Date(now.getTime() - 4 * day) }))), now).waitingOn).toHaveLength(20);
});
test("window boundaries, future and null dates, invalid clock; DST uses elapsed days", () => {
  const f = input([message("edge", { receivedAt: new Date(now.getTime() - 14 * day) }), message("old", { receivedAt: new Date(now.getTime() - 14 * day - 1) }), message("future", { receivedAt: new Date(now.getTime() + 1) }), message("null", { receivedAt: null })]);
  expect(buildSummary(f, now).needsYou.map(i => i.source.messageId)).toEqual(["edge"]);
  expect(() => buildSummary(f, new Date(NaN))).toThrow();
  for (const clock of [new Date("2026-03-10T12:00:00-04:00"), new Date("2026-11-03T12:00:00-05:00")]) {
    expect(buildSummary(input([message("dst", { fromAddress: "me@example.test", receivedAt: new Date(clock.getTime() - 4 * day) })]), clock).waitingOn[0]?.days).toBe(4);
  }
});
test("an old unread message stays answered when a later inbound is not directly addressed", () => {
  const result = buildSummary(input([
    message("old", { threadId: "t", receivedAt: new Date(now.getTime() - 6 * day) }),
    message("sent", { threadId: "t", fromAddress: "me@example.test", receivedAt: new Date(now.getTime() - 5 * day) }),
    message("latest", { threadId: "t", toRecipients: "[]", isRead: true }),
  ]), now);
  expect(result.needsYou).toEqual([]);
  expect(result.waitingOn).toEqual([]);
});
test("multiple signals merge their reasons without duplicating a thread", () => {
  const f = input([message("m")]);
  f.events = [{ accountId: "a", ownerUserId: "u", messageId: "m", threadId: "m", lifecycleState: "new", title: "event", whyThisMatters: "deadline" }];
  f.reminders = [{ accountId: "a", threadId: "m", status: "resurfaced" }];
  const result = buildSummary(f, now);
  expect(result.needsYou).toHaveLength(1);
  expect(result.needsYou[0]?.reasons).toContain("agent_event");
  expect(result.needsYou[0]?.reasons).toContain("resurfaced_reminder");
});
test("a read older direct human message needs no action when latest inbound does not qualify", () => {
  const result = buildSummary(input([
    message("older", { threadId: "t", isRead: true, receivedAt: new Date(now.getTime() - 2 * day) }),
    message("latest", { threadId: "t", toRecipients: "[]", humanClassification: "automated_or_bulk", humanSignal: 1 }),
  ]), now);
  expect(result.needsYou).toEqual([]);
});
test("waiting skips latest outbound with malformed or non-string classification reasons", () => {
  const result = buildSummary(input(["{bad", '["valid",1]'].map((reasons, i) => message(`bad-out-${i}`, {
    fromAddress: "me@example.test", receivedAt: new Date(now.getTime() - 4 * day), humanClassificationReasons: reasons,
  }))), now);
  expect(result.waitingOn).toEqual([]);
  expect(result.needsYou).toEqual([]);
});
test("waiting days floor fractional elapsed days after the three-day threshold", () => {
  const result = buildSummary(input([2.9, 3.5, 3.9, 4.9].map(days => message(String(days), {
    fromAddress: "me@example.test", receivedAt: new Date(now.getTime() - days * day),
  }))), now);
  expect(result.waitingOn.map(i => [i.source.messageId, i.days])).toEqual([["3.5", 3], ["3.9", 3], ["4.9", 4]]);
});
test("own address normalization trims and folds provider, sender and recipient addresses", () => {
  for (const [providerEmail, recipientEmail, fromAddress] of [
    ["  Me@Example.com  ", "me@example.com", "me@example.com"],
    ["me@example.com", "  ME@Example.com  ", "  me@EXAMPLE.com  "],
  ] as const) {
    const f = input([
      message("direct", { toRecipients: JSON.stringify([{ email: recipientEmail }]) }),
      message("outbound", { fromAddress, receivedAt: new Date(now.getTime() - 4 * day) }),
    ]);
    f.account.providerEmail = providerEmail;
    const result = buildSummary(f, now);
    expect(result.needsYou.map(i => i.source.messageId)).toEqual(["direct"]);
    expect(result.waitingOn.map(i => i.source.messageId)).toEqual(["outbound"]);
  }
});
test("invalid receivedAt is skipped in messages and event or reminder source messages", () => {
  const invalid = message("invalid", { receivedAt: new Date(NaN) });
  const f = input([invalid, message("valid")]);
  f.events = [{ accountId: "a", ownerUserId: "u", messageId: invalid.id, threadId: invalid.threadId, lifecycleState: "new", title: "event", whyThisMatters: "reason", sourceMessage: invalid }];
  f.reminders = [{ accountId: "a", threadId: invalid.threadId, status: "resurfaced", sourceMessage: invalid }];
  expect(() => buildSummary(f, now)).not.toThrow();
  const result = buildSummary(f, now);
  expect(result.needsYou.map(i => i.source.messageId)).toEqual(["valid"]);
  expect(result.waitingOn).toEqual([]);
});
