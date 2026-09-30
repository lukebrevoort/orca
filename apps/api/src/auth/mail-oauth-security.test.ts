import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createDatabaseClient } from "../db/client.ts";
import { emails, mailOAuthTransactions, oauthAccounts, threads, users } from "../db/schema.ts";
import { createSession, getSessionFromToken, invalidateSession, renewSession } from "./session-store.ts";
import { buildSessionCookie } from "./jwt.ts";
import { createGmailAuthApp } from "./gmail/routes.ts";
import { createOutlookAuthApp } from "./outlook/routes.ts";
import { DatabaseMailOAuthTransactionStore } from "./mail-oauth-transactions.ts";
import { completeMailOAuthLogin } from "./mail-oauth-login.ts";
import type { GmailOAuthConfig } from "./gmail/config.ts";
import type { OutlookOAuthConfig } from "./outlook/config.ts";
import { createMobileSession } from "./mobile/store.ts";

const key = Buffer.alloc(32, 7).toString("base64");
const common = { clientId: "client", clientSecret: "secret", tokenEncryptionKey: key, stateSecret: "state-secret", successRedirectUrl: "http://localhost:5173/onboarding", errorRedirectUrl: null, webOrigin: "http://localhost:5173" };
const gmailConfig: GmailOAuthConfig = { ...common, redirectUri: "http://localhost:3000/v1/auth/gmail/callback", scopes: ["https://www.googleapis.com/auth/gmail.readonly"], composeScopes: ["https://www.googleapis.com/auth/gmail.compose"] };
const outlookConfig: OutlookOAuthConfig = { ...common, redirectUri: "http://localhost:3000/v1/auth/outlook/callback", tenant: "common", scopes: ["User.Read", "Mail.Read", "offline_access"] };
const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

async function fixture(provider: "gmail" | "outlook", providerEmail = "new@example.com", returnedScope: string | null = "Mail.Read") {
  const previousSecret = process.env.SESSION_SECRET;
  const previousKey = process.env.TOKEN_ENCRYPTION_KEY;
  process.env.TOKEN_ENCRYPTION_KEY = key;
  process.env.SESSION_SECRET = "test-session-secret-that-is-long-enough";
  const dir = mkdtempSync(join(tmpdir(), "orca-oauth-binding-"));
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true });
    if (previousSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSecret;
    if (previousKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = previousKey;
  });
  const dbFactory = () => createDatabaseClient(join(dir, "test.sqlite"));
  const client = dbFactory();
  migrate(client.db, { migrationsFolder: resolve(import.meta.dir, "../../drizzle") });
  client.db.insert(users).values([
    { id: "victim", email: "victim@example.com", authenticatedAt: new Date(), onboardingCompletedAt: new Date() },
    { id: "attacker", email: "attacker@example.com", authenticatedAt: new Date() },
  ]).run();
  client.db.insert(oauthAccounts).values({ id: "victim-account", userId: "victim", provider, providerId: "victim-provider", providerEmail: "victim@example.com", accessTokenEncrypted: "old-access", refreshTokenEncrypted: "old-refresh", syncCursor: "cached-cursor", scope: "old-scope" }).run();
  client.db.insert(threads).values({ id: "cached-thread", accountId: "victim-account", providerThreadId: "provider-thread", subject: "private", latestReceivedAt: new Date() }).run();
  client.db.insert(emails).values({ id: "cached-email", accountId: "victim-account", threadId: "cached-thread", providerMessageId: "provider-email", subject: "private", fromName: "Private", fromAddress: "private@example.com", toRecipients: "[]", receivedAt: new Date(), snippet: "private", bodyText: "private cached mail" }).run();
  const victim = await createSession(client.db, "victim");
  const otherVictimSession = await createSession(client.db, "victim");
  const attacker = await createSession(client.db, "attacker");
  client.sqlite.close();
  const calls: Array<{ url: string; body: URLSearchParams }> = [];
  let onToken: (() => void) | null = null;
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: new URLSearchParams(String(init?.body ?? "")) });
    if (url.includes("/token")) {
      onToken?.();
      return Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600, ...(returnedScope !== null ? { scope: returnedScope } : {}) });
    }
    if (url.endsWith("/photo/$value")) return new Response(null, { status: 404 });
    return Response.json({ id: "new-provider", email: providerEmail, mail: providerEmail });
  };
  const makeApp = () => provider === "gmail"
    ? createGmailAuthApp({ config: gmailConfig, dbFactory, fetch: fetchImpl })
    : createOutlookAuthApp({ config: outlookConfig, dbFactory, fetch: fetchImpl });
  const cookie = (token: string) => buildSessionCookie(token, new Date(Date.now() + 3600_000)).split(";", 1)[0]!;
  const snapshot = () => {
    const { db, sqlite } = dbFactory();
    try { return { user: db.select().from(users).where(eq(users.id, "victim")).get(), accounts: db.select().from(oauthAccounts).where(eq(oauthAccounts.userId, "victim")).all(), emails: db.select().from(emails).all(), threads: db.select().from(threads).all() }; }
    finally { sqlite.close(); }
  };
  const start = async (path: "login" | "connect", token = attacker.token) => {
    const response = await makeApp().request(`/${path}?returnTo=http%3A%2F%2Flocalhost%3A5173%2Fonboarding`, { headers: path === "connect" ? { cookie: cookie(token) } : {} });
    expect(response.status).toBe(200);
    return { ...await response.json() as { state: string; authUrl: string }, cookie: response.headers.get("set-cookie")?.split(";", 1)[0] ?? cookie(token) };
  };
  const callback = (state: string, sessionCookie: string) => makeApp().request(`/callback?state=${encodeURIComponent(state)}&code=code`, { headers: { cookie: sessionCookie }, redirect: "manual" });
  return { dbFactory, calls, cookie, victim, attacker, otherVictimSession, snapshot, start, callback, makeApp, setOnToken(fn: () => void) { onToken = fn; } };
}

