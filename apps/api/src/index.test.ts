import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  accountFixture,
  authSessionFixture,
  inboxResponseSchema,
} from "@orca/shared";
import { app } from "./index.ts";

describe("Orca API", () => {
  test("returns the current auth session fixture", async () => {
    const response = await app.request("/v1/auth/session");

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), authSessionFixture);
  });

  test("returns the current account fixture", async () => {
    const response = await app.request("/v1/me");

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), accountFixture);
  });

  test("returns the inbox fixture with the shared response shape", async () => {
    const response = await app.request("/v1/inbox");
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(inboxResponseSchema.parse(body), body);
    assert.deepEqual(body.account, accountFixture);
    assert.equal(body.messages.length, 1);
    assert.equal(body.nextCursor, null);
  });

  test("rejects blank inbox cursors", async () => {
    const response = await app.request("/v1/inbox?cursor=");
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.error.code, "validation_error");
    assert.equal(body.error.message, "Invalid inbox query parameters");
    assert.deepEqual(body.error.issues, [
      {
        path: "cursor",
        message: "String must contain at least 1 character(s)",
      },
    ]);
  });
});
