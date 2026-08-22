import { and, eq } from "drizzle-orm";

import { createDatabaseClient } from "../../db/client.ts";
import { calendarConnections } from "../../db/schema.ts";

export type CalendarConnectionRecord = {
  id: string;
  userId: string;
  provider: "google";
  providerAccountId: string;
  accountLabel: string;
  accessTokenEncrypted: string | null;
  refreshTokenEncrypted: string | null;
  tokenExpiry: Date | null;
  grantedScopes: string[];
  state: "connected" | "expired" | "revoked" | "error";
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CalendarConnectionStore = {
  findById(userId: string, id: string): Promise<CalendarConnectionRecord | null>;
  listForUser(userId: string): Promise<CalendarConnectionRecord[]>;
  upsert(input: {
    userId: string;
    providerAccountId: string;
    accountLabel: string;
    accessTokenEncrypted: string;
    refreshTokenEncrypted: string | null;
    tokenExpiry: Date | null;
    grantedScopes: string[];
  }): Promise<CalendarConnectionRecord>;
};

export class DatabaseCalendarConnectionStore implements CalendarConnectionStore {
  constructor(private readonly dbFactory = createDatabaseClient) {}

  async findById(userId: string, id: string) {
    const { db, sqlite } = this.dbFactory();
    try {
      const row = db.select().from(calendarConnections).where(and(eq(calendarConnections.id, id), eq(calendarConnections.userId, userId))).get();
      return row ? toRecord(row) : null;
    } finally { sqlite.close(); }
  }

  async listForUser(userId: string) {
    const { db, sqlite } = this.dbFactory();
    try {
      return db.select().from(calendarConnections).where(eq(calendarConnections.userId, userId)).all().map(toRecord);
    } finally { sqlite.close(); }
  }

  async upsert(input: Parameters<CalendarConnectionStore["upsert"]>[0]) {
    const { db, sqlite } = this.dbFactory();
    try {
      const existing = db.select().from(calendarConnections).where(and(
        eq(calendarConnections.userId, input.userId),
        eq(calendarConnections.provider, "google"),
        eq(calendarConnections.providerAccountId, input.providerAccountId),
      )).get();
      const now = new Date();
      if (existing) {
        db.update(calendarConnections).set({
          accountLabel: input.accountLabel,
          accessTokenEncrypted: input.accessTokenEncrypted,
          refreshTokenEncrypted: input.refreshTokenEncrypted ?? existing.refreshTokenEncrypted,
          tokenExpiry: input.tokenExpiry,
          scope: input.grantedScopes.join(" "),
          state: "connected",
          error: null,
          updatedAt: now,
        }).where(eq(calendarConnections.id, existing.id)).run();
        return toRecord(db.select().from(calendarConnections).where(eq(calendarConnections.id, existing.id)).get()!);
      }
      const id = `calendar-connection:${crypto.randomUUID()}`;
      db.insert(calendarConnections).values({
        id,
        userId: input.userId,
        provider: "google",
        providerAccountId: input.providerAccountId,
        accountLabel: input.accountLabel,
        accessTokenEncrypted: input.accessTokenEncrypted,
        refreshTokenEncrypted: input.refreshTokenEncrypted,
        tokenExpiry: input.tokenExpiry,
        scope: input.grantedScopes.join(" "),
        state: "connected",
        error: null,
        updatedAt: now,
      }).run();
      return toRecord(db.select().from(calendarConnections).where(eq(calendarConnections.id, id)).get()!);
    } finally { sqlite.close(); }
  }
}

function toRecord(row: typeof calendarConnections.$inferSelect): CalendarConnectionRecord {
  return {
    ...row,
    provider: "google",
    grantedScopes: row.scope.split(/\s+/).filter(Boolean),
    state: row.state as CalendarConnectionRecord["state"],
  };
}

