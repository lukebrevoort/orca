import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ThreadDetail, ThreadDetailMessage } from "@orca/shared";
import { App, GmailLabelMigrationPage, MessageReader, ReaderPreferencesPage, applySenderAttention, defaultReaderPreferences, getMessagesForMailbox, groupThreadMessages, isDevPreviewPath, readStoredPreferences, shouldShowReaderJumpToTop, sortThreadMessages, splitQuotedContent, syncGmailLabelsUntilReady } from "./App";
import { demoMessages } from "./demo-data";
import { collectComposeContacts, ComposeWorkspace, createEmptyComposeDraft, hasComposeContent, isValidEmail, parseRecipientText, readComposeDraft } from "./compose-workspace";

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

  test("explains the read-only Gmail label migration while it loads", () => {
    const html = renderToStaticMarkup(<GmailLabelMigrationPage mode="settings" setTheme={() => {}} theme="light" />);

    expect(html).toContain("Keep the labels");
    expect(html).toContain("nothing in Gmail is changed");
    expect(html).toContain("Labels are never renamed, removed, or edited");
    expect(html).toContain("Checking your Gmail organization");
  });

  test("defaults reader preferences to OS behavior and safely restores saved choices", () => {
    expect(readStoredPreferences({ getItem: () => null })).toEqual(defaultReaderPreferences);
    expect(readStoredPreferences({ getItem: (key) => key === "orca-theme" ? "dark" : null })).toEqual({ ...defaultReaderPreferences, theme: "dark" });
    expect(readStoredPreferences({ getItem: () => JSON.stringify({ theme: "light", textSize: "large", density: "compact", motion: "reduced", notifyByDefault: true }) })).toEqual({
      theme: "light", textSize: "large", density: "compact", motion: "reduced", notifyByDefault: true,
    });
    expect(readStoredPreferences({ getItem: () => "not-json" })).toEqual(defaultReaderPreferences);
  });

  test("renders accessible reading preference groups with selected labels intact", () => {
    const html = renderToStaticMarkup(<ReaderPreferencesPage preferences={{ ...defaultReaderPreferences, theme: "dark", notifyByDefault: true }} setPreferences={() => {}} systemTheme="light" />);

    expect(html).toContain("Read at");
    expect(html).toContain("System is currently light");
    expect(html).toContain("preference-option preference-option-selected");
    expect(html).toContain("Notify me by default");
    expect(html).toContain("checked=\"\"");
  });

  test("resumes Gmail sync until label migration data is ready", async () => {
    const pending = { status: "pending" as const, ready: false, labels: [], completedAt: null };
    const ready = { ...pending, ready: true };
    const previews = [pending, ready];
    let syncCalls = 0;

    const result = await syncGmailLabelsUntilReady(
      pending,
      async () => { syncCalls += 1; },
      async () => previews.shift() ?? ready,
    );

    expect(syncCalls).toBe(2);
    expect(result.ready).toBe(true);
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
    expect(isDevPreviewPath("/", false, true)).toBe(true);
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

  test("reveals the top jump after meaningful reader scrolling", () => {
    expect(shouldShowReaderJumpToTop(360, 800)).toBe(false);
    expect(shouldShowReaderJumpToTop(361, 800)).toBe(true);
    expect(shouldShowReaderJumpToTop(500, 1400)).toBe(false);
    expect(shouldShowReaderJumpToTop(561, 1400)).toBe(true);
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
    expect(html).toContain("Jump to top");
    expect(html).toContain("reader-jump-top\" hidden=\"\"");
    expect(html).toContain("Unread messages");
    expect(html).toContain("Newest");
    expect(html).toContain("Message details");
    expect(html).toContain("Show quoted history");
    expect(html).toContain("Earlier note");
    expect(html).not.toContain("<details open=\"\"");
    expect(html.indexOf("message-0")).toBeLessThan(html.indexOf("message-4"));
  });

  test("prefers the formatted HTML alternative over plain text", () => {
    const message = { ...makeThreadMessage("formatted", "2026-07-12T18:00:00.000Z", false, "Plain fallback"), bodyHtml: "<h2>Release notes</h2><p>Hello <strong>Luke</strong>.</p>" };
    const html = renderToStaticMarkup(
      <MessageReader
        detail={makeThreadDetail([message])}
        error={null}
        fallbackMessages={[]}
        fallbackTitle="Reader test"
        onAttentionChange={async () => "normal"}
        onBack={() => {}}
        onRetry={() => {}}
        status="ready"
      />,
    );

    expect(html).toContain('class="reader-body reader-body-html"');
    expect(html).toContain("<h2>Release notes</h2>");
    expect(html).toContain("<strong>Luke</strong>");
    expect(html).not.toContain("Plain fallback");
  });

  test("targets Attention at the sender shown in the newest reader message", () => {
    const older = makeThreadMessage("older", "2026-07-11T08:00:00.000Z");
    const newest = {
      ...makeThreadMessage("newest", "2026-07-12T18:00:00.000Z"),
      from: { name: "Anika Lee", email: "anika@example.com" },
    };
    const html = renderToStaticMarkup(
      <MessageReader
        detail={makeThreadDetail([older, newest])}
        error={null}
        fallbackMessages={[]}
        fallbackTitle="Reader test"
        onAttentionChange={async () => "normal"}
        onBack={() => {}}
        onRetry={() => {}}
        status="ready"
      />,
    );

    expect(html).toContain('aria-label="Manage mail from Anika Lee"');
    expect(html).not.toContain('aria-label="Manage mail from Maya Chen"');
  });

  test("normalizes realistic recipient paste and rejects incomplete addresses", () => {
    expect(parseRecipientText("Maya Chen <MAYA@example.com>, dana@example.com\nno-address")).toEqual([
      { name: "Maya Chen", email: "maya@example.com" },
      { name: null, email: "dana@example.com" },
    ]);
    expect(isValidEmail("anika@example.com")).toBe(true);
    expect(isValidEmail("anika@")).toBe(false);
  });

  test("keeps compose suggestions scoped to people in the active account inbox", () => {
    expect(collectComposeContacts(demoMessages, "luke@example.com").map((contact) => contact.email)).toEqual([
      "anika@example.com",
      "dana@example.com",
      "alerts@harborbank.example",
      "maya@example.com",
      "family@example.com",
      "digest@dispatch.example",
    ]);
  });

  test("restores a durable compose draft and falls back safely when storage is corrupt", () => {
    const draft = { ...createEmptyComposeDraft("account"), subject: "A durable thought", body: "Hello Maya" };
    const storage = { getItem: () => JSON.stringify(draft) };
    expect(readComposeDraft("account", storage)).toMatchObject({ subject: "A durable thought", body: "Hello Maya" });
    expect(hasComposeContent(readComposeDraft("account", storage))).toBe(true);
    expect(readComposeDraft("account", { getItem: () => "not-json" })).toMatchObject({ accountId: "account", subject: "", body: "" });
  });

  test("renders the write-first controls, delivery explanation, and labeled saved state", () => {
    const draft = { ...createEmptyComposeDraft("account"), to: [{ name: "Maya Chen", email: "maya@example.com" }], subject: "Launch notes", body: "A human note." };
    const html = renderToStaticMarkup(
      <ComposeWorkspace
        contacts={[{ name: "Maya Chen", email: "maya@example.com" }]}
        controller={{ draft, saveStatus: "saved", hasContent: true, updateDraft() {}, discardDraft() {} }}
      />,
    );
    expect(html).toContain("Write first. Send when it’s ready.");
    expect(html).toContain("Saved on this device");
    expect(html).toContain("Plain text · type / for structure");
    expect(html).toContain("Gmail send access");
    expect(html).toContain("disabled=\"\"");
    expect(html).toContain("Remove Maya Chen from To");
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
