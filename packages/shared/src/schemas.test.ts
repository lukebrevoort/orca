import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  authSessionSchema,
  inboxQuerySchema,
  inboxResponseSchema,
} from "./index.ts";
import { accountFixture, inboxFixture } from "./fixtures.ts";

describe("shared API schemas", () => {
  test("parses the fixture inbox response shape", () => {
    assert.deepEqual(
      inboxResponseSchema.parse({
        account: accountFixture,
        messages: inboxFixture,
        nextCursor: null,
      }),
      {
      account: accountFixture,
      messages: inboxFixture,
      nextCursor: null,
      },
    );
  });

  test("rejects blank inbox cursors", () => {
    assert.throws(
      () => inboxQuerySchema.parse({ cursor: "" }),
      /Too small: expected string to have >=1 characters/,
    );
  });

  test("requires an authenticated user when the session is authenticated", () => {
    assert.throws(
      () =>
        authSessionSchema.parse({
        isAuthenticated: true,
        user: null,
        expiresAt: null,
      }),
      /Authenticated sessions must include a user/,
    );
  });
});
