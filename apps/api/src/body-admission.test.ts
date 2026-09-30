import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createApp } from "./index.ts";
import { createDatabaseClient } from "./db/client.ts";
import { oauthAccounts, users } from "./db/schema.ts";
import { createSession } from "./auth/session-store.ts";
import { mcpOAuthLimits, type McpOAuthConfig } from "./auth/mcp/config.ts";
import { ordinaryJsonBodyBytes } from "./request-body.ts";
import { gmailProvider } from "./providers/gmail/provider.ts";
import { ProviderRegistry } from "./providers/registry.ts";
import { handleFeedbackRequest } from "./feedback.ts";

const config: McpOAuthConfig = {
  enabled: true, issuer: "https://auth.orca.test", resource: "https://mcp.orca.test/mcp",
  accessTokenTtlMs: 600_000, refreshTokenTtlMs: 2_592_000_000, authorizationCodeTtlMs: 300_000,
  signingKey: new Uint8Array(32).fill(17), signingKeyId: "test-mcp-v1",
  allowedRedirectUris: ["https://chatgpt.com/connector_platform_oauth_redirect"], registrationLimitPerMinute: 30,
};

function streamed(path: string, sizes: number[], headers: Record<string, string> = {}, method = "POST") {
  const state = { reads: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.reads++;
      const size = sizes.shift();
      if (size !== undefined) controller.enqueue(new Uint8Array(size).fill(32));
      else controller.close();
    },
    cancel() { state.cancelled = true; },
  }, { highWaterMark: 0 });
  return { request: new Request(`http://localhost${path}`, { method, headers, body }), state };
}

test("every protected JSON family rejects unauthenticated requests before reading their stream", async () => {
  const app = createApp({ mcpOAuthConfig: config, dbFactory: () => { throw new Error("No unauthenticated database work"); } });
  const routes = [
    ["POST", "/v1/drafts"], ["PATCH", "/v1/drafts/id"], ["POST", "/v1/drafts/id/send"],
    ["PATCH", "/v1/agent-events/id/lifecycle"], ["PATCH", "/v1/preferences"],
    ["POST", "/v1/attention/rules/batch"], ["POST", "/v1/attention/rules"], ["PATCH", "/v1/attention/rules/id"],
    ["PUT", "/v1/attention/preferences"], ["PUT", "/v1/attention/routing"], ["PATCH", "/v1/attention/view-settings/focus"],
    ["POST", "/v1/classification/overrides"], ["PATCH", "/v1/classification/overrides/id"],
    ["POST", "/v1/gmail-label-migration/import"], ["POST", "/v1/collections"], ["PATCH", "/v1/collections/id"],
    ["POST", "/v1/pins"], ["PATCH", "/v1/pins/id"], ["POST", "/v1/reminders"], ["PATCH", "/v1/reminders/id"], ["PATCH", "/v1/reminders/view-settings"],
    ["POST", "/v1/threads/id/reply-brief"], ["PATCH", "/v1/threads/id/read?accountId=a"],
    ["POST", "/v1/destinations"], ["PATCH", "/v1/destinations/id"], ["PUT", "/v1/destinations/routing"], ["PUT", "/v1/destinations/routing/batch"], ["POST", "/v1/destinations/id/retire"],
    ["PATCH", "/v1/calendar/preferences"], ["PATCH", "/v1/calendar/calendars/selection"], ["POST", "/v1/calendar/availability"],
    ["POST", "/v1/organization/apply"], ["PUT", "/v1/mobile/devices/id"],
    ["POST", "/v1/mobile/auth/grant"], ["POST", "/v1/mobile/auth/cancel"], ["POST", "/v1/mobile/auth/restart"], ["POST", "/oauth/authorize"],
  ];
  for (const [method, path] of routes) {
    const { request, state } = streamed(path!, [10_000_000], { "content-type": "application/json" }, method);
    const response = await app.fetch(request);
    assert.equal(response.status, 401, `${method} ${path}`);
    assert.equal(state.reads, 0, `${method} ${path} must not read`);
    await request.body!.cancel();
  }
});

