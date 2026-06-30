import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { getServerConfig } from "./server.ts";

describe("server config", () => {
  test("uses the local defaults when env vars are absent", () => {
    assert.deepEqual(getServerConfig({}), {
      port: 3000,
      webOrigin: "http://localhost:5173",
    });
  });

  test("validates the port", () => {
    assert.throws(() => getServerConfig({ PORT: "abc" }), /PORT/);
    assert.throws(() => getServerConfig({ PORT: "0" }), /PORT/);
  });

  test("validates the web origin", () => {
    assert.throws(() => getServerConfig({ WEB_ORIGIN: "not-a-url" }), /WEB_ORIGIN/);
  });
});
