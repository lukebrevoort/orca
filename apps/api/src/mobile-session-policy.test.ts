import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createDatabaseClient } from "./db/client.ts";
import { users } from "./db/schema.ts";
import { createMobileSession, revokeMobileSession } from "./auth/mobile/store.ts";
import { isMobilePushSessionActive } from "./mobile-session-policy.ts";

test("push eligibility requires the original live session and user, including exact expiry", () => {
  const directory = mkdtempSync(join(tmpdir(), "orca-push-session-"));
  const { db, sqlite } = createDatabaseClient(join(directory, "test.sqlite"));
  try {
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });
    const now = new Date("2026-09-22T12:00:00Z");
    db.insert(users).values({ id: "owner", email: "owner@example.com", authenticatedAt: now }).run();
    const mobile = createMobileSession(db, "owner", now);
    const input = { userId: "owner", sessionId: mobile.sessionId, now };
    expect(isMobilePushSessionActive(sqlite, input)).toBe(true);
    expect(isMobilePushSessionActive(sqlite, { ...input, userId: "other" })).toBe(false);
    expect(isMobilePushSessionActive(sqlite, { ...input, now: mobile.expiresAt })).toBe(false);
    revokeMobileSession(db, mobile.sessionId, "owner", now);
    expect(isMobilePushSessionActive(sqlite, input)).toBe(false);
    sqlite.query("INSERT INTO sessions(id,user_id,expires_at) VALUES ('web-session','owner',?)").run(now.getTime() + 1_000);
    const web = { ...input, sessionId: "web-session" };
    expect(isMobilePushSessionActive(sqlite, web)).toBe(true);
    expect(isMobilePushSessionActive(sqlite, { ...web, now: new Date(now.getTime() + 1_000) })).toBe(false);
    sqlite.query("UPDATE sessions SET invalidated_at=? WHERE id='web-session'").run(now.getTime());
    expect(isMobilePushSessionActive(sqlite, web)).toBe(false);
    expect(isMobilePushSessionActive(sqlite, { ...input, sessionId: "mobile_session_missing" })).toBe(false);
  } finally {
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
