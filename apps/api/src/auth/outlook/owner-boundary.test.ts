import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createDatabaseClient } from "../../db/client.ts";
import { users } from "../../db/schema.ts";
import { createSession } from "../session-store.ts";
import { createApp } from "../../index.ts";
import { createOutlookAuthApp } from "./routes.ts";

async function fixture(run: (f: {
  auth: ReturnType<typeof createApp>;
  outlook: ReturnType<typeof createOutlookAuthApp>;
  u: Awaited<ReturnType<typeof createSession>>;
  v: Awaited<ReturnType<typeof createSession>>;
  rows: () => unknown[];
}) => Promise<void>) {
  const previous = { SESSION_SECRET: process.env.SESSION_SECRET, TOKEN_ENCRYPTION_KEY: process.env.TOKEN_ENCRYPTION_KEY };
  process.env.SESSION_SECRET = "synthetic-outlook-original-owner-secret";
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 21).toString("base64");
  const directory = mkdtempSync(join(tmpdir(), "orca-outlook-owner-")), path = join(directory, "test.sqlite");
  const { db, sqlite } = createDatabaseClient(path);
  let providerCalls = 0;
  try {
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../../../drizzle") });
    db.insert(users).values([{ id: "u", email: "u@example.test" }, { id: "v", email: "v@example.test" }]).run();
    const u = await createSession(db, "u"), v = await createSession(db, "v");
    const dbFactory = () => createDatabaseClient(path);
    const auth = createApp({ dbFactory });
    const outlook = createOutlookAuthApp({ dbFactory, config: {
      clientId: "synthetic-client", clientSecret: "synthetic-not-used", tenant: "common",
      redirectUri: "http://localhost:3000/v1/auth/outlook/callback", scopes: ["openid", "Mail.Read"],
      tokenEncryptionKey: process.env.TOKEN_ENCRYPTION_KEY, stateSecret: "synthetic-outlook-state-secret",
      successRedirectUrl: "http://localhost:5173/onboarding", errorRedirectUrl: "http://localhost:5173/login", webOrigin: "http://localhost:5173",
    }, fetch: async () => { providerCalls++; throw new Error("External OAuth is forbidden in this fixture"); } });
    // Exclude opaque state, verifier and session IDs from evidence.
    const rows = () => sqlite.query("SELECT user_id,provider,pending_email FROM mail_oauth_transactions ORDER BY user_id").all();
    await run({ auth, outlook, u, v, rows });
    expect(providerCalls).toBe(0);
  } finally {
    sqlite.close(); rmSync(directory, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

test("BRE-469 Outlook start rejects captured U with replacement V before transaction creation", async () => fixture(async ({ auth, outlook, u, v, rows }) => {
  const held = await auth.request("/v1/auth/session", { headers: { cookie: `orca_session=${u.token}` } });
  expect(held.status).toBe(200); expect((await held.json() as { user: { id: string } }).user.id).toBe("u");
  const before = rows();
  const response = await outlook.request("/connect", { headers: { cookie: `orca_session=${v.token}`, "x-orca-expected-user-id": "u" } });
  expect({ status: response.status, rows: rows() }).toEqual({ status: 409, rows: before });
}));

test("BRE-469 Outlook start rejects malformed captured owner", async () => fixture(async ({ outlook, u, rows }) => {
  const response = await outlook.request("/connect", { headers: { cookie: `orca_session=${u.token}`, "x-orca-expected-user-id": "u v" } });
  expect({ status: response.status, rows: rows() }).toEqual({ status: 400, rows: [] });
}));

test("BRE-469 Outlook same-owner and legacy starts retain their authorized transaction scope", async () => fixture(async ({ outlook, u, v, rows }) => {
  const own = await outlook.request("/connect", { headers: { cookie: `orca_session=${u.token}`, "x-orca-expected-user-id": "u" } });
  expect(own.status).toBe(200); expect(new URL((await own.json() as { authUrl: string }).authUrl).host).toBe("login.microsoftonline.com");
  const legacy = await outlook.request("/connect", { headers: { cookie: `orca_session=${v.token}` } });
  expect(legacy.status).toBe(200); expect(rows()).toEqual([{ user_id: "u", provider: "outlook", pending_email: null }, { user_id: "v", provider: "outlook", pending_email: null }]);
}));

test("BRE-469 Outlook owner header never supplies authentication", async () => fixture(async ({ outlook, rows }) => {
  const response = await outlook.request("/connect", { headers: { "x-orca-expected-user-id": "u" } });
  expect(response.status).toBe(401); expect(rows()).toEqual([]);
}));
