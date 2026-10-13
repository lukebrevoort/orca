// Deterministic synthetic reproduction only: copied existing fixture, inject the
// elapsed millisecond between its two clock reads. No application source edits.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const root = resolve(Bun.argv[2]!);
const source = (name: string) => pathToFileURL(resolve(root, "apps/api/src/agents", name)).href;
const { orcaAgentAuthorizationContextSchema } = await import(source("authorization.ts"));
const { createOrcaMcpHttpHandler } = await import(source("mcp.ts"));
const { McpRequestLimiter } = await import(source("request-guards.ts"));
let injectedClockSkewMs = 0;
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
        const capturedNow = Date.now();
        verifierCalls += 1;
        return {
          token, clientId: "client", scopes: ["mail:read"],
          expiresAt: Math.floor(Date.now() / 1_000) + 600,
          resource: new URL(resource),
          extra: {
            orcaAuthorization: orcaAgentAuthorizationContextSchema.parse({
              connectionId: token, clientId: "client", userId: "workspace", accountIds: ["account"],
              issuer, resource, scopes: ["orca:mail.metadata:read"],
              issuedAt: new Date(capturedNow), expiresAt: new Date(capturedNow + 600_000 + injectedClockSkewMs),
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


const observations = [];
for (const skew of [0, 1, 0]) {
  injectedClockSkewMs = skew;
  const limiter = new McpRequestLimiter({ maximumConnectionCost: 1, maximumWorkspaceCost: 1 });
  const { request, calls } = fixture(limiter);
  const invalid = await request({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { arguments: {} } });
  const body = await invalid.text();
  const state = limiter.getStateObservability();
  // Original test accepted either a JSON-RPC validation error or auth challenge.
  assert(body.includes('"error"'));
  assert.equal(state.connections, skew === 0 ? 1 : 0);
  if (skew === 1) assert.equal(invalid.status, 500);
  // Normalize the clock for the second request to distinguish uncharged failure
  // from the expected already-exhausted admission budget.
  injectedClockSkewMs = 0;
  const next = await request({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  await next.text();
  assert.equal(next.status, skew === 0 ? 429 : 200);
  observations.push({ injectedClockSkewMs: skew, lifetimeMs: 600000 + skew, status: invalid.status, response: body, limiter: state, nextValidRequestStatus: next.status, calls: calls() });
}
console.log(JSON.stringify({ purpose: "Deterministic pre-existing test fixture timing reproduction; does not prove the historical failure cause", runtime: Bun.version, root, fixtureSourceSha256: createHash("sha256").update(readFileSync(resolve(root,"apps/api/src/agents/mcp-cost-budgets.test.ts"))).digest("hex"), observations, passed: true }, null, 2));
