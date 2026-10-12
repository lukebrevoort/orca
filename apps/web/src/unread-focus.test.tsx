import { describe, expect, test } from "bun:test";
import type { InboxMessage } from "@orca/shared";
import { demoMessages } from "./demo-data";
import { getLatestThreadRows, sortMessagesByAttention, mergeMessages } from "./App";

const message = (id: string, day: number, behavior: InboxMessage["attentionBehavior"], unread: boolean, extra: Partial<InboxMessage> = {}): InboxMessage => ({
  ...demoMessages[0]!, id, threadId: id, receivedAt: `2026-10-${String(day).padStart(2, "0")}T12:00:00.000Z`, attentionBehavior: behavior, unread, ...extra,
});
const getInboxTimelineRows = (messages: InboxMessage[]) => sortMessagesByAttention(getLatestThreadRows(messages), {});
const ids = (messages: InboxMessage[]) => messages.map(message => message.id);

describe("unread Focus timeline", () => {
  test("combines unread notify and focus, then interleaves read Focus with normal by date", () => {
    const rows = [message("read-focus", 2, "focus", false), message("notify-old", 1, "notify", true), message("normal-new", 10, "normal", true), message("focus-new", 4, "focus", true), message("read-notify", 3, "notify", false), message("normal-read", 5, "normal", false)];
    expect(ids(getInboxTimelineRows(rows))).toEqual(["focus-new", "notify-old", "normal-new", "normal-read", "read-notify", "read-focus"]);
    expect(rows[0]!.attentionBehavior).toBe("focus");
  });
  test("any unread message promotes the latest row without crossing account boundaries", () => {
    const latest = message("latest-read", 3, "focus", false, { threadId: "thread" });
    const older = message("older-unread", 1, "focus", true, { threadId: "thread" });
    const other = message("other-account", 4, "focus", false, { accountId: "other", threadId: "thread" });
    const normal = message("normal", 5, "normal", true);
    expect(getLatestThreadRows([older, latest, other]).find(row => row.id === latest.id)?.unread).toBe(true);
    const rows = getInboxTimelineRows([older, latest, other, normal]);
    expect(ids(rows)).toEqual(["latest-read", "normal", "other-account"]);
    expect(rows.find(row => row.id === other.id)?.unread).toBe(false);
  });
  test("read, mark-unread and incoming-reply updates reorder a merged paginated source", () => {
    const focus = message("focus", 1, "focus", true);
    const normal = message("normal", 8, "normal", false);
    const pageTwo = message("page-two", 4, "notify", true);
    let source = mergeMessages([normal, focus], [pageTwo]);
    expect(ids(getInboxTimelineRows(source))).toEqual(["page-two", "focus", "normal"]);
    source = mergeMessages(source, [{ ...focus, unread: false }]);
    expect(ids(getInboxTimelineRows(source))).toEqual(["page-two", "normal", "focus"]);
    expect(getInboxTimelineRows(source).at(-1)?.attentionBehavior).toBe("focus");
    source = mergeMessages(source, [{ ...focus, unread: true }]);
    expect(ids(getInboxTimelineRows(source))).toEqual(["page-two", "focus", "normal"]);
    source = mergeMessages(source, [message("reply", 9, "focus", true, { threadId: focus.threadId })]);
    expect(ids(getInboxTimelineRows(source))).toEqual(["reply", "page-two", "normal"]);
  });
  test("ties are deterministic and account-scoped for duplicate provider IDs", () => {
    const a = message("same", 1, "focus", true, { accountId: "a" });
    const b = { ...a, accountId: "b" };
    expect(getInboxTimelineRows([b, a])).toEqual(getInboxTimelineRows([a, b]));
    expect(getInboxTimelineRows([b, a]).map(row => row.accountId)).toEqual(["a", "b"]);
  });
});
