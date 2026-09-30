import assert from "node:assert/strict";
import { describe, test } from "bun:test";

import { orcaMcpTools } from "@orca/shared";

import { orcaAgentAuthorizationContextSchema } from "./authorization.ts";
import { createOrcaMcpHttpHandler } from "./mcp.ts";
import { McpRequestLimiter, mcpToolRequestCost } from "./request-guards.ts";

const unknownNames = ["toString", "constructor", "__proto__", "hasOwnProperty", "missing_tool", ""];

function release(lease: ReturnType<McpRequestLimiter["acquire"]>) {
  assert.equal(lease.allowed, true);
  if (lease.allowed) lease.release();
}

function fixture(limiter: McpRequestLimiter) {
  const issuer = "https://identity.orca.test";
  const resource = "https://api.orca.test/mcp";
  let verifierCalls = 0;
  let dispatchCalls = 0;
  const unavailable = () => { throw new Error("unexpected tool dispatch"); };
  const handler = createOrcaMcpHttpHandler({
    policy: { enabled: true, issuer, resource },
    requestLimiter: limiter,
    dataSource: {
      getCurrentAccountIds: () => ["account"],
      describeOrganization: unavailable,
      queryOrganization: unavailable,
      simulateOrganization: unavailable,
      applyOrganization: unavailable,
      revertOrganization: unavailable,
      searchMail: () => {
        dispatchCalls += 1;
        return {
          messages: [],
          counts: {
            attention: { focus: 0, normal: 0, quiet: 0, hidden: 0, all: 0 },
            classification: { likely_human: 0, automated_or_bulk: 0, uncertain: 0, unclassified: 0, all: 0 },
          },
          nextCursor: null,
        };
      },
      getThread: unavailable,
      listAgentEvents: unavailable,
      getConnectionStatus: unavailable,
      sourceUrl: () => resource,
    },
    verifier: {
      async verifyAccessToken(token) {
        verifierCalls += 1;
        return {
          token, clientId: "client", scopes: ["mail:read"],
          expiresAt: Math.floor(Date.now() / 1_000) + 600,
          resource: new URL(resource),
          extra: {
            orcaAuthorization: orcaAgentAuthorizationContextSchema.parse({
              connectionId: token, clientId: "client", userId: "workspace", accountIds: ["account"],
              issuer, resource, scopes: ["orca:mail.metadata:read"],
              issuedAt: new Date(), expiresAt: new Date(Date.now() + 600_000),
            }),
            grantRevokedAt: null,
          },
        };
      },
    },
  });
  return {
    calls: () => ({ verifierCalls, dispatchCalls }),
    request: (body: unknown, connectionId = "connection-a", authenticated = true, modern = false, headers: Record<string, string> = {}) => handler.fetch(new Request(resource, {
      method: "POST",
      headers: {
        ...(authenticated ? { authorization: `Bearer ${connectionId}` } : {}),
        ...(modern ? {
          "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call",
          "mcp-name": (body as ReturnType<typeof call>).params.name,
        } : {}),
        host: "api.orca.test", accept: "application/json, text/event-stream", "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    })),
  };
}

function call(name: string, id: string | number = 1, modern = false) {
  return {
    jsonrpc: "2.0", id, method: "tools/call",
    params: {
      name, arguments: { accountId: "account", limit: 1 },
      ...(modern ? { _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
      } } : {}),
    },
  };
}

describe("BRE-422 MCP numeric cost budgets", () => {
  test("cost lookup returns numeric weights only for own tool names and preserves no-name metadata cost", () => {
    const expected = [1, 2, 10, 5, 5, 2, 2, 2, 1];
    for (const [index, tool] of orcaMcpTools.entries()) assert.equal(mcpToolRequestCost(tool.name), expected[index]);
    for (const name of [...unknownNames, null]) assert.equal(mcpToolRequestCost(name), 1);
  });

  test("rejects invalid runtime costs before clock, sweep, keys, counters, or active leases are touched", () => {
    let clockCalls = 0;
    const limiter = new McpRequestLimiter({
      now: () => { clockCalls += 1; return 1_000; },
      maximumConnectionCost: 2, maximumWorkspaceCost: 4,
      maximumConnectionInFlight: 1, maximumWorkspaceInFlight: 2,
    });
    const invalid = [NaN, Infinity, -Infinity, -1, 0, 0.5, "1", () => 1, {}, null, undefined];
    const assertInvalid = (connectionId: string, workspaceId: string) => {
      const before = limiter.getStateObservability();
      const previousClockCalls = clockCalls;
      for (const cost of invalid) {
        assert.throws(() => limiter.acquire({ connectionId, workspaceId, cost: cost as number }), RangeError);
        assert.deepEqual(limiter.getStateObservability(), before);
        assert.equal(clockCalls, previousClockCalls);
      }
    };
    assertInvalid("invalid-connection", "invalid-workspace");
    const first = limiter.acquire({ connectionId: "a", workspaceId: "workspace", cost: 2 });
    assertInvalid("a", "workspace");
    assert.deepEqual(limiter.acquire({ connectionId: "a", workspaceId: "workspace", cost: 1 }), {
      allowed: false, retryAfterSeconds: 60, reason: "connection_in_flight",
    });
    release(first);
    assert.deepEqual(limiter.acquire({ connectionId: "a", workspaceId: "workspace", cost: 1 }), {
      allowed: false, retryAfterSeconds: 60, reason: "connection_rate",
    });
    release(limiter.acquire({ connectionId: "b", workspaceId: "workspace", cost: 2 }));
    assert.deepEqual(limiter.acquire({ connectionId: "c", workspaceId: "workspace", cost: 1 }), {
      allowed: false, retryAfterSeconds: 60, reason: "workspace_rate",
    });
  });

  for (const encoding of ["legacy", "modern", "payload"] as const) {
    test(`rejects unknown ${encoding} tool names without admission and later enforces both budgets`, async () => {
      const limiter = new McpRequestLimiter({ maximumConnectionCost: 2, maximumWorkspaceCost: 4 });
      const { request, calls } = fixture(limiter);
      const before = limiter.getStateObservability();
      for (const [index, name] of unknownNames.entries()) {
        const rpc = call(name, `unknown-${index}`, encoding === "modern");
        const response = await request(encoding === "payload" ? { payload: rpc } : rpc, "connection-a", true, encoding === "modern");
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), {
          jsonrpc: "2.0", id: rpc.id, error: { code: -32602, message: `Tool ${name} not found` },
        });
        assert.deepEqual(limiter.getStateObservability(), before);
      }
      assert.deepEqual(calls(), { verifierCalls: unknownNames.length, dispatchCalls: 0 });
      const accepted = await request(call("search_mail", 1, encoding === "modern"), "connection-a", true, encoding === "modern");
      assert.equal(accepted.status, 200);
      await accepted.text();
      assert.equal(calls().dispatchCalls, 1);
      const connectionLimited = await request(call("search_mail", 2));
      assert.equal(connectionLimited.status, 429);
      assert.equal((await connectionLimited.json()).error.code, "rate_limit");
      const otherConnection = await request(call("search_mail", 3), "connection-b");
      assert.equal(otherConnection.status, 200);
      await otherConnection.text();
      const workspaceLimited = await request(call("search_mail", 4), "connection-c");
      assert.equal(workspaceLimited.status, 429);
      assert.equal((await workspaceLimited.json()).error.code, "rate_limit");
      assert.equal(calls().dispatchCalls, 2);
    });
  }

  test("preserves bearer challenges for unknown tools and unit-cost metadata admission", async () => {
    const limiter = new McpRequestLimiter({ maximumConnectionCost: 1, maximumWorkspaceCost: 1 });
    const { request, calls } = fixture(limiter);
    const unauthenticated = await request(call("toString"), "connection-a", false);
    assert.equal(unauthenticated.status, 401);
    assert.ok(unauthenticated.headers.get("www-authenticate"));
    assert.equal(limiter.getStateObservability().connections, 0);
    const tools = await request({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    assert.equal(tools.status, 200);
    await tools.text();
    const exhausted = await request({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.equal(exhausted.status, 429);
    assert.equal(calls().dispatchCalls, 0);
  });

  test("leaves missing tool names to SDK validation while retaining their unit request cost", async () => {
    const limiter = new McpRequestLimiter({ maximumConnectionCost: 1, maximumWorkspaceCost: 1 });
    const { request, calls } = fixture(limiter);
    const body = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { arguments: {} } };
    const invalid = await request(body);
    const text = await invalid.text();
    assert.ok(text.includes('"error"'), text);
    assert.equal(limiter.getStateObservability().connections, 1);
    const exhausted = await request({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.equal(exhausted.status, 429);
    assert.equal(calls().dispatchCalls, 0);
  });

  test("modern headers cannot select a different dispatch tool or undercharge the body tool", async () => {
    const limiter = new McpRequestLimiter({ maximumConnectionCost: 2, maximumWorkspaceCost: 2 });
    const { request, calls } = fixture(limiter);
    const mismatch = await request(call("search_mail", 1, true), "connection-a", true, true, {
      "mcp-name": "describe_organization",
    });
    assert.equal(mismatch.status, 400);
    assert.equal((await mismatch.json()).error.code, -32020);
    assert.equal(calls().dispatchCalls, 0);
    const exhausted = await request(call("search_mail", 2));
    assert.equal(exhausted.status, 429, "admission must use the body tool's cost, never the mismatched header's lower cost");
  });

  test("payload copies and method headers cannot turn metadata into an uncharged tool dispatch", async () => {
    const { request, calls } = fixture(new McpRequestLimiter());
    const metadata = await request({
      jsonrpc: "2.0", id: 1, method: "tools/list",
      params: { _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
      } },
      payload: call("search_mail", 2, true),
    }, "connection-a", true, false, {
      "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "search_mail",
    });
    assert.equal(metadata.status, 400);
    assert.equal((await metadata.json()).error.code, -32600);
    assert.equal(calls().dispatchCalls, 0);
  });
});
