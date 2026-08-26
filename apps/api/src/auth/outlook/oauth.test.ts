import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { decryptSecret } from "../gmail/crypto.ts";
import { InMemoryOAuthAccountStore } from "../gmail/oauth-accounts.ts";
import { createOutlookOAuthService } from "./oauth.ts";
import type { OutlookOAuthConfig } from "./config.ts";

const key = Buffer.alloc(32, 7).toString("base64");
const config: OutlookOAuthConfig = { clientId: "client", clientSecret: "secret", tenant: "common", redirectUri: "http://localhost:3000/v1/auth/outlook/callback", scopes: ["openid", "offline_access", "User.Read", "Mail.Read"], tokenEncryptionKey: key, stateSecret: "state-secret", successRedirectUrl: "http://localhost:5173/onboarding", errorRedirectUrl: "http://localhost:5173/login", webOrigin: "http://localhost:5173" };

describe("Outlook OAuth", () => {
  test("uses read-first Microsoft scopes and returns encrypted tokens for persistence", async () => {
    const store = new InMemoryOAuthAccountStore();
    const requests: string[] = [];
    const expectedCodeVerifier = "server-side-pkce-verifier";
    const service = createOutlookOAuthService({ config, store, fetch: async (input, init) => {
      requests.push(String(input));
      if (String(input).includes("/token")) {
        const body = new URLSearchParams(String(init?.body));
        expect(init?.method).toBe("POST");
        expect(body.get("code_verifier")).toBe(expectedCodeVerifier);
        return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: "User.Read Mail.Read offline_access" });
      }
      if (String(input).endsWith("/photo/$value")) {
        return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
      }
      return Response.json({ id: "microsoft-user", mail: "person@outlook.com" });
    } });
    const transaction = {
      id: "txn-1",
      provider: "outlook" as const,
      intent: "login" as const,
      sessionId: "attempt-session",
      userId: "attempt-user",
      returnTo: "http://localhost:5173/onboarding",
      accountId: null,
      codeVerifier: expectedCodeVerifier,
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
    };
    const authorization = service.getAuthorizationUrl("opaque-server-state", expectedCodeVerifier);
    const authUrl = new URL(authorization.url);
    expect(authUrl.hostname).toBe("login.microsoftonline.com");
    expect(authUrl.searchParams.get("scope")).toContain("Mail.Read");
    expect(authUrl.searchParams.get("scope")).not.toContain("Mail.ReadWrite");
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.state).toBe("opaque-server-state");
    expect(authorization.state).not.toContain(expectedCodeVerifier);
    expect(authUrl.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(expectedCodeVerifier).digest("base64url"),
    );

    const result = await service.handleCallback(new URLSearchParams({ code: "code", state: authorization.state }), transaction);
    expect(result.ok).toBe(true);
    expect(requests).toEqual([expect.stringContaining("/token"), "https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName", "https://graph.microsoft.com/v1.0/me/photo/$value"]);
    if (!result.ok) throw new Error(result.message);
    expect(result.grant.provider).toBe("outlook");
    expect(result.grant.encryptedAccessToken).not.toContain("access");
    expect(decryptSecret(result.grant.encryptedAccessToken, key)).toBe("access");
    expect(result.grant.profileImageUrl).toBe("data:image/png;base64,AQID");
  });

  test("rejects a transaction without its server-side PKCE verifier before exchanging tokens", async () => {
    const service = createOutlookOAuthService({ config, store: new InMemoryOAuthAccountStore(), fetch: async () => { throw new Error("must not fetch"); } });
    const result = await service.handleCallback(new URLSearchParams({ code: "code", state: "opaque" }), {
      id: "txn-2",
      provider: "outlook",
      intent: "connect",
      sessionId: "session",
      userId: "user-1",
      returnTo: null,
      accountId: null,
      codeVerifier: null,
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
    });
    expect(result).toMatchObject({ ok: false, code: "invalid_state" });
  });
});
