import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, lte } from "drizzle-orm";
import { createDatabaseClient } from "../db/client.ts";
import { mailOAuthTransactions, sessions, users } from "../db/schema.ts";
import { mobileSessions } from "./mobile/schema.ts";
import type { AuthContext } from "./middleware.ts";

export type OAuthOwner = Pick<AuthContext, "userId" | "sessionId">;
export type MailOAuthTransaction = Omit<typeof mailOAuthTransactions.$inferInsert, "stateHash">;
export interface MailOAuthTransactionStore {
  create(input: Omit<MailOAuthTransaction, "codeVerifier" | "expiresAt">): { state: string; codeChallenge: string };
  consume(state: string, owner: OAuthOwner, provider: "gmail" | "outlook"): MailOAuthTransaction | null;
  isPending(owner: OAuthOwner, pendingEmail: string): boolean;
  isActive(owner: OAuthOwner): boolean;
}

const lifetimeMs = 10 * 60 * 1000;
const hash = (value: string) => createHash("sha256").update(value).digest("base64url");

export class DatabaseMailOAuthTransactionStore implements MailOAuthTransactionStore {
  constructor(private readonly dbFactory = createDatabaseClient) {}

  create(input: Omit<MailOAuthTransaction, "codeVerifier" | "expiresAt">) {
    const state = randomBytes(32).toString("base64url");
    const codeVerifier = randomBytes(32).toString("base64url");
    const { db, sqlite } = this.dbFactory();
    try {
      db.transaction((tx) => {
        tx.delete(mailOAuthTransactions).where(lte(mailOAuthTransactions.expiresAt, new Date())).run();
        tx.insert(mailOAuthTransactions).values({ ...input, stateHash: hash(state), codeVerifier, expiresAt: new Date(Date.now() + lifetimeMs) }).run();
      });
      return { state, codeChallenge: hash(codeVerifier) };
    } finally { sqlite.close(); }
  }

  consume(state: string, owner: OAuthOwner, provider: "gmail" | "outlook") {
    // Canonical opaque state only; reject signed legacy payloads and alternate encodings.
    if (!/^[A-Za-z0-9_-]{43}$/.test(state)) return null;
    const { db, sqlite } = this.dbFactory();
    try {
      return db.transaction((tx) => {
        if (!isMailOAuthSessionActive(tx, owner)) return null;
        const row = tx.delete(mailOAuthTransactions).where(and(
          eq(mailOAuthTransactions.stateHash, hash(state)),
          eq(mailOAuthTransactions.userId, owner.userId),
          eq(mailOAuthTransactions.sessionId, owner.sessionId),
          eq(mailOAuthTransactions.provider, provider),
          gt(mailOAuthTransactions.expiresAt, new Date()),
        )).returning().get();
        if (!row) return null;
        if (row.pendingEmail && !tx.select({ id: users.id }).from(users).where(pendingUserWhere(owner.userId, row.pendingEmail)).get()) return null;
        return row;
      });
    } finally { sqlite.close(); }
  }

  isPending(owner: OAuthOwner, pendingEmail: string) {
    const { db, sqlite } = this.dbFactory();
    try { return Boolean(db.select({ id: users.id }).from(users).where(pendingUserWhere(owner.userId, pendingEmail)).get()); }
    finally { sqlite.close(); }
  }

  isActive(owner: OAuthOwner) {
    const { db, sqlite } = this.dbFactory();
    try { return isMailOAuthSessionActive(db, owner); }
    finally { sqlite.close(); }
  }
}

export function isMailOAuthSessionActive(db: Pick<ReturnType<typeof createDatabaseClient>["db"], "select">, owner: OAuthOwner) {
  const now = new Date();
  return Boolean(db.select({ id: sessions.id }).from(sessions).where(and(
    eq(sessions.id, owner.sessionId), eq(sessions.userId, owner.userId), isNull(sessions.invalidatedAt), gt(sessions.expiresAt, now),
  )).get() || db.select({ id: mobileSessions.id }).from(mobileSessions).where(and(
    eq(mobileSessions.id, owner.sessionId), eq(mobileSessions.userId, owner.userId), isNull(mobileSessions.revokedAt), gt(mobileSessions.expiresAt, now),
  )).get());
}

export function pendingUserWhere(userId: string, pendingEmail: string) {
  return and(eq(users.id, userId), eq(users.email, pendingEmail), isNull(users.authenticatedAt), isNull(users.onboardingCompletedAt));
}

/** Injectable service-test store. Production routes always default to SQLite. */
export class InMemoryMailOAuthTransactionStore implements MailOAuthTransactionStore {
  private readonly records = new Map<string, MailOAuthTransaction>();
  create(input: Omit<MailOAuthTransaction, "codeVerifier" | "expiresAt">) {
    const state = randomBytes(32).toString("base64url");
    const codeVerifier = randomBytes(32).toString("base64url");
    this.records.set(state, { ...input, codeVerifier, expiresAt: new Date(Date.now() + lifetimeMs) });
    return { state, codeChallenge: hash(codeVerifier) };
  }
  consume(state: string, owner: OAuthOwner, provider: "gmail" | "outlook") {
    const row = this.records.get(state);
    if (!row || row.userId !== owner.userId || row.sessionId !== owner.sessionId || row.provider !== provider || row.expiresAt.getTime() <= Date.now()) return null;
    this.records.delete(state);
    return row;
  }
  isPending() { return true; }
  isActive() { return true; }
}
