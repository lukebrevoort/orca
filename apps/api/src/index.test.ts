import { describe, expect, test } from "bun:test";
import {
  accountFixture,
  authSessionFixture,
  inboxResponseSchema,
} from "@orca/shared";
import { app } from "./index";

describe("Orca API", () => {
  test("returns the current auth session fixture", async () => {
    const response = await app.request("/v1/auth/session");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(authSessionFixture);
  });

  test("returns the current account fixture", async () => {
    const response = await app.request("/v1/me");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(accountFixture);
  });

  test("returns the inbox fixture with the shared response shape", async () => {
    const response = await app.request("/v1/inbox");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(inboxResponseSchema.parse(body)).toEqual(body);
    expect(body.account).toEqual(accountFixture);
    expect(body.messages).toHaveLength(1);
    expect(body.nextCursor).toBeNull();
  });

  test("rejects blank inbox cursors", async () => {
    const response = await app.request("/v1/inbox?cursor=");
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("validation_error");
    expect(body.error.message).toBe("Invalid inbox query parameters");
    expect(body.error.issues).toContainEqual({
      path: "cursor",
      message: "Too small: expected string to have >=1 characters",
    });
  });
});
