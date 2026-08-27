import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, test } from "bun:test";
import { eq } from "drizzle-orm";
import { serve } from "@hono/node-server";
import { jwtVerify, SignJWT } from "jose";
import { OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import {
  propagatedAgentEventSchema,
  organizationFallbackPlacementFixture,
  organizationLaneConfigurationFixture,
  type AgentEventListPage,
  type McpQueryOrganizationInput,
  type OrganizationDescribeResponse,
  type OrganizationQueryResponse,
  type OrcaMcpScope,
  type PropagatedAgentEvent,
} from "@orca/shared";

import { createDatabaseClient } from "../db/client.ts";
import { emails, mcpConnectionAccounts, mcpConnections, mcpOAuthClients, mcpOrganizationApprovals, oauthAccounts, organizationChangeSets, organizationLanePolicies, organizationLanes, organizationMutationAttempts, organizationRuleSets, organizationThreadStates, organizationWorkspaceStates, senderAttentionRules, threads, users } from "../db/schema.ts";
import { createSession } from "../auth/session-store.ts";
import { createApp } from "../index.ts";
import { orcaAgentAuthorizationContextSchema } from "./authorization.ts";
import { createOrcaMcpHttpHandler, type OrcaMcpDataSource } from "./mcp.ts";
import { getOAuthScopeForResourceScope, mapOAuthScopesToResourceScopes, type OrcaMcpTokenVerifier } from "./access-token.ts";

const issuer = "https://identity.orca.test";
const resource = "https://api.orca.test/mcp";
const signingSecret = "test-mcp-signing-secret-that-is-long-enough";
const allScopes: OrcaMcpScope[] = [
  "orca:mail.metadata:read",
  "orca:mail.content:read",
  "orca:agent-events:read",
  "orca:connection-status:read",
  "orca:organization:control",
];
const oauthScopes = ["mail:read", "agent_events:read", "organization:control"];
const tempDirs: string[] = [];

async function signToken(input: {
  userId?: string;
  accountIds?: string[];
  scopes?: string[];
  issuer?: string;
  audience?: string;
  issuedAt?: number;
  expiresAt?: number;
} = {}) {
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({
    account_ids: input.accountIds ?? ["account_a"],
    scope: (input.scopes ?? allScopes).join(" "),
    client_id: "https://chatgpt.com/oauth/client.json",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(input.issuer ?? issuer)
    .setAudience(input.audience ?? resource)
    .setSubject(input.userId ?? "user_a")
    .setIssuedAt(input.issuedAt ?? now)
    .setExpirationTime(input.expiresAt ?? now + 600)
    .sign(new TextEncoder().encode(signingSecret));
}

function createTestTokenVerifier(policy: { issuer: string; resource: string }): OrcaMcpTokenVerifier {
  return {
    async verifyAccessToken(token) {
      try {
        const { payload } = await jwtVerify(token, new TextEncoder().encode(signingSecret), {
          algorithms: ["HS256"], issuer: policy.issuer, audience: policy.resource,
        });
        const scopes = typeof payload.scope === "string" ? payload.scope.split(/\s+/).filter(Boolean) : [];
        const publicScopes = [...new Set(scopes.map((scope) => getOAuthScopeForResourceScope(scope as OrcaMcpScope)))];
        const accountIds = Array.isArray(payload.account_ids) ? payload.account_ids : [];
        const authorization = orcaAgentAuthorizationContextSchema.parse({
          connectionId: "connection_a",
          clientId: String(payload.client_id),
          userId: payload.sub,
          accountIds,
          issuer: payload.iss,
          resource: policy.resource,
          scopes,
          issuedAt: new Date(Number(payload.iat) * 1_000),
          expiresAt: new Date(Number(payload.exp) * 1_000),
        });
        return {
          token,
          clientId: String(payload.client_id),
          scopes: publicScopes,
          expiresAt: payload.exp,
          resource: new URL(policy.resource),
          extra: { orcaAuthorization: authorization, grantRevokedAt: null },
        };
      } catch {
        throw new OAuthError(OAuthErrorCode.InvalidToken, "The access token is invalid or expired");
      }
    },
  };
}

function rpc(method: string, params?: unknown, id = 1) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
}

async function callMcp(
  app: ReturnType<typeof createApp>,
  token: string | null,
  method: string,
  params?: unknown,
  headers: Record<string, string> = {},
) {
  const response = await app.request("/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      host: new URL(resource).host,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: rpc(method, params),
  });
  return response;
}

async function rpcBody(response: Response) {
  const text = await response.text();
  if (response.headers.get("content-type")?.includes("application/json")) return JSON.parse(text);
  const data = text.split(/\r?\n/).find((line) => line.startsWith("data: "))?.slice(6);
  if (!data) throw new Error(`MCP response did not contain a JSON or SSE result: ${text.slice(0, 120)}`);
  return JSON.parse(data);
}

const organizationDescribeFixture: OrganizationDescribeResponse = {
  workspaceId: "user_a",
  accountIds: ["account_a"],
  workspaceRevision: 4,
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
  },
};

const organizationQueryFixture: OrganizationQueryResponse = {
  workspaceId: "user_a",
  accountIds: ["account_a"],
  threads: [{
    id: "thread_a",
    accountId: "account_a",
    subject: "Safe",
    latestReceivedAt: "2026-08-19T16:00:00.000Z",
    messageCount: 1,
    readState: "unread",
    organization: { attentionBehavior: "normal", humanSignal: 8, humanClassification: null, lanePlacement: { ...organizationFallbackPlacementFixture, accountId: "account_a", threadId: "thread_a" } },
    messages: [{
      id: "message_a",
      sourceId: "source_a",
      from: { name: "Ada", email: "ada@example.com" },
      subject: "Safe",
      snippet: "Safe",
      receivedAt: "2026-08-19T16:00:00.000Z",
      unread: true,
      labels: [],
      humanSignal: 8,
      humanClassification: null,
    }],
  }],
  counts: { threads: 1, messages: 1 },
  nextCursor: null,
  laneConfiguration: organizationLaneConfigurationFixture,
};

function createProjectionTestHandler(
  describeOutput: OrganizationDescribeResponse,
  queryOutput: OrganizationQueryResponse,
  onQuery?: (query: McpQueryOrganizationInput) => void,
) {
  const unavailable = () => { throw new Error("not used by this projection test"); };
  const dataSource: OrcaMcpDataSource = {
    getCurrentAccountIds: () => ["account_a"],
    describeOrganization: () => describeOutput,
    queryOrganization: ({ query }) => {
      onQuery?.(query);
      return queryOutput;
    },
    simulateOrganization: unavailable,
    applyOrganization: unavailable,
    revertOrganization: unavailable,
    searchMail: unavailable,
    getThread: unavailable,
    listAgentEvents: unavailable,
    getConnectionStatus: unavailable,
    sourceUrl: () => "https://orca.test/",
  };
  return createOrcaMcpHttpHandler({
    dataSource,
    policy: { enabled: true, issuer, resource },
    verifier: createTestTokenVerifier({ issuer, resource }),
    env: { ORCA_M6_MCP_ALLOWED_ORIGINS: "https://chatgpt.com" },
  });
}

async function callProjectionHandler(
  handler: ReturnType<typeof createProjectionTestHandler>,
  token: string,
  name: "describe_organization" | "query_organization",
  args: Record<string, unknown> = {},
) {
  return handler.fetch(new Request(resource, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      host: new URL(resource).host,
    },
    body: rpc("tools/call", { name, arguments: { workspaceId: "user_a", accountIds: ["account_a"], expectedWorkspaceRevision: name === "describe_organization" ? 4 : organizationQueryFixture.laneConfiguration.workspaceRevision, ...args } }),
  }));
}

