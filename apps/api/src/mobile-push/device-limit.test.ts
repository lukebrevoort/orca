import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { Hono } from "hono";

import { sessionCookieName } from "../auth/config.ts";
import type { AuthVariables } from "../auth/middleware.ts";
import { createSession } from "../auth/session-store.ts";
import { createDatabaseClient } from "../db/client.ts";
import { createDestinations } from "../destinations/service.ts";
import { registerMobilePushRoutes } from "./routes.ts";
import * as store from "./store.ts";
import { clearMobilePushTestEnv, createMobilePushTestDb, seedAccount, seedMessage, setMobilePushTestEnv, testConfig } from "./test-helpers.ts";

beforeEach(setMobilePushTestEnv);
afterEach(clearMobilePushTestEnv);

const token = (n: number) => n.toString(16).padStart(64, "0");
function snapshot(sqlite: ReturnType<typeof createMobilePushTestDb>["sqlite"]) {
  return ["mobile_push_devices", "mobile_push_device_spaces", "mobile_push_outbox"]
    .map((table) => sqlite.query(`SELECT * FROM ${table} ORDER BY rowid`).all());
}

async function fixture() {
  const client = createMobilePushTestDb();
  seedAccount(client.sqlite, "owner", "owner-account");
  seedAccount(client.sqlite, "other", "other-account");
  const destinations = createDestinations(client.db, "owner");
  const space = destinations.create({ expectedRevision: destinations.list().revision, name: "Projects" })
    .state.destinations.find(({ name }) => name === "Projects")!;
  const selection = { inbox: true, spaceIds: [`destination:${space.id}`] };
  const owner = await createSession(client.db, "owner");
  const other = await createSession(client.db, "other");
  const app = new Hono<{ Variables: AuthVariables }>();
  registerMobilePushRoutes(app, { dbFactory: () => createDatabaseClient(client.path), config: testConfig, now: () => new Date(2_000) });
  const request = (id: string, options: { user?: "owner" | "other"; method?: string; token?: string; environment?: string; notificationSelection?: typeof selection } = {}) =>
    app.request(`http://orca.test/v1/mobile/devices/${id}`, {
      method: options.method ?? "PUT",
      headers: { cookie: `${sessionCookieName}=${options.user === "other" ? other.token : owner.token}`, "content-type": "application/json" },
      ...(options.method === "DELETE" ? {} : { body: JSON.stringify({ token: options.token ?? token(100), environment: options.environment ?? "sandbox",
        notificationSelection: options.notificationSelection ?? selection }) }),
    });
  for (let n = 1; n <= 10; n++) assert.equal((await request(`phone-${n}`, { token: token(n) })).status, 200);
  // Disabled registrations still occupy a slot.
  client.sqlite.query("UPDATE mobile_push_devices SET disabled_at=1 WHERE user_id='owner' AND installation_id='phone-10'").run();
  return { client, selection, request };
}

test("per-user cap rejects new devices without writes, permits refresh, and frees slots only on real deletion", async () => {
  const { client, request } = await fixture();
  try {
    const before = snapshot(client.sqlite);
    const rejected = await request("eleventh");
    assert.equal(rejected.status, 409);
    assert.deepEqual(await rejected.json(), { error: { code: "device_limit", message: "Device limit reached. Remove an unused device and try again." } });
    assert.equal(store.listDevices(client.sqlite, "owner").length, 10);
    assert.equal(store.getDevice(client.sqlite, "owner", "eleventh"), null);
    assert.deepEqual(snapshot(client.sqlite), before);

    const refresh = await request("phone-10", { token: token(101), environment: "production", notificationSelection: { inbox: false, spaceIds: [] } });
    assert.equal(refresh.status, 200);
    const refreshed = store.getDevice(client.sqlite, "owner", "phone-10")!;
    assert.equal(refreshed.tokenHash, store.hashDeviceToken(token(101)));
    assert.equal(refreshed.environment, "production");
    assert.equal(refreshed.disabledAt, null);
    assert.deepEqual(refreshed.notificationSelection, { inbox: false, spaceIds: [] });
    assert.equal(store.listDevices(client.sqlite, "owner").length, 10);

    assert.equal((await request("other-phone", { user: "other", token: token(102), notificationSelection: { inbox: true, spaceIds: [] } })).status, 200);
    assert.equal(store.listDevices(client.sqlite, "other").length, 1);
    assert.equal((await request("missing", { method: "DELETE" })).status, 404);
    assert.equal((await request("still-full")).status, 409);
    assert.equal((await request("%3Cscript%3E")).status, 400);
    assert.equal((await request("x".repeat(129))).status, 400);
    assert.equal((await request("phone-1", { method: "DELETE" })).status, 204);
    assert.equal((await request("replacement")).status, 200);
    assert.equal(store.listDevices(client.sqlite, "owner").length, 10);
  } finally { client.sqlite.close(); }
});

test("capped account switching preserves the other user's device, spaces and pending outbox; store throws DeviceLimitError", async () => {
  const { client, selection, request } = await fixture();
  try {
    assert.equal((await request("other-phone", { user: "other", token: token(102), notificationSelection: { inbox: true, spaceIds: [] } })).status, 200);
    seedMessage(client.sqlite, { id: "message", accountId: "other-account", createdAt: 1 });
    client.sqlite.query(`INSERT INTO mobile_push_outbox
      (id,user_id,installation_id,device_generation,message_id,account_id,thread_id,environment,payload_json,apns_id,state,available_at,created_at,updated_at)
      VALUES ('pending','other','other-phone',1,'message','other-account','thread-message','sandbox','{}','apns','pending',1,1,1)`).run();
    const before = snapshot(client.sqlite);
    await assert.rejects(store.registerDevice(client.sqlite, {
      userId: "owner", installationId: "store-phone", sessionId: "session-owner", token: token(102), environment: "sandbox",
      notificationSelection: selection, now: new Date(3_000),
    }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.constructor.name, "DeviceLimitError");
      return true;
    });
    assert.deepEqual(snapshot(client.sqlite), before);
    const rejected = await request("switch-phone", { token: token(102) });
    assert.equal(rejected.status, 409);
    assert.deepEqual(snapshot(client.sqlite), before);
  } finally { client.sqlite.close(); }
});
