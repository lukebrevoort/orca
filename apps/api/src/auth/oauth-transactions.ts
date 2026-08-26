import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { MailProvider } from "@orca/shared";
import { and, count, eq, gt, gte, isNull, lt } from "drizzle-orm";

import { createDatabaseClient } from "../db/client.ts";
import { oauthTransactions } from "../db/schema.ts";
import { createSessionToken, getSessionCookieOptions, verifySessionToken } from "./jwt.ts";
import { getSessionFromToken } from "./session-store.ts";

export const oauthAttemptCookieName = "orca_oauth_attempt";
export const oauthTransactionTtlMs = 10 * 60 * 1000;
export const oauthTransactionRetentionMs = 60 * 60 * 1000;

export const defaultOAuthLoginLimits = {
  perKeyPerMinute: 10,
  perKeyPerHour: 50,
  globalActive: 1_000,
  globalPerHour: 5_000,
} as const;

export type OAuthTransactionIntent = "login" | "connect" | "upgrade";

export type OAuthBinding = {
  sessionId: string;
  userId: string;
};

export type OAuthTransactionRecord = OAuthBinding & {
  id: string;
  provider: MailProvider;
  intent: OAuthTransactionIntent;
  returnTo: string | null;
  accountId: string | null;
  codeVerifier: string | null;
  expiresAt: Date;
  createdAt: Date;
};

export type OAuthLoginLimits = {
  perKeyPerMinute: number;
  perKeyPerHour: number;
  globalActive: number;
  globalPerHour: number;
};

export type BeginOAuthTransactionInput = OAuthBinding & {
  provider: MailProvider;
  intent: OAuthTransactionIntent;
  returnTo: string | null;
  accountId?: string | null;
  usePkce?: boolean;
  rateLimitKey?: string | null;
};

export type BeginOAuthTransactionResult =
  | { ok: true; state: string; codeVerifier: string | null; expiresAt: Date }
  | { ok: false; reason: "rate_limited" };

export interface OAuthTransactionStore {
  begin(input: BeginOAuthTransactionInput): Promise<BeginOAuthTransactionResult>;
  consume(state: string, provider: MailProvider, binding: OAuthBinding): Promise<OAuthTransactionRecord | null>;
  collect(now?: Date): Promise<number>;
}

type DatabaseFactory = typeof createDatabaseClient;

export class DatabaseOAuthTransactionStore implements OAuthTransactionStore {
  constructor(
    private readonly dbFactory: DatabaseFactory = createDatabaseClient,
    private readonly now: () => Date = () => new Date(),
    private readonly limits: OAuthLoginLimits = defaultOAuthLoginLimits,
  ) {}

  async begin(input: BeginOAuthTransactionInput): Promise<BeginOAuthTransactionResult> {
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + oauthTransactionTtlMs);
    const state = randomBytes(32).toString("base64url");
    const codeVerifier = input.usePkce ? randomBytes(32).toString("base64url") : null;
    const { db, sqlite } = this.dbFactory();

