import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import {
  replyBriefOutputSchema,
  schedulingReplyBriefFixture,
  type CalendarConnection,
  type ReplyBriefOutput,
  type ThreadDetail,
} from "@orca/shared";

import { ReplyBriefPanel } from "./reply-brief";

const detail: ThreadDetail = {
  account: { id: "account-1", provider: "gmail", email: "me@example.com", displayName: "Me", capabilities: { read: true, draft: true, send: true } },
  thread: {
    id: "thread-1",
    provider: "gmail",
    providerThreadId: "provider-thread-1",
    subject: "Project review next week",
    latestReceivedAt: "2026-08-19T17:45:00.000Z",
    messageCount: 1,
    labels: ["INBOX"],
    participants: [{ name: "Maya Chen", email: "maya@example.com" }],
    readState: "read",
    attention: { hasUnread: false, hasStarred: false, hasDraft: false, humanSignal: 9 },
  },
  messages: [{
    id: "message-1",
    accountId: "account-1",
    provider: "gmail",
    providerMessageId: "provider-message-1",
    from: { name: "Maya Chen", email: "maya@example.com" },
    to: [{ name: "Me", email: "me@example.com" }],
    cc: [],
    bcc: [],
    subject: "Project review next week",
    snippet: "Can we meet Friday?",
    bodyText: "Can we meet Friday between 10 and noon Mountain for 30 minutes?",
    bodyHtml: null,
    internetMessageId: "<message-1@example.com>",
    references: [],
    receivedAt: "2026-08-19T17:45:00.000Z",
    unread: false,
    labels: ["INBOX"],
    humanSignal: 9,
    humanClassification: null,
    attachments: [],
  }],
};

