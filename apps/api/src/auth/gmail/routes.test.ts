import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";

import type { AuthVariables } from "../middleware.ts";
import type { GmailOAuthConfig } from "./config.ts";
import { decryptSecret } from "./crypto.ts";
import { InMemoryOAuthAccountStore } from "./oauth-accounts.ts";
import { createGmailAuthApp, redirectReturningUserToWorkspace } from "./routes.ts";

const config: GmailOAuthConfig = {
  clientId: "client-id",
  clientSecret: "client-secret",
  redirectUri: "http://localhost:3000/v1/auth/gmail/callback",
  scopes: [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/userinfo.email",
  ],
  composeScopes: ["https://www.googleapis.com/auth/gmail.compose"],
  tokenEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
  stateSecret: "test-state-secret",
  successRedirectUrl: "http://localhost:5173/settings/integrations/gmail",
  errorRedirectUrl: "http://localhost:5173/settings/integrations/gmail",
  webOrigin: "http://localhost:5173",
};

const authMiddleware: MiddlewareHandler<{ Variables: AuthVariables }> = async (c, next) => {
  c.set("auth", {
    sessionId: "session_1",
    userId: "user_1",
    expiresAt: new Date("2026-07-01T00:00:00.000Z"),
  });

  await next();
};

describe("Gmail auth routes", () => {
  test("sends returning users to their workspace while retaining callback status", () => {
    expect(
      redirectReturningUserToWorkspace(
        "https://orca.example/onboarding?status=success&email=luke%40example.com",
      ),
    ).toBe("https://orca.example/?status=success&email=luke%40example.com");
  });

  test("connect returns a Google authorization URL", async () => {
    const app = createGmailAuthApp({
      authMiddleware,
      config,
      store: new InMemoryOAuthAccountStore(),
    });

    const response = await app.request(
      "/connect?returnTo=http%3A%2F%2Flocalhost%3A5173%2Fsettings%2Fintegrations%2Fgmail",
    );
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      authUrl: string;
      state: string;
      redirectUri: string;
      scopes: string[];
    };
    expect(body.redirectUri).toBe(config.redirectUri);
    expect(body.scopes).toEqual(config.scopes);

    const authUrl = new URL(body.authUrl);
    expect(authUrl.origin).toBe("https://accounts.google.com");
    expect(authUrl.searchParams.get("client_id")).toBe(config.clientId);
    expect(authUrl.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    expect(authUrl.searchParams.get("scope")).toBe(config.scopes.join(" "));
    expect(authUrl.searchParams.get("state")).toBe(body.state);
  });

  test("callback exchanges code, encrypts tokens, and upserts an oauth account record", async () => {
    const store = new InMemoryOAuthAccountStore();
    const app = createGmailAuthApp({
      authMiddleware,
      config,
      store,
      fetch: async (input, init) => {
        const url = input.toString();

        if (url === "https://oauth2.googleapis.com/token") {
          expect(init?.method).toBe("POST");
          return Response.json({
            access_token: "access-token-123",
            refresh_token: "refresh-token-456",
            expires_in: 3600,
            scope: config.scopes.join(" "),
          });
        }

        if (url === "https://www.googleapis.com/oauth2/v2/userinfo") {
          expect(init?.headers).toMatchObject({
            authorization: "Bearer access-token-123",
          });
          return Response.json({
            id: "google-user-1",
            email: "luke@gmail.com",
          });
        }

        throw new Error(`Unexpected fetch: ${url}`);
      },
    });

    const connectResponse = await app.request(
      "/connect?returnTo=http%3A%2F%2Flocalhost%3A5173%2Fsettings%2Fintegrations%2Fgmail",
    );
    const connectBody = (await connectResponse.json()) as { state: string };

    const callbackResponse = await app.request(
      `/callback?code=test-code&state=${encodeURIComponent(connectBody.state)}`,
      { redirect: "manual" },
    );

    expect(callbackResponse.status).toBe(302);
    const location = callbackResponse.headers.get("location");
    expect(location).toContain("status=success");
    expect(location).toContain("email=luke%40gmail.com");

    const records = store.getAll();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      userId: "user_1",
      provider: "gmail",
      providerAccountId: "google-user-1",
      providerEmail: "luke@gmail.com",
      grantedScopes: config.scopes,
    });
    expect(records[0].encryptedAccessToken).not.toBe("access-token-123");
    expect(records[0].encryptedRefreshToken).not.toBe("refresh-token-456");
    expect(decryptSecret(records[0].encryptedAccessToken, config.tokenEncryptionKey)).toBe(
      "access-token-123",
    );
    expect(decryptSecret(records[0].encryptedRefreshToken!, config.tokenEncryptionKey)).toBe(
      "refresh-token-456",
    );
  });

  test("callback ignores cross-origin returnTo values and falls back to the configured redirect", async () => {
    const app = createGmailAuthApp({
      authMiddleware,
      config,
      store: new InMemoryOAuthAccountStore(),
      fetch: async (input) => {
        const url = input.toString();

        if (url === "https://oauth2.googleapis.com/token") {
          return Response.json({
            access_token: "access-token-123",
            expires_in: 3600,
          });
        }

        if (url === "https://www.googleapis.com/oauth2/v2/userinfo") {
          return Response.json({
            id: "google-user-1",
            email: "luke@gmail.com",
          });
        }

        throw new Error(`Unexpected fetch: ${url}`);
      },
    });

    const connectResponse = await app.request(
      "/connect?returnTo=https%3A%2F%2Fevil.example%2Fsteal",
    );
    const connectBody = (await connectResponse.json()) as { state: string };

    const callbackResponse = await app.request(
      `/callback?code=test-code&state=${encodeURIComponent(connectBody.state)}`,
      { redirect: "manual" },
    );

    expect(callbackResponse.status).toBe(302);
    expect(callbackResponse.headers.get("location")).toStartWith(
      "http://localhost:5173/settings/integrations/gmail",
    );
    expect(callbackResponse.headers.get("location")).not.toContain("evil.example");
  });

  test("callback redirects with a clear error state when Google denies access", async () => {
    const app = createGmailAuthApp({
      authMiddleware,
      config,
      store: new InMemoryOAuthAccountStore(),
    });

    const connectResponse = await app.request("/connect");
    const connectBody = (await connectResponse.json()) as { state: string };

    const callbackResponse = await app.request(
      `/callback?error=access_denied&state=${encodeURIComponent(connectBody.state)}`,
      { redirect: "manual" },
    );

    expect(callbackResponse.status).toBe(302);
    const location = callbackResponse.headers.get("location");
    expect(location).toContain("status=error");
    expect(location).toContain("reason=provider_error");
    expect(location).toContain("access_denied");
  });

  test("upgrade requests only gmail.compose and identifies the existing account", async () => {
    const store = new InMemoryOAuthAccountStore();
    const existing = await seedReadOnlyAccount(store);
    const app = createGmailAuthApp({ authMiddleware, config, store });

    const response = await app.request("/upgrade?returnTo=http%3A%2F%2Flocalhost%3A5173%2F%3Fcompose%3D1");
    expect(response.status).toBe(200);
    const body = await response.json() as { accountId: string; scopes: string[]; authUrl: string };
    expect(body.accountId).toBe(existing.id);
    expect(body.scopes).toEqual(config.composeScopes);
    const authUrl = new URL(body.authUrl);
    expect(authUrl.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.compose");
    expect(authUrl.searchParams.get("include_granted_scopes")).toBe("true");
  });

  test("denied upgrade leaves the existing read-only grant untouched", async () => {
    const store = new InMemoryOAuthAccountStore();
    const existing = await seedReadOnlyAccount(store);
    const app = createGmailAuthApp({ authMiddleware, config, store });
    const connect = await (await app.request("/upgrade?returnTo=http%3A%2F%2Flocalhost%3A5173%2F%3Fcompose%3D1")).json() as { state: string };
    const response = await app.request(`/callback?error=access_denied&state=${encodeURIComponent(connect.state)}`, { redirect: "manual" });

    expect(response.headers.get("location")).toContain("intent=upgrade");
    expect(await store.findById("user_1", existing.id)).toEqual(existing);
  });

  test("upgrade rejects a different Google account without creating or replacing a connection", async () => {
    const store = new InMemoryOAuthAccountStore();
    const existing = await seedReadOnlyAccount(store);
    const app = createGmailAuthApp({
      authMiddleware, config, store,
      fetch: async (input) => input.toString().includes("token")
        ? Response.json({ access_token: "compose-access", scope: config.composeScopes.join(" ") })
        : Response.json({ id: "different-google-user", email: "other@gmail.com" }),
    });
    const connect = await (await app.request("/upgrade?returnTo=http%3A%2F%2Flocalhost%3A5173%2F%3Fcompose%3D1")).json() as { state: string };
    const response = await app.request(`/callback?code=upgrade-code&state=${encodeURIComponent(connect.state)}`, { redirect: "manual" });

    expect(response.headers.get("location")).toContain("reason=account_mismatch");
    expect(store.getAll()).toEqual([existing]);
  });

  test("successful upgrade merges capabilities and preserves the refresh grant", async () => {
    const store = new InMemoryOAuthAccountStore();
    const existing = await seedReadOnlyAccount(store);
    const app = createGmailAuthApp({
      authMiddleware, config, store,
      fetch: async (input) => input.toString().includes("token")
        ? Response.json({ access_token: "compose-access", scope: config.composeScopes.join(" ") })
        : Response.json({ id: "google-user-1", email: "luke@gmail.com" }),
    });
    const connect = await (await app.request("/upgrade?returnTo=http%3A%2F%2Flocalhost%3A5173%2F%3Fcompose%3D1")).json() as { state: string };
    const response = await app.request(`/callback?code=upgrade-code&state=${encodeURIComponent(connect.state)}`, { redirect: "manual" });
    const upgraded = store.getAll()[0]!;

    expect(response.headers.get("location")).toContain("status=success");
    expect(response.headers.get("location")).toContain("intent=upgrade");
    expect(upgraded.id).toBe(existing.id);
    expect(upgraded.grantedScopes).toEqual([...config.scopes, ...config.composeScopes]);
    expect(upgraded.encryptedRefreshToken).toBe("encrypted-read-refresh");
    expect(decryptSecret(upgraded.encryptedAccessToken, config.tokenEncryptionKey)).toBe("compose-access");
  });
});

async function seedReadOnlyAccount(store: InMemoryOAuthAccountStore) {
  return store.upsert({
    userId: "user_1",
    provider: "gmail",
    providerAccountId: "google-user-1",
    providerEmail: "luke@gmail.com",
    grantedScopes: config.scopes,
    encryptedAccessToken: "encrypted-read-access",
    encryptedRefreshToken: "encrypted-read-refresh",
    expiresAt: null,
  });
}
