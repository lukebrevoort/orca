import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { MiddlewareHandler } from "hono";

import type { AuthVariables } from "../middleware.ts";
import type { GmailOAuthConfig } from "./config.ts";
import { decryptSecret } from "./crypto.ts";
import { createDatabaseClient } from "../../db/client.ts";
import { oauthAccounts, users } from "../../db/schema.ts";
import { DatabaseOAuthAccountStore, InMemoryOAuthAccountStore } from "./oauth-accounts.ts";
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

  test("uses one configured database for the login session and OAuth account", async () => {
    const previousSessionSecret = process.env.SESSION_SECRET;
    const previousTokenEncryptionKey = process.env.TOKEN_ENCRYPTION_KEY;
    process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
    process.env.TOKEN_ENCRYPTION_KEY = config.tokenEncryptionKey;

    const tempDir = mkdtempSync(join(tmpdir(), "orca-gmail-login-route-test-"));
    const dbPath = join(tempDir, "login.sqlite");
    const initialClient = createDatabaseClient(dbPath);
    migrate(initialClient.db, { migrationsFolder: resolve(import.meta.dir, "../../../drizzle") });
    initialClient.sqlite.close();

    try {
      const dbFactory = () => createDatabaseClient(dbPath);
      const app = createGmailAuthApp({
        config,
        dbFactory,
        fetch: async (input) => input.toString().includes("oauth2.googleapis.com/token")
          ? Response.json({
              access_token: "login-access-token",
              refresh_token: "login-refresh-token",
              scope: config.scopes.join(" "),
            })
          : Response.json({ id: "google-login-user", email: "login@example.com" }),
      });

      const loginResponse = await app.request("/login?returnTo=http%3A%2F%2Flocalhost%3A5173%2Fonboarding");
      expect(loginResponse.status).toBe(200);
      const loginBody = (await loginResponse.json()) as { state: string };
      const sessionCookie = loginResponse.headers.get("set-cookie")?.split(";", 1)[0];
      expect(sessionCookie).toBeTruthy();

      const callbackResponse = await app.request(
        `/callback?code=login-code&state=${encodeURIComponent(loginBody.state)}`,
        { headers: { cookie: sessionCookie! }, redirect: "manual" },
      );
      expect(callbackResponse.status).toBe(302);
      expect(callbackResponse.headers.get("location")).toContain("/onboarding");

      const verificationClient = dbFactory();
      try {
        const user = verificationClient.db.select().from(users).where(eq(users.email, "login@example.com")).get();
        expect(user).toBeTruthy();
        const account = await new DatabaseOAuthAccountStore(dbFactory).findForUser(user!.id);
        expect(account).toMatchObject({
          userId: user!.id,
          providerEmail: "login@example.com",
          providerAccountId: "google-login-user",
        });
        expect(verificationClient.db.select().from(oauthAccounts).where(eq(oauthAccounts.userId, user!.id)).all()).toHaveLength(1);
      } finally {
        verificationClient.sqlite.close();
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      if (previousSessionSecret === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = previousSessionSecret;
      if (previousTokenEncryptionKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
      else process.env.TOKEN_ENCRYPTION_KEY = previousTokenEncryptionKey;
    }
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
    expect(location).not.toContain("email=");

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
    expect(location).not.toContain("access_denied");
    expect(location).not.toContain("message=");
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
        ? Response.json({ access_token: "compose-access", scope: [...config.scopes, ...config.composeScopes].join(" ") })
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

  test("treats granular consent without gmail.compose as a recoverable denial", async () => {
    const store = new InMemoryOAuthAccountStore();
    const existing = await seedReadOnlyAccount(store);
    const app = createGmailAuthApp({
      authMiddleware, config, store,
      fetch: async (input) => input.toString().includes("token")
        ? Response.json({ access_token: "read-access", scope: config.scopes.join(" ") })
        : Response.json({ id: "google-user-1", email: "luke@gmail.com" }),
    });
    const connect = await (await app.request("/upgrade?returnTo=http%3A%2F%2Flocalhost%3A5173%2Fsettings%2Fintegrations%2Fgmail")).json() as { state: string };
    const response = await app.request(`/callback?code=partial-code&state=${encodeURIComponent(connect.state)}`, { redirect: "manual" });

    expect(response.headers.get("location")).toContain("reason=compose_not_granted");
    expect(response.headers.get("location")).not.toContain("message=");
    expect(store.getAll()).toEqual([existing]);
  });

  test("trusts Google's returned scope set when an upgrade changes the current grant", async () => {
    const store = new InMemoryOAuthAccountStore();
    await seedReadOnlyAccount(store);
    const app = createGmailAuthApp({
      authMiddleware, config, store,
      fetch: async (input) => input.toString().includes("token")
        ? Response.json({ access_token: "compose-only-access", scope: config.composeScopes.join(" ") })
        : Response.json({ id: "google-user-1", email: "luke@gmail.com" }),
    });
    const connect = await (await app.request("/upgrade")).json() as { state: string };
    await app.request(`/callback?code=changed-grant&state=${encodeURIComponent(connect.state)}`, { redirect: "manual" });

    expect(store.getAll()[0]?.grantedScopes).toEqual(config.composeScopes);
  });

  test("falls back to existing plus requested scopes when Google omits scope", async () => {
    const store = new InMemoryOAuthAccountStore();
    await seedReadOnlyAccount(store);
    const app = createGmailAuthApp({
      authMiddleware, config, store,
      fetch: async (input) => input.toString().includes("token")
        ? Response.json({ access_token: "scope-omitted-access" })
        : Response.json({ id: "google-user-1", email: "luke@gmail.com" }),
    });
    const connect = await (await app.request("/upgrade")).json() as { state: string };
    const response = await app.request(`/callback?code=no-scope&state=${encodeURIComponent(connect.state)}`, { redirect: "manual" });

    expect(response.headers.get("location")).toContain("status=success");
    expect(store.getAll()[0]?.grantedScopes).toEqual([...config.scopes, ...config.composeScopes]);
  });

  test("targets an explicitly selected account for multi-account users", async () => {
    const store = new InMemoryOAuthAccountStore();
    await seedReadOnlyAccount(store);
    const second = await store.upsert({
      userId: "user_1", provider: "gmail", providerAccountId: "google-user-2", providerEmail: "work@gmail.com",
      grantedScopes: config.scopes, encryptedAccessToken: "work-access", encryptedRefreshToken: "work-refresh", expiresAt: null,
    });
    const app = createGmailAuthApp({ authMiddleware, config, store });
    const response = await app.request(`/upgrade?accountId=${encodeURIComponent(second.id)}`);
    const body = await response.json() as { accountId: string };

    expect(body.accountId).toBe(second.id);
    expect((await app.request("/upgrade?accountId=someone-elses-account")).status).toBe(404);
  });

  test("a replayed callback cannot mutate the account after Google rejects the used code", async () => {
    const store = new InMemoryOAuthAccountStore();
    await seedReadOnlyAccount(store);
    let tokenCalls = 0;
    const app = createGmailAuthApp({
      authMiddleware, config, store,
      fetch: async (input) => {
        if (input.toString().includes("token")) {
          tokenCalls += 1;
          return tokenCalls === 1
            ? Response.json({ access_token: "first-access", scope: [...config.scopes, ...config.composeScopes].join(" ") })
            : new Response(null, { status: 400 });
        }
        return Response.json({ id: "google-user-1", email: "luke@gmail.com" });
      },
    });
    const connect = await (await app.request("/upgrade")).json() as { state: string };
    const callback = `/callback?code=one-time-code&state=${encodeURIComponent(connect.state)}`;
    expect((await app.request(callback, { redirect: "manual" })).headers.get("location")).toContain("status=success");
    const afterSuccess = store.getAll()[0];
    expect((await app.request(callback, { redirect: "manual" })).headers.get("location")).toContain("reason=token_exchange_failed");
    expect(store.getAll()[0]).toEqual(afterSuccess);
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
