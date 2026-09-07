import { test, expect } from "bun:test";
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createDatabaseClient } from "./client";

test("BRE-386 migration retires existing human Views without a GET mutation or resetting writing preferences", () => {
  const dir = mkdtempSync(join(tmpdir(), "orca-guidance-migrate-"));
  const prior = join(dir, "prior");
  cpSync(resolve(import.meta.dir, "../../drizzle"), prior, { recursive: true });
  const journal = JSON.parse(readFileSync(join(prior, "meta/_journal.json"), "utf8"));
  journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 38);
  writeFileSync(join(prior, "meta/_journal.json"), JSON.stringify(journal));
  const { db, sqlite } = createDatabaseClient(join(dir, "migration.sqlite"));
  try {
    migrate(db, { migrationsFolder: prior });
    sqlite.query("INSERT INTO users (id,email) VALUES ('existing','existing@example.com'),('new','new@example.com')").run();
    sqlite.query("INSERT INTO user_preferences (user_id,signature) VALUES ('existing','Keep my signature')").run();
    sqlite.query("INSERT INTO organization_views (workspace_id,id,name,description,color,position,definition,revision,created_at,updated_at) VALUES ('existing','old-view','Old View','','#70867d',0,'{\"revision\":1}',1,1000,1000)").run();
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../../drizzle") });
    const preferences = sqlite.query("SELECT signature,first_view_guidance_completed_at FROM user_preferences WHERE user_id='existing'").get() as { signature: string; first_view_guidance_completed_at: string | null };
    expect(preferences.signature).toBe("Keep my signature");
    expect(preferences.first_view_guidance_completed_at).toBe("1970-01-01T00:00:01.000Z");
    sqlite.query("DELETE FROM organization_views WHERE id='old-view'").run();
    expect((sqlite.query("SELECT first_view_guidance_completed_at AS stamp FROM user_preferences WHERE user_id='existing'").get() as { stamp: string }).stamp).toBe(preferences.first_view_guidance_completed_at);
    expect(sqlite.query("SELECT * FROM user_preferences WHERE user_id='new'").get()).toBeNull();
  } finally { sqlite.close(); rmSync(dir, { recursive: true, force: true }); }
});
