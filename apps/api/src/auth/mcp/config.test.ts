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
      signingKey: null,
      signingKeyId: "mcp-v1",
      allowedRedirectUris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
      registrationLimitPerMinute: 30,
    });
  });

  test("caps token lifetimes at the architecture boundary", () => {
    const config = getMcpOAuthConfig({
      ORCA_M6_MCP_ENABLED: "true",
      ORCA_M6_MCP_ISSUER: "https://api.example.com/",
      ORCA_M6_MCP_RESOURCE: "https://api.example.com/mcp/",
      ORCA_M6_MCP_ACCESS_TOKEN_TTL_SECONDS: "3600",
      ORCA_M6_MCP_REFRESH_TOKEN_TTL_SECONDS: "99999999",
      ORCA_M6_MCP_SIGNING_KEY: Buffer.alloc(32, 9).toString("base64"),
    });
    assert.equal(config.enabled, true);
    assert.equal(config.issuer, "https://api.example.com");
    assert.equal(config.resource, "https://api.example.com/mcp");
    assert.equal(config.accessTokenTtlMs, 600_000);
    assert.equal(config.refreshTokenTtlMs, 2_592_000_000);
  });

  test("accepts only configured exact redirect URIs", () => {
    const redirects = { allowedRedirectUris: ["https://chatgpt.com/connector_platform_oauth_redirect", "http://127.0.0.1:48123/callback"] };
    assert.equal(isAllowedMcpRedirectUri("https://chatgpt.com/connector_platform_oauth_redirect", redirects), true);
    assert.equal(isAllowedMcpRedirectUri("http://127.0.0.1:48123/callback", redirects), true);
    assert.equal(isAllowedMcpRedirectUri("https://chatgpt.com.evil.example/callback", redirects), false);
    assert.equal(isAllowedMcpRedirectUri("http://example.com/callback", redirects), false);
    assert.equal(isAllowedMcpRedirectUri("javascript:alert(1)", redirects), false);
    assert.equal(isAllowedMcpRedirectUri("https://chatgpt.com/connector_platform_oauth_redirect#fragment", redirects), false);
  });

  test("keeps disabled MCP from blocking production startup", () => {
    const config = getMcpOAuthConfig({ NODE_ENV: "production" });
    assert.equal(config.enabled, false);
  });

  test("requires HTTPS identifiers when MCP is enabled in production", () => {
    assert.throws(() => getMcpOAuthConfig({
      NODE_ENV: "production",
      ORCA_M6_MCP_ENABLED: "true",
      ORCA_M6_MCP_SIGNING_KEY: Buffer.alloc(32, 9).toString("base64"),
    }), /must use HTTPS/);
    assert.throws(() => getMcpOAuthConfig({ ORCA_M6_MCP_ISSUER: "https://api.example.com/auth" }), /without a path/);
  });

  test("derives protected-resource discovery from the full MCP resource identifier", () => {
    assert.equal(
      getMcpProtectedResourceMetadataUrl("https://mcp.example.com/orca/mcp"),
      "https://mcp.example.com/.well-known/oauth-protected-resource/orca/mcp",
    );
  });

  test("requires a distinct 256-bit MCP signing key when enabled", () => {
    assert.throws(() => getMcpOAuthConfig({ ORCA_M6_MCP_ENABLED: "true" }), /MCP_SIGNING_KEY/);
    assert.throws(() => getMcpOAuthConfig({ ORCA_M6_MCP_ENABLED: "true", ORCA_M6_MCP_SIGNING_KEY: "dG9vLXNob3J0" }), /32 bytes/);
  });
});
