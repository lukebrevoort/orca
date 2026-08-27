import assert from "node:assert/strict";
import { describe, test } from "bun:test";

import { mcpToolErrorSchema } from "@orca/shared";

import {
  McpRequestLimiter,
  boundedMcpRequest,
  mcpRequestLimits,
} from "./request-guards.ts";
import { createOrcaMcpHttpHandler, type OrcaMcpDataSource } from "./mcp.ts";
import { orcaAgentAuthorizationContextSchema } from "./authorization.ts";

describe("BRE-319 MCP exhaustion guards", () => {
  test("rejects declared and streamed oversized bodies before dispatch with a typed 413", async () => {
    const declared = await boundedMcpRequest(new Request("https://orca.example/mcp", {
      method: "POST",
      headers: { "content-length": String(mcpRequestLimits.maximumBodyBytes + 1) },
      body: "{}",
    }));
    assert.equal(declared.allowed, false);
    if (declared.allowed) throw new Error("expected declared body rejection");
    assert.equal(declared.response.status, 413);
    assert.equal((await declared.response.json()).error.code, "payload_limit");

    const streamed = await boundedMcpRequest(new Request("https://orca.example/mcp", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(mcpRequestLimits.maximumBodyBytes));
          controller.enqueue(new Uint8Array(1));
          controller.close();
        },
      }),
      // Bun requires duplex for streaming request bodies even though it is not
      // currently represented in the TypeScript RequestInit declaration.
      duplex: "half",
    } as RequestInit));
    assert.equal(streamed.allowed, false);
    if (streamed.allowed) throw new Error("expected streamed body rejection");
    assert.equal(streamed.response.status, 413);
    assert.equal((await streamed.response.json()).error.code, "payload_limit");
  });

  test("preserves an accepted body byte-for-byte for the authenticated MCP handler", async () => {
    const source = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const guarded = await boundedMcpRequest(new Request("https://orca.example/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: source,
    }));
    assert.equal(guarded.allowed, true);
    if (!guarded.allowed) throw new Error("expected accepted body");
    assert.deepEqual(guarded.body, JSON.parse(source));
    assert.equal(await guarded.request.text(), source);
  });

  test("enforces fair connection/workspace cost and in-flight bounds with deterministic recovery", () => {
    let now = 1_000;
    const limiter = new McpRequestLimiter({
      now: () => now,
      windowMilliseconds: 1_000,
      maximumConnectionCost: 3,
      maximumWorkspaceCost: 4,
      maximumConnectionInFlight: 1,
      maximumWorkspaceInFlight: 2,
    });
    const first = limiter.acquire({ connectionId: "connection-a", workspaceId: "workspace", cost: 2 });
    assert.equal(first.allowed, true);
    const concurrent = limiter.acquire({ connectionId: "connection-a", workspaceId: "workspace", cost: 1 });
    assert.deepEqual(concurrent, { allowed: false, retryAfterSeconds: 1, reason: "connection_in_flight" });
    if (first.allowed) first.release();

    const second = limiter.acquire({ connectionId: "connection-a", workspaceId: "workspace", cost: 1 });
    assert.equal(second.allowed, true);
    if (second.allowed) second.release();
    assert.deepEqual(limiter.acquire({ connectionId: "connection-a", workspaceId: "workspace", cost: 1 }), {
      allowed: false,
      retryAfterSeconds: 1,
      reason: "connection_rate",
    });

    const fairTenant = limiter.acquire({ connectionId: "connection-b", workspaceId: "other-workspace", cost: 3 });
    assert.equal(fairTenant.allowed, true);
    if (fairTenant.allowed) fairTenant.release();
    now = 2_001;
    const recovered = limiter.acquire({ connectionId: "connection-a", workspaceId: "workspace", cost: 3 });
    assert.equal(recovered.allowed, true);
    if (recovered.allowed) recovered.release();
  });

  test("releases an in-flight lease after a rate-window rollover without poisoning later windows", () => {
    let now = 1_000;
    const limiter = new McpRequestLimiter({
      now: () => now,
      windowMilliseconds: 1_000,
      maximumConnectionCost: 10,
      maximumWorkspaceCost: 10,
      maximumConnectionInFlight: 1,
      maximumWorkspaceInFlight: 1,
    });
    const first = limiter.acquire({ connectionId: "connection", workspaceId: "workspace", cost: 1 });
    assert.equal(first.allowed, true);
    now = 2_001;
    assert.equal(limiter.acquire({ connectionId: "connection", workspaceId: "workspace", cost: 1 }).allowed, false);
    if (first.allowed) first.release();
    now = 3_002;
    const recovered = limiter.acquire({ connectionId: "connection", workspaceId: "workspace", cost: 1 });
    assert.equal(recovered.allowed, true, "release must decrement the current key state after rollover");
    if (recovered.allowed) recovered.release();
  });

  test("exports every stable BRE-319 denial and exhaustion error code", () => {
    for (const code of [
      "denial",
      "approval_required",
      "simulation_mismatch",
      "idempotency_conflict",
      "invalid_request",
      "revision_conflict",
      "payload_limit",
      "rate_limit",
    ] as const) {
      assert.equal(mcpToolErrorSchema.safeParse({ error: { code, message: "bounded" } }).success, true, code);
    }
  });

  test("runs payload admission before bearer verification and rate admission before MCP dispatch", async () => {
    const issuer = "https://identity.orca.test";
    const resource = "https://api.orca.test/mcp";
    let verifierCalls = 0;
    const unavailable = () => { throw new Error("tool dispatch was not expected"); };
    const dataSource: OrcaMcpDataSource = {
      getCurrentAccountIds: () => ["account"],
      describeOrganization: unavailable,
      queryOrganization: unavailable,
      simulateOrganization: unavailable,
      applyOrganization: unavailable,
      revertOrganization: unavailable,
      searchMail: unavailable,
      getThread: unavailable,
      listAgentEvents: unavailable,
      getConnectionStatus: unavailable,
      sourceUrl: () => resource,
    };
    const handler = createOrcaMcpHttpHandler({
      dataSource,
      policy: { enabled: true, issuer, resource },
      requestLimiter: new McpRequestLimiter({ maximumConnectionCost: 1, maximumWorkspaceCost: 1 }),
      verifier: {
        async verifyAccessToken(token) {
          verifierCalls += 1;
          return {
            token,
            clientId: "client",
            scopes: ["mail:read"],
            expiresAt: Math.floor(Date.now() / 1_000) + 600,
            resource: new URL(resource),
            extra: {
              orcaAuthorization: orcaAgentAuthorizationContextSchema.parse({
                connectionId: "connection",
                clientId: "client",
                userId: "workspace",
                accountIds: ["account"],
                issuer,
                resource,
                scopes: ["orca:mail.metadata:read"],
                issuedAt: new Date(),
                expiresAt: new Date(Date.now() + 600_000),
              }),
              grantRevokedAt: null,
            },
          };
        },
      },
    });
    const headers = {
      authorization: "Bearer bounded-token",
      host: "api.orca.test",
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    };
    const oversized = await handler.fetch(new Request(resource, {
      method: "POST",
      headers,
      body: "x".repeat(mcpRequestLimits.maximumBodyBytes + 1),
    }));
    assert.equal(oversized.status, 413);
    assert.equal(verifierCalls, 0);

    const rpc = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    assert.equal((await handler.fetch(new Request(resource, { method: "POST", headers, body: rpc }))).status, 200);
    const rateLimited = await handler.fetch(new Request(resource, { method: "POST", headers, body: rpc }));
    assert.equal(rateLimited.status, 429);
    assert.equal((await rateLimited.json()).error.code, "rate_limit");
    assert.equal(verifierCalls, 2);
  });

  test("rejects JSON-RPC batches before authorization or partial tool execution", async () => {
    const issuer = "https://identity.orca.test";
    const resource = "https://api.orca.test/mcp";
    let verifierCalls = 0;
    let dispatchCalls = 0;
    const unavailable = () => { throw new Error("unexpected tool dispatch"); };
    const emptyCounts = {
      attention: { focus: 0, normal: 0, quiet: 0, hidden: 0, all: 0 },
      classification: { likely_human: 0, automated_or_bulk: 0, uncertain: 0, unclassified: 0, all: 0 },
    };
    const handler = createOrcaMcpHttpHandler({
      dataSource: {
        getCurrentAccountIds: () => ["account"],
        describeOrganization: unavailable,
        queryOrganization: unavailable,
        simulateOrganization: unavailable,
        applyOrganization: unavailable,
        revertOrganization: unavailable,
        searchMail: () => {
          dispatchCalls += 1;
          return { messages: [], counts: emptyCounts, nextCursor: null };
        },
        getThread: unavailable,
        listAgentEvents: unavailable,
        getConnectionStatus: unavailable,
        sourceUrl: () => resource,
      },
      policy: { enabled: true, issuer, resource },
      requestLimiter: new McpRequestLimiter({ maximumConnectionCost: 2, maximumWorkspaceCost: 2 }),
      verifier: {
        async verifyAccessToken(token) {
          verifierCalls += 1;
          return {
            token,
            clientId: "client",
            scopes: ["mail:read"],
            expiresAt: Math.floor(Date.now() / 1_000) + 600,
            resource: new URL(resource),
            extra: {
              orcaAuthorization: orcaAgentAuthorizationContextSchema.parse({
                connectionId: "connection", clientId: "client", userId: "workspace", accountIds: ["account"],
                issuer, resource, scopes: ["orca:mail.metadata:read"], issuedAt: new Date(), expiresAt: new Date(Date.now() + 600_000),
              }),
              grantRevokedAt: null,
            },
          };
        },
      },
    });
    const request = (id: number) => ({
      jsonrpc: "2.0", id, method: "tools/call",
      params: { name: "search_mail", arguments: { accountId: "account", limit: 1 } },
    });
    const response = await handler.fetch(new Request(resource, {
      method: "POST",
      headers: {
        authorization: "Bearer bounded-token", host: "api.orca.test",
        accept: "application/json, text/event-stream", "content-type": "application/json",
      },
      body: JSON.stringify([request(1), request(2)]),
    }));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "invalid_request");
    assert.equal(verifierCalls, 0);
    assert.equal(dispatchCalls, 0);
  });
});