test("enabled OAuth endpoints cancel undeclared and deceptive-length oversized streams with their stable errors", async () => {
  const app = createApp({ mcpOAuthConfig: config, dbFactory: () => { throw new Error("Rejected body must not open DB"); } });
  for (const path of ["/oauth/register", "/oauth/token", "/oauth/revoke"]) {
    for (const declared of [undefined, "1"]) {
      const headers: Record<string, string> = declared === undefined ? {} : { "content-length": declared };
      const { request, state } = streamed(path, [mcpOAuthLimits.tokenRequestBodyBytes, 1, 100_000], headers);
      const response = await app.fetch(request);
      assert.equal(response.status, 413);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal((await response.json()).error, path.endsWith("register") ? "invalid_client_metadata" : "invalid_request");
      assert.deepEqual(state, { reads: 2, cancelled: true });
    }
  }
});

test("disabled OAuth endpoints do not consume bodies; public mobile readers retain public errors and cancel overflow", async () => {
  const app = createApp({ mcpOAuthConfig: { ...config, enabled: false }, dbFactory: () => { throw new Error("Rejected body must not open DB"); } });
  const disabled = streamed("/oauth/register", [100_000]);
  assert.equal((await app.fetch(disabled.request)).status, 404);
  assert.equal(disabled.state.reads, 0);
  await disabled.request.body!.cancel();
  for (const path of ["/v1/mobile/auth/start", "/v1/mobile/auth/exchange"]) {
    const input = streamed(path, [4096, 1, 100_000], { "content-type": "application/json", "content-length": "1" });
    const response = await app.fetch(input.request);
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error.code, "payload_too_large");
    assert.deepEqual(input.state, { reads: 2, cancelled: true });
    assert.equal((await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 400);
  }
});

test("public feedback and verified push readers stream-admit before JSON parsing", async () => {
  for (const declared of [undefined, "1"]) {
    const headers: Record<string, string> = declared === undefined ? {} : { "content-length": declared };
    const input = streamed("/v1/feedback", [40 * 1024 * 1024, 1, 100_000], headers);
    const response = await handleFeedbackRequest(input.request, { onReport() { throw new Error("Rejected reports must not be delivered"); } });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error, "Feedback payload is too large.");
    assert.deepEqual(input.state, { reads: 2, cancelled: true });
  }
  const app = createApp({ dbFactory: () => { throw new Error("Rejected push must not open DB"); }, gmailPushConfig: { verificationToken: "push-secret", topicName: "projects/orca/topics/gmail", syncIntervalMs: 60_000, watchRenewalWindowMs: 60_000, backfillPageSize: 25, backfillMaxPages: 20 } });
  for (const path of ["/v1/webhooks/gmail", "/v1/gmail/push"]) {
    const unverified = streamed(path, [10_000_000]);
    assert.equal((await app.fetch(unverified.request)).status, 401);
    assert.equal(unverified.state.reads, 0);
    await unverified.request.body!.cancel();
    const verified = streamed(`${path}?token=push-secret`, [ordinaryJsonBodyBytes, 1, 100_000], { "content-length": "1" });
    assert.equal((await app.fetch(verified.request)).status, 413);
    assert.deepEqual(verified.state, { reads: 2, cancelled: true });
  }
});

