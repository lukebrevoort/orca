/** Owned loopback HTTP → authenticated preferences → independent SQLite proof. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createDatabaseClient } from "../src/db/client.ts";
import { createSession } from "../src/auth/session-store.ts";
import { createMobileSession } from "../src/auth/mobile/store.ts";
import { createApp } from "../src/index.ts";

const root = resolve(import.meta.dir, "../../..");
function git(...args: string[]) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw Error("Cannot establish fixture source identity");
  return result.stdout.trim();
}
const head = git("rev-parse", "HEAD");
assert.match(head, /^[a-f0-9]{40}$/); assert.equal(git("status", "--porcelain=v1", "--untracked-files=all"), "");
const output = resolve(process.argv[2] ?? "");
assert(output.startsWith("/tmp/bre469-"), "Provide a new /tmp/bre469- output directory");
mkdirSync(output);
const scratch = mkdtempSync(join(tmpdir(), "orca-bre469-demo-"));
const path = join(scratch, "demo.sqlite"), client = createDatabaseClient(path);
const prior = { SESSION_SECRET: process.env.SESSION_SECRET, TOKEN_ENCRYPTION_KEY: process.env.TOKEN_ENCRYPTION_KEY };
process.env.SESSION_SECRET = "synthetic-bre469-demo-session-secret-long-enough";
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString("base64");
let server: ReturnType<typeof Bun.serve> | undefined;
try {
  migrate(client.db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });
  client.sqlite.exec("INSERT INTO users(id,email) VALUES('u','u@example.com'),('v','v@example.com'); INSERT INTO user_preferences(user_id,signature,updated_at) VALUES('u','Original U',1000),('v','Original V',1000)");
  const u = await createSession(client.db, "u"), v = await createSession(client.db, "v");
  const mobileV = createMobileSession(client.db, "v");
  const app = createApp({ dbFactory: () => createDatabaseClient(path) });
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  const origin = server.url.origin;
  const transcript: { method: string; expectedOwner: string | null; credentialOwner: string | null; status: number; errorCode: string | null }[] = [];
  const rows = () => client.sqlite.query("SELECT * FROM user_preferences ORDER BY user_id").all();
  const before = rows();
  async function request(owner: "u" | "v" | null, expected: string | undefined, method = "GET", signature?: string, bearer = false) {
    const response = await fetch(origin + "/v1/preferences", { method, headers: {
      "content-type": "application/json", ...(owner ? bearer ? { authorization: `Bearer ${mobileV.accessToken}` } : { cookie: `orca_session=${owner === "u" ? u.token : v.token}` } : {}),
      ...(expected === undefined ? {} : { "x-orca-expected-user-id": expected }),
    }, ...(signature === undefined ? {} : { body: JSON.stringify({ signature }) }) });
    const body = await response.json() as { error?: { code: string }; signature?: string };
    transcript.push({ method, expectedOwner: expected ?? null, credentialOwner: owner, status: response.status, errorCode: body.error?.code ?? null });
    return { status: response.status, body };
  }
  assert.equal((await request("u", "u")).body.signature, "Original U");
  for (const method of ["GET", "PATCH"]) assert.equal((await request("v", "u", method, method === "PATCH" ? "Captured U draft" : undefined)).status, 409);
  assert.equal((await request("v", "u", "PATCH", "Captured U draft", true)).status, 409);
  assert.deepEqual(rows(), before, "Rejected cookie and bearer requests cannot change either row");
  const afterRejections = rows();
  assert.equal((await request("v", "v", "PATCH", "Owned V edit")).status, 200);
  assert.equal((await request("u", undefined, "PATCH", "Legacy U edit")).status, 200);
  assert.equal((await request("u", "", "PATCH", "Malformed must not save")).status, 400);
  assert.equal((await request(null, "u", "PATCH", "Unauthenticated must not save")).status, 401);
  const after = rows();
  assert.deepEqual(after.map(row => ({ user: (row as { user_id: string }).user_id, signature: (row as { signature: string }).signature })), [{ user: "u", signature: "Legacy U edit" }, { user: "v", signature: "Owned V edit" }]);
  assert.equal(git("rev-parse", "HEAD"), head); assert.equal(git("status", "--porcelain=v1", "--untracked-files=all"), "");
  writeFileSync(join(output, "results.json"), JSON.stringify({ head, clean: true, scope: "synthetic loopback HTTP/API/SQLite only; no browser, providers or OS", requests: transcript, before, afterRejections, after, credentialsRetained: false }, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ head, requests: transcript.length, ownerMismatches: transcript.filter(row => row.status === 409).length, sameOwnerOrLegacyWrites: transcript.filter(row => row.method === "PATCH" && row.status === 200).length, rejectedRowsUnchanged: true, output }));
} finally {
  server?.stop(true); client.sqlite.close(); rmSync(scratch, { recursive: true, force: true });
  for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
}
