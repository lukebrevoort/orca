import { test, expect } from "bun:test";
import { setMobilePushTestEnv, clearMobilePushTestEnv, createMobilePushTestDb, seedAccount } from "../mobile-push/test-helpers.ts";
test("BRE-455 migration enforces owner/account/message boundaries and leaves stable importance migrations intact", () => {
  setMobilePushTestEnv(); const f = createMobilePushTestDb();
  try {
    seedAccount(f.sqlite, "u", "a"); seedAccount(f.sqlite, "v", "b");
    f.sqlite.query(`INSERT INTO important_notification_installations(user_id,channel,installation_id,session_id,enabled,permission,revision,generation,created_at,updated_at) VALUES('u','open_app','browser','session-u',1,'granted',1,1,1,1)`).run();
    expect(() => f.sqlite.query("INSERT INTO important_notification_accounts VALUES('u','open_app','browser','b',1,0,0)").run()).toThrow();
    expect(() => f.sqlite.query("INSERT INTO important_notification_accounts VALUES('u','open_app','unknown','a',1,0,0)").run()).toThrow();
    expect(f.sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(f.sqlite.query("SELECT count(*) n FROM important_notification_arrivals").get()).toEqual({ n: 0 });
    f.sqlite.query("DELETE FROM users WHERE id='u'").run();
    expect(f.sqlite.query("SELECT count(*) n FROM important_notification_installations").get()).toEqual({ n: 0 });
  } finally { f.sqlite.close(); clearMobilePushTestEnv(); }
});
