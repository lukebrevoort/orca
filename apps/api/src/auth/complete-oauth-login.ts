import { and, eq, sql } from "drizzle-orm";

import { createDatabaseClient } from "../db/client.ts";
import { oauthAccounts, sessions, users } from "../db/schema.ts";
import { defaultSessionTtlMs } from "./config.ts";
import type { OAuthAccountUpsert } from "./gmail/oauth-accounts.ts";
import { createSessionToken } from "./jwt.ts";

type DatabaseFactory = typeof createDatabaseClient;

export type CompleteOAuthLoginResult =
  | {
      ok: true;
      returningUser: boolean;
      session: {
        sessionId: string;
        userId: string;
        expiresAt: Date;
        token: string;
      };
    }
  | { ok: false; code: "account_identity_conflict" };

/**
 * Turns a consumed pre-authentication attempt into durable identity state.
 * Provider account identity, never email alone, is authoritative for a
 * returning-user merge.
 */
export async function completeOAuthLogin(options: {
  dbFactory?: DatabaseFactory;
  attemptedUserId: string;
  grant: Omit<OAuthAccountUpsert, "userId">;
  completeOnboardingForNewUser: boolean;
  now?: Date;
}): Promise<CompleteOAuthLoginResult> {
  const dbFactory = options.dbFactory ?? createDatabaseClient;
  const now = options.now ?? new Date();
  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(now.getTime() + defaultSessionTtlMs);
  const { db, sqlite } = dbFactory();

  try {
    const completed = db.transaction((tx) => {
      const matchingAccounts = tx.select({ id: oauthAccounts.id, userId: oauthAccounts.userId })
        .from(oauthAccounts)
        .where(and(
          eq(oauthAccounts.provider, options.grant.provider),
          eq(oauthAccounts.providerId, options.grant.providerAccountId),
        ))
        .all();

      if (matchingAccounts.length > 1) return null;

      const matchingAccount = matchingAccounts[0] ?? null;
      const emailOwner = tx.select({ id: users.id }).from(users)
        .where(eq(users.email, options.grant.providerEmail))
        .get();

      if (!matchingAccount && emailOwner) {
        // An email match without the same provider identity is not proof that
        // this callback owns the completed Orca user.
        return null;
      }

      const userId = matchingAccount?.userId ?? options.attemptedUserId;
      const returningUser = Boolean(matchingAccount);

      if (matchingAccount) {
        tx.update(users)
          .set({ authenticatedAt: now, onboardingCompletedAt: now })
          .where(eq(users.id, userId))
          .run();
        tx.update(oauthAccounts)
          .set({
            providerEmail: options.grant.providerEmail,
            profileImageUrl: options.grant.profileImageUrl ?? undefined,
            accessTokenEncrypted: options.grant.encryptedAccessToken,
            refreshTokenEncrypted: sql<string | null>`coalesce(${options.grant.encryptedRefreshToken}, ${oauthAccounts.refreshTokenEncrypted})`,
            tokenExpiry: options.grant.expiresAt,
            scope: options.grant.grantedScopes.join(" "),
            updatedAt: now,
          })
          .where(eq(oauthAccounts.id, matchingAccount.id))
          .run();
      } else {
        tx.insert(users).values({
          id: userId,
          email: options.grant.providerEmail,
          authenticatedAt: now,
          onboardingCompletedAt: options.completeOnboardingForNewUser ? now : null,
        }).run();
        tx.insert(oauthAccounts).values({
          id: `oauth_${crypto.randomUUID()}`,
          userId,
          provider: options.grant.provider,
          providerEmail: options.grant.providerEmail,
          providerId: options.grant.providerAccountId,
          profileImageUrl: options.grant.profileImageUrl,
          accessTokenEncrypted: options.grant.encryptedAccessToken,
          refreshTokenEncrypted: options.grant.encryptedRefreshToken,
          tokenExpiry: options.grant.expiresAt,
          scope: options.grant.grantedScopes.join(" "),
          updatedAt: now,
        }).run();
      }

      tx.insert(sessions).values({ id: sessionId, userId, expiresAt, createdAt: now }).run();
      return { userId, returningUser };
    });

    if (!completed) return { ok: false, code: "account_identity_conflict" };

    return {
      ok: true,
      returningUser: completed.returningUser,
      session: {
        sessionId,
        userId: completed.userId,
        expiresAt,
        token: await createSessionToken({ sessionId, userId: completed.userId, expiresAt }),
      },
    };
  } finally {
    sqlite.close();
  }
}
