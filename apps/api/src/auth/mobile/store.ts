import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { and, count, eq, gt, isNotNull, isNull, lt, lte, or } from "drizzle-orm";

import { createDatabaseClient } from "../../db/client.ts";
import { mobileAuthRequests, mobileSessions } from "./schema.ts";

type DatabaseClient = ReturnType<typeof createDatabaseClient>["db"];

export const mobileAuthRequestTtlMs = 10 * 60 * 1000;
export const mobileAuthorizationCodeTtlMs = 5 * 60 * 1000;
export const mobileSessionTtlMs = 30 * 24 * 60 * 60 * 1000;
export const mobileAuthMaximumPendingRequests = 10_000;
const mobileRecordRetentionMs = 7 * 24 * 60 * 60 * 1000;

export function randomOpaqueToken() {
  return randomBytes(32).toString("base64url");
}

export function hashOpaqueToken(value: string) {
  return createHash("sha256").update(value).digest("base64url");
}

export function verifyPkce(codeVerifier: string, expectedChallenge: string) {
  const actual = Buffer.from(hashOpaqueToken(codeVerifier));
  const expected = Buffer.from(expectedChallenge);
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

export function createMobileAuthRequest(
  db: DatabaseClient,
  input: { codeChallenge: string; state: string },
  now = new Date(),
) {
  const requestToken = randomOpaqueToken();
  const expiresAt = new Date(now.getTime() + mobileAuthRequestTtlMs);
  db.insert(mobileAuthRequests).values({
    id: `mobile_request_${crypto.randomUUID()}`,
    requestTokenHash: hashOpaqueToken(requestToken),
    codeChallenge: input.codeChallenge,
    state: input.state,
    requestExpiresAt: expiresAt,
    createdAt: now,
  }).run();
  return { requestToken, expiresAt };
}

export function admitMobileAuthRequest(
  db: DatabaseClient,
  input: { codeChallenge: string; state: string },
  now = new Date(),
  maximumPendingRequests = mobileAuthMaximumPendingRequests,
) {
  return db.transaction((tx) => {
    const retentionBoundary = new Date(now.getTime() - mobileRecordRetentionMs);
    tx.delete(mobileAuthRequests).where(or(
      and(isNull(mobileAuthRequests.authorizedAt), lte(mobileAuthRequests.requestExpiresAt, now)),
      and(isNotNull(mobileAuthRequests.authorizedAt), lte(mobileAuthRequests.codeExpiresAt, now)),
    )).run();
    tx.delete(mobileSessions).where(or(
      lt(mobileSessions.expiresAt, retentionBoundary),
      and(isNotNull(mobileSessions.revokedAt), lt(mobileSessions.revokedAt, retentionBoundary)),
    )).run();
    const pending = tx.select({ value: count() }).from(mobileAuthRequests).where(and(
      isNull(mobileAuthRequests.authorizedAt),
      gt(mobileAuthRequests.requestExpiresAt, now),
    )).get()?.value ?? 0;
    if (pending >= maximumPendingRequests) return null;

    const requestToken = randomOpaqueToken();
    const expiresAt = new Date(now.getTime() + mobileAuthRequestTtlMs);
    tx.insert(mobileAuthRequests).values({
      id: `mobile_request_${crypto.randomUUID()}`,
      requestTokenHash: hashOpaqueToken(requestToken),
      codeChallenge: input.codeChallenge,
      state: input.state,
      requestExpiresAt: expiresAt,
      createdAt: now,
    }).run();
    return { requestToken, expiresAt };
  });
}

export function bindMobileAuthRequest(
  db: DatabaseClient,
  input: { requestToken: string; userId: string; browserSessionId: string },
  now = new Date(),
) {
  const csrfToken = randomOpaqueToken();
  const request = db.transaction((tx) => {
    const existing = tx.select().from(mobileAuthRequests).where(and(
      eq(mobileAuthRequests.requestTokenHash, hashOpaqueToken(input.requestToken)),
      gt(mobileAuthRequests.requestExpiresAt, now),
      isNull(mobileAuthRequests.authorizedAt),
    )).get();
    if (!existing) return null;
    if (existing.userId && (existing.userId !== input.userId || existing.browserSessionId !== input.browserSessionId)) return null;
    const updated = tx.update(mobileAuthRequests).set({
      userId: input.userId,
      browserSessionId: input.browserSessionId,
      csrfTokenHash: hashOpaqueToken(csrfToken),
    }).where(and(
      eq(mobileAuthRequests.id, existing.id),
      isNull(mobileAuthRequests.authorizedAt),
    )).returning({ state: mobileAuthRequests.state, expiresAt: mobileAuthRequests.requestExpiresAt }).get();
    return updated ?? null;
  });
  return request ? { ...request, csrfToken } : null;
}

export function grantMobileAuthRequest(
  db: DatabaseClient,
  input: { requestToken: string; csrfToken: string; userId: string; browserSessionId: string },
  now = new Date(),
) {
  const authorizationCode = randomOpaqueToken();
  const codeExpiresAt = new Date(now.getTime() + mobileAuthorizationCodeTtlMs);
  const granted = db.update(mobileAuthRequests).set({
    authorizationCodeHash: hashOpaqueToken(authorizationCode),
    codeExpiresAt,
    authorizedAt: now,
    csrfTokenHash: null,
  }).where(and(
    eq(mobileAuthRequests.requestTokenHash, hashOpaqueToken(input.requestToken)),
    eq(mobileAuthRequests.csrfTokenHash, hashOpaqueToken(input.csrfToken)),
    eq(mobileAuthRequests.userId, input.userId),
    eq(mobileAuthRequests.browserSessionId, input.browserSessionId),
    gt(mobileAuthRequests.requestExpiresAt, now),
    isNull(mobileAuthRequests.authorizedAt),
  )).returning({ state: mobileAuthRequests.state }).get();
  return granted ? { authorizationCode, codeExpiresAt, state: granted.state } : null;
}

export function exchangeMobileAuthorizationCode(
  db: DatabaseClient,
  input: { code: string; codeVerifier: string },
  now = new Date(),
) {
  const codeHash = hashOpaqueToken(input.code);
  const request = db.select().from(mobileAuthRequests).where(and(
    eq(mobileAuthRequests.authorizationCodeHash, codeHash),
    gt(mobileAuthRequests.codeExpiresAt, now),
    isNull(mobileAuthRequests.consumedAt),
  )).get();
  if (!request?.userId || !verifyPkce(input.codeVerifier, request.codeChallenge)) return null;

  const credential = buildMobileSessionCredential(request.userId, now);
  const consumed = db.transaction((tx) => {
    const row = tx.update(mobileAuthRequests).set({ consumedAt: now }).where(and(
      eq(mobileAuthRequests.id, request.id),
      eq(mobileAuthRequests.authorizationCodeHash, codeHash),
      gt(mobileAuthRequests.codeExpiresAt, now),
      isNull(mobileAuthRequests.consumedAt),
    )).returning({ userId: mobileAuthRequests.userId }).get();
    if (!row?.userId) return false;
    tx.insert(mobileSessions).values({
      id: credential.sessionId,
      userId: row.userId,
      tokenHash: hashOpaqueToken(credential.accessToken),
      expiresAt: credential.expiresAt,
      createdAt: now,
    }).run();
    return true;
  });
  return consumed ? credential : null;
}

/** Seeds a real opaque mobile credential without adding a development auth route. */
export function createMobileSession(db: DatabaseClient, userId: string, now = new Date()) {
  const credential = buildMobileSessionCredential(userId, now);
  db.insert(mobileSessions).values({
    id: credential.sessionId,
    userId,
    tokenHash: hashOpaqueToken(credential.accessToken),
    expiresAt: credential.expiresAt,
    createdAt: now,
  }).run();
  return credential;
}

export function getMobileSessionFromToken(db: DatabaseClient, token: string, now = new Date()) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return db.select({
    sessionId: mobileSessions.id,
    userId: mobileSessions.userId,
    expiresAt: mobileSessions.expiresAt,
  }).from(mobileSessions).where(and(
    eq(mobileSessions.tokenHash, hashOpaqueToken(token)),
    gt(mobileSessions.expiresAt, now),
    isNull(mobileSessions.revokedAt),
  )).get() ?? null;
}

export function revokeMobileSession(db: DatabaseClient, sessionId: string, userId: string, now = new Date()) {
  return Boolean(db.update(mobileSessions).set({ revokedAt: now }).where(and(
    eq(mobileSessions.id, sessionId),
    eq(mobileSessions.userId, userId),
    isNull(mobileSessions.revokedAt),
  )).returning({ id: mobileSessions.id }).get());
}

function buildMobileSessionCredential(userId: string, now: Date) {
  return {
    accessToken: randomOpaqueToken(),
    expiresAt: new Date(now.getTime() + mobileSessionTtlMs),
    sessionId: `mobile_session_${crypto.randomUUID()}`,
    userId,
  };
}
