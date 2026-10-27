import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { eq } from "drizzle-orm";
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
    let data = Buffer.from("hello");
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
        return Response.json({ data: data.toString("base64url"), size: data.length });
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
    for (const disposition of ["INLINE", "garbage"]) {
      const fallback = await app.request(`${pathName}&disposition=${disposition}`, { headers });
      assert.equal(await fallback.text(), "hello");
      assert.equal(fallback.headers.get("content-disposition"), result.headers.get("content-disposition"));
      assert.equal(fallback.headers.get("content-type"), "application/octet-stream");
    }
    const inlinePath = `${pathName}&disposition=inline`;
    assert.equal((await app.request(inlinePath, { headers: { cookie: `orca_session=${stranger.token}` } })).status, 404);
    for (const mimeType of ["image/svg+xml", "text/html", "image/png"]) {
      db.update(emailAttachments).set({ mimeType }).where(eq(emailAttachments.id, "attachment")).run();
      for (const content of ["<html>hostile</html>", "<svg onload='alert(1)'/>", ""]) {
        data = Buffer.from(content);
        const rejected = await app.request(inlinePath, { headers });
        assert.equal(rejected.status, 415);
        assert.equal((await rejected.json()).error.code, "preview_unavailable");
      }
    }
    for (const [mimeType, content, expected] of [
      ["IMAGE/PNG; charset=binary", Buffer.from([137,80,78,71,13,10,26,10]), "image/png"],
      ["image/jpeg", Buffer.from([255,216,255]), "image/jpeg"],
      ["image/gif", Buffer.from("GIF89a"), "image/gif"],
      ["image/webp", Buffer.from("RIFF0000WEBP"), "image/webp"],
    ] as const) {
      db.update(emailAttachments).set({ mimeType, filename: 'evil\r\n"雪.png' }).where(eq(emailAttachments.id, "attachment")).run();
      data = Buffer.from(content);
      const preview = await app.request(inlinePath, { headers });
      assert.equal(preview.status, 200);
      assert.deepEqual(Buffer.from(await preview.arrayBuffer()), data);
      assert.equal(preview.headers.get("content-type"), expected);
      assert.equal(preview.headers.get("content-security-policy"), "default-src 'none'; sandbox");
      assert.equal(preview.headers.get("cache-control"), "private, no-store");
      assert.equal(preview.headers.get("x-content-type-options"), "nosniff");
      assert.equal(preview.headers.get("content-disposition"), "inline; filename*=UTF-8''evil__%22%E9%9B%AA.png");
      const ordinary = await app.request(pathName, { headers });
      assert.deepEqual(Buffer.from(await ordinary.arrayBuffer()), data);
      assert.equal(ordinary.headers.get("content-type"), "application/octet-stream");
      assert.match(ordinary.headers.get("content-disposition")!, /^attachment; filename=/);
      assert.equal(ordinary.headers.get("content-security-policy"), null);
    }
    for (const [mimeType, content] of [
      ["image/gif", Buffer.from("GIF89a").map(value => value | 128)],
      ["image/webp", Buffer.from("RIFF0000WEBP").map(value => value | 128)],
      ["image/png", Buffer.from("GIF89a")],
      ["image/jpeg", Buffer.from([255, 216])],
      ["image/webp", Buffer.from("RIFF")],
    ] as const) {
      db.update(emailAttachments).set({ mimeType }).where(eq(emailAttachments.id, "attachment")).run();
      data = Buffer.from(content);
      assert.equal((await app.request(inlinePath, { headers })).status, 415);
    }
    db.update(emailAttachments).set({ size: 26 * 1024 * 1024 }).where(eq(emailAttachments.id, "attachment")).run();
    assert.equal((await app.request(inlinePath, { headers })).status, 413);
    db.update(emailAttachments).set({ size: 5 }).where(eq(emailAttachments.id, "attachment")).run();
    data = Buffer.alloc(25 * 1024 * 1024 + 1);
    assert.equal((await app.request(inlinePath, { headers })).status, 413);
    data = Buffer.from("hello");
    const beforeRetry = requests;
    mode = "retry";
    assert.equal((await app.request(pathName, { headers })).status, 200);
    assert.equal(requests, beforeRetry + 2);
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
