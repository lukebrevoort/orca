import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "bun:test";

import { getDatabasePath } from "./config.ts";

test("anchors relative database paths to the API workspace", () => {
  const previousDatabasePath = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = "./data/test.sqlite";

  try {
    assert.equal(getDatabasePath(), resolve(import.meta.dir, "../..", "data/test.sqlite"));
  } finally {
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
  }
});
