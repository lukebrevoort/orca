import {
  accountFixture,
  authSessionFixture,
  inboxFixture,
  organizationFallbackPlacementFixture,
  organizationLaneConfigurationFixture,
  type InboxMessage,
  type OrganizationDescribeResponse,
  type OrganizationQueryResponse,
  type ThreadDetail,
} from "@orca/shared";

const port = 3000;
const refreshDelayMs = 5_500;
const selected = inboxFixture[0]!;
const unrelated: InboxMessage = {
  ...selected,
  id: "msg_bre377_unrelated",
  providerMessageId: "gmail_msg_bre377_unrelated",
  threadId: "thread_bre377_unrelated",
  from: { name: "Harbor Team", email: "harbor@example.com" },
  subject: "Unrelated mailbox row",
  snippet: "This row changes during background refresh; the open Reader does not.",
  receivedAt: "2026-06-29T17:30:00.000Z",
  unread: false,
};

let refreshGeneration = 0;
let detailRequests = 0;

function inboxMessages() {
  return [
    { ...selected },
    {
      ...unrelated,
      subject: refreshGeneration > 0 ? "Unrelated mailbox row — refreshed" : unrelated.subject,
    },
  ];
}

function inboxResponse() {
  const messages = inboxMessages();
  return {
    accounts: [accountFixture],
    messages,
    nextCursor: null,
    counts: {
      attention: { focus: 0, normal: messages.length, quiet: 0, hidden: 0, all: messages.length },
      classification: { likely_human: messages.length, automated_or_bulk: 0, uncertain: 0, unclassified: 0, all: messages.length },
    },
  };
}

function longThreadDetail(): ThreadDetail {
  const paragraphs = [
    "The Reader should remain a calm document even while fresh mail arrives behind it.",
    "This deliberately long conversation makes browser scroll clamping observable if loaded content is ever replaced by the short loading skeleton.",
    "Background mailbox work may replace list arrays, but that is not a navigation event and must not replay route entrance motion.",
    "Only a meaningful version change inside this active thread should refresh its detail, and that refresh must keep the document mounted.",
  ];
  const messages = Array.from({ length: 9 }, (_, index) => ({
    id: `msg_bre377_reader_${index + 1}`,
    accountId: accountFixture.id,
    provider: "gmail" as const,
    providerMessageId: `gmail_msg_bre377_reader_${index + 1}`,
    from: index % 2 === 0 ? selected.from : { name: accountFixture.displayName, email: accountFixture.email },
    to: index % 2 === 0 ? [{ name: accountFixture.displayName, email: accountFixture.email }] : [selected.from],
    cc: [],
    bcc: [],
    subject: selected.subject,
    snippet: paragraphs[index % paragraphs.length]!,
    bodyText: Array.from({ length: 5 }, (_, paragraphIndex) => `${paragraphs[(index + paragraphIndex) % paragraphs.length]} Passage ${index + 1}.${paragraphIndex + 1}.`).join("\n\n"),
    bodyHtml: null,
    internetMessageId: `<bre377-${index + 1}@example.com>`,
    references: index === 0 ? [] : [`<bre377-${index}@example.com>`],
    receivedAt: new Date(Date.UTC(2026, 5, 20 + index, 17, 30)).toISOString(),
    unread: index === 8,
    labels: ["INBOX"],
    humanSignal: 9,
    humanClassification: selected.humanClassification,
    attachments: [],
  }));
  return {
    account: accountFixture,
    thread: {
      id: selected.threadId,
      provider: "gmail",
      providerThreadId: `provider-${selected.threadId}`,
      subject: selected.subject,
      latestReceivedAt: messages[messages.length - 1]!.receivedAt,
      messageCount: messages.length,
      labels: ["INBOX"],
      participants: [selected.from, { name: accountFixture.displayName, email: accountFixture.email }],
      readState: "unread",
      attention: { hasUnread: true, hasStarred: false, hasDraft: false, humanSignal: 9 },
    },
    messages,
  };
}