for (const provider of ["gmail", "outlook"] as const) {
  describe(`${provider} server-side OAuth transactions`, () => {
    for (const path of ["login", "connect"] as const) {
      for (const email of ["new@example.com", "attacker@example.com"]) {
        test(`${path} rejects transplanted callbacks (${email}) before exchange and preserves the victim`, async () => {
          const f = await fixture(provider, email);
          const before = f.snapshot();
          const authorization = await f.start(path);
          const response = await f.callback(authorization.state, f.cookie(f.victim.token));
          expect(response.status).toBe(400);
          expect(await response.json()).toMatchObject({ ok: false, error: "invalid_state" });
          expect(f.calls).toHaveLength(0);
          expect(f.snapshot()).toEqual(before);
          // A failed foreign callback cannot consume the initiator's transaction.
          expect((await f.callback(authorization.state, authorization.cookie)).headers.get("location")).toContain("status=success");
        });
      }
    }

    test("connect requires the exact initiating session even for the same user", async () => {
      const f = await fixture(provider);
      const before = f.snapshot();
      const authorization = await f.start("connect", f.victim.token);
      expect((await f.callback(authorization.state, f.cookie(f.otherVictimSession.token))).status).toBe(400);
      expect(f.calls).toHaveLength(0);
      expect(f.snapshot()).toEqual(before);
      expect((await f.callback(authorization.state, authorization.cookie)).headers.get("location")).toContain("status=success");
      expect(f.snapshot().user).toEqual(before.user); // Connecting never promotes/replaces primary identity.
    });

    test("login rejects a different session belonging to the same pending user", async () => {
      const f = await fixture(provider);
      const authorization = await f.start("login");
      const client = f.dbFactory();
      const transaction = client.db.select().from(mailOAuthTransactions).get()!;
      const otherSession = await createSession(client.db, transaction.userId);
      client.sqlite.close();
      expect((await f.callback(authorization.state, f.cookie(otherSession.token))).status).toBe(400);
      expect(f.calls).toHaveLength(0);
      expect((await f.callback(authorization.state, authorization.cookie)).status).toBe(302);
    });

    test("legitimate login survives a new service instance, uses private PKCE, and rejects replay", async () => {
      const f = await fixture(provider);
      const authorization = await f.start("login");
      expect(authorization.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const challenge = new URL(authorization.authUrl).searchParams.get("code_challenge");
      expect(new URL(authorization.authUrl).searchParams.get("code_verifier")).toBeNull();
      expect((await f.callback(authorization.state, authorization.cookie)).headers.get("location")).toContain("status=success");
      const tokenCall = f.calls.find((call) => call.url.includes("/token"))!;
      const verifier = tokenCall.body.get("code_verifier")!;
      expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(createHash("sha256").update(verifier).digest("base64url")).toBe(challenge!);
      expect(authorization.state).not.toBe(verifier);
      const count = f.calls.length;
      expect((await f.callback(authorization.state, authorization.cookie)).status).toBe(400);
      expect(f.calls).toHaveLength(count);
      const client = f.dbFactory();
      try {
        expect(client.db.select().from(users).where(eq(users.email, "new@example.com")).get()?.authenticatedAt).toBeInstanceOf(Date);
        expect(client.db.select().from(mailOAuthTransactions).all()).toHaveLength(0);
      } finally { client.sqlite.close(); }
    });

    test("expiry and provider mismatch reject before exchange", async () => {
      const f = await fixture(provider);
      const authorization = await f.start("connect");
      const transactions = new DatabaseMailOAuthTransactionStore(f.dbFactory);
      expect(transactions.consume(authorization.state, f.attacker, provider === "gmail" ? "outlook" : "gmail")).toBeNull();
      const client = f.dbFactory();
      client.db.update(mailOAuthTransactions).set({ expiresAt: new Date(Date.now() - 1) }).run();
      client.sqlite.close();
      expect((await f.callback(authorization.state, authorization.cookie)).status).toBe(400);
      expect(f.calls).toHaveLength(0);
    });

    test("simultaneous callbacks consume a transaction only once", async () => {
      const f = await fixture(provider);
      const authorization = await f.start("connect");
      const responses = await Promise.all([f.callback(authorization.state, authorization.cookie), f.callback(authorization.state, authorization.cookie)]);
      expect(responses.map((response) => response.status).sort()).toEqual([302, 400]);
      expect(f.calls.filter((call) => call.url.includes("/token"))).toHaveLength(1);
    });

    test("provider denial consumes the transaction without persisting a grant", async () => {
      const f = await fixture(provider);
      const authorization = await f.start("connect");
      const denied = await f.makeApp().request(`/callback?state=${authorization.state}&error=access_denied`, { headers: { cookie: authorization.cookie } });
      expect(denied.headers.get("location")).toContain("reason=provider_error");
      expect((await f.callback(authorization.state, authorization.cookie)).status).toBe(400);
      expect(f.calls).toHaveLength(0);
    });

    test("returning login preserves account ID, cached mail, and a usable rotated session", async () => {
      const f = await fixture(provider, "victim@example.com");
      const before = f.snapshot();
      const seed = f.dbFactory();
      seed.db.update(oauthAccounts).set({ providerId: "new-provider" }).where(eq(oauthAccounts.id, "victim-account")).run();
      seed.sqlite.close();
      const authorization = await f.start("login");
      const response = await f.callback(authorization.state, authorization.cookie);
      expect(response.headers.get("location")).toStartWith("http://localhost:5173/?");
      const rotatedCookie = response.headers.get("set-cookie")!.split(";", 1)[0]!;
      expect(rotatedCookie).not.toBe(authorization.cookie);
      const verify = f.dbFactory();
      try {
        const token = rotatedCookie.slice(rotatedCookie.indexOf("=") + 1);
        expect((await getSessionFromToken(verify.db, token))?.userId).toBe("victim");
        const account = verify.db.select().from(oauthAccounts).where(eq(oauthAccounts.id, "victim-account")).get()!;
        expect(account.syncCursor).toBe("cached-cursor");
        expect(account.accessTokenEncrypted).not.toBe("old-access");
        expect(verify.db.select().from(oauthAccounts).all()).toHaveLength(1);
        expect(verify.db.select().from(users).all()).toHaveLength(2);
      } finally { verify.sqlite.close(); }
      expect(f.snapshot().emails).toEqual(before.emails);
      expect(f.snapshot().threads).toEqual(before.threads);
    });

    test("session renewal retains binding and mobile bearer connect remains supported", async () => {
      const f = await fixture(provider);
      const authorization = await f.start("connect");
      const client = f.dbFactory();
      const renewed = await renewSession(client.db, f.attacker);
      expect(renewed!.sessionId).toBe(f.attacker.sessionId);
      const mobile = createMobileSession(client.db, "victim");
      client.sqlite.close();
      expect((await f.callback(authorization.state, f.cookie(renewed!.token))).status).toBe(302);
      const start = await f.makeApp().request("/connect", { headers: { authorization: `Bearer ${mobile.accessToken}` } });
      expect(start.status).toBe(200);
      const { state } = await start.json() as { state: string };
      const callback = await f.makeApp().request(`/callback?state=${state}&code=code`, { headers: { authorization: `Bearer ${mobile.accessToken}` } });
      expect(callback.status).toBe(302);
      expect(f.snapshot().user!.email).toBe("victim@example.com");
    });

    test("a completed pending user is rejected before exchange and cannot be deleted by promotion", async () => {
      const f = await fixture(provider, "attacker@example.com");
      const authorization = await f.start("login");
      const client = f.dbFactory();
      const transaction = client.db.select().from(mailOAuthTransactions).get()!;
      client.db.update(users).set({ authenticatedAt: new Date() }).where(eq(users.id, transaction.userId)).run();
      expect(completeMailOAuthLogin(client.db, { ...transaction, pendingEmail: transaction.pendingEmail!, providerEmail: "attacker@example.com", providerAccountId: "new-provider" })).toEqual({ ok: false });
      client.sqlite.close();
      expect((await f.callback(authorization.state, authorization.cookie)).status).toBe(400);
      expect(f.calls).toHaveLength(0);
      const verify = f.dbFactory();
      expect(verify.db.select().from(users).where(eq(users.id, transaction.userId)).get()).toBeTruthy();
      verify.sqlite.close();
    });

    for (const mutation of ["pending_completed", "session_revoked"] as const) {
      test(`rejects ${mutation} during exchange before grant persistence`, async () => {
        const f = await fixture(provider);
        const authorization = await f.start("login");
        const initial = f.dbFactory();
        const transaction = initial.db.select().from(mailOAuthTransactions).get()!;
        initial.sqlite.close();
        f.setOnToken(() => {
          const client = f.dbFactory();
          if (mutation === "pending_completed") client.db.update(users).set({ authenticatedAt: new Date() }).where(eq(users.id, transaction.userId)).run();
          else invalidateSession(client.db, transaction.sessionId);
          client.sqlite.close();
        });
        expect((await f.callback(authorization.state, authorization.cookie)).status).toBe(400);
        const client = f.dbFactory();
        try {
          expect(client.db.select().from(oauthAccounts).where(eq(oauthAccounts.userId, transaction.userId)).all()).toHaveLength(0);
          expect(client.db.select().from(users).where(eq(users.id, transaction.userId)).get()?.email).toBe(transaction.pendingEmail!);
        } finally { client.sqlite.close(); }
      });
    }
  });
}

describe("Gmail returning-login scope reporting", () => {
  for (const returnedScope of [null, gmailConfig.scopes.join(" ")]) {
    test(returnedScope === null ? "preserves compose permission when Google omits scope" : "honors Google's explicit current scope when it removes compose permission", async () => {
      const f = await fixture("gmail", "victim@example.com", returnedScope);
      const previousScopes = [...gmailConfig.scopes, ...gmailConfig.composeScopes].join(" ");
      const seed = f.dbFactory();
      seed.db.update(oauthAccounts).set({ providerId: "new-provider", scope: previousScopes }).where(eq(oauthAccounts.id, "victim-account")).run();
      seed.sqlite.close();
      const authorization = await f.start("login");
      expect((await f.callback(authorization.state, authorization.cookie)).status).toBe(302);
      const verification = f.dbFactory();
      try {
        const account = verification.db.select().from(oauthAccounts).where(eq(oauthAccounts.id, "victim-account")).get()!;
        expect(account.scope).toBe(returnedScope ?? previousScopes);
        expect(account.syncCursor).toBe("cached-cursor");
        expect(account.accessTokenEncrypted).not.toBe("old-access");
      } finally { verification.sqlite.close(); }
    });
  }
});
