import { InMemoryMailOAuthTransactionStore } from "../mail-oauth-transactions.ts";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { decryptSecret } from "../gmail/crypto.ts";
import { InMemoryOAuthAccountStore } from "../gmail/oauth-accounts.ts";
import { createOutlookOAuthService } from "./oauth.ts";
import type { OutlookOAuthConfig } from "./config.ts";

const key = Buffer.alloc(32, 7).toString("base64");
const config: OutlookOAuthConfig = { clientId: "client", clientSecret: "secret", tenant: "common", redirectUri: "http://localhost:3000/v1/auth/outlook/callback", scopes: ["openid", "offline_access", "User.Read", "Mail.Read"], tokenEncryptionKey: key, stateSecret: "state-secret", successRedirectUrl: "http://localhost:5173/onboarding", errorRedirectUrl: "http://localhost:5173/login", webOrigin: "http://localhost:5173" };

describe("Outlook OAuth", () => {
  test("uses read-first Microsoft scopes and persists encrypted tokens", async () => {
    const store = new InMemoryOAuthAccountStore();
    const requests: string[] = [];
    let expectedChallenge = "";
    const service = createOutlookOAuthService({ transactions: new InMemoryMailOAuthTransactionStore(), config, store, fetch: async (input, init) => {
      requests.push(String(input));
      if (String(input).includes("/token")) {
        const body = new URLSearchParams(String(init?.body));
        expect(init?.method).toBe("POST");
        expect(createHash("sha256").update(body.get("code_verifier")!).digest("base64url")).toBe(expectedChallenge);
        return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: "User.Read Mail.Read offline_access" });
      }
      if (String(input).endsWith("/photo/$value")) {
        return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
      }
      return Response.json({ id: "microsoft-user", mail: "person@outlook.com" });
    } });
    const authorization = service.getAuthorizationUrl({ userId: "user-1", sessionId: "session-1" }, "http://localhost:5173/onboarding", "pending-test@orca.invalid");
    const authUrl = new URL(authorization.url);
    expect(authUrl.hostname).toBe("login.microsoftonline.com");
    expect(authUrl.searchParams.get("scope")).toContain("Mail.Read");
    expect(authUrl.searchParams.get("scope")).not.toContain("Mail.ReadWrite");
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expectedChallenge = authUrl.searchParams.get("code_challenge")!;
    expect(authorization.state).not.toContain(".");

    const result = await service.handleCallback(new URLSearchParams({ code: "code", state: authorization.state }), { userId: "user-1", sessionId: "session-1" });
    expect(result.ok).toBe(true);
    expect(requests).toEqual([expect.stringContaining("/token"), "https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName", "https://graph.microsoft.com/v1.0/me/photo/$value"]);
    const account = store.getAll()[0]!;
    expect(account.provider).toBe("outlook");
    expect(account.encryptedAccessToken).not.toContain("access");
    expect(decryptSecret(account.encryptedAccessToken, key)).toBe("access");
    expect(account.profileImageUrl).toBe("data:image/png;base64,AQID");
  });

  test("rejects a tampered state before exchanging tokens", async () => {
    const service = createOutlookOAuthService({ transactions: new InMemoryMailOAuthTransactionStore(), config, store: new InMemoryOAuthAccountStore(), fetch: async () => { throw new Error("must not fetch"); } });
    const { state } = service.getAuthorizationUrl({ userId: "user-1", sessionId: "session-1" });
    const result = await service.handleCallback(new URLSearchParams({ code: "code", state: `${state}x` }), { userId: "user-1", sessionId: "session-1" });
    expect(result).toMatchObject({ ok: false, code: "invalid_state" });
  });
});
