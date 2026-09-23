import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { Hono } from "hono";

import { sessionCookieName } from "../auth/config.ts";
import type { AuthVariables } from "../auth/middleware.ts";
import { createSession } from "../auth/session-store.ts";
import { createDatabaseClient } from "../db/client.ts";
import { createDestinations } from "../destinations/service.ts";
import { registerMobilePushRoutes } from "./routes.ts";
import { clearMobilePushTestEnv, createMobilePushTestDb, seedAccount, setMobilePushTestEnv, testConfig } from "./test-helpers.ts";

beforeEach(setMobilePushTestEnv);
afterEach(clearMobilePushTestEnv);

describe("mobile push routes", () => {
  test("requires authentication and keeps installation registrations isolated per user", async () => {
    const client = createMobilePushTestDb();
    seedAccount(client.sqlite, "owner", "owner-account");
    seedAccount(client.sqlite, "other", "other-account");
    const ownerDestinations = createDestinations(client.db, "owner");
    const projects = ownerDestinations.create({ expectedRevision: ownerDestinations.list().revision, name: "Projects" }).state.destinations.find(({ name }) => name === "Projects")!;
    const otherDestinations = createDestinations(client.db, "other");
    const privateSpace = otherDestinations.create({ expectedRevision: otherDestinations.list().revision, name: "Private" }).state.destinations.find(({ name }) => name === "Private")!;
    const owner = await createSession(client.db, "owner");
    const other = await createSession(client.db, "other");
    const app = new Hono<{ Variables: AuthVariables }>();
    registerMobilePushRoutes(app, { dbFactory: () => createDatabaseClient(client.path), config: testConfig, now: () => new Date(2_000) });
    const body = JSON.stringify({ token: "ab".repeat(32), environment: "sandbox", notificationMode: "human" });

    const unauthorized = await app.request("http://orca.test/v1/mobile/devices/phone", { method: "PUT", headers: { "content-type": "application/json" }, body });
    assert.equal(unauthorized.status, 401);
    const oversized = await app.request("http://orca.test/v1/mobile/devices/phone", { method: "PUT", headers: { cookie: `${sessionCookieName}=${owner.token}`, "content-type": "application/json" }, body: JSON.stringify({ token: "a".repeat(40_000) }) });
    assert.equal(oversized.status, 413);
    const registered = await app.request("http://orca.test/v1/mobile/devices/phone", { method: "PUT", headers: { cookie: `${sessionCookieName}=${owner.token}`, "content-type": "application/json" }, body });
    assert.equal(registered.status, 200);
    const registeredBody = await registered.json() as Record<string, unknown>;
    assert.equal(JSON.stringify(registeredBody).includes("abababab"), false);
    assert.equal((registeredBody.push as { configured: boolean }).configured, true);
    assert.deepEqual((registeredBody.device as { notificationSelection: unknown }).notificationSelection, { inbox: true, spaceIds: [] });

    const catalogResponse = await app.request("http://orca.test/v1/mobile/push/catalog", { headers: { cookie: `${sessionCookieName}=${owner.token}` } });
    assert.equal(catalogResponse.status, 200);
    const catalog = await catalogResponse.json() as { defaultSelection: unknown; spaces: Array<{ id: string; kind: string; name: string }> };
    assert.deepEqual(catalog.defaultSelection, { inbox: true, spaceIds: [] });
    assert.deepEqual(catalog.spaces.map(({ id, kind, name }) => ({ id, kind, name })), [
      { id: `destination:${projects.id}`, kind: "destination", name: "Projects" },
    ]);

    const selected = await app.request("http://orca.test/v1/mobile/devices/phone", { method: "PUT", headers: { cookie: `${sessionCookieName}=${owner.token}`, "content-type": "application/json" }, body: JSON.stringify({
      token: "ab".repeat(32), environment: "sandbox", notificationSelection: { inbox: true, spaceIds: [`destination:${projects.id}`] },
    }) });
    assert.equal(selected.status, 200);
    assert.deepEqual(((await selected.json()) as { device: { notificationSelection: unknown } }).device.notificationSelection,
      { inbox: true, spaceIds: [`destination:${projects.id}`] });
    ownerDestinations.retire(projects.id, { expectedRevision: ownerDestinations.list().revision,
      reassignToDestinationId: ownerDestinations.list().fallbackDestinationId });
    const retired = await app.request("http://orca.test/v1/mobile/devices/phone", { method: "PUT", headers: { cookie: `${sessionCookieName}=${owner.token}`, "content-type": "application/json" }, body: JSON.stringify({
      token: "ab".repeat(32), environment: "sandbox", notificationSelection: { inbox: false, spaceIds: [`destination:${projects.id}`] },
    }) });
    assert.equal(retired.status, 400);
    const foreign = await app.request("http://orca.test/v1/mobile/devices/phone", { method: "PUT", headers: { cookie: `${sessionCookieName}=${owner.token}`, "content-type": "application/json" }, body: JSON.stringify({
      token: "ab".repeat(32), environment: "sandbox", notificationSelection: { inbox: false, spaceIds: [`destination:${privateSpace.id}`] },
    }) });
    assert.equal(foreign.status, 400);

    const legacyOff = await app.request("http://orca.test/v1/mobile/devices/tablet", { method: "PUT", headers: { cookie: `${sessionCookieName}=${owner.token}`, "content-type": "application/json" }, body: JSON.stringify({
      token: "cd".repeat(32), environment: "sandbox", notificationMode: "off",
    }) });
    assert.equal(legacyOff.status, 200);
    assert.deepEqual(((await legacyOff.json()) as { device: { notificationSelection: unknown } }).device.notificationSelection, { inbox: false, spaceIds: [] });

    const ownerStatus = await app.request("http://orca.test/v1/mobile/push/status", { headers: { cookie: `${sessionCookieName}=${owner.token}` } });
    const otherStatus = await app.request("http://orca.test/v1/mobile/push/status", { headers: { cookie: `${sessionCookieName}=${other.token}` } });
    assert.equal(((await ownerStatus.json()) as { devices: unknown[] }).devices.length, 2);
    assert.equal(((await otherStatus.json()) as { devices: unknown[] }).devices.length, 0);

    const otherDelete = await app.request("http://orca.test/v1/mobile/devices/phone", { method: "DELETE", headers: { cookie: `${sessionCookieName}=${other.token}` } });
    assert.equal(otherDelete.status, 404);
    const ownerDelete = await app.request("http://orca.test/v1/mobile/devices/phone", { method: "DELETE", headers: { cookie: `${sessionCookieName}=${owner.token}` } });
    assert.equal(ownerDelete.status, 204);
    client.sqlite.close();
  });

  test("reports a clear disabled state when APNs credentials are absent", async () => {
    const client = createMobilePushTestDb();
    seedAccount(client.sqlite, "owner", "owner-account");
    const owner = await createSession(client.db, "owner");
    const app = new Hono<{ Variables: AuthVariables }>();
    registerMobilePushRoutes(app, { dbFactory: () => createDatabaseClient(client.path), config: { ...testConfig, configured: false, disabledReason: "APNs credentials are not configured" } });
    const response = await app.request("http://orca.test/v1/mobile/push/status", { headers: { cookie: `${sessionCookieName}=${owner.token}` } });
    assert.deepEqual(await response.json(), { configured: false, deliveryEnabled: false, disabledReason: "APNs credentials are not configured", devices: [] });
    client.sqlite.close();
  });
});
