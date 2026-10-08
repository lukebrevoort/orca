import { describe, expect, test } from "bun:test";
import { threadDetailSchema } from "../../../packages/shared/src/index";
import { inbox, thread } from "./fixture";
import { groupAttention, initialMessage, splitTrailingQuote, decodePreview } from "./model";

describe("synthetic long-thread design contracts", () => {
  test("fixture is wire-valid and includes 24 messages, unread, HTML, attachments and inline answers", () => {
    expect(threadDetailSchema.safeParse(thread).success).toBe(true);
    expect(thread.messages).toHaveLength(24);
    expect(thread.messages.filter(m => m.unread)).toHaveLength(3);
    expect(thread.messages.some(m => m.bodyHtml)).toBe(true);
    expect(thread.messages.some(m => m.attachments.length)).toBe(true);
    expect(thread.messages[11]!.bodyText).toContain("Unique inline answer");
  });
  test("attention precedes dates without changing existing five-state priority", () => {
    const groups = groupAttention([...inbox].reverse());
    expect(groups.map(g => g.behavior)).toEqual(["notify", "focus", "normal", "quiet", "hidden"]);
    expect(groups.every(g => g.messages[0]!.receivedAt >= g.messages[1]!.receivedAt)).toBe(true);
    expect(groups.flatMap(g => g.messages).length).toBe(inbox.length);
  });
  test("first unread wins; otherwise latest; empty has no target; does not mutate read flags", () => {
    const before = JSON.stringify(thread.messages);
    expect(initialMessage(thread.messages)?.id).toBe("synthetic-message-22");
    expect(initialMessage(thread.messages.map(m => ({...m, unread:false})))?.id).toBe("synthetic-message-24");
    expect(initialMessage([])).toBeUndefined();
    expect(JSON.stringify(thread.messages)).toBe(before);
  });
  test("quote folding is lossless and never folds a unique answer after quotes", () => {
    for (const message of thread.messages) {
      const body = message.bodyText!;
      const parts = splitTrailingQuote(body);
      expect(parts.current + parts.quote).toBe(body);
    }
    expect(splitTrailingQuote(thread.messages[11]!.bodyText!).quote).toBe("");
    expect(splitTrailingQuote("Fresh\r\n\r\nOn Monday, Sam wrote:\r\n> old\r\n").quote).toContain("> old");
    expect(splitTrailingQuote("Fresh\n> earlier\nNew answer").quote).toBe("");
    expect(splitTrailingQuote("Forwarded message\nUnique content").quote).toBe("");
  });
  test("preview decoding is bounded and yields text, never markup execution", () => {
    expect(decodePreview("Here&amp;#39;s the update")).toBe("Here's the update");
    expect(decodePreview("&lt;script&gt;literal&lt;/script&gt;")).toBe("<script>literal</script>");
    expect(decodePreview("AT&amp;T")).toBe("AT&T");
  });
});
