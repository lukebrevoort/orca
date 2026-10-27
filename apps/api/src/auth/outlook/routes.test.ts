import { DatabaseOAuthAccountStore } from "../gmail/oauth-accounts.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { createApp } from "../../index.ts";
import { createDatabaseClient } from "../../db/client.ts";
import { oauthAccounts, sessions, users } from "../../db/schema.ts";
import { decryptSecret, encryptSecret } from "../gmail/crypto.ts";
import type { OutlookOAuthConfig } from "./config.ts";
import { createOutlookAuthApp, redirectReturningUserToWorkspace } from "./routes.ts";

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
  test("preserves a returning user's mobile authorization destination", () => {
    expect(redirectReturningUserToWorkspace(
      "http://localhost:5173/mobile-auth?request=device-request&status=success",
    )).toBe("http://localhost:5173/mobile-auth?request=device-request&status=success");
  });

  test("publishes safe configured and unavailable sign-in states", async () => {
    const ready = await createOutlookAuthApp({ config }).request("/status");
    expect(await ready.json()).toEqual({ provider: "outlook", available: true, reason: null });

    const unavailable = createOutlookAuthApp({ config: { ...config, clientId: "", clientSecret: "", stateSecret: "" } });
    const statusResponse = await unavailable.request("/status");
    const statusText = await statusResponse.text();
    expect(JSON.parse(statusText)).toEqual({ provider: "outlook", available: false, reason: "configuration_required" });
    expect(statusText).not.toMatch(/OUTLOOK_|CLIENT_|SECRET|TOKEN_ENCRYPTION/i);

    const loginResponse = await unavailable.request("/login");
    const loginText = await loginResponse.text();
    expect(loginResponse.status).toBe(503);
    expect(JSON.parse(loginText)).toEqual({ error: {
      code: "provider_unavailable",
      message: "Outlook sign-in is unavailable in this Orca environment. Nothing in your account was changed. Try again later.",
      retryable: true,
    } });
    expect(loginText).not.toMatch(/OUTLOOK_|CLIENT_|SECRET|TOKEN_ENCRYPTION/i);
  });

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
});


