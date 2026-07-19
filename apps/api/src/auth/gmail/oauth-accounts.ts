import { and, asc, eq, sql } from "drizzle-orm";

import { createDatabaseClient } from "../../db/client.ts";
import { oauthAccounts } from "../../db/schema.ts";

type DatabaseFactory = typeof createDatabaseClient;

export type OAuthAccountRecord = {
  id: string;
  userId: string;
  provider: "gmail";
  providerAccountId: string;
  providerEmail: string;
  grantedScopes: string[];
  encryptedAccessToken: string;
  encryptedRefreshToken: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type OAuthAccountUpsert = {
  userId: string;
  provider: "gmail";
  providerAccountId: string;
  providerEmail: string;
  grantedScopes: string[];
  encryptedAccessToken: string;
  encryptedRefreshToken: string | null;
  expiresAt: Date | null;
};

export interface OAuthAccountStore {
  findById(userId: string, accountId: string): Promise<OAuthAccountRecord | null>;
  findForUser(userId: string): Promise<OAuthAccountRecord | null>;
  upsert(input: OAuthAccountUpsert): Promise<OAuthAccountRecord>;
}

export class InMemoryOAuthAccountStore implements OAuthAccountStore {
  private readonly records = new Map<string, OAuthAccountRecord>();

  async findById(userId: string, accountId: string): Promise<OAuthAccountRecord | null> {
    return [...this.records.values()].find((record) => record.userId === userId && record.id === accountId) ?? null;
  }

  async findForUser(userId: string): Promise<OAuthAccountRecord | null> {
    return [...this.records.values()]
      .filter((record) => record.userId === userId && record.provider === "gmail")
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id))[0] ?? null;
  }

  async upsert(input: OAuthAccountUpsert): Promise<OAuthAccountRecord> {
    const now = new Date();
    const key = buildKey(input.userId, input.provider, input.providerAccountId);
    const existing = this.records.get(key);
    const record: OAuthAccountRecord = {
      ...input,
      grantedScopes: input.grantedScopes,
      encryptedRefreshToken: input.encryptedRefreshToken ?? existing?.encryptedRefreshToken ?? null,
      id: existing?.id ?? `oauth_${crypto.randomUUID()}`,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.records.set(key, record);
    return record;
  }

  getAll(): OAuthAccountRecord[] {
    return [...this.records.values()];
  }
}

export class DatabaseOAuthAccountStore implements OAuthAccountStore {
  constructor(private readonly dbFactory: DatabaseFactory = createDatabaseClient) {}

  async findById(userId: string, accountId: string): Promise<OAuthAccountRecord | null> {
    const { db, sqlite } = this.dbFactory();
    try {
      const record = db.select().from(oauthAccounts).where(and(
        eq(oauthAccounts.userId, userId),
        eq(oauthAccounts.id, accountId),
      )).get();
      return record ? mapRecord(record) : null;
    } finally {
      sqlite.close();
    }
  }

  async findForUser(userId: string): Promise<OAuthAccountRecord | null> {
    const { db, sqlite } = this.dbFactory();
    try {
      const record = db.select().from(oauthAccounts).where(and(
        eq(oauthAccounts.userId, userId),
        eq(oauthAccounts.provider, "gmail"),
      )).orderBy(asc(oauthAccounts.createdAt), asc(oauthAccounts.id)).get();
      return record ? mapRecord(record) : null;
    } finally {
      sqlite.close();
    }
  }

  async upsert(input: OAuthAccountUpsert): Promise<OAuthAccountRecord> {
    const { db, sqlite } = this.dbFactory();
    const now = new Date();

    try {
      const grantedScopes = input.grantedScopes;
      db
        .insert(oauthAccounts)
        .values({
          id: `oauth_${crypto.randomUUID()}`,
          userId: input.userId,
          provider: input.provider,
          providerEmail: input.providerEmail,
          providerId: input.providerAccountId,
          accessTokenEncrypted: input.encryptedAccessToken,
          refreshTokenEncrypted: input.encryptedRefreshToken,
          tokenExpiry: input.expiresAt,
          scope: grantedScopes.join(" "),
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            oauthAccounts.userId,
            oauthAccounts.provider,
            oauthAccounts.providerId,
          ],
          set: {
            providerEmail: input.providerEmail,
            accessTokenEncrypted: input.encryptedAccessToken,
            refreshTokenEncrypted: sql<string | null>`coalesce(excluded.refresh_token_encrypted, ${oauthAccounts.refreshTokenEncrypted})`,
            tokenExpiry: input.expiresAt,
            scope: grantedScopes.join(" "),
            updatedAt: now,
          },
        })
        .run();

      const record = db
        .select()
        .from(oauthAccounts)
        .where(
          and(
            eq(oauthAccounts.userId, input.userId),
            eq(oauthAccounts.provider, input.provider),
            eq(oauthAccounts.providerId, input.providerAccountId),
          ),
        )
        .get();

      if (!record) {
        throw new Error("OAuth account record could not be loaded after upsert");
      }

      return mapRecord(record);
    } finally {
      sqlite.close();
    }
  }
}

function mapRecord(record: typeof oauthAccounts.$inferSelect): OAuthAccountRecord {
  return {
    id: record.id,
    userId: record.userId,
    provider: "gmail",
    providerAccountId: record.providerId,
    providerEmail: record.providerEmail,
    grantedScopes: record.scope ? record.scope.split(/\s+/).filter(Boolean) : [],
    encryptedAccessToken: record.accessTokenEncrypted ?? "",
    encryptedRefreshToken: record.refreshTokenEncrypted,
    expiresAt: record.tokenExpiry,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function buildKey(userId: string, provider: string, providerAccountId: string): string {
  return `${userId}:${provider}:${providerAccountId}`;
}