const organizationDescribe: OrganizationDescribeResponse = {
  workspaceId: "workspace_bre377",
  accountIds: [accountFixture.id],
  workspaceRevision: organizationLaneConfigurationFixture.workspaceRevision,
  workspaceSchema: {
    revision: 4,
    aggregate: "thread",
    resources: ["account", "thread", "lane", "lane_policy", "facet", "workflow_state", "context", "context_relationship"],
    filters: ["account", "thread", "attention", "classification", "sender", "text", "received_at", "facet", "workflow_state", "context", "context_relationship", "lane"],
  },
  laneConfiguration: organizationLaneConfigurationFixture,
  capabilities: {
    operations: { describe: true, query: true, simulate: false, apply: false, revert: false },
    authority: { sendMail: false, deleteProviderMail: false },
    surfaces: {
      rest: { describe: true, query: true, simulate: false, apply: true, revert: false, correct: false },
      mcp: { describe: false, query: false, simulate: false, apply: false, revert: false, correct: false },
    },
  },
};

const organizationQuery: OrganizationQueryResponse = {
  workspaceId: organizationDescribe.workspaceId,
  accountIds: organizationDescribe.accountIds,
  threads: [{
    id: selected.threadId,
    accountId: selected.accountId,
    subject: selected.subject,
    latestReceivedAt: selected.receivedAt,
    messageCount: 1,
    readState: selected.unread ? "unread" : "read",
    organization: {
      attentionBehavior: selected.attentionBehavior,
      humanSignal: selected.humanSignal,
      humanClassification: selected.humanClassification,
      lanePlacement: { ...organizationFallbackPlacementFixture, accountId: selected.accountId, threadId: selected.threadId },
    },
    messages: [{
      id: selected.id,
      sourceId: selected.providerMessageId,
      from: selected.from,
      subject: selected.subject,
      snippet: selected.snippet,
      receivedAt: selected.receivedAt,
      unread: selected.unread,
      labels: selected.labels,
      humanSignal: selected.humanSignal,
      humanClassification: selected.humanClassification,
    }],
  }],
  counts: { threads: 1, messages: 1 },
  nextCursor: null,
  laneConfiguration: organizationLaneConfigurationFixture,
};

function json(body: unknown, status = 200) {
  return Response.json(body, { status });
}

const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true });
    if (url.pathname === "/v1/__bre377/metrics") return json({ detailRequests, refreshGeneration, refreshDelayMs });
    if (url.pathname === "/v1/auth/session") return json(authSessionFixture);
    if (url.pathname === "/v1/organization/describe") return json(organizationDescribe);
    if (url.pathname === "/v1/organization/query") return json(organizationQuery);
    if (url.pathname === "/v1/me") return json(accountFixture);
    if (url.pathname === "/v1/sync/status") return json({
      accounts: [{ ...accountFixture, state: "idle", lastSyncedAt: "2026-06-29T17:30:00.000Z", error: null }],
    });
    if (url.pathname === "/v1/sync/gmail" && request.method === "POST") {
      await Bun.sleep(refreshDelayMs);
      refreshGeneration += 1;
      return json({ ok: true });
    }
    if (url.pathname === "/v1/inbox") return json(inboxResponse());
    if (url.pathname === `/v1/threads/${encodeURIComponent(selected.threadId)}` && request.method === "GET") {
      detailRequests += 1;
      return json(longThreadDetail());
    }
    if (url.pathname.endsWith("/read") && request.method === "PATCH") return new Response(null, { status: 204 });
    if (["/v1/collections", "/v1/pins", "/v1/reminders", "/v1/drafts", "/v1/attention/view-settings", "/v1/agent-event-mutes"].includes(url.pathname)) return json([]);
    if (url.pathname === "/v1/reminders/view-settings") return json({ displayName: "Later" });
    if (url.pathname === "/v1/agent-events") return json({ events: [], nextCursor: null });
    return json({ error: { code: "not_found", message: `${request.method} ${url.pathname}` } }, 404);
  },
});

console.log(`BRE-377 deterministic mailbox listening on http://localhost:${server.port}`);
console.log(`Reader URL: http://localhost:5173/?destination=inbox&thread=${encodeURIComponent(selected.threadId)}&accountId=${encodeURIComponent(selected.accountId)}`);
