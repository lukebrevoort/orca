import { and, eq, inArray, isNull, like, lt, notExists, or } from "drizzle-orm";
import type { createDatabaseClient } from "../db/client.ts";
import { oauthAccounts, pendingMailLogins, users } from "../db/schema.ts";
import { pendingUserEmailPattern } from "./pending-user.ts";
import { purgeStalePendingUsers, stalePendingPurgeBatchSize } from "./session-store.ts";

// Shared across providers and processes using the same SQLite database.
export const maxPendingMailLogins = 1000;
export const mailLoginRetryAfterSeconds = 60;
const maxPendingAgeMs = 60 * 60 * 1000;

export function admitPendingMailLogin(db: ReturnType<typeof createDatabaseClient>["db"]) {
  return db.transaction((tx) => {
    const userId = `user_${crypto.randomUUID()}`;
    const pendingEmail = `pending-${crypto.randomUUID()}@orca.invalid`;
    const now = Date.now();
    // A marker proves this is a principal created by this starter, even if a
    // callback persisted a provider grant before it could promote the user.
    tx.delete(users).where(inArray(users.id, tx.select({ id: users.id }).from(users)
      .innerJoin(pendingMailLogins, eq(pendingMailLogins.userId, users.id))
      .where(and(eq(users.email, pendingMailLogins.pendingEmail), isNull(users.authenticatedAt),
        isNull(users.onboardingCompletedAt), lt(users.createdAt, new Date(now - maxPendingAgeMs))))
      .limit(stalePendingPurgeBatchSize))).run();
    purgeStalePendingUsers(tx, now, userId);
    const pending = tx.select({ id: users.id }).from(users).where(and(
      like(users.email, pendingUserEmailPattern), isNull(users.authenticatedAt),
      // Preserve legacy account owners, which cannot be distinguished from an
      // interrupted callback; only marked principals are safe to reclaim.
      or(notExists(tx.select({ id: oauthAccounts.id }).from(oauthAccounts).where(eq(oauthAccounts.userId, users.id))),
        inArray(users.id, tx.select({ id: pendingMailLogins.userId }).from(pendingMailLogins))),
    )).limit(maxPendingMailLogins).all();
    if (pending.length >= maxPendingMailLogins) return null;
    tx.insert(users).values({ id: userId, email: pendingEmail }).run();
    tx.insert(pendingMailLogins).values({ userId, pendingEmail }).run();
    return { userId, pendingEmail };
  });
}
