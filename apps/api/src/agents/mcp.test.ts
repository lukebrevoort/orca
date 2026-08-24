import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, test } from "bun:test";
import { serve } from "@hono/node-server";
import { jwtVerify, SignJWT } from "jose";
import { OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import {
  propagatedAgentEventSchema,
  type AgentEventListPage,
  type OrganizationDescribeResponse,
  type OrganizationQueryResponse,
  type OrcaMcpScope,
  type PropagatedAgentEvent,
} from "@orca/shared";

import { createDatabaseClient } from "../db/client.ts";
import { emails, oauthAccounts, senderAttentionRules, threads, users } from "../db/schema.ts";
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
];
const oauthScopes = ["mail:read", "agent_events:read"];
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
  workspaceSchema: {
    revision: 3,
    aggregate: "thread",
    resources: ["account", "thread", "facet", "workflow_state", "context", "context_relationship"],
    filters: ["account", "thread", "attention", "classification", "sender", "text", "received_at", "facet", "workflow_state", "context", "context_relationship"],
  },
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
    organization: { attentionBehavior: "normal", humanSignal: 8, humanClassification: null },
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
};

function createProjectionTestHandler(
  describeOutput: OrganizationDescribeResponse,
  queryOutput: OrganizationQueryResponse,
) {
  const unavailable = () => { throw new Error("not used by this projection test"); };
  const dataSource: OrcaMcpDataSource = {
    getCurrentAccountIds: () => ["account_a"],
    describeOrganization: () => describeOutput,
    queryOrganization: () => queryOutput,
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
) {
  return handler.fetch(new Request(resource, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      host: new URL(resource).host,
    },
    body: rpc("tools/call", { name, arguments: {} }),
  }));
}

function createFixture(options: {
  mcpBoundaryPolicy?: { enabled: true; issuer: string; resource: string };
  mcpEnv?: NodeJS.ProcessEnv;
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
    dbFactory: () => createDatabaseClient(dbPath),
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

describe("Orca read-only MCP server", () => {
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
        resource_name: "Orca mail and agent events (read only)",
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

  test("initializes with stable metadata and lists only the six annotated read tools", async () => {
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
      assert.deepEqual(initializeBody.result.serverInfo, { name: "orca-mail-readonly", version: "1.0.0" });

      const tools = await callMcp(app, token, "tools/list", {});
      assert.equal(tools.status, 200);
      const body = await rpcBody(tools);
      assert.ok(body.result, JSON.stringify(body));
      assert.deepEqual(body.result.tools.map((tool: { name: string }) => tool.name), [
        "describe_organization", "query_organization", "search_mail", "get_thread", "list_agent_events", "get_connection_status",
      ]);
      for (const tool of body.result.tools) {
        assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, openWorldHint: false });
        assert.equal(tool.inputSchema.type, "object");
        assert.equal(tool.outputSchema.type, "object");
      }
    } finally {
      sqlite.close();
    }
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
        arguments: { accountId: "account_a" },
      });
      const describeBody = await rpcBody(describe);
      assert.deepEqual(describeBody.result.structuredContent.accountIds, ["account_a"]);
      assert.equal(describeBody.result.structuredContent.workspaceSchema.aggregate, "thread");
      assert.equal(describeBody.result.structuredContent.capabilities.operations.apply, false);
      assert.deepEqual(describeBody.result.structuredContent.collectionsPins.operations, {
        describe: true, query: true, apply: false, revert: false, simulate: false,
      });
      assert.doesNotMatch(JSON.stringify(describeBody), /account_b|gmail|outlook|provider-access|provider-refresh/);

      const deniedDescribe = await callMcp(app, token, "tools/call", {
        name: "describe_organization",
        arguments: { accountId: "account_b" },
      });
      const deniedDescribeBody = await rpcBody(deniedDescribe);
      assert.equal(deniedDescribeBody.result.isError, true);
      assert.equal(JSON.parse(deniedDescribeBody.result.content[0].text).error.code, "account_denied");

      const organizationQuery = await callMcp(app, token, "tools/call", {
        name: "query_organization",
        arguments: { accountId: "account_a", attention: "all", limit: 25 },
      });
      const organizationBody = await rpcBody(organizationQuery);
      assert.deepEqual(organizationBody.result.structuredContent.accountIds, ["account_a"]);
      assert.deepEqual(organizationBody.result.structuredContent.threads.map((thread: { id: string }) => thread.id), ["thread_a_1", "thread_a_2"]);
      assert.doesNotMatch(JSON.stringify(organizationBody), /account_b|Private B|provider-access|provider-refresh/);

      const deniedOrganization = await callMcp(app, token, "tools/call", {
        name: "query_organization",
        arguments: { accountId: "account_b", attention: "all" },
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
});
