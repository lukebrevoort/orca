import { describe, expect, test } from "bun:test";
import { accountFixture, inboxFixture } from "@orca/shared";
import { app } from "./index";

describe("read-only inbox API", () => {
  test("returns the current account", async () => {
    const response = await app.request("/v1/me");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(accountFixture);
  });

  test("returns the inbox list payload", async () => {
    const response = await app.request("/v1/inbox");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      account: accountFixture,
      messages: inboxFixture,
      nextCursor: null,
    });
  });
});
