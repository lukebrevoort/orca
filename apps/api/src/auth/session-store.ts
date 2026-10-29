import { and, eq, gt, inArray, isNull, like, lt, ne, notExists } from "drizzle-orm";

import { createDatabaseClient } from "../db/client.ts";
import { oauthAccounts, sessions, users } from "../db/schema.ts";
import { defaultSessionTtlMs } from "./config.ts";
import { createSessionToken, verifySessionToken } from "./jwt.ts";
import { decryptToken, encryptToken } from "./token-crypto.ts";

type DatabaseClient = ReturnType<typeof createDatabaseClient>["db"];

export const pendingUserEmailPattern = "pending-%@orca.invalid";
export const pendingSessionTtlMs = 1000 * 60 * 15;
export const stalePendingPurgeBatchSize = 100;
export const pendingSessionMaxAgeMs = 1000 * 60 * 60;
const stalePendingUserAgeMs = 1000 * 60 * 60;

export function isPendingUser(db: DatabaseClient, userId: string) {
  return Boolean(db.select({ id: users.id }).from(users).where(
    and(eq(users.id, userId), like(users.email, pendingUserEmailPattern), isNull(users.authenticatedAt)),
  ).get());
}

export type SessionRecord = {
  sessionId: string;
  userId: string;
  expiresAt: Date;
};

export async function createSession(
  db: DatabaseClient,
  userId: string,
  ttlMs?: number,
) {
  const now = Date.now();
  const pending = isPendingUser(db, userId);
  if (pending) {
    try {
      db.delete(users).where(inArray(users.id,
        db.select({ id: users.id }).from(users).where(and(
          like(users.email, pendingUserEmailPattern),
          isNull(users.authenticatedAt),
          lt(users.createdAt, new Date(now - stalePendingUserAgeMs)),
          ne(users.id, userId),
          notExists(db.select({ id: oauthAccounts.id }).from(oauthAccounts).where(eq(oauthAccounts.userId, users.id))),
        )).limit(stalePendingPurgeBatchSize),
      )).run();
    } catch {
      // Opportunistic cleanup must never prevent login.
    }
  }
  const expiresAt = new Date(now + (ttlMs ?? (pending ? pendingSessionTtlMs : defaultSessionTtlMs)));
  const sessionId = crypto.randomUUID();

  db.insert(sessions).values({
    id: sessionId,
    userId,
    expiresAt,
  }).run();

  const token = await createSessionToken({
    sessionId,
    userId,
    expiresAt,
  });

  return {
    sessionId,
    userId,
    expiresAt,
    token,
  };
}

export async function renewSession(
  db: DatabaseClient,
  session: Pick<SessionRecord, "sessionId" | "userId">,
  ttlMs?: number,
) {
  const now = new Date();
  const pending = ttlMs === undefined && isPendingUser(db, session.userId);
  const effectiveTtlMs = ttlMs ?? (pending
    ? pendingSessionTtlMs
    : defaultSessionTtlMs);
  let expiresAt = new Date(now.getTime() + effectiveTtlMs);
  if (pending) {
    const record = db.select({ createdAt: sessions.createdAt }).from(sessions).where(and(
      eq(sessions.id, session.sessionId),
      eq(sessions.userId, session.userId),
    )).get();
    if (!record) return null;
    expiresAt = new Date(Math.min(expiresAt.getTime(), record.createdAt.getTime() + pendingSessionMaxAgeMs));
    if (expiresAt.getTime() <= now.getTime()) return null;
  }

  const updated = db
    .update(sessions)
    .set({ expiresAt })
    .where(
      and(
        eq(sessions.id, session.sessionId),
        eq(sessions.userId, session.userId),
        isNull(sessions.invalidatedAt),
        gt(sessions.expiresAt, now),
      ),
    )
    .returning({ sessionId: sessions.id })
    .get();

  if (!updated) {
    return null;
  }

  const token = await createSessionToken({
    sessionId: session.sessionId,
    userId: session.userId,
    expiresAt,
  });

  return {
    ...session,
    expiresAt,
    token,
  };
}

export async function getSessionFromToken(db: DatabaseClient, token: string) {
  const payload = await verifySessionToken(token);

  const record = db
    .select({
      sessionId: sessions.id,
      userId: sessions.userId,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .where(
      and(
        eq(sessions.id, payload.sessionId),
        eq(sessions.userId, payload.userId),
        isNull(sessions.invalidatedAt),
        gt(sessions.expiresAt, new Date()),
      ),
    )
    .get();

  if (!record) {
    return null;
  }

  return record satisfies SessionRecord;
}

export function invalidateSession(db: DatabaseClient, sessionId: string) {
  db
    .update(sessions)
    .set({
      invalidatedAt: new Date(),
    })
    .where(eq(sessions.id, sessionId))
    .run();
}

export async function storeProviderTokens(
  db: DatabaseClient,
  input: {
    oauthAccountId: string;
    accessToken: string | null;
    refreshToken: string | null;
    tokenExpiry: Date | null;
    expected?: {
      accessTokenEncrypted: string | null;
      refreshTokenEncrypted: string | null;
      tokenExpiry: Date | null;
    };
  },
) {
  const accessTokenEncrypted = input.accessToken
    ? await encryptToken(input.accessToken)
    : null;
  const refreshTokenEncrypted = input.refreshToken
    ? await encryptToken(input.refreshToken)
    : null;

  const accountWhere = input.expected
    ? and(
        eq(oauthAccounts.id, input.oauthAccountId),
        input.expected.accessTokenEncrypted === null
          ? isNull(oauthAccounts.accessTokenEncrypted)
          : eq(oauthAccounts.accessTokenEncrypted, input.expected.accessTokenEncrypted),
        input.expected.refreshTokenEncrypted === null
          ? isNull(oauthAccounts.refreshTokenEncrypted)
          : eq(oauthAccounts.refreshTokenEncrypted, input.expected.refreshTokenEncrypted),
        input.expected.tokenExpiry === null
          ? isNull(oauthAccounts.tokenExpiry)
          : eq(oauthAccounts.tokenExpiry, input.expected.tokenExpiry),
      )
    : eq(oauthAccounts.id, input.oauthAccountId);

  const result = db
    .update(oauthAccounts)
    .set({
      accessTokenEncrypted,
      refreshTokenEncrypted,
      tokenExpiry: input.tokenExpiry,
      updatedAt: new Date(),
    })
    .where(accountWhere)
    .returning({ id: oauthAccounts.id })
    .get();

  return Boolean(result);
}

export async function readProviderTokens(db: DatabaseClient, oauthAccountId: string) {
  const account = db
    .select({
      accessTokenEncrypted: oauthAccounts.accessTokenEncrypted,
      refreshTokenEncrypted: oauthAccounts.refreshTokenEncrypted,
      tokenExpiry: oauthAccounts.tokenExpiry,
    })
    .from(oauthAccounts)
    .where(eq(oauthAccounts.id, oauthAccountId))
    .get();

  if (!account) {
    return null;
  }

  return {
    accessToken: account.accessTokenEncrypted
      ? await decryptToken(account.accessTokenEncrypted)
      : null,
    refreshToken: account.refreshTokenEncrypted
      ? await decryptToken(account.refreshTokenEncrypted)
      : null,
    tokenExpiry: account.tokenExpiry,
  };
}
