import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { legacyUserPreferencesResponseSchema, guidanceUserPreferencesResponseSchema } from "@orca/shared";
import { createDatabaseClient } from "./db/client.ts";
import { createSession } from "./auth/session-store.ts";
import { createMobileSession } from "./auth/mobile/store.ts";
import { createApp } from "./index.ts";
import { getServerConfig } from "./config/server.ts";

const ownerHeader = "x-orca-expected-user-id";
async function fixture(run: (f: {
  request: (owner: "u" | "v" | null, expected: string | undefined, method?: "GET" | "PATCH", suffix?: string, bearer?: string) => Promise<Response>;
  snapshot: () => unknown[]; preferenceAccess: string[];
  sessionU: string; tokenV: string;
}) => Promise<void>) {
  const prior = { SESSION_SECRET: process.env.SESSION_SECRET, TOKEN_ENCRYPTION_KEY: process.env.TOKEN_ENCRYPTION_KEY };
  process.env.SESSION_SECRET = "bre469-synthetic-session-secret-long-enough";
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 16).toString("base64");
  const directory = mkdtempSync(join(tmpdir(), "orca-bre469-"));
  const path = join(directory, "preferences.sqlite"), client = createDatabaseClient(path);
  try {
    migrate(client.db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });
    client.sqlite.exec("INSERT INTO users(id,email) VALUES('u','u@example.com'),('v','v@example.com'); INSERT INTO user_preferences(user_id,signature,updated_at) VALUES('u','Original U',1000),('v','Original V',1000)");
    const sessionU = await createSession(client.db, "u"), sessionV = await createSession(client.db, "v");
    const mobileV = createMobileSession(client.db, "v");
    const preferenceAccess: string[] = [];
    const app = createApp({ dbFactory() {
      const db = createDatabaseClient(path);
      for (const method of ["query", "prepare"] as const) {
        const original = db.sqlite[method].bind(db.sqlite);
        Object.defineProperty(db.sqlite, method, { configurable: true, value(sql: string, ...args: unknown[]) {
          if (/\buser_preferences\b/i.test(sql)) preferenceAccess.push(sql);
          return Reflect.apply(original, db.sqlite, [sql, ...args]);
        } });
      }
      return db;
    } });
    const request = (owner: "u" | "v" | null, expected: string | undefined, method: "GET" | "PATCH" = "GET", suffix = "", bearer?: string) => app.request("/v1/preferences" + suffix, {
      method, headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : owner ? { cookie: `orca_session=${owner === "u" ? sessionU.token : sessionV.token}` } : {}), ...(expected === undefined ? {} : { [ownerHeader]: expected }) },
      ...(method === "PATCH" ? { body: JSON.stringify({ signature: "Unsaved U draft", composeFormat: "rich" }) } : {}),
    });
    await run({ request, snapshot: () => client.sqlite.query("SELECT * FROM user_preferences ORDER BY user_id").all(), preferenceAccess, sessionU: sessionU.token, tokenV: mobileV.accessToken });
  } finally {
    client.sqlite.close(); rmSync(directory, { recursive: true, force: true });
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

test("BRE-469 replacement cookie cannot read or write the original preference owner's draft", () => fixture(async f => {
  const capturedU = await f.request("u", "u");
  expect((await capturedU.json()).signature).toBe("Original U");
  expect(f.preferenceAccess.length).toBeGreaterThan(0);
  const before = f.snapshot(); f.preferenceAccess.length = 0;
  for (const method of ["GET", "PATCH"] as const) {
    const response = await f.request("v", "u", method);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "session_owner_changed" } });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  }
  expect(f.snapshot()).toEqual(before);
  expect(f.preferenceAccess).toHaveLength(0);
}));

test("BRE-469 replacement mobile bearer cannot apply the original owner's preferences", () => fixture(async f => {
  const before = f.snapshot();
  const response = await f.request(null, "u", "PATCH", "?include=first_view_guidance", f.tokenV);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: "session_owner_changed" } });
  expect(f.snapshot()).toEqual(before);
  expect(f.preferenceAccess).toHaveLength(0);
}));

test("BRE-469 same-owner and legacy requests retain strict preference shapes", () => fixture(async f => {
  for (const expected of ["v", undefined]) {
    const read = await f.request("v", expected);
    expect(read.status).toBe(200);
    expect(legacyUserPreferencesResponseSchema.parse(await read.json()).signature).toMatch(/Original V|Unsaved U draft/);
    const saved = await f.request("v", expected, "PATCH", "?include=first_view_guidance");
    expect(saved.status).toBe(200);
    expect(guidanceUserPreferencesResponseSchema.parse(await saved.json()).signature).toBe("Unsaved U draft");
  }
}));

test("BRE-469 malformed preconditions and unauthenticated requests never access preferences", () => fixture(async f => {
  const before = f.snapshot();
  for (const value of ["", "u v", "u".repeat(257)]) for (const method of ["GET", "PATCH"] as const) expect((await f.request("u", value, method)).status).toBe(400);
  for (const method of ["GET", "PATCH"] as const) expect((await f.request(null, "u", method)).status).toBe(401);
  expect(f.snapshot()).toEqual(before);
  expect(f.preferenceAccess).toHaveLength(0);
}));

test("BRE-469 CORS accepts the owner precondition without widening allowed origins", async () => {
  const app = createApp({ dbFactory: () => { throw Error("Preflight must not open a database"); } });
  const allowed = getServerConfig().webOrigin;
  for (const origin of [allowed, "https://foreign.synthetic.invalid"]) {
    const response = await app.request("/v1/preferences", { method: "OPTIONS", headers: {
      origin, "access-control-request-method": "PATCH", "access-control-request-headers": `content-type,${ownerHeader}`,
    } });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(origin === allowed ? allowed : null);
    expect(response.headers.get("access-control-allow-headers")?.split(",")).toContain(ownerHeader);
    expect(response.headers.get("access-control-allow-methods")?.split(",")).toContain("PATCH");
  }
});
