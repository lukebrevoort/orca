import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import { createApp } from "../../index.ts";
import { createDatabaseClient } from "../../db/client.ts";
import { oauthAccounts, users } from "../../db/schema.ts";
import { decryptSecret, encryptSecret } from "../gmail/crypto.ts";
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