    try {
      return db.transaction((tx) => {
        tx.delete(oauthTransactions)
          .where(lt(oauthTransactions.createdAt, new Date(createdAt.getTime() - oauthTransactionRetentionMs)))
          .run();

        if (input.intent === "login") {
          const minuteAgo = new Date(createdAt.getTime() - 60_000);
          const hourAgo = new Date(createdAt.getTime() - oauthTransactionRetentionMs);
          const globalHour = tx.select({ value: count() }).from(oauthTransactions)
            .where(and(eq(oauthTransactions.intent, "login"), gte(oauthTransactions.createdAt, hourAgo)))
            .get()?.value ?? 0;
          const active = tx.select({ value: count() }).from(oauthTransactions)
            .where(and(eq(oauthTransactions.intent, "login"), isNull(oauthTransactions.consumedAt), gt(oauthTransactions.expiresAt, createdAt)))
            .get()?.value ?? 0;
          const perKeyMinute = input.rateLimitKey
            ? tx.select({ value: count() }).from(oauthTransactions).where(and(
                eq(oauthTransactions.intent, "login"),
                eq(oauthTransactions.rateLimitKey, input.rateLimitKey),
                gte(oauthTransactions.createdAt, minuteAgo),
              )).get()?.value ?? 0
            : 0;
          const perKeyHour = input.rateLimitKey
            ? tx.select({ value: count() }).from(oauthTransactions).where(and(
                eq(oauthTransactions.intent, "login"),
                eq(oauthTransactions.rateLimitKey, input.rateLimitKey),
                gte(oauthTransactions.createdAt, hourAgo),
              )).get()?.value ?? 0
            : 0;

          if (
            globalHour >= this.limits.globalPerHour
            || active >= this.limits.globalActive
            || perKeyMinute >= this.limits.perKeyPerMinute
            || perKeyHour >= this.limits.perKeyPerHour
          ) {
            return { ok: false as const, reason: "rate_limited" as const };
          }
        }

        tx.insert(oauthTransactions).values({
          id: `oauth_txn_${randomUUID()}`,
          stateHash: hashOAuthState(state),
          provider: input.provider,
          intent: input.intent,
          sessionId: input.sessionId,
          userId: input.userId,
          returnTo: input.returnTo,
          accountId: input.accountId ?? null,
          codeVerifier,
          rateLimitKey: input.rateLimitKey ?? null,
          expiresAt,
          createdAt,
        }).run();

        return { ok: true as const, state, codeVerifier, expiresAt };
      });
    } finally {
      sqlite.close();
    }
  }

  async consume(state: string, provider: MailProvider, binding: OAuthBinding): Promise<OAuthTransactionRecord | null> {
    const consumedAt = this.now();
    const { db, sqlite } = this.dbFactory();

    try {
      return db.transaction((tx) => {
        const record = tx.select().from(oauthTransactions).where(and(
          eq(oauthTransactions.stateHash, hashOAuthState(state)),
          eq(oauthTransactions.provider, provider),
          eq(oauthTransactions.sessionId, binding.sessionId),
          eq(oauthTransactions.userId, binding.userId),
          isNull(oauthTransactions.consumedAt),
          gt(oauthTransactions.expiresAt, consumedAt),
        )).get();
        if (!record) return null;

        const consumed = tx.update(oauthTransactions)
          .set({ consumedAt, codeVerifier: null })
          .where(and(eq(oauthTransactions.id, record.id), isNull(oauthTransactions.consumedAt)))
          .returning({ id: oauthTransactions.id })
          .get();
        if (!consumed) return null;

        return {
          id: record.id,
          provider: record.provider as MailProvider,
          intent: record.intent as OAuthTransactionIntent,
          sessionId: record.sessionId,
          userId: record.userId,
          returnTo: record.returnTo,
          accountId: record.accountId,
          codeVerifier: record.codeVerifier,
          expiresAt: record.expiresAt,
          createdAt: record.createdAt,
        };
      });
    } finally {
      sqlite.close();
    }
  }

  async collect(now = this.now()): Promise<number> {
    const { db, sqlite } = this.dbFactory();
    try {
      return db.delete(oauthTransactions)
        .where(lt(oauthTransactions.createdAt, new Date(now.getTime() - oauthTransactionRetentionMs)))
        .returning({ id: oauthTransactions.id })
        .all().length;
    } finally {
      sqlite.close();
    }
  }
}

export class InMemoryOAuthTransactionStore implements OAuthTransactionStore {
  private readonly records = new Map<string, OAuthTransactionRecord & { stateHash: string; consumedAt: Date | null; rateLimitKey: string | null }>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async begin(input: BeginOAuthTransactionInput): Promise<BeginOAuthTransactionResult> {
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + oauthTransactionTtlMs);
    const state = randomBytes(32).toString("base64url");
    const stateHash = hashOAuthState(state);
    const codeVerifier = input.usePkce ? randomBytes(32).toString("base64url") : null;
    this.records.set(stateHash, {
      id: `oauth_txn_${randomUUID()}`,
      stateHash,
      provider: input.provider,
      intent: input.intent,
      sessionId: input.sessionId,
      userId: input.userId,
      returnTo: input.returnTo,
      accountId: input.accountId ?? null,
      codeVerifier,
      rateLimitKey: input.rateLimitKey ?? null,
      expiresAt,
      createdAt,
      consumedAt: null,
    });
    return { ok: true, state, codeVerifier, expiresAt };
  }

  async consume(state: string, provider: MailProvider, binding: OAuthBinding): Promise<OAuthTransactionRecord | null> {
    const record = this.records.get(hashOAuthState(state));
    if (
      !record
      || record.provider !== provider
      || record.sessionId !== binding.sessionId
      || record.userId !== binding.userId
      || record.consumedAt
      || record.expiresAt <= this.now()
    ) return null;
    record.consumedAt = this.now();
    return { ...record };
  }

  async collect(now = this.now()): Promise<number> {
    let deleted = 0;
    for (const [key, record] of this.records) {
      if (record.createdAt.getTime() < now.getTime() - oauthTransactionRetentionMs) {
        this.records.delete(key);
        deleted += 1;
      }
    }
    return deleted;
  }
}

