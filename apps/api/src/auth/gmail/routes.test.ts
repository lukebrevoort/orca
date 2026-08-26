import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { MiddlewareHandler } from "hono";

import type { AuthVariables } from "../middleware.ts";
import type { GmailOAuthConfig } from "./config.ts";
import { decryptSecret, encryptSecret } from "./crypto.ts";
import { createDatabaseClient } from "../../db/client.ts";
import { oauthAccounts, oauthTransactions, sessions, users } from "../../db/schema.ts";
import { createSession } from "../session-store.ts";
import { InMemoryOAuthTransactionStore } from "../oauth-transactions.ts";
import { DatabaseOAuthAccountStore, InMemoryOAuthAccountStore } from "./oauth-accounts.ts";
import { createGmailAuthApp as createProductionGmailAuthApp, redirectReturningUserToWorkspace } from "./routes.ts";
import { createApp } from "../../index.ts";

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

function createGmailAuthApp(options: NonNullable<Parameters<typeof createProductionGmailAuthApp>[0]> = {}) {
  return createProductionGmailAuthApp({
    transactionStore: options.dbFactory ? undefined : new InMemoryOAuthTransactionStore(),
    ...options,
  });
}

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

  test("authenticated connects retain the first Gmail account when a second Google identity is added", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "orca-gmail-multi-account-test-"));
    const dbPath = join(tempDir, "multi-account.sqlite");
    const initialClient = createDatabaseClient(dbPath);
    migrate(initialClient.db, { migrationsFolder: resolve(import.meta.dir, "../../../drizzle") });
    initialClient.db.insert(users).values({ id: "user_1", email: "owner@example.com" }).run();
    initialClient.sqlite.close();

    let identity = 0;
    try {
      const dbFactory = () => createDatabaseClient(dbPath);
      const app = createGmailAuthApp({
        authMiddleware,
        config,
        dbFactory,
        fetch: async (input) => input.toString().includes("oauth2.googleapis.com/token")
          ? Response.json({ access_token: `access-${identity + 1}`, refresh_token: `refresh-${identity + 1}`, scope: config.scopes.join(" ") })
          : Response.json({ id: `google-user-${++identity}`, email: `account-${identity}@example.com` }),
      });

      for (const code of ["first-code", "second-code"]) {
        const connect = await app.request("/connect?returnTo=http%3A%2F%2Flocalhost%3A5173%2Fsettings%2Fintegrations%2Fgmail");
        expect(connect.status).toBe(200);
        const { state } = await connect.json() as { state: string };
        const callback = await app.request(`/callback?code=${code}&state=${encodeURIComponent(state)}`, { redirect: "manual" });
        expect(callback.status).toBe(302);
      }

      const verification = dbFactory();
      try {
        expect(verification.db.select().from(oauthAccounts).where(eq(oauthAccounts.userId, "user_1")).all())
          .toMatchObject([
            { providerId: "google-user-1", providerEmail: "account-1@example.com" },
            { providerId: "google-user-2", providerEmail: "account-2@example.com" },
          ]);
      } finally {
        verification.sqlite.close();
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("binds connect callbacks to the initiating session and consumes them before provider calls", async () => {
    const previousSessionSecret = process.env.SESSION_SECRET;
    const previousTokenEncryptionKey = process.env.TOKEN_ENCRYPTION_KEY;
    process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
    process.env.TOKEN_ENCRYPTION_KEY = config.tokenEncryptionKey;
    const tempDir = mkdtempSync(join(tmpdir(), "orca-gmail-bound-connect-"));
    const dbPath = join(tempDir, "bound-connect.sqlite");
    const initial = createDatabaseClient(dbPath);
    migrate(initial.db, { migrationsFolder: resolve(import.meta.dir, "../../../drizzle") });
    initial.db.insert(users).values([
      { id: "user_a", email: "a@example.com" },
      { id: "user_b", email: "b@example.com" },
    ]).run();
    const sessionA = await createSession(initial.db, "user_a");
    const sessionB = await createSession(initial.db, "user_b");
    initial.sqlite.close();
    let providerCalls = 0;

    try {
      const dbFactory = () => createDatabaseClient(dbPath);
      const app = createGmailAuthApp({
        config,
        dbFactory,
        fetch: async (input) => {
          providerCalls += 1;
          return input.toString().includes("oauth2.googleapis.com/token")
            ? Response.json({ access_token: "bound-access", scope: config.scopes.join(" ") })
            : Response.json({ id: "bound-google", email: "bound@gmail.com" });
        },
      });
      const cookieA = `orca_session=${sessionA.token}`;
      const cookieB = `orca_session=${sessionB.token}`;
      const start = await app.request("/connect", { headers: { cookie: cookieA } });
      const { state } = await start.json() as { state: string };
      const callback = `/callback?code=bound-code&state=${encodeURIComponent(state)}`;

      const crossed = await app.request(callback, { headers: { cookie: cookieB }, redirect: "manual" });
      expect(crossed.headers.get("location")).toContain("reason=invalid_state");
      expect(providerCalls).toBe(0);

      const accepted = await app.request(callback, { headers: { cookie: cookieA }, redirect: "manual" });
      expect(accepted.headers.get("location")).toContain("status=success");
      expect(providerCalls).toBe(2);
      const replay = await app.request(callback, { headers: { cookie: cookieA }, redirect: "manual" });
      expect(replay.headers.get("location")).toContain("reason=invalid_state");
      expect(providerCalls).toBe(2);

      const verification = dbFactory();
      try {
        expect(verification.db.select().from(oauthAccounts).all()).toMatchObject([{ userId: "user_a", providerId: "bound-google" }]);
      } finally {
        verification.sqlite.close();
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      if (previousSessionSecret === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = previousSessionSecret;
      if (previousTokenEncryptionKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
      else process.env.TOKEN_ENCRYPTION_KEY = previousTokenEncryptionKey;
    }
  });

  test("reconnect carries the selected stacked account through OAuth", async () => {
    const store = new InMemoryOAuthAccountStore();
    const first = await seedReadOnlyAccount(store);
    const second = await store.upsert({
      userId: "user_1", provider: "gmail", providerAccountId: "google-user-2", providerEmail: "work@gmail.com",
      grantedScopes: config.scopes, encryptedAccessToken: "work-access", encryptedRefreshToken: "work-refresh", expiresAt: null,
    });
    const app = createGmailAuthApp({
      authMiddleware,
      config,
      store,
      fetch: async (input) => input.toString().includes("token")
        ? Response.json({ access_token: "reconnected-access", refresh_token: "reconnected-refresh", scope: config.scopes.join(" ") })
        : Response.json({ id: "google-user-2", email: "work@gmail.com" }),
    });

    const connect = await (await app.request(`/connect?accountId=${encodeURIComponent(second.id)}`)).json() as { state: string };
    const callback = await app.request(`/callback?code=reconnect-code&state=${encodeURIComponent(connect.state)}`, { redirect: "manual" });

    expect(callback.headers.get("location")).toContain("status=success");
    expect(store.getAll().find((account) => account.id === first.id)?.encryptedAccessToken).toBe("encrypted-read-access");
    expect(store.getAll().find((account) => account.id === second.id)?.encryptedAccessToken).not.toBe("work-access");
    expect(store.getAll()).toHaveLength(2);
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

      const beforeCallback = dbFactory();
      try {
        expect(beforeCallback.db.select().from(users).all()).toEqual([]);
        expect(beforeCallback.db.select().from(sessions).all()).toEqual([]);
        expect(beforeCallback.db.select().from(oauthTransactions).all()).toHaveLength(1);
      } finally {
        beforeCallback.sqlite.close();
      }

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

  test("binds login callbacks to the exact ephemeral attempt and rejects replay without durable pre-auth state", async () => {
    const previousSessionSecret = process.env.SESSION_SECRET;
    const previousTokenEncryptionKey = process.env.TOKEN_ENCRYPTION_KEY;
    process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
    process.env.TOKEN_ENCRYPTION_KEY = config.tokenEncryptionKey;
    const tempDir = mkdtempSync(join(tmpdir(), "orca-gmail-bound-login-"));
    const dbPath = join(tempDir, "bound-login.sqlite");
    const initial = createDatabaseClient(dbPath);
    migrate(initial.db, { migrationsFolder: resolve(import.meta.dir, "../../../drizzle") });
    initial.sqlite.close();
    let providerCalls = 0;

    try {
      const dbFactory = () => createDatabaseClient(dbPath);
      const app = createGmailAuthApp({
        config,
        dbFactory,
        fetch: async (input) => {
          providerCalls += 1;
          return input.toString().includes("oauth2.googleapis.com/token")
            ? Response.json({ access_token: "login-access", refresh_token: "login-refresh", scope: config.scopes.join(" ") })
            : Response.json({ id: "login-google", email: "new-login@example.com" });
        },
      });
      const startA = await app.request("/login");
      const startB = await app.request("/login");
      const stateA = (await startA.json() as { state: string }).state;
      const cookieA = startA.headers.get("set-cookie")!.split(";", 1)[0]!;
      const cookieB = startB.headers.get("set-cookie")!.split(";", 1)[0]!;
      const callback = `/callback?code=login-code&state=${encodeURIComponent(stateA)}`;

      const before = dbFactory();
      try {
        expect(before.db.select().from(users).all()).toEqual([]);
        expect(before.db.select().from(sessions).all()).toEqual([]);
        expect(before.db.select().from(oauthTransactions).all()).toHaveLength(2);
      } finally {
        before.sqlite.close();
      }

      const crossed = await app.request(callback, { headers: { cookie: cookieB }, redirect: "manual" });
      expect(crossed.headers.get("location")).toContain("reason=invalid_state");
      expect(providerCalls).toBe(0);

      const accepted = await app.request(callback, { headers: { cookie: cookieA }, redirect: "manual" });
      expect(accepted.headers.get("location")).toContain("status=success");
      expect(providerCalls).toBe(2);
      const replay = await app.request(callback, { headers: { cookie: cookieA }, redirect: "manual" });
      expect(replay.headers.get("location")).toContain("reason=invalid_state");
      expect(providerCalls).toBe(2);

      const after = dbFactory();
      try {
        expect(after.db.select().from(users).all()).toHaveLength(1);
        expect(after.db.select().from(sessions).all()).toHaveLength(1);
        expect(after.db.select().from(oauthAccounts).all()).toMatchObject([{ provider: "gmail", providerId: "login-google" }]);
      } finally {
        after.sqlite.close();
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      if (previousSessionSecret === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = previousSessionSecret;
      if (previousTokenEncryptionKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
      else process.env.TOKEN_ENCRYPTION_KEY = previousTokenEncryptionKey;
    }
  });

  test("does not merge or mutate an unrelated completed user that only shares the provider email", async () => {
    const previousSessionSecret = process.env.SESSION_SECRET;
    const previousTokenEncryptionKey = process.env.TOKEN_ENCRYPTION_KEY;
    process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
    process.env.TOKEN_ENCRYPTION_KEY = config.tokenEncryptionKey;
    const tempDir = mkdtempSync(join(tmpdir(), "orca-gmail-login-conflict-"));
    const dbPath = join(tempDir, "identity-conflict.sqlite");
    const initial = createDatabaseClient(dbPath);
    migrate(initial.db, { migrationsFolder: resolve(import.meta.dir, "../../../drizzle") });
    const originalAuthenticatedAt = new Date("2026-01-01T00:00:00.000Z");
    initial.db.insert(users).values({ id: "completed_user", email: "shared@example.com", authenticatedAt: originalAuthenticatedAt }).run();
    initial.sqlite.close();

    try {
      const dbFactory = () => createDatabaseClient(dbPath);
      const app = createGmailAuthApp({
        config,
        dbFactory,
        fetch: async (input) => input.toString().includes("oauth2.googleapis.com/token")
          ? Response.json({ access_token: "attacker-access", scope: config.scopes.join(" ") })
          : Response.json({ id: "different-google-identity", email: "shared@example.com" }),
      });
      const start = await app.request("/login");
      const { state } = await start.json() as { state: string };
      const attemptCookie = start.headers.get("set-cookie")!.split(";", 1)[0]!;
      const callback = await app.request(`/callback?code=conflict-code&state=${encodeURIComponent(state)}`, {
        headers: { cookie: attemptCookie },
        redirect: "manual",
      });
      expect(callback.headers.get("location")).toContain("reason=account_identity_conflict");

      const after = dbFactory();
      try {
        expect(after.db.select().from(users).all()).toEqual([expect.objectContaining({
          id: "completed_user",
          email: "shared@example.com",
          authenticatedAt: originalAuthenticatedAt,
          onboardingCompletedAt: null,
        })]);
        expect(after.db.select().from(oauthAccounts).all()).toEqual([]);
        expect(after.db.select().from(sessions).all()).toEqual([]);
      } finally {
        after.sqlite.close();
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      if (previousSessionSecret === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = previousSessionSecret;
      if (previousTokenEncryptionKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
      else process.env.TOKEN_ENCRYPTION_KEY = previousTokenEncryptionKey;
    }
  });

  test("merges returning users onto the existing account and rotates a usable session", async () => {
    const previousSessionSecret = process.env.SESSION_SECRET;
    const previousTokenEncryptionKey = process.env.TOKEN_ENCRYPTION_KEY;
    process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
    process.env.TOKEN_ENCRYPTION_KEY = config.tokenEncryptionKey;

    const tempDir = mkdtempSync(join(tmpdir(), "orca-gmail-returning-user-test-"));
    const dbPath = join(tempDir, "returning.sqlite");
    const initialClient = createDatabaseClient(dbPath);
    migrate(initialClient.db, { migrationsFolder: resolve(import.meta.dir, "../../../drizzle") });
    initialClient.db.insert(users).values({
      id: "existing_user",
      email: "returning@example.com",
    }).run();
    initialClient.db.insert(oauthAccounts).values({
      id: "existing_account",
      userId: "existing_user",
      provider: "gmail",
      providerEmail: "returning@example.com",
      providerId: "google-returning-user",
      scope: config.scopes.join(" "),
      accessTokenEncrypted: encryptSecret("existing-access-token", config.tokenEncryptionKey),
      refreshTokenEncrypted: encryptSecret("existing-refresh-token", config.tokenEncryptionKey),
    }).run();
    initialClient.sqlite.close();

    try {
      const dbFactory = () => createDatabaseClient(dbPath);
      const authApp = createGmailAuthApp({
        config,
        dbFactory,
        fetch: async (input) => input.toString().includes("oauth2.googleapis.com/token")
          ? Response.json({
              access_token: "returning-access-token",
              refresh_token: "returning-refresh-token",
              scope: config.scopes.join(" "),
            })
          : Response.json({ id: "google-returning-user", email: "returning@example.com" }),
      });

      const loginResponse = await authApp.request("/login?returnTo=http%3A%2F%2Flocalhost%3A5173%2Fonboarding");
      expect(loginResponse.status).toBe(200);
      const loginBody = (await loginResponse.json()) as { state: string };
      const pendingCookie = loginResponse.headers.get("set-cookie")?.split(";", 1)[0];
      expect(pendingCookie).toBeTruthy();

      const callbackResponse = await authApp.request(
        "/callback?code=returning-code&state=" + encodeURIComponent(loginBody.state),
        { headers: { cookie: pendingCookie! }, redirect: "manual" },
      );
      expect(callbackResponse.status).toBe(302);
      expect(callbackResponse.headers.get("location")).toStartWith("http://localhost:5173/?");
      const rotatedCookie = callbackResponse.headers.get("set-cookie")?.split(";", 1)[0];
      expect(rotatedCookie).toBeTruthy();
      expect(rotatedCookie).not.toBe(pendingCookie);

      const api = createApp({ dbFactory });
      const sessionResponse = await api.request("/v1/auth/session", {
        headers: { cookie: rotatedCookie! },
      });
      expect(sessionResponse.status).toBe(200);
      const session = await sessionResponse.json();
      expect(session.user).toEqual({ id: "existing_user", email: "returning@example.com", name: null });
      expect(session.onboardingCompletedAt).toEqual(expect.any(String));

      const accountResponse = await api.request("/v1/me", {
        headers: { cookie: rotatedCookie! },
      });
      expect(accountResponse.status).toBe(200);
      expect(await accountResponse.json()).toMatchObject({
        id: "existing_account",
        email: "returning@example.com",
      });

      const verificationClient = dbFactory();
      try {
        const account = verificationClient.db.select().from(oauthAccounts).where(eq(oauthAccounts.id, "existing_account")).get();
        expect(account).toBeTruthy();
        expect(decryptSecret(account!.accessTokenEncrypted!, config.tokenEncryptionKey)).toBe("returning-access-token");
        expect(decryptSecret(account!.refreshTokenEncrypted!, config.tokenEncryptionKey)).toBe("returning-refresh-token");
        expect(verificationClient.db.select().from(oauthAccounts).all()).toHaveLength(1);
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
            picture: "https://lh3.googleusercontent.com/profile-photo",
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
      profileImageUrl: "https://lh3.googleusercontent.com/profile-photo",
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

  test("a replayed callback is rejected before another Google token exchange or account mutation", async () => {
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
    expect((await app.request(callback, { redirect: "manual" })).headers.get("location")).toContain("reason=invalid_state");
    expect(tokenCalls).toBe(1);
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