function createFixture(options: {
  mcpBoundaryPolicy?: { enabled: true; issuer: string; resource: string };
  mcpEnv?: NodeJS.ProcessEnv;
  beforeMutationTransaction?: (db: ReturnType<typeof createDatabaseClient>["db"]) => void;
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "orca-mcp-"));
  tempDirs.push(directory);
  const dbPath = join(directory, "mcp.sqlite");
  const { db, sqlite } = createDatabaseClient(dbPath);
  migrate(db, { migrationsFolder: resolve(import.meta.dir, "../../drizzle") });

  db.insert(users).values([
    { id: "user_a", email: "a@example.com", displayName: "User A" },
    { id: "user_b", email: "b@example.com", displayName: "User B" },
  ]).run();
  db.insert(oauthAccounts).values([
    {
      id: "account_a", userId: "user_a", provider: "gmail", providerEmail: "a@gmail.com", providerId: "provider-a",
      scope: "https://www.googleapis.com/auth/gmail.readonly", accessTokenEncrypted: "provider-access-a", refreshTokenEncrypted: "provider-refresh-a",
      lastSyncedAt: new Date("2026-08-19T17:00:00.000Z"), createdAt: new Date(1),
    },
    {
      id: "account_b", userId: "user_b", provider: "gmail", providerEmail: "b@gmail.com", providerId: "provider-b",
      scope: "https://www.googleapis.com/auth/gmail.readonly", accessTokenEncrypted: "provider-access-b", refreshTokenEncrypted: "provider-refresh-b",
      lastSyncedAt: new Date("2026-08-19T17:05:00.000Z"), createdAt: new Date(2),
    },
  ]).run();
  db.insert(mcpOAuthClients).values({
    id: "https://chatgpt.com/oauth/client.json",
    name: "ChatGPT or Codex",
    redirectUris: "[]",
  }).run();
  db.insert(mcpConnections).values({
    id: "connection_a",
    userId: "user_a",
    clientId: "https://chatgpt.com/oauth/client.json",
    resource,
    scopes: oauthScopes.join(" "),
  }).run();
  db.insert(mcpConnectionAccounts).values({
    id: "connection_account_a",
    connectionId: "connection_a",
    accountId: "account_a",
  }).run();
  db.insert(threads).values([
    { id: "thread_a_1", accountId: "account_a", providerThreadId: "provider-thread-a-1", subject: "Launch review", latestReceivedAt: new Date("2026-08-19T16:00:00.000Z"), messageCount: 1 },
    { id: "thread_a_2", accountId: "account_a", providerThreadId: "provider-thread-a-2", subject: "Build failed", latestReceivedAt: new Date("2026-08-19T15:00:00.000Z"), messageCount: 1 },
    { id: "thread_b", accountId: "account_b", providerThreadId: "provider-thread-b", subject: "Private B", latestReceivedAt: new Date("2026-08-19T17:00:00.000Z"), messageCount: 1 },
  ]).run();
  db.insert(emails).values([
    {
      id: "message_a_1", accountId: "account_a", threadId: "thread_a_1", providerMessageId: "provider-message-a-1",
      fromAddress: "maya@example.com", fromName: "Maya", toRecipients: JSON.stringify([{ name: "User A", email: "a@example.com" }]),
      subject: "Launch review", snippet: "Review the release", bodyText: "Please review. Authorization: Bearer super-secret-token-value",
      receivedAt: new Date("2026-08-19T16:00:00.000Z"), humanSignal: 9, humanClassification: "likely_human",
      humanClassificationReasons: JSON.stringify(["direct_recipient"]), humanClassifierVersion: "m5-v1",
    },
    {
      id: "message_a_2", accountId: "account_a", threadId: "thread_a_2", providerMessageId: "provider-message-a-2",
      fromAddress: "ci@example.dev", fromName: "CI", subject: "Build failed", snippet: "Main is red", bodyText: "The deploy failed.",
      receivedAt: new Date("2026-08-19T15:00:00.000Z"), humanSignal: 2, humanClassification: "automated_or_bulk",
      humanClassificationReasons: JSON.stringify(["auto_submitted_header"]), humanClassifierVersion: "m5-v1",
    },
    {
      id: "message_b", accountId: "account_b", threadId: "thread_b", providerMessageId: "provider-message-b",
      fromAddress: "private@example.com", fromName: "Private B", subject: "Private B", snippet: "Never disclose", bodyText: "private body",
      receivedAt: new Date("2026-08-19T17:00:00.000Z"), humanSignal: 8, humanClassification: "likely_human",
      humanClassificationReasons: JSON.stringify(["direct_recipient"]), humanClassifierVersion: "m5-v1",
    },
  ]).run();
  db.insert(senderAttentionRules).values({
    id: "focus-a", accountId: "account_a", scope: "address", value: "maya@example.com", behavior: "focus", source: "user_choice",
  }).run();

  const events: PropagatedAgentEvent[] = [
    propagatedAgentEventSchema.parse({
      id: "event_a",
      source: {
        ownerUserId: "user_a", accountId: "account_a", provider: "gmail", messageId: "message_a_2", providerMessageId: "provider-message-a-2", threadId: "thread_a_2",
        sender: { name: "CI", email: "ci@example.dev" }, subject: "Build failed", receivedAt: "2026-08-19T15:00:00.000Z",
        sourceUrl: "https://evil.invalid/unrelated?thread=wrong&accountId=account_b&token=provider-secret",
      },
      provenance: { trigger: "push", policyVersion: "m6-v0", agentId: "orca-deterministic-propagator", agentVersion: "0.1.0", executionMode: "deterministic" },
      eventKind: "ci_or_deploy_failure", importance: "high", relevance: "matched", destination: "timeline", reasonCodes: ["workflow_failed"],
      title: "The main build failed", summary: "CI reports a failed build.", whyThisMatters: "The release is blocked.", suggestedNextStep: "Open the source message.",
      humanClassification: { classification: "automated_or_bulk", score: 2, reasonCodes: ["auto_submitted_header"], classifierVersion: "m5-v1", source: "automatic_heuristic" },
      deduplicationKey: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", evaluatedAt: "2026-08-19T15:00:01.000Z",
      lifecycle: { state: "new", lastTransition: "created", revision: 1, createdAt: "2026-08-19T15:00:01.000Z", updatedAt: "2026-08-19T15:00:01.000Z", lastTransitionAt: "2026-08-19T15:00:01.000Z", seenAt: null, snoozedUntil: null },
    }),
    propagatedAgentEventSchema.parse({
      id: "event_a_missing_account",
      source: {
        ownerUserId: "user_a", accountId: "account_a", provider: "gmail", messageId: "message_a_1", providerMessageId: "provider-message-a-1", threadId: "thread_a_1",
        sender: { name: "Maya", email: "maya@example.com" }, subject: "Launch review", receivedAt: "2026-08-19T16:00:00.000Z",
        sourceUrl: "https://elsewhere.invalid/no-account?thread=wrong",
      },
      provenance: { trigger: "sync", policyVersion: "m6-v0", agentId: "orca-deterministic-propagator", agentVersion: "0.1.0", executionMode: "deterministic" },
      eventKind: "release_available", importance: "medium", relevance: "matched", destination: "timeline", reasonCodes: ["release_became_available"],
      title: "Launch review", summary: "The release is ready for review.", whyThisMatters: "The team is waiting.", suggestedNextStep: "Open the source message.",
      humanClassification: { classification: "likely_human", score: 9, reasonCodes: ["direct_recipient"], classifierVersion: "m5-v1", source: "automatic_heuristic" },
      deduplicationKey: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", evaluatedAt: "2026-08-19T16:00:01.000Z",
      lifecycle: { state: "new", lastTransition: "created", revision: 1, createdAt: "2026-08-19T16:00:01.000Z", updatedAt: "2026-08-19T16:00:01.000Z", lastTransitionAt: "2026-08-19T16:00:01.000Z", seenAt: null, snoozedUntil: null },
    }),
    propagatedAgentEventSchema.parse({
      id: "event_b",
      source: {
        ownerUserId: "user_b", accountId: "account_b", provider: "gmail", messageId: "message_b", providerMessageId: "provider-message-b", threadId: "thread_b",
        sender: { name: "Private B", email: "private@example.com" }, subject: "Private B", receivedAt: "2026-08-19T17:00:00.000Z",
        sourceUrl: "https://orca.example/?thread=thread_b",
      },
      provenance: { trigger: "sync", policyVersion: "m6-v0", agentId: "orca-deterministic-propagator", agentVersion: "0.1.0", executionMode: "deterministic" },
      eventKind: "other", importance: "medium", relevance: "matched", destination: "timeline", reasonCodes: ["insufficient_evidence"],
      title: "Private B", summary: "Private B", whyThisMatters: "Private B", suggestedNextStep: null, humanClassification: null,
      deduplicationKey: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", evaluatedAt: "2026-08-19T17:00:01.000Z",
      lifecycle: { state: "new", lastTransition: "created", revision: 1, createdAt: "2026-08-19T17:00:01.000Z", updatedAt: "2026-08-19T17:00:01.000Z", lastTransitionAt: "2026-08-19T17:00:01.000Z", seenAt: null, snoozedUntil: null },
    }),
  ];

  const policy = options.mcpBoundaryPolicy ?? { enabled: true as const, issuer, resource };
  const app = createApp({
    dbFactory: () => {
      const client = createDatabaseClient(dbPath);
      if (options.beforeMutationTransaction) {
        const originalTransaction = client.db.transaction.bind(client.db);
        let fired = false;
        client.db.transaction = ((callback, config) => {
          if (!fired) {
            fired = true;
            options.beforeMutationTransaction!(client.db);
          }
          return originalTransaction(callback, config);
        }) as typeof client.db.transaction;
      }
      return client;
    },
    mcpBoundaryPolicy: policy,
    mcpTokenVerifier: createTestTokenVerifier(policy),
    mcpEnv: options.mcpEnv ?? {
      ORCA_M6_MCP_ALLOWED_ORIGINS: "https://chatgpt.com,http://127.0.0.1:6274",
    },
    agentEventStore: {
      async list(query): Promise<AgentEventListPage> {
        const allowed = new Set(query.accountIds);
        return {
          events: events.filter((event) => event.source.ownerUserId === query.ownerUserId && allowed.has(event.source.accountId)).slice(0, query.limit),
          nextCursor: null,
        };
      },
    },
  });
  return { app, db, sqlite };
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("Orca scoped MCP server", () => {
  test("maps the public OAuth scopes to only their resource capabilities", () => {
    assert.deepEqual(mapOAuthScopesToResourceScopes(["mail:read"]), [
      "orca:mail.metadata:read",
      "orca:mail.content:read",
      "orca:connection-status:read",
    ]);
    assert.deepEqual(mapOAuthScopesToResourceScopes(["agent_events:read"]), ["orca:agent-events:read"]);
  });

  test("requires the enabled resource to receive an OAuth verifier", () => {
    assert.throws(
      () => createOrcaMcpHttpHandler({ dataSource: {} as never, policy: { enabled: true, issuer, resource } }),
      /requires a live OAuth token verifier/,
    );
  });

  test("rejects hostile Host and Origin headers before bearer dispatch", async () => {
    const { app, sqlite } = createFixture();
    try {
      const token = await signToken();
      const hostileHost = await callMcp(app, token, "tools/list", {}, { host: "evil.invalid" });
      assert.equal(hostileHost.status, 403);
      assert.match(await hostileHost.text(), /Invalid Host/);

      const hostileOrigin = await callMcp(app, token, "tools/list", {}, { origin: "https://evil.invalid" });
      assert.equal(hostileOrigin.status, 403);
      assert.match(await hostileOrigin.text(), /Invalid Origin/);

      const allowedOrigin = await callMcp(app, token, "tools/list", {}, { origin: "https://chatgpt.com" });
      assert.equal(allowedOrigin.status, 200);
    } finally {
      sqlite.close();
    }
  });

  test("authenticates then rejects oversized Organization route bodies with typed 413 before route dispatch", async () => {
    const { app, db, sqlite } = createFixture();
    const previousSessionSecret = process.env.SESSION_SECRET;
    const previousTokenEncryptionKey = process.env.TOKEN_ENCRYPTION_KEY;
    try {
      process.env.SESSION_SECRET = "bre-319-route-limit-session-secret";
      process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 31).toString("base64");
      const session = await createSession(db, "user_a");
      const response = await app.request("/v1/organization/apply", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `orca_session=${session.token}` },
        body: JSON.stringify({ source: "x".repeat(512 * 1_024) }),
      });
      assert.equal(response.status, 413);
      assert.deepEqual(await response.json(), {
        error: { code: "payload_limit", message: "The Organization request body exceeds the 512 KiB limit" },
      });
    } finally {
      if (previousSessionSecret === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = previousSessionSecret;
      if (previousTokenEncryptionKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
      else process.env.TOKEN_ENCRYPTION_KEY = previousTokenEncryptionKey;
      sqlite.close();
    }
  });

  test("prevents DNS rebinding against a loopback MCP resource", async () => {
    const loopbackIssuer = "http://127.0.0.1:33165";
    const loopbackResource = `${loopbackIssuer}/mcp`;
    const { app, sqlite } = createFixture({
      mcpBoundaryPolicy: { enabled: true, issuer: loopbackIssuer, resource: loopbackResource },
      mcpEnv: {
        ORCA_M6_MCP_ALLOWED_ORIGINS: "http://127.0.0.1:6274",
      },
    });
    try {
      const token = await signToken({ issuer: loopbackIssuer, audience: loopbackResource });
      const accepted = await callMcp(app, token, "tools/list", {}, {
        host: "127.0.0.1:33165",
        origin: "http://127.0.0.1:6274",
      });
      assert.equal(accepted.status, 200);

      const rebound = await callMcp(app, token, "tools/list", {}, {
        host: "attacker.invalid:33165",
        origin: "http://127.0.0.1:6274",
      });
      assert.equal(rebound.status, 403);
      assert.match(await rebound.text(), /Invalid Host/);
    } finally {
      sqlite.close();
    }
  });

  test("publishes protected-resource metadata and standards-compliant bearer challenges", async () => {
    const { app, sqlite } = createFixture();
    try {
      const metadata = await app.request("/.well-known/oauth-protected-resource/mcp");
      assert.equal(metadata.status, 200);
      assert.deepEqual(await metadata.json(), {
        resource,
        authorization_servers: [issuer],
        scopes_supported: oauthScopes,
        resource_name: "Orca mail and Organization control",
      });

      const missing = await callMcp(app, null, "tools/list", {});
      assert.equal(missing.status, 401);
      assert.match(missing.headers.get("www-authenticate") ?? "", /Bearer/);
      assert.match(missing.headers.get("www-authenticate") ?? "", /resource_metadata="https:\/\/api\.orca\.test\/\.well-known\/oauth-protected-resource\/mcp"/);

      const wrongAudience = await callMcp(app, await signToken({ audience: "https://attacker.example/mcp" }), "tools/list", {});
      assert.equal(wrongAudience.status, 401);
      assert.match(wrongAudience.headers.get("www-authenticate") ?? "", /error="invalid_token"/);

      const now = Math.floor(Date.now() / 1_000);
      const expired = await callMcp(app, await signToken({ issuedAt: now - 100, expiresAt: now - 1 }), "tools/list", {});
      assert.equal(expired.status, 401);
      assert.match(expired.headers.get("www-authenticate") ?? "", /error="invalid_token"/);

      const mailOnly = await signToken({ scopes: ["orca:mail.metadata:read", "orca:mail.content:read", "orca:connection-status:read"] });
      const insufficient = await callMcp(app, mailOnly, "tools/call", { name: "list_agent_events", arguments: {} });
      assert.equal(insufficient.status, 403);
      assert.match(insufficient.headers.get("www-authenticate") ?? "", /error="insufficient_scope"/);
      assert.match(insufficient.headers.get("www-authenticate") ?? "", /scope="agent_events:read"/);
    } finally {
      sqlite.close();
    }
  });

  test("keeps the bearer gate closed through the live Node server adapter", async () => {
    const requestDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Request")!;
    const responseDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Response")!;
    const loopbackIssuer = "http://127.0.0.1";
    const loopbackResource = `${loopbackIssuer}/mcp`;
    const { app, sqlite } = createFixture({
      mcpBoundaryPolicy: { enabled: true, issuer: loopbackIssuer, resource: loopbackResource },
    });
    const server = serve({ fetch: app.fetch, port: 0 });

    try {
      if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: rpc("tools/list"),
      });

      assert.equal(response.status, 401);
      assert.match(response.headers.get("www-authenticate") ?? "", /error="invalid_token"/);
      assert.deepEqual(await response.json(), {
        error: "invalid_token",
        error_description: "Missing Authorization header",
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      Object.defineProperty(globalThis, "Request", requestDescriptor);
      Object.defineProperty(globalThis, "Response", responseDescriptor);
      sqlite.close();
    }
  });

  test("initializes with stable metadata and lists only the bounded annotated tools", async () => {
    const { app, sqlite } = createFixture();
    try {
      const token = await signToken();
      const initialized = await callMcp(app, token, "initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "orca-test", version: "1.0.0" },
      });
      assert.equal(initialized.status, 200);
      const initializeBody = await rpcBody(initialized);
      assert.deepEqual(initializeBody.result.serverInfo, { name: "orca-organization", version: "2.0.0" });

      const tools = await callMcp(app, token, "tools/list", {});
      assert.equal(tools.status, 200);
      const body = await rpcBody(tools);
      assert.ok(body.result, JSON.stringify(body));
      assert.deepEqual(body.result.tools.map((tool: { name: string }) => tool.name), [
        "describe_organization", "query_organization", "simulate_organization", "apply_organization", "revert_organization", "search_mail", "get_thread", "list_agent_events", "get_connection_status",
      ]);
      const toolNames = body.result.tools.map((tool: { name: string }) => tool.name);
      assert.deepEqual(toolNames.filter((name: string) => name.endsWith("_organization")), [
        "describe_organization", "query_organization", "simulate_organization", "apply_organization", "revert_organization",
      ]);
      assert.equal(toolNames.some((name: string) => /send|reply|forward|delete|execute|code/.test(name)), false);
      for (const tool of body.result.tools) {
        assert.deepEqual(tool.annotations, { readOnlyHint: !["apply_organization", "revert_organization"].includes(tool.name), destructiveHint: false, idempotentHint: true, openWorldHint: false });
        assert.equal(tool.inputSchema.type, "object");
        assert.equal(tool.outputSchema.type, "object");
      }
    } finally {
      sqlite.close();
    }
  });

  test("accepts and forwards stable typed Context filters through query_organization", async () => {
    const token = await signToken({ accountIds: ["account_a"] });
    let captured: McpQueryOrganizationInput | undefined;
    const contextFilters = [{
      context: { contextTypeId: "type_project", contextId: "context_orca" },
      relationshipTypeId: "relationship_concerns",
      direction: "thread_to_context" as const,
    }];
    const response = await callProjectionHandler(
      createProjectionTestHandler(organizationDescribeFixture, organizationQueryFixture, (query) => { captured = query; }),
      token,
      "query_organization",
      { contextFilters },
    );
    const body = await rpcBody(response);
    assert.ok(body.result?.structuredContent, JSON.stringify(body));
    assert.deepEqual(captured?.contextFilters, contextFilters);
  });

  test("fails closed when an Organization data source returns cross-scope attribution", async () => {
    const token = await signToken({ accountIds: ["account_a"] });
    const maliciousDescribe = {
      ...organizationDescribeFixture,
      workspaceId: "user_b",
      accountIds: ["account_b"],
    };
    const describe = await callProjectionHandler(
      createProjectionTestHandler(maliciousDescribe, organizationQueryFixture),
      token,
      "describe_organization",
    );
    const describeBody = await rpcBody(describe);
    assert.ok(describeBody.result, JSON.stringify(describeBody));
    assert.equal(describeBody.result.isError, true);
    assert.equal(JSON.parse(describeBody.result.content[0].text).error.code, "account_denied");
    assert.equal(describeBody.result.structuredContent, undefined);

    const crossAccountOverride = {
      id: "override_b",
      accountId: "account_b",
      target: { scope: "message" as const, messageId: "message_a" },
      classification: "likely_human" as const,
      source: "user_choice" as const,
      createdAt: "2026-08-19T16:00:00.000Z",
      updatedAt: "2026-08-19T16:00:00.000Z",
    };
    const classification = {
      automatic: null,
      effective: {
        classification: "likely_human" as const,
        score: 8,
        reasonCodes: ["user_message_override" as const],
        classifierVersion: "user-v1",
        source: "user_override" as const,
        userOverride: crossAccountOverride,
      },
      userOverride: crossAccountOverride,
    };
    const cases: OrganizationQueryResponse[] = [
      { ...organizationQueryFixture, workspaceId: "user_b" },
      { ...organizationQueryFixture, accountIds: ["account_b"] },
      { ...organizationQueryFixture, threads: [{ ...organizationQueryFixture.threads[0]!, accountId: "account_b" }] },
      {
        ...organizationQueryFixture,
        threads: [{
          ...organizationQueryFixture.threads[0]!,
          organization: { ...organizationQueryFixture.threads[0]!.organization, humanClassification: classification },
          messages: [{ ...organizationQueryFixture.threads[0]!.messages[0]!, humanClassification: classification }],
        }],
      },
    ];
    for (const maliciousQuery of cases) {
      const response = await callProjectionHandler(
        createProjectionTestHandler(organizationDescribeFixture, maliciousQuery),
        token,
        "query_organization",
      );
      const body = await rpcBody(response);
      assert.ok(body.result, JSON.stringify(body));
      assert.equal(body.result.isError, true);
      assert.equal(JSON.parse(body.result.content[0].text).error.code, "account_denied");
      assert.equal(body.result.structuredContent, undefined);
    }
  });

  test("keeps every tool and source link inside the live user/account intersection", async () => {
    const { app, sqlite } = createFixture();
    try {
      const token = await signToken({ accountIds: ["account_a", "account_b"] });

      const describe = await callMcp(app, token, "tools/call", {
        name: "describe_organization",
        arguments: { workspaceId: "user_a", accountIds: ["account_a"], expectedWorkspaceRevision: 1 },
      });
      const describeBody = await rpcBody(describe);
      assert.deepEqual(describeBody.result.structuredContent.accountIds, ["account_a"]);
      assert.equal(describeBody.result.structuredContent.workspaceSchema.aggregate, "thread");
      assert.equal(describeBody.result.structuredContent.capabilities.operations.apply, true);
      assert.equal(describeBody.result.structuredContent.capabilities.operations.simulate, true);
      assert.equal(describeBody.result.structuredContent.capabilities.operations.revert, true);
      assert.deepEqual(describeBody.result.structuredContent.collectionsPins.operations, {
        describe: true, query: true, apply: true, revert: true, simulate: false,
      });
      assert.doesNotMatch(JSON.stringify(describeBody), /account_b|gmail|outlook|provider-access|provider-refresh/);

      const deniedDescribe = await callMcp(app, token, "tools/call", {
        name: "describe_organization",
        arguments: { workspaceId: "user_a", accountIds: ["account_b"], expectedWorkspaceRevision: 1 },
      });
      const deniedDescribeBody = await rpcBody(deniedDescribe);
      assert.equal(deniedDescribeBody.result.isError, true);
      assert.equal(JSON.parse(deniedDescribeBody.result.content[0].text).error.code, "account_denied");

      const organizationQuery = await callMcp(app, token, "tools/call", {
        name: "query_organization",
        arguments: { workspaceId: "user_a", accountIds: ["account_a"], expectedWorkspaceRevision: 1, attention: "all", limit: 25 },
      });
      const organizationBody = await rpcBody(organizationQuery);
      assert.deepEqual(organizationBody.result.structuredContent.accountIds, ["account_a"]);
      assert.deepEqual(organizationBody.result.structuredContent.threads.map((thread: { id: string }) => thread.id), ["thread_a_1", "thread_a_2"]);
      assert.doesNotMatch(JSON.stringify(organizationBody), /account_b|Private B|provider-access|provider-refresh/);

      const deniedOrganization = await callMcp(app, token, "tools/call", {
        name: "query_organization",
        arguments: { workspaceId: "user_a", accountIds: ["account_b"], expectedWorkspaceRevision: 1, attention: "all" },
      });
      const deniedOrganizationBody = await rpcBody(deniedOrganization);
      assert.equal(deniedOrganizationBody.result.isError, true);
      assert.equal(JSON.parse(deniedOrganizationBody.result.content[0].text).error.code, "account_denied");

      const search = await callMcp(app, token, "tools/call", {
        name: "search_mail",
        arguments: { classification: "all", attention: "all", limit: 1 },
      });
      assert.equal(search.status, 200);
      const searchBody = await rpcBody(search);
      assert.ok(searchBody.result, JSON.stringify(searchBody));
      assert.ok(searchBody.result.structuredContent, JSON.stringify(searchBody));
      assert.deepEqual(searchBody.result.structuredContent.messages.map((message: { accountId: string }) => message.accountId), ["account_a"]);
      assert.equal(searchBody.result.structuredContent.counts.attention.all, 2);
      assert.ok(searchBody.result.structuredContent.nextCursor);
      assert.match(searchBody.result.structuredContent.messages[0].sourceUrl, /accountId=account_a/);
      assert.doesNotMatch(JSON.stringify(searchBody), /account_b|Private B|provider-access|provider-refresh/);

      const next = await callMcp(app, token, "tools/call", {
        name: "search_mail",
        arguments: { classification: "all", attention: "all", limit: 1, cursor: searchBody.result.structuredContent.nextCursor },
      });
      assert.equal((await rpcBody(next)).result.structuredContent.messages[0].id, "message_a_2");

      const filtered = await callMcp(app, token, "tools/call", {
        name: "search_mail",
        arguments: {
          query: "release",
          sender: "maya",
          receivedAfter: "2026-08-19T15:30:00.000Z",
          receivedBefore: "2026-08-19T16:30:00.000Z",
          classification: "human",
          attention: "focus",
        },
      });
      const filteredBody = await rpcBody(filtered);
      assert.deepEqual(filteredBody.result.structuredContent.messages.map((message: { id: string }) => message.id), ["message_a_1"]);
      assert.equal(filteredBody.result.structuredContent.counts.attention.all, 1);

      const cursorReplay = await callMcp(app, token, "tools/call", {
        name: "search_mail",
        arguments: { classification: "all", attention: "all", sender: "ci", limit: 1, cursor: searchBody.result.structuredContent.nextCursor },
      });
      const cursorReplayBody = await rpcBody(cursorReplay);
      assert.equal(cursorReplayBody.result.isError, true);
      assert.equal(JSON.parse(cursorReplayBody.result.content[0].text).error.code, "invalid_cursor");

      const thread = await callMcp(app, token, "tools/call", {
        name: "get_thread",
        arguments: { accountId: "account_a", threadId: "thread_a_1" },
      });
      const threadBody = await rpcBody(thread);
      assert.equal(threadBody.result.structuredContent.messages[0].bodyExcerpt, "Please review. [REDACTED]");
      assert.equal(threadBody.result.structuredContent.messages[0].safety.contentTrust, "untrusted_external_content");
      assert.match(threadBody.result.structuredContent.thread.sourceUrl, /accountId=account_a/);
      assert.doesNotMatch(JSON.stringify(threadBody), /super-secret-token-value|provider-access|provider-refresh/);

      const deniedThread = await callMcp(app, token, "tools/call", {
        name: "get_thread",
        arguments: { accountId: "account_b", threadId: "thread_b" },
      });
      const deniedBody = await rpcBody(deniedThread);
      assert.equal(deniedBody.result.isError, true);
      assert.equal(JSON.parse(deniedBody.result.content[0].text).error.code, "account_denied");

      const events = await callMcp(app, token, "tools/call", { name: "list_agent_events", arguments: { limit: 25 } });
      const eventsBody = await rpcBody(events);
      assert.deepEqual(eventsBody.result.structuredContent.events.map((event: { id: string }) => event.id), ["event_a", "event_a_missing_account"]);
      const eventSourceUrls = eventsBody.result.structuredContent.events.map((event: { source: { threadId: string; sourceUrl: string } }) => ({
        threadId: event.source.threadId,
        url: new URL(event.source.sourceUrl),
      }));
      const expectedOrigin = new URL(searchBody.result.structuredContent.messages[0].sourceUrl).origin;
      for (const source of eventSourceUrls) {
        assert.equal(source.url.origin, expectedOrigin);
        assert.equal(source.url.searchParams.get("thread"), source.threadId);
        assert.equal(source.url.searchParams.get("accountId"), "account_a");
      }
      assert.doesNotMatch(JSON.stringify(eventsBody), /event_b|account_b|evil\.invalid|elsewhere\.invalid|token=provider-secret|deduplicationKey|ownerUserId/);

      const status = await callMcp(app, token, "tools/call", { name: "get_connection_status", arguments: {} });
      const statusBody = await rpcBody(status);
      assert.deepEqual(statusBody.result.structuredContent.accounts.map((account: { id: string }) => account.id), ["account_a"]);
      assert.equal(statusBody.result.structuredContent.accounts[0].ready, true);
      assert.doesNotMatch(JSON.stringify(statusBody), /account_b|provider-access|provider-refresh|gmail\.readonly/);
    } finally {
      sqlite.close();
    }
  });

  test("runs all five Organization operations with a control-only grant and preserves legacy read-only describe/query", async () => {
    const { app, db, sqlite } = createFixture();
    try {
      const token = await signToken({ accountIds: ["account_a"], scopes: ["orca:organization:control"] });
      const scope = { workspaceId: "user_a", accountIds: ["account_a"] };
      const describe = await callMcp(app, token, "tools/call", {
        name: "describe_organization",
        arguments: { ...scope, expectedWorkspaceRevision: 1 },
      });
      const described = (await rpcBody(describe)).result.structuredContent;
      assert.deepEqual(described.capabilities.operations, { describe: true, query: true, simulate: true, apply: true, revert: true });
      assert.deepEqual(described.capabilities.authority, { sendMail: false, deleteProviderMail: false });

      const laneArguments = {
          ...scope,
          expectedWorkspaceRevision: 1,
          targetKind: "lanes",
          target: { kind: "lanes", request: { id: "mcp-lanes-r1", idempotencyKey: "mcp-lanes-r1", expectedWorkspaceRevision: 1, actions: [
            { kind: "define_lane_policy", id: "policy-focus", visibility: "prominent", interruption: "badge", review: "continuous", retention: { mode: "keep", days: null } },
            { kind: "define_lane", id: "lane-focus", name: "Focus", position: 1, defaultPolicyId: "policy-focus" },
          ] } },
        };
      const lanes = await callMcp(app, token, "tools/call", { name: "apply_organization", arguments: laneArguments });
      const lanesBody = await rpcBody(lanes);
      assert.ok(lanesBody.result?.structuredContent, JSON.stringify(lanesBody));
      assert.deepEqual(lanesBody.result.structuredContent.changeSetIds, { applied: ["mcp-lanes-r1"], rejected: [] });
      assert.equal(lanesBody.result.structuredContent.targetKind, "lanes");
      assert.deepEqual(lanesBody.result.structuredContent.resourceFamilies, JSON.parse(db.select().from(organizationChangeSets).where(eq(organizationChangeSets.idempotencyKey, "mcp-lanes-r1")).get()!.authorityTrace).requestedResourceFamilies);
      assert.equal("resourceFamily" in lanesBody.result.structuredContent, false);
      const laneReplay = await rpcBody(await callMcp(app, token, "tools/call", { name: "apply_organization", arguments: laneArguments }));
      assert.deepEqual(laneReplay.result.structuredContent, lanesBody.result.structuredContent);
      assert.equal(db.select().from(organizationChangeSets).where(eq(organizationChangeSets.idempotencyKey, "mcp-lanes-r1")).all().length, 1);
      const laneConflict = await rpcBody(await callMcp(app, token, "tools/call", { name: "apply_organization", arguments: {
        ...laneArguments,
        target: { kind: "lanes", request: { ...laneArguments.target.request, actions: [{ ...laneArguments.target.request.actions[1], name: "Conflicting replay" }] } },
      } }));
      assert.equal(laneConflict.result.isError, true);
      assert.equal(JSON.parse(laneConflict.result.content[0].text).error.code, "idempotency_conflict");
      assert.equal(db.select().from(organizationChangeSets).where(eq(organizationChangeSets.idempotencyKey, "mcp-lanes-r1")).all().length, 1);
      let structureRevision = lanesBody.result.structuredContent.result.workspaceRevision;
      const facetArguments = {
        ...scope, expectedWorkspaceRevision: structureRevision, targetKind: "facets_workflow",
        target: { kind: "facets_workflow", request: { id: "mcp-facets-r1", idempotencyKey: "mcp-facets-r1", expectedWorkspaceRevision: structureRevision, actions: [
          { kind: "define_facet", id: "facet-owner", name: "Owner", position: 0, valueType: { kind: "text", maxLength: 200 }, cardinality: { kind: "single" }, isOptional: true, defaultValue: null },
          { kind: "define_workflow_state", id: "state-review", name: "Needs review", position: 0 },
        ] } },
      };
      const facets = await callMcp(app, token, "tools/call", { name: "apply_organization", arguments: facetArguments });
      const facetsBody = await rpcBody(facets);
      assert.ok(facetsBody.result?.structuredContent, JSON.stringify(facetsBody));
      assert.deepEqual(facetsBody.result.structuredContent.changeSetIds, { applied: ["mcp-facets-r1"], rejected: [] });
      assert.equal(facetsBody.result.structuredContent.targetKind, "facets_workflow");
      assert.deepEqual(facetsBody.result.structuredContent.resourceFamilies, JSON.parse(db.select().from(organizationChangeSets).where(eq(organizationChangeSets.idempotencyKey, "mcp-facets-r1")).get()!.authorityTrace).requestedResourceFamilies);
      const facetReplay = await rpcBody(await callMcp(app, token, "tools/call", { name: "apply_organization", arguments: facetArguments }));
      assert.ok(facetReplay.result?.structuredContent, JSON.stringify(facetReplay));
      assert.deepEqual(facetReplay.result.structuredContent, facetsBody.result.structuredContent);
      assert.equal(db.select().from(organizationChangeSets).where(eq(organizationChangeSets.idempotencyKey, "mcp-facets-r1")).all().length, 1);
      const facetConflict = await rpcBody(await callMcp(app, token, "tools/call", { name: "apply_organization", arguments: {
        ...facetArguments,
        target: { kind: "facets_workflow", request: { ...facetArguments.target.request, actions: [{ ...facetArguments.target.request.actions[0], name: "Conflicting replay" }] } },
      } }));
      assert.equal(facetConflict.result.isError, true);
      assert.equal(JSON.parse(facetConflict.result.content[0].text).error.code, "idempotency_conflict");
      assert.equal(db.select().from(organizationChangeSets).where(eq(organizationChangeSets.idempotencyKey, "mcp-facets-r1")).all().length, 1);
      structureRevision = facetsBody.result.structuredContent.result.workspaceRevision;

      const view = await callMcp(app, token, "tools/call", { name: "apply_organization", arguments: {
        ...scope, expectedWorkspaceRevision: structureRevision, targetKind: "view_create",
        target: { kind: "view_create", request: { idempotencyKey: "mcp-view-r1", expectedWorkspaceRevision: structureRevision, name: "Agent review", description: "Fixture View", color: "#0b9b84", position: 0, definition: { revision: 1, accountIds: ["account_a"] } } },
      } });
      const viewBody = await rpcBody(view);
      assert.ok(viewBody.result?.structuredContent, JSON.stringify(viewBody));
      assert.deepEqual(viewBody.result.structuredContent.changeSetIds, {
        applied: [db.select().from(organizationChangeSets).where(eq(organizationChangeSets.idempotencyKey, "mcp-view-r1")).get()!.id], rejected: [],
      });
      assert.equal(viewBody.result.structuredContent.result.name, "Agent review");
      structureRevision = db.select().from(organizationWorkspaceStates).get()!.revision;

      const collection = await callMcp(app, token, "tools/call", { name: "apply_organization", arguments: {
        ...scope, expectedWorkspaceRevision: structureRevision, targetKind: "collection",
        target: { kind: "collection", request: { idempotencyKey: "mcp-collection-r1", change: { kind: "collection", action: "create", accountId: "account_a", collection: { name: "Launch", color: "#336699" } } } },
      } });
      const collectionBody = await rpcBody(collection);
      assert.ok(collectionBody.result?.structuredContent, JSON.stringify(collectionBody));
      assert.equal(collectionBody.result.structuredContent.changeSetIds.applied[0], collectionBody.result.structuredContent.result.change.id);
      assert.equal(collectionBody.result.structuredContent.result.state.collections[0].name, "Launch");
      structureRevision = db.select().from(organizationWorkspaceStates).get()!.revision;

      const context = await callMcp(app, token, "tools/call", { name: "apply_organization", arguments: {
        ...scope, expectedWorkspaceRevision: structureRevision, targetKind: "context",
        target: { kind: "context", request: { idempotencyKey: "mcp-context-r1", expectedWorkspaceRevision: structureRevision, actions: [{ kind: "create_context_type", name: "Project", position: 0 }] } },
      } });
      const contextBody = await rpcBody(context);
      assert.ok(contextBody.result?.structuredContent, JSON.stringify(contextBody));
      assert.equal(contextBody.result.structuredContent.changeSetIds.applied[0], contextBody.result.structuredContent.result.change.id);
      assert.equal(contextBody.result.structuredContent.result.state.contextTypes[0].name, "Project");
      structureRevision = contextBody.result.structuredContent.result.state.workspaceRevision;

      const laneWorkspaceRevision = structureRevision;
      const source = `orca 1\nrule "Fixture failures"\nevent message.received\nwhen subject contains "failed"\naction route lane "Focus"\nbecause "Fixture-backed failures need deterministic review"`;
      const compile = await callMcp(app, token, "tools/call", {
        name: "apply_organization",
        arguments: {
          ...scope,
          expectedWorkspaceRevision: laneWorkspaceRevision,
          targetKind: "rule_revision",
          target: { kind: "rule_revision", request: { idempotencyKey: "mcp-rule-r1", expectedRuleRevision: null, workspaceSchemaRevision: laneWorkspaceRevision, source } },
        },
      });
      const compiledBody = await rpcBody(compile);
      assert.ok(compiledBody.result?.structuredContent, JSON.stringify(compiledBody));
      assert.deepEqual(compiledBody.result.structuredContent.changeSetIds, {
        applied: [db.select().from(organizationChangeSets).where(eq(organizationChangeSets.idempotencyKey, "mcp-rule-r1")).get()!.id], rejected: [],
      });
      const compiled = compiledBody.result.structuredContent.result;
      assert.equal(compiled.ok, true);
      assert.equal(compiled.revision.actor.type, "agent");
      assert.match(compiled.revision.actor.id, /chatgpt\.com/);

      db.insert(organizationThreadStates).values({ workspaceId: "user_a", accountId: "account_a", threadId: "thread_a_2", revision: 1 }).run();

      const currentWorkspace = db.select().from(organizationWorkspaceStates).get()!.revision;
      const simulationRequest = {
        ruleId: compiled.rule.id,
        revisionId: compiled.revision.id,
        workspaceSchemaRevision: compiled.revision.compiled.workspaceSchemaRevision,
        accountIds: ["account_a"],
        maximumThreads: 50,
      };
      const simulation = await callMcp(app, token, "tools/call", {
        name: "simulate_organization",
        arguments: { ...scope, expectedWorkspaceRevision: currentWorkspace, resourceFamily: "rule", request: simulationRequest },
      });
      const simulatedBody = await rpcBody(simulation);
      assert.ok(simulatedBody.result?.structuredContent, JSON.stringify(simulatedBody));
      const simulated = simulatedBody.result.structuredContent;
      assert.equal(simulated.state, "simulated");
      assert.equal(simulated.risk, "low");
      assert.ok(simulated.winningRules.some((winner: { ruleId: string }) => winner.ruleId === compiled.rule.id));
      assert.ok(simulated.observedReasons.some((reason: { threadId: string; reason: string }) => reason.threadId === "thread_a_2" && reason.reason.length > 0));

      const ruleSetRevision = db.select().from(organizationRuleSets).get()!.revision;
      const activationRequest = {
        ruleId: compiled.rule.id,
        revisionId: compiled.revision.id,
        simulationId: simulated.simulationId,
        accountIds: ["account_a"],
        maximumThreads: 50,
        expectedWorkspaceRevision: simulated.binding.workspaceRevision,
        expectedRuleRevision: compiled.rule.latestRevision,
        expectedRuleSetRevision: ruleSetRevision,
        idempotencyKey: "mcp-activate-r1",
      };
      const missingApproval = await callMcp(app, token, "tools/call", {
        name: "apply_organization",
        arguments: { ...scope, expectedWorkspaceRevision: simulated.binding.workspaceRevision, targetKind: "rule_change_set", target: { kind: "rule_change_set", request: activationRequest } },
      });
      const missingApprovalBody = await rpcBody(missingApproval);
      assert.ok(missingApprovalBody.error?.code === -32602 || missingApprovalBody.result?.isError === true, JSON.stringify(missingApprovalBody));

      const beforeRejected = db.select().from(organizationChangeSets).all().length;
      const staleApproval = await callMcp(app, token, "tools/call", {
        name: "apply_organization",
        arguments: { ...scope, expectedWorkspaceRevision: simulated.binding.workspaceRevision, targetKind: "rule_change_set", target: { kind: "rule_change_set", request: activationRequest, approval: { source: "oauth_organization_control_grant", simulationId: simulated.simulationId, acknowledgedRisk: "high" } } },
      });
      const staleApprovalBody = await rpcBody(staleApproval);
      assert.equal(staleApprovalBody.result.isError, true);
      assert.equal(db.select().from(organizationChangeSets).all().length, beforeRejected);

      const applyArguments = { ...scope, expectedWorkspaceRevision: simulated.binding.workspaceRevision, targetKind: "rule_change_set", target: { kind: "rule_change_set", request: activationRequest, approval: { source: "oauth_organization_control_grant", simulationId: simulated.simulationId, acknowledgedRisk: simulated.risk } } };
      const applied = await callMcp(app, token, "tools/call", { name: "apply_organization", arguments: applyArguments });
      const appliedBody = await rpcBody(applied);
      assert.ok(appliedBody.result?.structuredContent, JSON.stringify(appliedBody));
      const appliedOutput = appliedBody.result.structuredContent;
      assert.equal(appliedOutput.result.status, "active");
      assert.deepEqual(appliedOutput.changeSetIds, { applied: [appliedOutput.result.changeSetId], rejected: [] });
      assert.equal(appliedOutput.actor.type, "agent");
      const storedApply = db.select().from(organizationChangeSets).all().find((row) => row.id === appliedOutput.result.changeSetId)!;
      assert.deepEqual(JSON.parse(storedApply.commandJson).approval, applyArguments.target.approval);
      const durableApproval = db.select().from(mcpOrganizationApprovals).get()!;
      assert.equal(durableApproval.connectionId, "connection_a");
      assert.equal(durableApproval.clientId, appliedOutput.actor.id);
      assert.equal(durableApproval.approverUserId, "user_a");
      assert.equal(durableApproval.operation, "apply");
      assert.equal(durableApproval.commandDigest, storedApply.commandDigest);
      assert.equal(durableApproval.simulationId, simulated.simulationId);
      assert.equal(durableApproval.risk, simulated.risk);
      assert.equal(durableApproval.consumedByIdempotencyKey, activationRequest.idempotencyKey);
      assert.ok(durableApproval.expiresAt > durableApproval.consumedAt);
      assert.deepEqual(JSON.parse(durableApproval.revisionsJson).workspace, activationRequest.expectedWorkspaceRevision);
      assert.doesNotMatch(JSON.stringify(durableApproval), /Bearer|provider-access|provider-refresh|Production failures/);

      const competingApprovalUse = await rpcBody(await callMcp(app, token, "tools/call", {
        name: "apply_organization",
        arguments: {
          ...applyArguments,
          target: {
            ...applyArguments.target,
            request: { ...activationRequest, idempotencyKey: "mcp-activate-competing-key" },
          },
        },
      }));
      assert.equal(competingApprovalUse.result.isError, true, JSON.stringify(competingApprovalUse));
      assert.ok(["approval_required", "simulation_mismatch", "revision_conflict"].includes(
        JSON.parse(competingApprovalUse.result.content[0].text).error.code,
      ));
      assert.equal(db.select().from(mcpOrganizationApprovals).all().length, 1);
      assert.equal(db.select().from(organizationChangeSets).where(eq(organizationChangeSets.operation, "apply")).all()
        .filter((row) => row.simulationId === simulated.simulationId).length, 1);

      const replay = await callMcp(app, token, "tools/call", { name: "apply_organization", arguments: applyArguments });
      assert.deepEqual((await rpcBody(replay)).result.structuredContent, appliedOutput);

      const organized = await callMcp(app, token, "tools/call", {
        name: "query_organization",
        arguments: { ...scope, expectedWorkspaceRevision: appliedOutput.result.workspaceRevisionAfter, threadId: "thread_a_2", attention: "all", classification: "all", limit: 1 },
      });
      const organizedBody = await rpcBody(organized);
      assert.equal(organizedBody.result.structuredContent.threads[0].organization.lanePlacement.evidence.winningSource, "rule_revision");

      const reverted = await callMcp(app, token, "tools/call", {
        name: "revert_organization",
        arguments: { ...scope, expectedWorkspaceRevision: appliedOutput.result.workspaceRevisionAfter, targetKind: "rule_change_set", request: { changeSetId: appliedOutput.result.changeSetId, accountIds: ["account_a"], expectedWorkspaceRevision: appliedOutput.result.workspaceRevisionAfter, idempotencyKey: "mcp-revert-r1" } },
      });
      const revertedBody = await rpcBody(reverted);
      assert.equal(revertedBody.result.structuredContent.result.status, "reverted");
      assert.equal(revertedBody.result.structuredContent.result.revertsChangeSetId, appliedOutput.result.changeSetId);
      assert.equal(revertedBody.result.structuredContent.targetKind, "rule_change_set");
      assert.deepEqual(revertedBody.result.structuredContent.resourceFamilies, JSON.parse(db.select().from(organizationChangeSets).where(eq(organizationChangeSets.id, revertedBody.result.structuredContent.result.changeSetId)).get()!.authorityTrace).requestedResourceFamilies);

      db.update(mcpConnections).set({ scopes: "mail:read", updatedAt: new Date() }).where(eq(mcpConnections.id, "connection_a")).run();
      const mailOnlyToken = await signToken({ accountIds: ["account_a"], scopes: ["orca:mail.metadata:read"] });
      const readOnlyDescribe = await rpcBody(await callMcp(app, mailOnlyToken, "tools/call", {
        name: "describe_organization",
        arguments: { ...scope, expectedWorkspaceRevision: revertedBody.result.structuredContent.result.workspaceRevisionAfter },
      }));
      assert.ok(readOnlyDescribe.result?.structuredContent, JSON.stringify(readOnlyDescribe));
      assert.deepEqual(readOnlyDescribe.result.structuredContent.capabilities.operations, { describe: true, query: true, simulate: false, apply: false, revert: false });
      const readOnlyQuery = await rpcBody(await callMcp(app, mailOnlyToken, "tools/call", {
        name: "query_organization",
        arguments: { ...scope, expectedWorkspaceRevision: revertedBody.result.structuredContent.result.workspaceRevisionAfter, attention: "all", classification: "all", limit: 1 },
      }));
      assert.ok(readOnlyQuery.result?.structuredContent, JSON.stringify(readOnlyQuery));
      const deniedControl = await callMcp(app, mailOnlyToken, "tools/call", { name: "simulate_organization", arguments: { ...scope, expectedWorkspaceRevision: currentWorkspace, resourceFamily: "rule", request: simulationRequest } });
      assert.equal(deniedControl.status, 403);
      const smuggledDescribe = await callMcp(app, token, "tools/call", { name: "describe_organization", arguments: { ...scope, expectedWorkspaceRevision: 1, target: { kind: "rule_revision", request: {} } } });
      const smuggledDescribeBody = await rpcBody(smuggledDescribe);
      assert.ok(smuggledDescribeBody.error?.code === -32602 || smuggledDescribeBody.result?.isError === true, JSON.stringify(smuggledDescribeBody));
      const ignoredReadAuthority = await rpcBody(await callMcp(app, token, "tools/call", { name: "query_organization", arguments: { ...scope, expectedWorkspaceRevision: 1, resourceFamilies: ["mail"] } }));
      assert.ok(ignoredReadAuthority.error?.code === -32602 || ignoredReadAuthority.result?.isError === true, JSON.stringify(ignoredReadAuthority));
    } finally { sqlite.close(); }
  }, 20_000);

  test("fails closed with zero Organization writes when the persisted grant changes between preflight and the Lane transaction", async () => {
    const mutations = [
      (db: ReturnType<typeof createDatabaseClient>["db"]) => db.update(mcpConnections).set({ revokedAt: new Date() }).where(eq(mcpConnections.id, "connection_a")).run(),
      (db: ReturnType<typeof createDatabaseClient>["db"]) => db.delete(mcpConnectionAccounts).where(eq(mcpConnectionAccounts.connectionId, "connection_a")).run(),
      (db: ReturnType<typeof createDatabaseClient>["db"]) => db.update(mcpConnections).set({ scopes: "mail:read" }).where(eq(mcpConnections.id, "connection_a")).run(),
    ];
    for (const [index, mutateGrant] of mutations.entries()) {
      const { app, db, sqlite } = createFixture({ beforeMutationTransaction: mutateGrant });
      try {
        const token = await signToken({ accountIds: ["account_a"], scopes: ["orca:organization:control"] });
        const response = await callMcp(app, token, "tools/call", { name: "apply_organization", arguments: {
          workspaceId: "user_a", accountIds: ["account_a"], expectedWorkspaceRevision: 1, targetKind: "lanes",
          target: { kind: "lanes", request: { id: `grant-race-${index}`, idempotencyKey: `grant-race-${index}`, expectedWorkspaceRevision: 1, actions: [
            { kind: "define_lane_policy", id: `grant-policy-${index}`, visibility: "prominent", interruption: "badge", review: "continuous", retention: { mode: "keep", days: null } },
          ] } },
        } });
        const body = await rpcBody(response);
        assert.equal(body.result.isError, true, JSON.stringify(body));
        assert.equal(db.select().from(organizationChangeSets).where(eq(organizationChangeSets.id, `grant-race-${index}`)).all().length, 0);
        const attempts = db.select().from(organizationMutationAttempts).where(eq(organizationMutationAttempts.idempotencyKey, `grant-race-${index}`)).all();
        assert.equal(attempts.length, 1);
        assert.match(attempts[0]!.reasonCode, /actor_operation_denied|capability|denied/);
      } finally { sqlite.close(); }
    }
  });

  test("denies guessed cross-Account resource IDs and replayed cross-Workspace credentials through the real MCP mutation seam", async () => {
    const { app, db, sqlite } = createFixture();
    try {
      const token = await signToken({ accountIds: ["account_a"], scopes: ["orca:organization:control"] });
      const crossAccountKey = "g2-cross-account-resource";
      const crossAccount = await rpcBody(await callMcp(app, token, "tools/call", { name: "apply_organization", arguments: {
        workspaceId: "user_a", accountIds: ["account_a"], expectedWorkspaceRevision: 1, targetKind: "collection",
        target: { kind: "collection", request: {
          idempotencyKey: crossAccountKey,
          change: { kind: "collection", action: "create", accountId: "account_b", collection: { name: "Guessed", color: "#336699" } },
        } },
      } }));
      assert.equal(crossAccount.result.isError, true, JSON.stringify(crossAccount));
      assert.equal(JSON.parse(crossAccount.result.content[0].text).error.code, "denial");
      assert.equal(db.select().from(organizationChangeSets).where(eq(organizationChangeSets.idempotencyKey, crossAccountKey)).all().length, 0);

      const crossWorkspaceKey = "g2-cross-workspace-credential";
      const replayedCredential = await signToken({ userId: "user_b", accountIds: ["account_b"], scopes: ["orca:organization:control"] });
      const crossWorkspace = await rpcBody(await callMcp(app, replayedCredential, "tools/call", { name: "apply_organization", arguments: {
        workspaceId: "user_b", accountIds: ["account_b"], expectedWorkspaceRevision: 1, targetKind: "lanes",
        target: { kind: "lanes", request: { id: crossWorkspaceKey, idempotencyKey: crossWorkspaceKey, expectedWorkspaceRevision: 1, actions: [
          { kind: "define_lane_policy", id: "cross-workspace-policy", visibility: "prominent", interruption: "badge", review: "continuous", retention: { mode: "keep", days: null } },
        ] } },
      } }));
      assert.equal(crossWorkspace.result.isError, true, JSON.stringify(crossWorkspace));
      assert.equal(JSON.parse(crossWorkspace.result.content[0].text).error.code, "account_denied");
      assert.equal(db.select().from(organizationChangeSets).where(eq(organizationChangeSets.idempotencyKey, crossWorkspaceKey)).all().length, 0);
      assert.equal(db.select().from(organizationMutationAttempts).where(eq(organizationMutationAttempts.idempotencyKey, crossAccountKey)).all().length, 1);
      const crossWorkspaceAttempts = db.select().from(organizationMutationAttempts).where(eq(organizationMutationAttempts.idempotencyKey, crossWorkspaceKey)).all();
      assert.equal(crossWorkspaceAttempts.length, 1);
      assert.equal(crossWorkspaceAttempts[0]?.connectionId, null, "a replayed connection must not be attributed across Workspaces");
    } finally { sqlite.close(); }
  });

  test("fails a cached Context replay when persisted authority is revoked after bearer preflight but before replay lookup", async () => {
    const idempotencyKey = "context-replay-grant-race";
    const { app, db, sqlite } = createFixture({
      beforeMutationTransaction(executor) {
        const existing = executor.select().from(organizationChangeSets).where(eq(organizationChangeSets.idempotencyKey, idempotencyKey)).get();
        if (existing) executor.update(mcpConnections).set({ revokedAt: new Date() }).where(eq(mcpConnections.id, "connection_a")).run();
      },
    });
    try {
      const token = await signToken({ accountIds: ["account_a"], scopes: ["orca:organization:control"] });
      const arguments_ = {
        workspaceId: "user_a", accountIds: ["account_a"], expectedWorkspaceRevision: 1, targetKind: "context",
        target: { kind: "context", request: { idempotencyKey, expectedWorkspaceRevision: 1, actions: [{ kind: "create_context_type", name: "Replay race", position: 0 }] } },
      };
      const first = await rpcBody(await callMcp(app, token, "tools/call", { name: "apply_organization", arguments: arguments_ }));
      assert.ok(first.result?.structuredContent, JSON.stringify(first));
      assert.equal(db.select().from(organizationChangeSets).where(eq(organizationChangeSets.idempotencyKey, idempotencyKey)).all().length, 1);

      const replay = await rpcBody(await callMcp(app, token, "tools/call", { name: "apply_organization", arguments: arguments_ }));
      assert.equal(replay.result.isError, true, JSON.stringify(replay));
      assert.equal(db.select().from(organizationChangeSets).where(eq(organizationChangeSets.idempotencyKey, idempotencyKey)).all().length, 1);
    } finally { sqlite.close(); }
  });

  test("rolls back first/middle/last multi-resource failures and appends one bounded redacted attempt each", async () => {
    for (const phase of ["first", "middle", "last"] as const) {
      const idempotencyKey = `g2-atomic-${phase}`;
      const policyId = `g2-policy-${phase}`;
      const laneId = `g2-lane-${phase}`;
      const { app, db, sqlite } = createFixture({
        beforeMutationTransaction(executor) {
          const trigger = phase === "first"
            ? `BEFORE INSERT ON organization_change_sets WHEN NEW.idempotency_key = '${idempotencyKey}'`
            : phase === "middle"
              ? `BEFORE INSERT ON organization_lane_policies WHEN NEW.id = '${policyId}'`
              : `BEFORE INSERT ON organization_lanes WHEN NEW.id = '${laneId}'`;
          executor.$client.exec(`CREATE TRIGGER IF NOT EXISTS bre319_fail_${phase} ${trigger}
            BEGIN SELECT RAISE(ABORT, 'g2 injected failure'); END`);
        },
      });
      try {
        const token = await signToken({ accountIds: ["account_a"], scopes: ["orca:organization:control"] });
        const request = {
          workspaceId: "user_a", accountIds: ["account_a"], expectedWorkspaceRevision: 1, targetKind: "lanes",
          target: { kind: "lanes", request: { id: idempotencyKey, idempotencyKey, expectedWorkspaceRevision: 1, actions: [
            { kind: "define_lane_policy", id: policyId, visibility: "prominent", interruption: "badge", review: "continuous", retention: { mode: "keep", days: null } },
            { kind: "define_lane", id: laneId, name: "Must roll back", position: 1, defaultPolicyId: policyId },
          ] } },
        };
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const body = await rpcBody(await callMcp(app, token, "tools/call", { name: "apply_organization", arguments: request }));
          assert.equal(body.result.isError, true, JSON.stringify(body));
        }
        assert.equal(db.select().from(organizationLanePolicies).where(eq(organizationLanePolicies.id, policyId)).all().length, 0, phase);
        assert.equal(db.select().from(organizationLanes).where(eq(organizationLanes.id, laneId)).all().length, 0, phase);
        assert.equal(db.select().from(organizationChangeSets).where(eq(organizationChangeSets.idempotencyKey, idempotencyKey)).all().length, 0, phase);
        const attempts = db.select().from(organizationMutationAttempts).where(eq(organizationMutationAttempts.idempotencyKey, idempotencyKey)).all();
        assert.equal(attempts.length, 1, phase);
        assert.equal(attempts[0]!.workspaceId, "user_a");
        assert.equal(attempts[0]!.connectionId, "connection_a");
        assert.equal(attempts[0]!.operation, "apply");
        assert.match(attempts[0]!.commandDigest, /^sha256:[0-9a-f]{64}$/);
        assert.match(attempts[0]!.accountIdsDigest, /^sha256:[0-9a-f]{64}$/);
        assert.doesNotMatch(JSON.stringify(attempts), /Bearer|provider-access|provider-refresh|Must roll back|g2 injected failure/);
      } finally { sqlite.close(); }
    }
  });
});