const globals = ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "AbortController"] as const;
const originals = new Map(globals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
let browserWindow: InstanceType<typeof Window>;
let root: Root | null;

beforeEach(() => {
  browserWindow = new Window({ url: "http://localhost:5173/?thread=thread-1" });
  const values: Record<string, unknown> = {
    window: browserWindow,
    document: browserWindow.document,
    navigator: browserWindow.navigator,
    HTMLElement: browserWindow.HTMLElement,
    Element: browserWindow.Element,
    Node: browserWindow.Node,
    Event: browserWindow.Event,
    MouseEvent: browserWindow.MouseEvent,
    AbortController: browserWindow.AbortController,
  };
  for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  root = null;
});

afterEach(async () => {
  await act(async () => root?.unmount());
  for (const name of globals) {
    const descriptor = originals.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  delete (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
  browserWindow.close();
});

async function renderPanel(
  loader: (input: Parameters<NonNullable<ComponentProps<typeof ReplyBriefPanel>["loader"]>>[0]) => Promise<ReplyBriefOutput>,
  connectionLoader: NonNullable<ComponentProps<typeof ReplyBriefPanel>["connectionLoader"]> = async () => [],
  minimumLoadingMs = 0,
) {
  const container = browserWindow.document.createElement("div");
  const composer = browserWindow.document.createElement("textarea");
  composer.setAttribute("aria-label", "Human response");
  container.append(composer);
  browserWindow.document.body.append(container);
  root = createRoot(container as unknown as Element);
  await act(async () => root!.render(<ReplyBriefPanel connectionLoader={connectionLoader} detail={detail} loader={loader} minimumLoadingMs={minimumLoadingMs} />));
  return { container, composer };
}

function button(label: string) {
  const match = [...browserWindow.document.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Button not found: ${label}`);
  return match as unknown as HTMLButtonElement;
}

async function click(label: string) {
  await act(async () => button(label).click());
}

describe("ReplyBriefPanel", () => {
  test("generates only after explicit invocation and leaves the human composer blank", async () => {
    let calls = 0;
    const { composer } = await renderPanel(async () => {
      calls += 1;
      return schedulingReplyBriefFixture;
    });

    expect(calls).toBe(0);
    expect(composer.value).toBe("");
    expect(browserWindow.document.body.textContent).toContain("Get reply guidance");

    await click("Get reply guidance");

    expect(calls).toBe(1);
    expect(composer.value).toBe("");
    expect(browserWindow.document.body.textContent).toContain("Reply Brief");
    expect(browserWindow.document.body.textContent).toContain("Your call");
    expect(browserWindow.document.body.textContent).toContain("Free/busy checked");
    expect(browserWindow.document.body.textContent).toContain("Guidance, not a draft");
    expect(browserWindow.document.body.textContent).not.toContain("Tuesday works for me");

    await click("Refresh");
    expect(calls).toBe(2);
    expect(composer.value).toBe("");

    await click("Dismiss");
    expect(composer.value).toBe("");
    expect(browserWindow.document.body.textContent).toContain("Get reply guidance");
  });

  test("keeps a perceivable loading phase when loaders resolve immediately", async () => {
    await renderPanel(async () => schedulingReplyBriefFixture, async () => [], 40);

    await click("Get reply guidance");
    expect(browserWindow.document.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(browserWindow.document.body.textContent).toContain("Building a short brief");
    expect(browserWindow.document.querySelector('[aria-label="Reply Brief"]')).toBeNull();

    await act(async () => await new Promise((resolve) => setTimeout(resolve, 55)));
    expect(browserWindow.document.querySelector('[aria-busy="true"]')).toBeNull();
    expect(browserWindow.document.querySelector('[aria-label="Reply Brief"]')).not.toBeNull();
  });

  test("keeps the ready brief short and decision-led", async () => {
    await renderPanel(async () => schedulingReplyBriefFixture);
    await click("Get reply guidance");

    expect(browserWindow.document.querySelectorAll(".reply-brief-section .reply-brief-claims > li")).toHaveLength(3);
    expect(browserWindow.document.body.textContent).toContain("Which available time, if any, works for the recipient?");
    expect(browserWindow.document.body.textContent).not.toContain("The preferred meeting platform is unknown");
    expect(browserWindow.document.body.textContent).not.toContain("Acknowledge the scheduling request");
    expect(browserWindow.document.body.textContent).not.toContain(schedulingReplyBriefFixture.confidence.rationale);
    expect(browserWindow.document.querySelector(".reply-brief-sources")?.hasAttribute("open")).toBe(false);
    expect(browserWindow.document.body.textContent).toContain("Your reply stays blank and yours");
  });

  test("requires an explicit choice when multiple calendar connections are available", async () => {
    const connections: CalendarConnection[] = [
      { id: "calendar-personal", provider: "google", accountLabel: "personal@example.com", state: "connected", grantedScopes: ["calendar.freebusy"], connectedAt: "2026-08-19T16:00:00.000Z", error: null },
      { id: "calendar-work", provider: "google", accountLabel: "work@example.com", state: "connected", grantedScopes: ["calendar.freebusy"], connectedAt: "2026-08-20T16:00:00.000Z", error: null },
    ];
    const selected: Array<string | null> = [];
    await renderPanel(async (input) => {
      selected.push(input.calendarConnectionId);
      return schedulingReplyBriefFixture;
    }, async () => connections);

    await click("Get reply guidance");
    expect(selected).toEqual([]);
    expect(browserWindow.document.body.textContent).toContain("Which calendar account should this brief check?");
    const work = [...browserWindow.document.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes("work@example.com"));
    if (!work) throw new Error("work calendar choice was not rendered");
    await act(async () => (work as unknown as HTMLButtonElement).click());

    expect(selected).toEqual(["calendar-work"]);
    expect(browserWindow.document.body.textContent).toContain("Reply Brief");
  });

  test("never renders a non-HTTP source URL as a link", async () => {
    const unsafeBrief = {
      ...schedulingReplyBriefFixture,
      sourceRefs: schedulingReplyBriefFixture.sourceRefs.map((source, index) => index === 0 ? { ...source, sourceUrl: "javascript:alert(document.cookie)" } : source),
    } as ReplyBriefOutput;
    await renderPanel(async () => unsafeBrief);
    await click("Get reply guidance");

    expect(browserWindow.document.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(browserWindow.document.querySelectorAll(".reply-brief-source-label").length).toBeGreaterThan(0);
  });

  test("keeps a stable loading state and aborts it when dismissed", async () => {
    const captured: { signal?: AbortSignal } = {};
    await renderPanel((input) => {
      captured.signal = input.signal;
      return new Promise(() => {});
    });

    await click("Get reply guidance");
    expect(browserWindow.document.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(browserWindow.document.body.textContent).toContain("Building a short brief");

    await click("Dismiss");
    expect(captured.signal?.aborted).toBe(true);
    expect(browserWindow.document.body.textContent).toContain("Get reply guidance");
  });

  test("renders model failure with deterministic facts and no response prose", async () => {
    const unavailable = replyBriefOutputSchema.parse({
      ...schedulingReplyBriefFixture,
      status: "unavailable",
      unavailableReason: "model_unavailable",
      statusDetail: "Interpretation failed; deterministic facts remain visible.",
      intent: null,
      considerations: [],
      confidence: { level: "unknown", rationale: "No interpretation runtime was available." },
    });
    await renderPanel(async () => unavailable);
    await click("Get reply guidance");

    expect(browserWindow.document.body.textContent).toContain("Interpretation unavailable");
    expect(browserWindow.document.body.textContent).toContain("30-minute duration");
    expect(browserWindow.document.body.textContent).not.toContain("Nothing was added");
  });

  test("shows permission failure as unavailable without converting it into a recommendation", async () => {
    const permissionFailure = replyBriefOutputSchema.parse({
      ...schedulingReplyBriefFixture,
      status: "partial",
      statusDetail: "Calendar access is not authorized. Orca cannot check availability.",
      availabilityContext: { status: "unavailable", timeZone: null, windowStart: null, windowEnd: null, busy: [], sourceRefs: [] },
      considerations: schedulingReplyBriefFixture.considerations.filter((item) => !item.text.includes("available window")),
    });
    await renderPanel(async () => permissionFailure);
    await click("Get reply guidance");

    expect(browserWindow.document.body.textContent).toContain("Unavailable");
    expect(browserWindow.document.body.textContent).toContain("Unavailable; no time was inferred");
    expect(browserWindow.document.body.textContent).not.toContain("Choose an available window");
  });

  test("labels stale context and exposes a retryable request error", async () => {
    const stale = replyBriefOutputSchema.parse({
      ...schedulingReplyBriefFixture,
      freshness: { ...schedulingReplyBriefFixture.freshness, generatedAt: "2026-08-20T18:01:00.000Z", status: "stale", statusDetail: "The selected source is more than 24 hours old." },
    });
    let calls = 0;
    await renderPanel(async () => {
      calls += 1;
      if (calls === 1) throw new Error("The selected source could not be checked.");
      return stale;
    });

    await click("Get reply guidance");
    expect(browserWindow.document.body.textContent).toContain("Guidance unavailable");
    expect(browserWindow.document.body.textContent).toContain("Nothing was added to your composer");
    await click("Try again");
    expect(browserWindow.document.body.textContent).toContain("Freshness · stale");
    expect(browserWindow.document.querySelector(".reply-brief-stale")).not.toBeNull();
  });

  test("uses theme-safe labeled controls in light and dark modes", () => {
    const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    const controls = css.slice(css.indexOf(".reply-brief-invitation"), css.indexOf(".reader-end"));
    expect(controls).toContain("background: var(--orca-surface-hover)");
    expect(controls).toContain("border: 1px solid var(--orca-border)");
    expect(controls).toContain("color: var(--orca-ink)");
    expect(controls).not.toContain("background: var(--orca-ink)");
  });
});
