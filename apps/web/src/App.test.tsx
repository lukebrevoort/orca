import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { MailAccount, MessageDraft, Pin, ThreadDetail, ThreadDetailMessage } from "@orca/shared";
import { m5InboxFixture } from "@orca/shared";
import { ApiRequestError, App, GmailAccountSettingsList, GmailConnectionSettingsPage, GmailLabelMigrationPage, MessageReader, ReaderPreferencesPage, SettingsHome, WelcomeOrientationPage, applySenderAttention, buildGmailAuthorizationRequestPath, buildGmailLabelMigrationPath, buildPinnedPeopleFromPins, buildReaderActionDraft, buildReminderSaveRequest, buildThreadDetailRequest, defaultReaderPreferences, getLatestThreadRows, getMessagesForMailbox, getReplyRecipient, getSelectedThreadAccountId, getStreamMessages, getStreamSectionLabel, groupThreadMessages, isDevPreviewPath, isSessionUnauthorizedError, normalizeForwardSubject, normalizeReplySubject, readStoredPreferences, shouldShowReaderJumpToTop, sortThreadMessages, splitQuotedContent, syncGmailLabelsUntilReady, withGmailAccountId } from "./App";
import { ClassificationCorrection, ClassificationTabs, classificationExplanation } from "./classification-ui";
import { demoMessages } from "./demo-data";
import { collectComposeContacts, ComposeWorkspace, createEmptyComposeDraft, deliverDurableDraft, hasComposeContent, isValidEmail, markdownToEditorHtml, parseRecipientText, readComposeDraft, acceptComposeFiles, sanitizeAttachmentFilename, COMPOSE_AUTOSAVE_DELAY_MS, MAX_COMPOSE_ATTACHMENT_BYTES, MAX_COMPOSE_ATTACHMENTS } from "./compose-workspace";