describe("Login email collision response", () => {
  for (const destination of ["/onboarding", "/mobile-auth?request=synthetic-request", null]) {
    test(`refuses an unrelated identity and clears its cookie for ${destination}`, async () => {
      const previousSecret = process.env.SESSION_SECRET;
      const previousKey = process.env.TOKEN_ENCRYPTION_KEY;
      process.env.SESSION_SECRET = "synthetic-session-secret-0123456789abcdef";
      process.env.TOKEN_ENCRYPTION_KEY = config.tokenEncryptionKey;
      const dir = mkdtempSync(join(tmpdir(), "orca-login-collision-"));
      const dbFactory = () => createDatabaseClient(join(dir, "test.sqlite"));
      const email = '\"><script>@example.test';
      const seed = dbFactory();
      migrate(seed.db, { migrationsFolder: resolve(import.meta.dir, "../../../drizzle") });
      seed.db.insert(users).values({ id: "existing", email, authenticatedAt: new Date() }).run();
      seed.db.insert(oauthAccounts).values({
        id: "existing-account", userId: "existing", provider: "outlook", providerId: "existing-id",
        providerEmail: email, accessTokenEncrypted: "existing-token", scope: "",
      }).run();
      seed.sqlite.close();
      try {
        const app = createOutlookAuthApp({
          config: { ...config, successRedirectUrl: null }, dbFactory,
          fetch: async (input) => {
            if (String(input).includes("/token")) return Response.json({ access_token: "synthetic-token", scope: config.scopes.join(" ") });
            if (String(input).endsWith("/photo/$value")) return new Response(null, { status: 404 });
            return Response.json({ id: "other-id", email, mail: email });
          },
        });
        const start = await app.request(destination === null ? "/login" : "/login?returnTo=" + encodeURIComponent(config.webOrigin + destination));
        if (destination === null) {
          const { mailOAuthTransactions } = await import("../../db/schema.ts");
          const client = dbFactory();
          try { client.db.update(mailOAuthTransactions).set({ returnTo: null }).run(); }
          finally { client.sqlite.close(); }
        }
        const { state } = await start.json() as { state: string };
        const cookie = start.headers.get("set-cookie")!.split(";", 1)[0]!;
        const response = await app.request("/callback?code=synthetic-code&state=" + encodeURIComponent(state), { headers: { cookie }, redirect: "manual" });
        const body = await response.text();
        if (destination === null) {
          expect(response.status).toBe(409);
          expect(JSON.parse(body)).toEqual({ ok: false, error: "account_exists" });
        } else {
          expect(response.status).toBe(302);
          const location = new URL(response.headers.get("location")!);
          expect(location.pathname).toBe(new URL(config.webOrigin + destination).pathname);
          expect(location.searchParams.get("status")).toBe("account_exists");
        }
        expect(response.headers.get("set-cookie")).toContain("Expires=Thu, 01 Jan 1970");
        expect(response.headers.get("set-cookie")).toMatch(/^[^=]+=;/);
        expect(body).not.toContain(email);
        expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
        const check = dbFactory();
        try {
          expect(check.db.select().from(users).all().map((u) => u.id)).toEqual(["existing"]);
          expect(check.db.select().from(oauthAccounts).all().map((a) => a.id)).toEqual(["existing-account"]);
        } finally { check.sqlite.close(); }
      } finally {
        rmSync(dir, { recursive: true, force: true });
        if (previousSecret === undefined) delete process.env.SESSION_SECRET;
        else process.env.SESSION_SECRET = previousSecret;
        if (previousKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
        else process.env.TOKEN_ENCRYPTION_KEY = previousKey;
      }
    });
  }
});


test("stale login stays 400 invalid_state after session removal at completion", async () => {
  const previousSecret = process.env.SESSION_SECRET;
  const previousKey = process.env.TOKEN_ENCRYPTION_KEY;
  process.env.SESSION_SECRET = "synthetic-session-secret-0123456789abcdef";
  process.env.TOKEN_ENCRYPTION_KEY = config.tokenEncryptionKey;
  const dir = mkdtempSync(join(tmpdir(), "orca-stale-completion-"));
  const dbFactory = () => createDatabaseClient(join(dir, "test.sqlite"));
  const seed = dbFactory();
  migrate(seed.db, { migrationsFolder: resolve(import.meta.dir, "../../../drizzle") });
  seed.sqlite.close();
  let removedSessionId = "";
  class SessionEndingStore extends DatabaseOAuthAccountStore {
    override async upsert(input: Parameters<DatabaseOAuthAccountStore["upsert"]>[0]) {
      const account = await super.upsert(input);
      removedSessionId = input.authorization!.sessionId;
      const client = dbFactory();
      try { client.db.delete(sessions).where(eq(sessions.id, removedSessionId)).run(); }
      finally { client.sqlite.close(); }
      return account;
    }
  }
  try {
    const app = createOutlookAuthApp({
      config, dbFactory, store: new SessionEndingStore(dbFactory, "outlook"),
      fetch: async (input) => {
        if (input.toString().includes("token")) return Response.json({ access_token: "synthetic-access", scope: config.scopes.join(" ") });
        if (input.toString().includes("photo")) return new Response(null, { status: 404 });
        return Response.json({ id: "new-id", email: "new@example.test", mail: "new@example.test" });
      },
    });
    const start = await app.request("/login");
    const { state } = await start.json() as { state: string };
    const cookie = start.headers.get("set-cookie")!.split(";", 1)[0]!;
    const response = await app.request("/callback?code=synthetic-code&state=" + encodeURIComponent(state), { headers: { cookie }, redirect: "manual" });
    expect(removedSessionId).not.toBe("");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: "invalid_state", message: "The pending login is no longer available. Try again from Orca." });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("location")).toBeNull();
    const check = dbFactory();
    try {
      const pending = check.db.select().from(users).all();
      expect(pending).toHaveLength(1);
      expect(pending[0]!.authenticatedAt).toBeNull();
      expect(pending[0]!.onboardingCompletedAt).toBeNull();
      expect(check.db.select().from(oauthAccounts).all()).toHaveLength(1);
      expect(check.db.select().from(sessions).all()).toEqual([]);
    } finally { check.sqlite.close(); }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (previousSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSecret;
    if (previousKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = previousKey;
  }
});
