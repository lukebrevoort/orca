import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ThreadDetail, ThreadDetailMessage } from "@orca/shared";
import { App, MessageReader, applySenderAttention, getMessagesForMailbox, groupThreadMessages, isDevPreviewPath, sortThreadMessages, splitQuotedContent } from "./App";
import { demoMessages } from "./demo-data";

describe("App", () => {
  test("checks for a session before rendering the inbox", () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain("Orca");
    expect(html).toContain("Checking your key.");
    expect(html).not.toContain("Compose");
  });

  test("renders the Gmail OAuth login page on auth routes", () => {
    const originalWindow = globalThis.window;
    const localStorage = new Map<string, string>();

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: {
          assign() {},
          href: "http://localhost:5173/login",
          origin: "http://localhost:5173",
          pathname: "/login",
          search: "",
        },
        localStorage: {
          getItem(key: string) {
            return localStorage.get(key) ?? null;
          },
          setItem(key: string, value: string) {
            localStorage.set(key, value);
          },
          removeItem(key: string) {
            localStorage.delete(key);
          },
          clear() {
            localStorage.clear();
          },
        },
      },
    });

    try {
      const html = renderToStaticMarkup(<App />);

      expect(html).toContain("Make room for the people.");
      expect(html).toContain("Continue with Google");
      expect(html).toContain("What happens next");
    } finally {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: originalWindow,
      });
    }
  });

  test("separates attention treatments into recoverable inbox views", () => {
    expect(getMessagesForMailbox(demoMessages, "inbox")).toHaveLength(5);
    expect(getMessagesForMailbox(demoMessages, "focus")).toHaveLength(3);
    expect(getMessagesForMailbox(demoMessages, "quiet")).toHaveLength(1);
    expect(getMessagesForMailbox(demoMessages, "hidden")).toHaveLength(1);
    expect(getMessagesForMailbox(demoMessages, "all")).toHaveLength(7);
  });

  test("only exposes the fake inbox preview route during development", () => {
    expect(isDevPreviewPath("/dev/inbox", true)).toBe(true);
    expect(isDevPreviewPath("/dev/inbox", false)).toBe(false);
    expect(isDevPreviewPath("/", true)).toBe(false);
  });

  test("applies sender attention to historical and newly synced messages", () => {
    const historical = demoMessages.filter((message) => message.from.email === "maya@example.com");
    const future = { ...historical[0], id: "future", providerMessageId: "future" };
    const all = [...demoMessages, future];

    expect(applySenderAttention(all, { "maya@example.com": "hidden" }).some((message) => message.from.email === "maya@example.com")).toBe(false);
    const quiet = applySenderAttention(all, { "maya@example.com": "quiet" });
    expect(quiet.filter((message) => message.from.email === "maya@example.com").map((message) => message.receivedAt))
      .toEqual([...historical, future].map((message) => message.receivedAt).sort().reverse());
    const priority = applySenderAttention(all, { "maya@example.com": "focus" });
    const lastMaya = priority.map((message) => message.from.email).lastIndexOf("maya@example.com");
    const firstNormal = priority.findIndex((message) => message.attentionBehavior === "normal");
    expect(lastMaya).toBeLessThan(firstNormal);
  });

  test("orders and groups thread messages chronologically", () => {
    const newest = makeThreadMessage("newest", "2026-07-12T18:00:00.000Z");
    const oldest = makeThreadMessage("oldest", "2026-07-11T08:00:00.000Z");
    const middle = makeThreadMessage("middle", "2026-07-12T09:00:00.000Z");

    expect(sortThreadMessages([newest, oldest, middle]).map((message) => message.id)).toEqual(["oldest", "middle", "newest"]);
    const groups = groupThreadMessages([newest, oldest, middle]);
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.messages.map((message) => message.id))).toEqual([["oldest"], ["middle", "newest"]]);
  });

  test("keeps quoted history recoverable behind a closed disclosure", () => {
    const split = splitQuotedContent("Fresh reply\n\nOn Jul 11, Maya wrote:\n> Earlier note");
    expect(split).toEqual({ current: "Fresh reply", quoted: "On Jul 11, Maya wrote:\n> Earlier note" });

    const messages = Array.from({ length: 5 }, (_, index) => makeThreadMessage(
      `message-${index}`,
      `2026-07-${String(8 + index).padStart(2, "0")}T09:00:00.000Z`,
      index === 4,
      index === 3 ? "Fresh reply\n\nOn Jul 10, Maya wrote:\n> Earlier note" : `Message ${index}`,
    ));
    const html = renderToStaticMarkup(
      <MessageReader
        detail={makeThreadDetail(messages)}
        error={null}
        fallbackMessages={[]}
        fallbackTitle="Reader test"
        onAttentionChange={async () => "normal"}
        onBack={() => {}}
        onRetry={() => {}}
        status="ready"
      />,
    );

    expect(html).toContain("Jump to newest unread");
    expect(html).toContain("Unread messages");
    expect(html).toContain("Newest");
    expect(html).toContain("Message details");
    expect(html).toContain("Show quoted history");
    expect(html).toContain("Earlier note");
    expect(html).not.toContain("<details open=\"\"");
    expect(html.indexOf("message-0")).toBeLessThan(html.indexOf("message-4"));
  });
});

function makeThreadMessage(id: string, receivedAt: string, unread = false, bodyText = id): ThreadDetailMessage {
  return {
    id,
    provider: "gmail",
    providerMessageId: `provider-${id}`,
    from: { name: "Maya Chen", email: "maya@example.com" },
    to: [{ name: "Luke Brevoort", email: "luke@example.com" }],
    cc: [],
    bcc: [],
    subject: "Reader test",
    snippet: bodyText,
    receivedAt,
    unread,
    labels: ["INBOX"],
    bodyText,
    bodyHtml: null,
    attachments: [],
  };
}

function makeThreadDetail(messages: ThreadDetailMessage[]): ThreadDetail {
  return {
    account: { id: "account", provider: "gmail", email: "luke@example.com", displayName: "Luke Brevoort" },
    thread: {
      id: "thread",
      provider: "gmail",
      providerThreadId: "provider-thread",
      subject: "Reader test",
      latestReceivedAt: messages[messages.length - 1].receivedAt,
      messageCount: messages.length,
      labels: ["INBOX"],
      participants: [{ name: "Maya Chen", email: "maya@example.com" }],
      readState: messages.some((message) => message.unread) ? "unread" : "read",
      attention: { hasUnread: messages.some((message) => message.unread), hasStarred: false, hasDraft: false, humanSignal: 10 },
    },
    messages,
  };
}
