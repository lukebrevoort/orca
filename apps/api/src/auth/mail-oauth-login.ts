import { and, asc, eq, like, ne, not } from "drizzle-orm";
import { createDatabaseClient } from "../db/client.ts";
import { oauthAccounts, users } from "../db/schema.ts";
import { isMailOAuthSessionActive, PENDING_EMAIL_LIKE, pendingUserWhere } from "./mail-oauth-transactions.ts";

/** Promote only the exact still-pending user created for this login transaction. */
export function completeMailOAuthLogin(db: ReturnType<typeof createDatabaseClient>["db"], input: {
  userId: string; sessionId: string; pendingEmail: string; provider: "gmail" | "outlook";
  providerEmail: string; providerAccountId: string;
  scopeReturned?: boolean;
}) {
  return db.transaction((tx) => {
    const pendingWhere = pendingUserWhere(input.userId, input.pendingEmail);
    if (!isMailOAuthSessionActive(tx, input)) return { ok: false as const };
    if (!tx.select({ id: users.id }).from(users).where(pendingWhere).get()) return { ok: false as const };
    const pendingAccount = tx.select().from(oauthAccounts).where(and(
      eq(oauthAccounts.userId, input.userId), eq(oauthAccounts.provider, input.provider),
      eq(oauthAccounts.providerId, input.providerAccountId),
    )).get();
    if (!pendingAccount) return { ok: false as const };

    const existingAccount = tx.select({ account: oauthAccounts }).from(oauthAccounts)
      .innerJoin(users, eq(users.id, oauthAccounts.userId))
      .where(and(
        eq(oauthAccounts.provider, input.provider),
        eq(oauthAccounts.providerId, input.providerAccountId),
        ne(oauthAccounts.userId, input.userId),
        not(like(users.email, PENDING_EMAIL_LIKE)),
      ))
      .orderBy(asc(oauthAccounts.createdAt), asc(oauthAccounts.id))
      .limit(1).get()?.account;
    if (existingAccount) {
      const ownerId = existingAccount.userId;
      // Preserve account identity and cached workspace/mail while rotating its grant.
      tx.update(oauthAccounts).set({
        providerEmail: pendingAccount.providerEmail,
        profileImageUrl: pendingAccount.profileImageUrl ?? existingAccount.profileImageUrl,
        accessTokenEncrypted: pendingAccount.accessTokenEncrypted,
        refreshTokenEncrypted: pendingAccount.refreshTokenEncrypted ?? existingAccount.refreshTokenEncrypted,
        tokenExpiry: pendingAccount.tokenExpiry,
        scope: input.scopeReturned === false ? existingAccount.scope : pendingAccount.scope,
        updatedAt: new Date(),
      }).where(eq(oauthAccounts.id, existingAccount.id)).run();
      tx.delete(oauthAccounts).where(eq(oauthAccounts.id, pendingAccount.id)).run();
      tx.update(users).set({ authenticatedAt: new Date(), onboardingCompletedAt: new Date() }).where(eq(users.id, ownerId)).run();
      tx.delete(users).where(pendingWhere).run();
      return { ok: true as const, returningUserId: ownerId };
    }
    const emailOwner = tx.select({ id: users.id }).from(users).where(eq(users.email, input.providerEmail)).get();
    if (emailOwner && emailOwner.id !== input.userId) {
      tx.delete(oauthAccounts).where(eq(oauthAccounts.id, pendingAccount.id)).run();
      tx.delete(users).where(pendingWhere).run();
      return { ok: false as const, reason: "account_exists" as const };
    }
    tx.update(users).set({
      email: input.providerEmail, authenticatedAt: new Date(),
      ...(input.provider === "outlook" ? { onboardingCompletedAt: new Date() } : {}),
    }).where(pendingWhere).run();
    return { ok: true as const, returningUserId: null };
  });
}
