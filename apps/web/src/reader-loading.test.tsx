import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { accountFixture, inboxFixture, type ThreadDetail } from "@orca/shared";
import { MessageReader } from "./App";

function renderLoading(count: number, title: string | null = "A known subject") {
  return renderToStaticMarkup(<MessageReader detail={null} error={null}
    fallbackMessages={Array.from({ length: count }, (_, index) => ({ ...inboxFixture[0]!, id: `preview-${index}` }))}
    fallbackTitle={title} status="loading" onBack={() => {}} onRetry={() => {}}
    onAttentionChange={async () => "normal"} />);
}

test("unknown loading conversation does not invent a subject or message count", () => {
  const html = renderLoading(0, null);
  expect(html).toContain('id="reader-title">Loading conversation</h1>');
  expect(html).toContain('class="reader-kicker">Opening conversation</p>');
  expect(html).toContain('class="visually-hidden">Loading conversation</span>');
  expect(html).not.toContain("1 messages");
  expect(html).not.toContain("(no subject)");
  expect(html).toContain('aria-busy="true"');
});

test("known title stays visible even without a message preview", () => {
  expect(renderLoading(0)).toContain('id="reader-title">A known subject</h1>');
});

for (const count of [1, 2]) test(`${count} loading previews retain count and body preview`, () => {
  const html = renderLoading(count);
  expect(html).toContain(`Opening conversation · ${count} ${count === 1 ? "message" : "messages"}`);
  expect(html).toContain(`Loading ${count} message conversation`);
  expect(html).toContain("Fetching the full conversation");
  expect(html).toContain('id="reader-title">A known subject</h1>');
});

test("known subjectless preview remains distinguishable from unknown subject", () => {
  expect(renderLoading(1, "(no subject)")).toContain('id="reader-title">(no subject)</h1>');
});


test("a loaded subjectless conversation keeps its subjectless heading", () => {
  const source = inboxFixture[0]!;
  const detail: ThreadDetail = {
    account: accountFixture,
    thread: { id: source.threadId, provider: "gmail", providerThreadId: "synthetic-thread", subject: "", latestReceivedAt: source.receivedAt, messageCount: 1, labels: [], participants: [], readState: "read", attention: { hasUnread: false, hasStarred: false, hasDraft: false, humanSignal: 0 } },
    messages: [{ ...source, subject: "", accountId: accountFixture.id, to: [], cc: [], bcc: [], bodyText: "Synthetic subjectless message", bodyHtml: null, internetMessageId: null, references: [], attachments: [] }],
  };
  const html = renderToStaticMarkup(<MessageReader detail={detail} error={null}
    fallbackMessages={[]} fallbackTitle={null} status="ready" onBack={() => {}}
    onRetry={() => {}} onAttentionChange={async () => "normal"} />);
  expect(html).toContain("(no subject)</h1>");
  expect(html).not.toContain("Loading conversation");
});
