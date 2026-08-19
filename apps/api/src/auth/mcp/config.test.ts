import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { getMcpOAuthConfig, getMcpProtectedResourceMetadataUrl, isAllowedMcpRedirectUri } from "./config.ts";

describe("MCP OAuth config", () => {
  test("is default-off with local development identifiers", () => {
    assert.deepEqual(getMcpOAuthConfig({}), {
      enabled: false,
      issuer: "http://localhost:3000",
      resource: "http://localhost:3000/mcp",
      accessTokenTtlMs: 600_000,
      refreshTokenTtlMs: 2_592_000_000,
      authorizationCodeTtlMs: 300_000,
    });
  });

  test("caps token lifetimes at the architecture boundary", () => {
    const config = getMcpOAuthConfig({
      ORCA_M6_MCP_ENABLED: "true",
      ORCA_M6_MCP_ISSUER: "https://api.example.com/",
      ORCA_M6_MCP_RESOURCE: "https://api.example.com/mcp/",
      ORCA_M6_MCP_ACCESS_TOKEN_TTL_SECONDS: "3600",
      ORCA_M6_MCP_REFRESH_TOKEN_TTL_SECONDS: "99999999",
    });
    assert.equal(config.enabled, true);
    assert.equal(config.issuer, "https://api.example.com");
    assert.equal(config.resource, "https://api.example.com/mcp");
    assert.equal(config.accessTokenTtlMs, 600_000);
    assert.equal(config.refreshTokenTtlMs, 2_592_000_000);
  });

  test("accepts HTTPS and development loopback redirects only", () => {
    assert.equal(isAllowedMcpRedirectUri("https://chatgpt.com/oauth/callback"), true);
    assert.equal(isAllowedMcpRedirectUri("http://127.0.0.1:48123/callback"), true);
    assert.equal(isAllowedMcpRedirectUri("http://localhost:48123/callback"), true);
    assert.equal(isAllowedMcpRedirectUri("http://example.com/callback"), false);
    assert.equal(isAllowedMcpRedirectUri("javascript:alert(1)"), false);
    assert.equal(isAllowedMcpRedirectUri("https://example.com/callback#fragment"), false);
  });

  test("requires HTTPS identifiers in production", () => {
    assert.throws(() => getMcpOAuthConfig({ NODE_ENV: "production" }), /must use HTTPS/);
    assert.throws(() => getMcpOAuthConfig({ ORCA_M6_MCP_ISSUER: "https://api.example.com/auth" }), /without a path/);
  });

  test("derives protected-resource discovery from the MCP resource origin", () => {
    assert.equal(
      getMcpProtectedResourceMetadataUrl("https://mcp.example.com/orca/mcp?ignored=true"),
      "https://mcp.example.com/.well-known/oauth-protected-resource",
    );
  });
});
