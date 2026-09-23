import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { Hono } from "hono";
import { createSession } from "../auth/session-store.ts";
import type { AuthVariables } from "../auth/middleware.ts";
import { createDatabaseClient } from "../db/client.ts";
import { emailAttachments, emails, oauthAccounts, threads, users } from "../db/schema.ts";
import { registerAttachmentRoutes } from "./routes.ts";

test("attachment downloads enforce ownership, bound payloads, and force safe private downloads", async () => {
  const priorSecret = process.env.SESSION_SECRET;
  const priorKey = process.env.TOKEN_ENCRYPTION_KEY;
  process.env.SESSION_SECRET = "attachment-test-session-secret-at-least-32-characters";
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 23).toString("base64");
  const dir = mkdtempSync(join(tmpdir(), "orca-attachments-"));
  const path = join(dir, "test.sqlite");
  const { db, sqlite } = createDatabaseClient(path);
  migrate(db, { migrationsFolder: resolve(import.meta.dir, "../../drizzle") });
  try {
    db.insert(users).values([{ id: "owner", email: "owner@example.com" }, { id: "stranger", email: "stranger@example.com" }]).run();
    db.insert(oauthAccounts).values({ id: "account", userId: "owner", provider: "gmail", providerEmail: "owner@example.com", providerId: "provider" }).run();
    db.insert(threads).values({ id: "thread", accountId: "account", providerThreadId: "provider-thread" }).run();
    db.insert(emails).values({ id: "message", accountId: "account", threadId: "thread", providerMessageId: "provider/message?x" }).run();
    db.insert(emailAttachments).values({ id: "attachment", emailId: "message", providerAttachmentId: "provider/attachment", filename: "../unsafe\r\n\".html", mimeType: "text/html", size: 5 }).run();
    const owner = await createSession(db, "owner");
    const stranger = await createSession(db, "stranger");
    const headers = { cookie: `orca_session=${owner.token}` };
    let requests = 0;
    let mode: "ok" | "retry" | "invalid" | "oversize" | "missing" = "ok";
    const app = new Hono<{ Variables: AuthVariables }>();
    registerAttachmentRoutes(app, {
      dbFactory: () => createDatabaseClient(path),
      getTokens: async (_db, _account, options) => ({ accessToken: options?.forceRefresh ? "fresh-token" : "fixture-token", refreshToken: "refresh", tokenExpiry: null }),
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        requests++;
        assert.equal(String(url), "https://gmail.googleapis.com/gmail/v1/users/me/messages/provider%2Fmessage%3Fx/attachments/provider%2Fattachment");
        assert.equal(init?.redirect, "error");
        if (mode === "retry" && (init?.headers as Record<string, string>).Authorization === "Bearer fixture-token") return new Response(null, { status: 401 });
        if (mode === "invalid") return Response.json({ data: "aGVsbG8", size: 999 });
        if (mode === "oversize") return new Response("{}", { headers: { "content-length": String(40 * 1024 * 1024) } });
        if (mode === "missing") return new Response(null, { status: 404 });
        return Response.json({ data: "aGVsbG8", size: 5 });
      }) as typeof fetch,
    });
    const pathName = "/v1/attachments/attachment?accountId=account";
    assert.equal((await app.request(pathName)).status, 401);
    assert.equal((await app.request(pathName, { headers: { cookie: `orca_session=${stranger.token}` } })).status, 404);
    assert.equal((await app.request("/v1/attachments/attachment?accountId=other", { headers })).status, 404);
    assert.equal((await app.request("/v1/attachments/attachment", { headers })).status, 400);
    assert.equal(requests, 0);
    const result = await app.request(pathName, { headers });
    assert.equal(result.status, 200);
    assert.equal(await result.text(), "hello");
    assert.equal(result.headers.get("content-type"), "application/octet-stream");
    assert.equal(result.headers.get("cache-control"), "private, no-store");
    assert.equal(result.headers.get("x-content-type-options"), "nosniff");
    assert.match(result.headers.get("content-disposition")!, /^attachment; filename=/);
    assert.doesNotMatch(result.headers.get("content-disposition")!, /[\r\n]/);
    mode = "retry";
    assert.equal((await app.request(pathName, { headers })).status, 200);
    assert.equal(requests, 3);
    mode = "invalid";
    assert.equal((await app.request(pathName, { headers })).status, 502);
    mode = "oversize";
    assert.equal((await app.request(pathName, { headers })).status, 502);
    mode = "missing";
    assert.equal((await app.request(pathName, { headers })).status, 404);
  } finally {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
    if (priorSecret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = priorSecret;
    if (priorKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY; else process.env.TOKEN_ENCRYPTION_KEY = priorKey;
  }
});
