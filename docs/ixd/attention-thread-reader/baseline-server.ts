import { account, inbox, thread } from "./fixture";
import {
  accountFixture,
  authSessionFixture,
  organizationFallbackPlacementFixture,
  organizationLaneConfigurationFixture,
  type OrganizationDescribeResponse,
  type OrganizationQueryResponse,
  type ThreadDetail,
} from "@orca/shared";

const port = 4319;
const selected = inbox.find(row => row.threadId === thread.thread.id)!;
let detailRequests = 0;

function inboxMessages() { return inbox; }

function inboxResponse() {
  const messages = inboxMessages();
  return {
    accounts: [account],
    messages,
    nextCursor: null,
    counts: {
      attention: { focus: 4, normal: 2, quiet: 2, hidden: 2, all: messages.length },
      classification: { likely_human: messages.length, automated_or_bulk: 0, uncertain: 0, unclassified: 0, all: messages.length },
    },
  };
}

function longThreadDetail(): ThreadDetail { return thread; }

const organizationDescribe: OrganizationDescribeResponse = {
  workspaceId: "workspace_reader_design",
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

// Sync and mark-read are acknowledged no-ops. They never change this fixture
// or contact a provider. Every other non-GET request is rejected.
const server = Bun.serve({
  port, hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/v1/sync/gmail" && request.method === "POST") return json({ok:true});
    if (url.pathname.endsWith("/read") && request.method === "PATCH") return new Response(null,{status:204});
    if (request.method !== "GET") return json({error:{code:"synthetic_read_only",message:"Fixture blocks mutations."}},403);
    if (url.pathname === "/v1/destinations") return json({revision:1, fallbackDestinationId:"synthetic-space", legacyDestinationIds:{normal:"synthetic-space"}, destinations:[{id:"synthetic-space",isFallback:true,name:"Everything else",color:"#70867d",position:0,retiredAt:null,revision:1,notificationPreference:"quiet",delivery:"proposal_only",counts:{total:10,unread:5}}]});
    if (url.pathname === "/v1/accounts") return json({items:[account]});
    if (url.pathname === "/v1/organization/views") return json({workspaceId:"workspace_reader_design", workspaceRevision:4, items:[]});
    if (url.pathname === "/v1/organization/collections-pins/query") return json({workspaceId:"workspace_reader_design", accountIds:[account.id], collections:[], pins:[], queries:[]});
    if (url.pathname === "/health") return json({ ok: true });
    if (url.pathname === "/v1/__reader_design/metrics") return json({ detailRequests, syntheticOnly: true });
    if (url.pathname === "/v1/auth/session") return json({...authSessionFixture,user:{id:"synthetic-user",name:account.displayName,email:account.email}});
    if (url.pathname === "/v1/organization/describe") return json(organizationDescribe);
    if (url.pathname === "/v1/organization/query") return json(organizationQuery);
    if (url.pathname === "/v1/me") return json(account);
    if (url.pathname === "/v1/sync/status") return json({
      accounts: [{ ...account, state: "idle", lastSyncedAt: "2026-10-08T17:30:00.000Z", error: null }],
    });
    if (url.pathname === "/v1/inbox") return json(inboxResponse());
    if (url.pathname === `/v1/threads/${encodeURIComponent(selected.threadId)}` && request.method === "GET") {
      detailRequests += 1;
      return json(longThreadDetail());
    }
    if (["/v1/collections", "/v1/pins", "/v1/reminders", "/v1/drafts", "/v1/attention/view-settings", "/v1/agent-event-mutes"].includes(url.pathname)) return json([]);
    if (url.pathname === "/v1/reminders/view-settings") return json({ displayName: "Later" });
    if (url.pathname === "/v1/agent-events") return json({ events: [], nextCursor: null });
    return json({ error: { code: "not_found", message: `${request.method} ${url.pathname}` } }, 404);
  },
});

console.log(`Synthetic long-thread baseline listening on http://localhost:${server.port}`);
console.log(`Reader URL: http://127.0.0.1:4320/?destination=inbox&thread=${encodeURIComponent(selected.threadId)}&accountId=${encodeURIComponent(selected.accountId)}`);
