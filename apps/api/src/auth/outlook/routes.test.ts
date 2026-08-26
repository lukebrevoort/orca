import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { createApp } from "../../index.ts";
import { createDatabaseClient } from "../../db/client.ts";
import { oauthAccounts, oauthTransactions, sessions, users } from "../../db/schema.ts";
import { decryptSecret, encryptSecret } from "../gmail/crypto.ts";
import { createSession } from "../session-store.ts";
import type { OutlookOAuthConfig } from "./config.ts";
import { createOutlookAuthApp } from "./routes.ts";

const config: OutlookOAuthConfig = {
  clientId: "client-id",
  clientSecret: "client-secret",
  tenant: "common",
  redirectUri: "http://localhost:3000/v1/auth/outlook/callback",
  scopes: ["openid", "offline_access", "User.Read", "Mail.Read"],
  tokenEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
  stateSecret: "test-outlook-state-secret",
  successRedirectUrl: "http://localhost:5173/onboarding",
  errorRedirectUrl: "http://localhost:5173/login",
  webOrigin: "http://localhost:5173",
};

describe("Outlook auth routes", () => {
  test("merges a returning user onto the existing account and rotates the session", async () => {
    const previousSessionSecret = process.env.SESSION_SECRET;
    const previousTokenEncryptionKey = process.env.TOKEN_ENCRYPTION_KEY;
    process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
    process.env.TOKEN_ENCRYPTION_KEY = config.tokenEncryptionKey;

    const tempDir = mkdtempSync(join(tmpdir(), "orca-outlook-returning-user-test-"));
    const dbPath = join(tempDir, "returning.sqlite");
    const initialClient = createDatabaseClient(dbPath);
    migrate(initialClient.db, { migrationsFolder: resolve(import.meta.dir, "../../../drizzle") });
    initialClient.db.insert(users).values({
      id: "existing_user",
      email: "returning@outlook.com",
    }).run();
    initialClient.db.insert(oauthAccounts).values({
      id: "existing_account",
      userId: "existing_user",
      provider: "outlook",
      providerEmail: "returning@outlook.com",
      providerId: "microsoft-returning-user",
      scope: config.scopes.join(" "),
      accessTokenEncrypted: encryptSecret("existing-access-token", config.tokenEncryptionKey),
      refreshTokenEncrypted: encryptSecret("existing-refresh-token", config.tokenEncryptionKey),
    }).run();
    initialClient.sqlite.close();

    try {
      const dbFactory = () => createDatabaseClient(dbPath);
      const authApp = createOutlookAuthApp({
        config,
        dbFactory,
        fetch: async (input, init) => {
          if (input.toString().includes("/token")) {
            const body = new URLSearchParams(String(init?.body));
            expect(body.get("code_verifier")).toBeTruthy();
            return Response.json({
              access_token: "returning-access-token",
              refresh_token: "returning-refresh-token",
              scope: config.scopes.join(" "),
            });
          }
          return Response.json({ id: "microsoft-returning-user", mail: "returning@outlook.com" });
        },
      });

      const loginResponse = await authApp.request("/login?returnTo=http%3A%2F%2Flocalhost%3A5173%2Fonboarding");
      expect(loginResponse.status).toBe(200);
      const loginBody = await loginResponse.json() as { state: string };
      const pendingCookie = loginResponse.headers.get("set-cookie")?.split(";", 1)[0];
      expect(pendingCookie).toBeTruthy();

      const beforeCallback = dbFactory();
      try {
        expect(beforeCallback.db.select().from(users).all()).toHaveLength(1);
        expect(beforeCallback.db.select().from(sessions).all()).toEqual([]);
        const transaction = beforeCallback.db.select().from(oauthTransactions).get();
        expect(transaction?.stateHash).not.toBe(loginBody.state);
        expect(transaction?.codeVerifier).toBeTruthy();
      } finally {
        beforeCallback.sqlite.close();
      }

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
      const sessionResponse = await api.request("/v1/auth/session", { headers: { cookie: rotatedCookie! } });
      expect(sessionResponse.status).toBe(200);
      expect(await sessionResponse.json()).toMatchObject({
        user: { id: "existing_user", email: "returning@outlook.com", name: null },
      });

      const verificationClient = dbFactory();
      try {
        const account = verificationClient.db.select().from(oauthAccounts).where(eq(oauthAccounts.id, "existing_account")).get();
        expect(account).toBeTruthy();
        expect(decryptSecret(account!.accessTokenEncrypted!, config.tokenEncryptionKey)).toBe("returning-access-token");
        expect(decryptSecret(account!.refreshTokenEncrypted!, config.tokenEncryptionKey)).toBe("returning-refresh-token");
        expect(verificationClient.db.select().from(users).all()).toHaveLength(1);
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

  test("binds connect callbacks to the initiating session and rejects replay before Microsoft calls", async () => {
    const previousSessionSecret = process.env.SESSION_SECRET;
    const previousTokenEncryptionKey = process.env.TOKEN_ENCRYPTION_KEY;
    process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
    process.env.TOKEN_ENCRYPTION_KEY = config.tokenEncryptionKey;
    const tempDir = mkdtempSync(join(tmpdir(), "orca-outlook-bound-connect-"));
    const dbPath = join(tempDir, "bound-connect.sqlite");
    const initial = createDatabaseClient(dbPath);
    migrate(initial.db, { migrationsFolder: resolve(import.meta.dir, "../../../drizzle") });
    initial.db.insert(users).values([
      { id: "outlook_user_a", email: "a@example.com" },
      { id: "outlook_user_b", email: "b@example.com" },
    ]).run();
    const sessionA = await createSession(initial.db, "outlook_user_a");
    const sessionB = await createSession(initial.db, "outlook_user_b");
    initial.sqlite.close();
    let providerCalls = 0;

    try {
      const dbFactory = () => createDatabaseClient(dbPath);
      const app = createOutlookAuthApp({
        config,
        dbFactory,
        fetch: async (input, init) => {
          providerCalls += 1;
          if (input.toString().includes("/token")) {
            expect(new URLSearchParams(String(init?.body)).get("code_verifier")).toBeTruthy();
            return Response.json({ access_token: "outlook-access", scope: config.scopes.join(" ") });
          }
          if (input.toString().endsWith("/photo/$value")) return new Response(null, { status: 404 });
          return Response.json({ id: "bound-microsoft", mail: "bound@outlook.com" });
        },
      });
      const cookieA = `orca_session=${sessionA.token}`;
      const cookieB = `orca_session=${sessionB.token}`;
      const start = await app.request("/connect", { headers: { cookie: cookieA } });
      const { state } = await start.json() as { state: string };
      const callback = `/callback?code=outlook-code&state=${encodeURIComponent(state)}`;

      const crossed = await app.request(callback, { headers: { cookie: cookieB }, redirect: "manual" });
      expect(crossed.headers.get("location")).toContain("status=error");
      expect(providerCalls).toBe(0);

      const accepted = await app.request(callback, { headers: { cookie: cookieA }, redirect: "manual" });
      expect(accepted.headers.get("location")).toContain("status=success");
      expect(providerCalls).toBe(3);
      const replay = await app.request(callback, { headers: { cookie: cookieA }, redirect: "manual" });
      expect(replay.headers.get("location")).toContain("status=error");
      expect(providerCalls).toBe(3);

      const after = dbFactory();
      try {
        expect(after.db.select().from(oauthAccounts).all()).toMatchObject([{ userId: "outlook_user_a", providerId: "bound-microsoft" }]);
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

  test("binds login callbacks to the exact short-lived attempt without preallocating users or sessions", async () => {
    const previousSessionSecret = process.env.SESSION_SECRET;
    const previousTokenEncryptionKey = process.env.TOKEN_ENCRYPTION_KEY;
    process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
    process.env.TOKEN_ENCRYPTION_KEY = config.tokenEncryptionKey;
    const tempDir = mkdtempSync(join(tmpdir(), "orca-outlook-bound-login-"));
    const dbPath = join(tempDir, "bound-login.sqlite");
    const initial = createDatabaseClient(dbPath);
    migrate(initial.db, { migrationsFolder: resolve(import.meta.dir, "../../../drizzle") });
    initial.sqlite.close();
    let providerCalls = 0;

    try {
      const dbFactory = () => createDatabaseClient(dbPath);
      const app = createOutlookAuthApp({
        config,
        dbFactory,
        fetch: async (input) => {
          providerCalls += 1;
          if (input.toString().includes("/token")) return Response.json({ access_token: "login-access", refresh_token: "login-refresh", scope: config.scopes.join(" ") });
          if (input.toString().endsWith("/photo/$value")) return new Response(null, { status: 404 });
          return Response.json({ id: "login-microsoft", mail: "new@outlook.com" });
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
      } finally {
        before.sqlite.close();
      }

      expect((await app.request(callback, { headers: { cookie: cookieB }, redirect: "manual" })).headers.get("location")).toContain("status=error");
      expect(providerCalls).toBe(0);
      expect((await app.request(callback, { headers: { cookie: cookieA }, redirect: "manual" })).headers.get("location")).toContain("status=success");
      expect(providerCalls).toBe(3);
      expect((await app.request(callback, { headers: { cookie: cookieA }, redirect: "manual" })).headers.get("location")).toContain("status=error");
      expect(providerCalls).toBe(3);

      const after = dbFactory();
      try {
        expect(after.db.select().from(users).all()).toHaveLength(1);
        expect(after.db.select().from(sessions).all()).toHaveLength(1);
        expect(after.db.select().from(oauthAccounts).all()).toMatchObject([{ provider: "outlook", providerId: "login-microsoft" }]);
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
});