test("authenticated admission preserves ordinary JSON, exact OAuth JSON/form limits, and 25 MiB attachment delivery", async () => {
  const previousSecret = process.env.SESSION_SECRET;
  const previousEncryption = process.env.TOKEN_ENCRYPTION_KEY;
  process.env.SESSION_SECRET = "body-admission-test-secret-at-least-32-characters";
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  const directory = mkdtempSync(join(tmpdir(), "orca-body-admission-"));
  const path = join(directory, "test.sqlite");
  const { db, sqlite } = createDatabaseClient(path);
  migrate(db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });
  try {
    db.insert(users).values({ id: "owner", email: "owner@example.com" }).run();
    db.insert(oauthAccounts).values({ id: "account", userId: "owner", provider: "gmail", providerId: "account", providerEmail: "owner@gmail.com" }).run();
    const session = await createSession(db, "owner");
    let deliveredBytes = 0;
    const app = createApp({
      dbFactory: () => createDatabaseClient(path), mcpOAuthConfig: config,
      providerRegistry: new ProviderRegistry([{ ...gmailProvider,
        detectCapabilities: () => ({ read: true, draft: false, send: true }),
        createTransport: () => ({ async saveDraft() { throw new Error("No draft mirror"); }, async deleteDraft() {},
          async send(_db, _account, draft) { deliveredBytes = Buffer.from(draft.attachments[0]!.contentBase64!, "base64").length; return { providerMessageId: "sent", providerThreadId: "sent-thread" }; },
        }),
      }]),
    });
    const headers = { cookie: `orca_session=${session.token}`, "content-type": "application/json" };
    const ordinary = await app.request("/v1/preferences", { method: "PATCH", headers, body: JSON.stringify({ signature: "Hello é😀" }) });
    assert.equal(ordinary.status, 200);
    for (const [route, method, limit] of [["/v1/preferences", "PATCH", ordinaryJsonBodyBytes], ["/v1/organization/apply", "POST", 512 * 1024], ["/v1/mobile/devices/id", "PUT", 32 * 1024], ["/v1/drafts", "POST", 36 * 1024 * 1024], ["/v1/drafts/id", "PATCH", 36 * 1024 * 1024]] as const) {
      const input = streamed(route, [limit, 1, 100_000], { ...headers, "content-length": "1" }, method);
      assert.equal((await app.fetch(input.request)).status, 413, route);
      assert.deepEqual(input.state, { reads: 2, cancelled: true });
    }
    const registration = JSON.stringify({ redirect_uris: config.allowedRedirectUris });
    assert.equal((await app.request("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: registration.padEnd(mcpOAuthLimits.registrationBodyBytes) })).status, 201);
    const revoke = "token=unknown&padding=".padEnd(mcpOAuthLimits.tokenRequestBodyBytes, "x");
    assert.equal((await app.request("/oauth/revoke", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: revoke })).status, 200);
    const token = `client_id=unknown&resource=${encodeURIComponent(config.resource)}&grant_type=unsupported&padding=`.padEnd(mcpOAuthLimits.tokenRequestBodyBytes, "x");
    const unsupported = await app.request("/oauth/token", { method: "POST", body: token });
    assert.equal(unsupported.status, 400);
    assert.equal((await unsupported.json()).error, "unsupported_grant_type");
    const attachment = { id: "file", filename: "large.bin", mimeType: "application/octet-stream", size: 25 * 1024 * 1024, contentBase64: Buffer.alloc(25 * 1024 * 1024, 7).toString("base64") };
    const body = JSON.stringify({ to: [{ name: null, email: "recipient@example.com" }], attachments: [attachment] });
    assert.ok(new TextEncoder().encode(body).length < 36 * 1024 * 1024);
    const created = await app.request("/v1/drafts?accountId=account", { method: "POST", headers, body });
    assert.equal(created.status, 201);
    const draft = await created.json();
    const sent = await app.request(`/v1/drafts/${draft.id}/send?accountId=account`, { method: "POST", headers, body: JSON.stringify({ revision: 0, idempotencyKey: "body-admission-send-stable-key" }) });
    assert.equal(sent.status, 200);
    assert.equal((await sent.json()).status, "sent");
    assert.equal(deliveredBytes, attachment.size);
  } finally {
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
    if (previousSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSecret;
    if (previousEncryption === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = previousEncryption;
  }
});