export async function createOAuthAttemptBinding(now = new Date()) {
  const expiresAt = new Date(now.getTime() + oauthTransactionTtlMs);
  const binding = {
    sessionId: `oauth_attempt_session_${randomUUID()}`,
    userId: `oauth_attempt_user_${randomUUID()}`,
  };
  return {
    binding,
    expiresAt,
    token: await createSessionToken({ ...binding, expiresAt }),
  };
}

export async function resolveOAuthCallbackBindings(
  cookieHeader: string | null,
  dbFactory: DatabaseFactory = createDatabaseClient,
): Promise<OAuthBinding[]> {
  const bindings: OAuthBinding[] = [];
  const sessionToken = readCookie(cookieHeader, "orca_session");
  if (sessionToken) {
    const { db, sqlite } = dbFactory();
    try {
      const session = await getSessionFromToken(db, sessionToken).catch(() => null);
      if (session) bindings.push({ sessionId: session.sessionId, userId: session.userId });
    } finally {
      sqlite.close();
    }
  }

  const attemptToken = readCookie(cookieHeader, oauthAttemptCookieName);
  if (attemptToken) {
    const attempt = await verifySessionToken(attemptToken).catch(() => null);
    if (
      attempt
      && attempt.expiresAt > new Date()
      && attempt.sessionId.startsWith("oauth_attempt_session_")
      && attempt.userId.startsWith("oauth_attempt_user_")
    ) {
      bindings.push({ sessionId: attempt.sessionId, userId: attempt.userId });
    }
  }
  return bindings;
}

export async function consumeOAuthTransactionForBindings(
  store: OAuthTransactionStore,
  state: string | null,
  provider: MailProvider,
  bindings: OAuthBinding[],
): Promise<OAuthTransactionRecord | null> {
  if (!state) return null;
  for (const binding of bindings) {
    const transaction = await store.consume(state, provider, binding);
    if (transaction) return transaction;
  }
  return null;
}

export function buildOAuthAttemptCookie(token: string, expiresAt: Date) {
  const secure = getSessionCookieOptions().secure ?? true;
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  return [
    `${oauthAttemptCookieName}=${token}`,
    "HttpOnly",
    "Path=/v1/auth",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
    `Max-Age=${maxAge}`,
    `Expires=${expiresAt.toUTCString()}`,
  ].join("; ");
}

export function buildClearedOAuthAttemptCookie() {
  const secure = getSessionCookieOptions().secure ?? true;
  return [
    `${oauthAttemptCookieName}=`,
    "HttpOnly",
    "Path=/v1/auth",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ].join("; ");
}

export function normalizeOAuthReturnTo(value: string | null | undefined, webOrigin: string): string | null {
  if (!value) return null;
  try {
    const origin = new URL(webOrigin);
    const url = value.startsWith("/") ? new URL(value, origin) : new URL(value);
    return url.origin === origin.origin ? url.toString() : null;
  } catch {
    return null;
  }
}

export function oauthLoginRateLimitKey(request: Request): string {
  const forwarded = request.headers.get("cf-connecting-ip")
    ?? request.headers.get("x-real-ip")
    ?? request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim()
    ?? "unknown";
  const userAgent = request.headers.get("user-agent")?.slice(0, 256) ?? "unknown";
  return createHash("sha256").update(`${forwarded}\0${userAgent}`).digest("base64url");
}

export function hashOAuthState(state: string): string {
  return createHash("sha256").update(state).digest("base64url");
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  return null;
}