describe("App", () => {
  test("checks for a session before rendering the inbox", () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain("Orca");
    expect(html).toContain("Checking your key.");
    expect(html).not.toContain("Compose");
  });

  test("keeps provider authorization failures separate from expired Orca sessions", () => {
    expect(isSessionUnauthorizedError(new ApiRequestError(401, "Gmail needs to be reconnected", "provider_auth_error"))).toBe(false);
    expect(isSessionUnauthorizedError(new ApiRequestError(401, "Authentication required", "unauthorized"))).toBe(true);
  });

  test("renders the Gmail and Outlook OAuth choices on auth routes", () => {
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

      expect(html).toContain("Make room for <em>the people.</em>");
      expect(html).toContain("Continue with Google");
      expect(html).toContain("Continue with Outlook");
      expect(html).toContain("Outlook setup guide");
      expect(html).toContain("What happens next");
    } finally {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: originalWindow,
      });
    }
  });

  test("explains the read-only Gmail label migration while it loads", () => {
    const html = renderToStaticMarkup(<GmailLabelMigrationPage setTheme={() => {}} theme="light" />);

    expect(html).toContain("Keep the labels");
    expect(html).toContain("nothing in Gmail is changed");
    expect(html).toContain("Labels are never renamed, removed, or edited");
    expect(html).toContain("Checking your Gmail organization");
  });

  test("keeps adding another Gmail account discoverable in connection settings", () => {
    const html = renderToStaticMarkup(<GmailConnectionSettingsPage setTheme={() => {}} theme="light" />);
    expect(html).toContain("Add Gmail account");
  });

  test("renders scoped capability, reconnect, and label-import controls for every Gmail account", () => {
    const accounts: MailAccount[] = [
      { id: "gmail_personal", provider: "gmail", email: "luke.personal@gmail.com", displayName: "Luke Personal", capabilities: { read: true, draft: false, send: false } },
      { id: "gmail_work", provider: "gmail", email: "luke@work.example", displayName: "Luke Work", capabilities: { read: true, draft: true, send: true } },
    ];
    const html = renderToStaticMarkup(
      <GmailAccountSettingsList
        accounts={accounts}
        authorization={{ accountId: null, status: "idle", errorMessage: null }}
        onAuthorize={() => {}}
      />,
    );

    expect(html).toContain('data-account-id="gmail_personal"');
    expect(html).toContain('data-account-id="gmail_work"');
    expect(html).toContain("luke.personal@gmail.com");
    expect(html).toContain("luke@work.example");
    expect(html).toContain('aria-label="Enable drafts and sending for luke.personal@gmail.com"');
    expect(html).toContain('aria-label="Reconnect Gmail for luke.personal@gmail.com"');
    expect(html).toContain('aria-label="Reconnect Gmail for luke@work.example"');
    expect(html).toContain('href="/settings/integrations/gmail/labels?accountId=gmail_personal"');
    expect(html).toContain('href="/settings/integrations/gmail/labels?accountId=gmail_work"');
    expect(html).not.toContain("/v1/accounts/gmail_personal");
  });

  test("keeps stacked Gmail actions on existing account-aware routes", () => {
    const returnTo = "http://localhost:5173/settings/integrations/gmail";

    expect(buildGmailAuthorizationRequestPath("upgrade", returnTo, "gmail_work")).toBe(
      "/v1/auth/gmail/upgrade?returnTo=http%3A%2F%2Flocalhost%3A5173%2Fsettings%2Fintegrations%2Fgmail&accountId=gmail_work",
    );
    expect(buildGmailAuthorizationRequestPath("connect", returnTo, "gmail_personal")).toBe(
      "/v1/auth/gmail/connect?returnTo=http%3A%2F%2Flocalhost%3A5173%2Fsettings%2Fintegrations%2Fgmail&accountId=gmail_personal",
    );
    expect(buildGmailLabelMigrationPath("gmail_personal")).toBe("/settings/integrations/gmail/labels?accountId=gmail_personal");
    expect(withGmailAccountId("/v1/gmail-label-migration/import", "gmail_work")).toBe("/v1/gmail-label-migration/import?accountId=gmail_work");
    expect(withGmailAccountId("/v1/gmail-label-migration", null)).toBe("/v1/gmail-label-migration");
  });

  test("orients new users without making Gmail labels part of sign-in", () => {
    const html = renderToStaticMarkup(<WelcomeOrientationPage setTheme={() => {}} theme="light" />);

    expect(html).toContain("Welcome to a");
    expect(html).toContain("Open my inbox");
    expect(html).toContain("Import Gmail labels from Settings");
    expect(html).not.toContain("Checking your Gmail organization");
    expect(html).not.toContain("Import selected");
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

  test("gives every settings category a discoverable home and preserves legacy destinations", () => {
    const html = renderToStaticMarkup(<SettingsHome demoMode preferences={defaultReaderPreferences} setPreferences={() => {}} setTheme={() => {}} systemTheme="light" theme="light" />);

    expect(html).toContain("Make Orca");
    expect(html).toContain("Appearance &amp; reading");
    expect(html).toContain("Inbox &amp; attention");
    expect(html).toContain("/settings/attention-views");
    expect(html).toContain("/settings/integrations/gmail");
    expect(html).toContain("Add Microsoft Outlook");
    expect(html).toContain("Connect Outlook");
    expect(html).toContain("Writing");
    expect(html).toContain("Privacy &amp; data");
    expect(html).toContain("Save account choices");
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
    expect(getMessagesForMailbox(demoMessages, "inbox")).toHaveLength(7);
    expect(getMessagesForMailbox(demoMessages, "focus")).toHaveLength(4);
    expect(getMessagesForMailbox(demoMessages, "quiet")).toHaveLength(1);
    expect(getMessagesForMailbox(demoMessages, "hidden")).toHaveLength(1);
    expect(getMessagesForMailbox(demoMessages, "all")).toHaveLength(9);
  });

  test("keeps classification filtering server-owned and searches the rendered stream", () => {
    const lowSignal = { ...demoMessages[0]!, id: "low", providerMessageId: "low", threadId: "low", humanSignal: 2 };
    const unknownSignal = { ...demoMessages[1]!, id: "unknown", providerMessageId: "unknown", threadId: "unknown", humanSignal: null, subject: "A singular lighthouse note" };
    const hidden = { ...demoMessages[3]!, id: "hidden", providerMessageId: "hidden", threadId: "hidden", attentionBehavior: "hidden" as const };

    expect(getStreamMessages([lowSignal, unknownSignal, hidden], "inbox").map((message) => message.id)).toEqual(["low", "unknown", "hidden"]);
    expect(getStreamMessages([lowSignal, unknownSignal, hidden], "hidden").map((message) => message.id)).toEqual(["low", "unknown", "hidden"]);
    expect(getStreamMessages([lowSignal, unknownSignal, hidden], "all", "lighthouse").map((message) => message.id)).toEqual(["unknown"]);
    expect(getStreamMessages([lowSignal, unknownSignal, hidden], "collection")).toHaveLength(3);
  });

  test("renders all M5 classification views and keeps corrections account-scoped", () => {
    const counts = { likely_human: 5, automated_or_bulk: 3, uncertain: 2, unclassified: 1, all: 10 } as const;
    const review = m5InboxFixture.filter((message) => ["uncertain", "unclassified"].includes(message.humanClassification?.effective.classification ?? ""));
    const human = m5InboxFixture.filter((message) => message.humanClassification?.effective.classification === "likely_human");
    const override = m5InboxFixture.find((message) => message.id === "m5_gmail_override")!;
    const tabs = renderToStaticMarkup(<ClassificationTabs active="uncertain" counts={counts} onChange={() => {}} />);
    const correction = renderToStaticMarkup(<ClassificationCorrection message={override} onCorrect={async () => {}} />);

    expect(human).toHaveLength(5);
    expect(review.map((message) => message.id)).toEqual(["m5_gmail_ambiguous", "m5_outlook_unknown"]);
    expect(new Set(m5InboxFixture.map((message) => message.accountId))).toEqual(new Set(["acct_m5_gmail", "acct_m5_outlook"]));
    expect(tabs).toContain('aria-label="Inbox classification views"');
    expect(tabs).toContain('aria-selected="true"');
    expect(tabs).toContain("Human Inbox");
    expect(tabs).toContain("Tideline");
    expect(tabs).toContain("Review");
    expect(tabs).toContain("All mail");
    expect(correction).toContain("Correct classification: Likely human");
    expect(correction).toContain("You");
    expect(classificationExplanation(override)).toContain("Your correction");
    expect(override.accountId).toBe("acct_m5_gmail");
  });

  test("uses the latest message as the mixed-thread row while retaining both classes", () => {
    const mixed = demoMessages.filter((message) => message.threadId === "thread_7");
    expect(getLatestThreadRows(mixed).map((message) => message.id)).toEqual(["msg_7_mixed_human"]);
    expect(mixed.find((message) => message.id === "msg_7_mixed_automated")?.humanClassification?.effective.classification).toBe("automated_or_bulk");
  });

  test("groups stream rows by local calendar date instead of read state", () => {
    const now = new Date(2026, 7, 8, 12);
    expect(getStreamSectionLabel(new Date(2026, 7, 8, 8).toISOString(), now)).toBe("Today");
    expect(getStreamSectionLabel(new Date(2026, 7, 7, 23).toISOString(), now)).toBe("Yesterday");
    expect(getStreamSectionLabel(new Date(2026, 7, 3, 8).toISOString(), now)).toBe("Earlier this week");
    expect(getStreamSectionLabel(new Date(2026, 6, 1, 8).toISOString(), now)).toBe("Older");
  });

  test("updates a resurfaced reminder in place when it is snoozed again", () => {
    const input = { threadId: "thread-1", scheduledFor: "2026-08-09T16:00:00.000Z", timezone: "America/Los_Angeles", notify: true };
    const resurfaced = {
      id: "reminder-resurfaced",
      accountId: "account-1",
      ...input,
      scheduledFor: "2026-08-08T16:00:00.000Z",
      status: "resurfaced" as const,
      resurfacedAt: "2026-08-08T16:00:00.000Z",
      completedAt: null,
      cancelledAt: null,
      createdAt: "2026-08-01T16:00:00.000Z",
      updatedAt: "2026-08-08T16:00:00.000Z",
    };

    expect(buildReminderSaveRequest(input, resurfaced)).toEqual({
      path: "/v1/reminders/reminder-resurfaced",
      method: "PATCH",
      body: { scheduledFor: input.scheduledFor, timezone: input.timezone, notify: true },
    });
    expect(buildReminderSaveRequest(input)).toEqual({ path: "/v1/reminders", method: "POST", body: input });
  });

  test("derives pinned people only from persisted sender pins", () => {
    const pins: Pin[] = [
      { id: "thread", accountId: "account", kind: "thread", targetId: demoMessages[0]!.threadId, label: "Thread", position: 0, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z" },
      { id: "anika", accountId: "account", kind: "sender", targetId: "anika@example.com", label: "Pinned Anika", position: 2, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z" },
      { id: "maya", accountId: "account", kind: "sender", targetId: "maya@example.com", label: "Pinned Maya", position: 1, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z" },
    ];
    const people = buildPinnedPeopleFromPins(pins, demoMessages);

    expect(people.map((person) => person.filterValue)).toEqual(["maya@example.com", "anika@example.com"]);
    expect(people.map((person) => person.name)).toEqual(["Maya Chen", "Anika Lee"]);
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

  test("scopes thread-detail requests to the selected message account", () => {
    const secondaryMessage = {
      ...demoMessages[0]!,
      id: "secondary-message",
      accountId: "acct_secondary",
      threadId: "secondary-thread",
    };

    expect(getSelectedThreadAccountId([secondaryMessage], secondaryMessage.threadId, null)).toBe("acct_secondary");
    expect(buildThreadDetailRequest(secondaryMessage)).toBe("/v1/threads/secondary-thread?accountId=acct_secondary");
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
    expect(html).toContain("Continue the conversation");
    expect(html).toContain(">Reply</button>");
    expect(html).toContain(">Reply all</button>");
    expect(html).toContain(">Forward</button>");
    expect(html).toContain("Earlier note");
    expect(html).not.toContain("<details open=\"\"");
    expect(html.indexOf("message-0")).toBeLessThan(html.indexOf("message-4"));
  });

  test("keeps the unread divider from colliding with the date heading", () => {
    const readOlder = makeThreadMessage("read-older", "2026-07-10T09:00:00.000Z", false, "Read older");
    const readSameDay = makeThreadMessage("read-same-day", "2026-07-11T09:00:00.000Z", false, "Read same day");
    const unreadNextDay = makeThreadMessage("unread-next-day", "2026-07-12T09:00:00.000Z", true, "Unread next day");
    const html = renderToStaticMarkup(
      <MessageReader
        detail={makeThreadDetail([readOlder, readSameDay, unreadNextDay])}
        error={null}
        fallbackMessages={[]}
        fallbackTitle="Reader test"
        onAttentionChange={async () => "normal"}
        onBack={() => {}}
        onRetry={() => {}}
        status="ready"
      />,
    );
    expect(html).toContain("reader-unread-divider reader-unread-divider-first");
    expect(html).toContain("Unread messages");

    const unreadSameDay = makeThreadMessage("unread-same-day", "2026-07-11T12:00:00.000Z", true, "Unread same day");
    const html2 = renderToStaticMarkup(
      <MessageReader
        detail={makeThreadDetail([readOlder, readSameDay, unreadSameDay])}
        error={null}
        fallbackMessages={[]}
        fallbackTitle="Reader test"
        onAttentionChange={async () => "normal"}
        onBack={() => {}}
        onRetry={() => {}}
        status="ready"
      />,
    );
    expect(html2).toContain("Unread messages");
    expect(html2).not.toContain("reader-unread-divider-first");
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

  test("keeps Attention available for every sender shown in the reader", () => {
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
    expect(html).toContain('aria-label="Manage mail from Maya Chen"');
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
      "digest@events.example",
      "alerts@harborbank.example",
      "jordan@example.com",
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
    expect(COMPOSE_AUTOSAVE_DELAY_MS).toBeGreaterThanOrEqual(300);
    expect(COMPOSE_AUTOSAVE_DELAY_MS).toBeLessThanOrEqual(500);
  });

  test("retries a response-lost delivery without patching or changing its idempotency key", async () => {
    const content = {
      to: [{ name: "Maya", email: "maya@example.com" }],
      cc: [],
      bcc: [],
      subject: "Re: Reader notes",
      body: { text: "Only once", html: "<p>Only once</p>" },
      context: null,
      attachments: [],
    };
    let server: MessageDraft = {
      id: "draft-1",
      accountId: "account",
      ...content,
      revision: 0,
      deliveryStatus: "draft",
      providerSyncStatus: "synced",
      providerSyncError: null,
      providerDraftId: "gmail-draft-1",
      providerMessageId: null,
      providerThreadId: null,
      createdAt: "2026-07-29T00:00:00.000Z",
      updatedAt: "2026-07-29T00:00:00.000Z",
    };
    let loseImmediateStatus = true;
    let sendCalls = 0;
    let updateCalls = 0;
    const keys: string[] = [];
    const operations = {
      async inspect() {
        if (sendCalls === 1 && loseImmediateStatus) {
          loseImmediateStatus = false;
          throw new Error("status response lost");
        }
        return server;
      },
      async create() {
        throw new Error("must reuse the existing draft");
      },
      async update(_draftId: string, revision: number) {
        updateCalls += 1;
        server = { ...server, revision: revision + 1 };
        return server;
      },
      async send(_draftId: string, _revision: number, idempotencyKey: string) {
        sendCalls += 1;
        keys.push(idempotencyKey);
        if (sendCalls === 1) {
          server = { ...server, deliveryStatus: "ambiguous" };
          throw new Error("send response lost");
        }
        server = { ...server, deliveryStatus: "sent", providerMessageId: "gmail-sent-1" };
        return { draftId: server.id, status: "sent" as const, providerMessageId: server.providerMessageId, providerThreadId: server.providerThreadId, error: null };
      },
    };
    const input = { serverId: server.id, revision: server.revision, content, idempotencyKeyFor: () => "stable-send-key" };

    await expect(deliverDurableDraft(input, operations)).rejects.toThrow("send response lost");
    const retry = await deliverDurableDraft(input, operations);

    expect(retry.result.status).toBe("sent");
    expect(updateCalls).toBe(1);
    expect(sendCalls).toBe(2);
    expect(keys).toEqual(["stable-send-key", "stable-send-key"]);
  });

  test("renders the write-first controls, delivery explanation, and labeled saved state", () => {
    const draft = { ...createEmptyComposeDraft("account"), to: [{ name: "Maya Chen", email: "maya@example.com" }], subject: "Launch notes", body: "A human note." };
    const html = renderToStaticMarkup(
      <ComposeWorkspace
        contacts={[{ name: "Maya Chen", email: "maya@example.com" }]}
        controller={{ draft, saveStatus: "saved", hasContent: true, updateDraft() {}, attachFiles: () => ({ accepted: [], rejected: [] }), removeAttachment() {}, discardDraft() {} }}
        onRequestSendAccess={() => {}}
      />,
    );
    expect(html).toContain("compose-workspace-intro");
    expect(html).toContain("Saved on this device");
    expect(html).toContain("Add Cc or Bcc");
    expect(html).toContain("This account is read-only. Enable Gmail compose access before Orca can create drafts or send mail.");
    expect(html).toContain("Type / for structure · drop anywhere to attach");
    expect(html).toContain("Enable Gmail compose access");
    expect(html).toContain("Enable sending");
    expect(html).toContain("aria-label=\"Attach files\"");
    expect(html).not.toContain("Attachments");
    expect(html).not.toContain("class=\"compose-send\" disabled");
    expect(html).toContain("Remove Maya Chen from To");
  });

  test("offers a deterministic, labeled recovery choice for stale drafts", () => {
    const local = { ...createEmptyComposeDraft("account"), id: "draft-1", revision: 1, body: "My unsaved ending" };
    const server = {
      id: "draft-1",
      accountId: "account",
      to: [],
      cc: [],
      bcc: [],
      subject: "",
      body: { text: "The newer saved ending", html: null },
      context: null,
      attachments: [],
      revision: 2,
      deliveryStatus: "draft" as const,
      providerSyncStatus: "synced" as const,
      providerSyncError: null,
      providerDraftId: "gmail-draft-1",
      providerMessageId: null,
      providerThreadId: null,
      createdAt: "2026-07-28T18:00:00.000Z",
      updatedAt: "2026-07-28T18:02:00.000Z",
    };
    const html = renderToStaticMarkup(
      <ComposeWorkspace
        contacts={[]}
        controller={{
          draft: local,
          saveStatus: "failed",
          saveMessage: "Another version was saved — choose which one to keep",
          conflict: { local, server },
          hasContent: true,
          updateDraft() {},
          attachFiles: () => ({ accepted: [], rejected: [] }),
          removeAttachment() {},
          discardDraft() {},
        }}
      />,
    );
    expect(html).toContain("This draft changed in another tab.");
    expect(html).toContain("Your words are still safe on this device.");
    expect(html).toContain("Use newer version");
    expect(html).toContain("Keep mine as a new draft");
    expect(html).toContain(">Retry</button>");
  });

  test("sanitizes attachment names and enforces safe compose attachment limits", () => {
    const urls: string[] = [];
    const createObjectUrl = () => {
      const url = `blob:preview-${urls.length}`;
      urls.push(url);
      return url;
    };
    expect(sanitizeAttachmentFilename("../../secret\\notes.pdf")).toBe("notes.pdf");
    expect(sanitizeAttachmentFilename("")).toBe("attachment");

    const image = new File([new Uint8Array(12)], "photo.png", { type: "image/png" });
    const pdf = new File([new Uint8Array(24)], "brief.pdf", { type: "application/pdf" });
    const empty = new File([], "empty.txt", { type: "text/plain" });
    const huge = { name: "huge.bin", type: "application/octet-stream", size: MAX_COMPOSE_ATTACHMENT_BYTES + 1 } as File;

    const acceptedBatch = acceptComposeFiles([], [image, pdf], createObjectUrl);
    expect(acceptedBatch.accepted).toHaveLength(2);
    expect(acceptedBatch.accepted[0]).toMatchObject({ filename: "photo.png", mimeType: "image/png", size: 12, previewUrl: "blob:preview-0", file: image });
    expect(acceptedBatch.accepted[1]).toMatchObject({ filename: "brief.pdf", mimeType: "application/pdf", size: 24, previewUrl: null, file: pdf });
    expect(acceptedBatch.accepted[1]!.file).toBe(pdf);
    expect(acceptedBatch.rejected).toEqual([]);

    const rejectedBatch = acceptComposeFiles(acceptedBatch.accepted, [empty, huge], createObjectUrl);
    expect(rejectedBatch.accepted).toEqual([]);
    expect(rejectedBatch.rejected.map((item) => item.filename)).toEqual(["empty.txt", "huge.bin"]);

    const filled = Array.from({ length: MAX_COMPOSE_ATTACHMENTS }, (_, index) => ({
      id: `file-${index}`,
      filename: `file-${index}.txt`,
      mimeType: "text/plain",
      size: 1,
      file: new File([new Uint8Array(1)], `file-${index}.txt`, { type: "text/plain" }),
      previewUrl: null,
    }));
    const overCount = acceptComposeFiles(filled, [new File([new Uint8Array(1)], "one-more.txt", { type: "text/plain" })], createObjectUrl);
    expect(overCount.accepted).toEqual([]);
    expect(overCount.rejected[0]?.reason).toContain("25");
  });

  test("treats draft attachments as content and never restores binary attachments from storage", () => {
    const withAttachment = {
      ...createEmptyComposeDraft("account"),
      attachments: [{ id: "a1", filename: "notes.pdf", mimeType: "application/pdf", size: 12, file: new File([new Uint8Array(12)], "notes.pdf", { type: "application/pdf" }), previewUrl: null }],
    };
    expect(hasComposeContent(withAttachment)).toBe(true);
    const storage = {
      getItem: () => JSON.stringify({
        ...withAttachment,
        attachments: [{ id: "a1", filename: "notes.pdf", mimeType: "application/pdf", size: 12, previewUrl: "blob:should-not-restore" }],
      }),
    };
    expect(readComposeDraft("account", storage).attachments).toEqual([]);
  });

  test("renders attachment chips with labeled remove controls only when files are present", () => {
    const noopController = { updateDraft() {}, attachFiles: () => ({ accepted: [], rejected: [] }), removeAttachment() {}, discardDraft() {} };
    const emptyHtml = renderToStaticMarkup(
      <ComposeWorkspace
        contacts={[]}
        controller={{ draft: createEmptyComposeDraft("account"), saveStatus: "saved", hasContent: false, ...noopController }}
      />,
    );
    expect(emptyHtml).not.toContain("compose-attachment-chips");
    expect(emptyHtml).not.toContain("0 B of 25.0 MB");
    expect(emptyHtml).toContain("Saved on this device");

    const sketch = new File([new Uint8Array(8)], "sketch.png", { type: "image/png" });
    const notes = new File([new Uint8Array(16)], "notes.pdf", { type: "application/pdf" });
    const draft = {
      ...createEmptyComposeDraft("account"),
      attachments: [
        { id: "img", filename: "sketch.png", mimeType: "image/png", size: 2048, file: sketch, previewUrl: "blob:sketch" },
        { id: "pdf", filename: "notes.pdf", mimeType: "application/pdf", size: 4096, file: notes, previewUrl: null },
      ],
    };
    const html = renderToStaticMarkup(
      <ComposeWorkspace
        contacts={[]}
        controller={{ draft, saveStatus: "saved", hasContent: true, ...noopController }}
      />,
    );
    expect(html).toContain("2 attachments");
    expect(html).toContain("sketch.png");
    expect(html).toContain("notes.pdf");
    expect(html).toContain("src=\"blob:sketch\"");
    expect(html).toContain("Remove sketch.png");
    expect(html).toContain("Remove notes.pdf");
    expect(html).toContain("Text saved · attachments stay until you close this tab");
    expect(html).not.toContain("Saved on this device");
    expect(renderToStaticMarkup(
      <ComposeWorkspace
        contacts={[]}
        controller={{
          draft: { ...createEmptyComposeDraft("account"), attachments: [draft.attachments[0]!] },
          saveStatus: "saved",
          hasContent: true,
          ...noopController,
        }}
      />,
    )).toContain("1 attachment");
  });

  test("renders supported Markdown as semantic writing blocks", () => {
    const html = markdownToEditorHtml("## Direction\n\nA **human** note with _care_.\n- First thought\n- Second thought\n> Keep this\n---");
    expect(html).toContain("<h2>Direction</h2>");
    expect(html).toContain("<strong>human</strong>");
    expect(html).toContain("<em>care</em>");
    expect(html).toContain("<ul><li>First thought</li><li>Second thought</li></ul>");
    expect(html).toContain("<blockquote>Keep this</blockquote>");
    expect(html).toContain("<hr>");
  });

  test("targets replies at the newest external sender and preserves an existing Re prefix", () => {
    const detail = makeThreadDetail([
      makeThreadMessage("maya", "2026-07-12T18:00:00.000Z"),
      { ...makeThreadMessage("anika", "2026-07-12T18:30:00.000Z"), from: { name: "Anika Lee", email: "anika@example.com" } },
      { ...makeThreadMessage("outgoing", "2026-07-12T19:00:00.000Z"), from: { name: "Luke Brevoort", email: "luke@example.com" } },
    ]);
    detail.thread.participants = [{ name: "Maya Chen", email: "maya@example.com" }, { name: "Anika Lee", email: "anika@example.com" }];
    expect(getReplyRecipient(detail, detail.messages[2])).toEqual({ name: "Anika Lee", email: "anika@example.com" });
    expect(normalizeReplySubject("Reader test")).toBe("Re: Reader test");
    expect(normalizeReplySubject("Re: Reader test")).toBe("Re: Reader test");
  });

  test("builds standards-aware reply-all and forward drafts", () => {
    const message = {
      ...makeThreadMessage("group", "2026-07-12T18:00:00.000Z"),
      to: [
        { name: "Luke Brevoort", email: "luke@example.com" },
        { name: "Dana Kim", email: "dana@example.com" },
        { name: "Maya duplicate", email: "MAYA@example.com" },
      ],
      cc: [
        { name: "Anika Lee", email: "anika@example.com" },
        { name: "Dana duplicate", email: "DANA@example.com" },
      ],
      references: ["<older@example.com>"],
      attachments: [{ id: "notes", filename: "notes.pdf", mimeType: "application/pdf", size: 42 }],
    };
    const detail = makeThreadDetail([message]);
    const replyAll = buildReaderActionDraft(detail, message, "reply_all");
    expect(replyAll.to.map((recipient) => recipient.email.toLowerCase())).toEqual(["maya@example.com", "dana@example.com"]);
    expect(replyAll.cc.map((recipient) => recipient.email)).toEqual(["anika@example.com"]);
    expect(replyAll.context).toMatchObject({ kind: "reply_all", providerThreadId: "provider-thread", inReplyTo: "<group@example.com>" });

    const forward = buildReaderActionDraft(detail, message, "forward");
    expect(forward.to).toEqual([]);
    expect(forward.subject).toBe("Fwd: Reader test");
    expect(forward.body).toContain("---------- Forwarded message ----------");
    expect(forward.body).toContain("Original attachments (not included automatically): notes.pdf");
    expect(normalizeForwardSubject("Fwd: Existing")).toBe("Fwd: Existing");
  });

  test("treats a SENT alias as owned when choosing reply recipients", () => {
    const message = {
      ...makeThreadMessage("alias-sent", "2026-07-12T18:00:00.000Z"),
      from: { name: "Luke at Work", email: "luke+work@example.com" },
      to: [
        { name: "Maya Chen", email: "maya@example.com" },
        { name: "Luke Brevoort", email: "luke@example.com" },
      ],
      cc: [{ name: "Luke alias", email: "LUKE+WORK@example.com" }],
      labels: ["SENT"],
    };
    const detail = makeThreadDetail([message]);

    expect(buildReaderActionDraft(detail, message, "reply").to.map((recipient) => recipient.email)).toEqual(["maya@example.com"]);
    expect(buildReaderActionDraft(detail, message, "reply_all").to.map((recipient) => recipient.email)).toEqual(["maya@example.com"]);
    expect(buildReaderActionDraft(detail, message, "reply_all").cc).toEqual([]);
  });
});

function makeThreadMessage(id: string, receivedAt: string, unread = false, bodyText = id): ThreadDetailMessage {
  return {
    id,
    accountId: "account",
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
    humanSignal: 10,
    humanClassification: null,
    bodyText,
    bodyHtml: null,
    internetMessageId: `<${id}@example.com>`,
    references: [],
    attachments: [],
  };
}

function makeThreadDetail(messages: ThreadDetailMessage[]): ThreadDetail {
  return {
    account: { id: "account", provider: "gmail", email: "luke@example.com", displayName: "Luke Brevoort", capabilities: { read: true, draft: false, send: false } },
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
