import { SignJWT, jwtVerify } from "jose";

import { getAuthConfig, sessionCookieName } from "./config.ts";

export type SessionTokenPayload = {
  sessionId: string;
  userId: string;
  expiresAt: Date;
};

function getSigningKey() {
  return new TextEncoder().encode(getAuthConfig().sessionSecret);
}

export async function createSessionToken(payload: SessionTokenPayload) {
  return new SignJWT({
    sessionId: payload.sessionId,
    userId: payload.userId,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(payload.expiresAt.getTime() / 1000))
    .sign(getSigningKey());
}

export async function verifySessionToken(token: string) {
  const { payload } = await jwtVerify(token, getSigningKey(), {
    algorithms: ["HS256"],
  });

  const sessionId = payload.sessionId;
  const userId = payload.userId;
  const expiresAtSeconds = payload.exp;

  if (
    typeof sessionId !== "string" ||
    typeof userId !== "string" ||
    typeof expiresAtSeconds !== "number"
  ) {
    throw new Error("Session token payload is invalid");
  }

  return {
    sessionId,
    userId,
    expiresAt: new Date(expiresAtSeconds * 1000),
  } satisfies SessionTokenPayload;
}

export function buildSessionCookie(token: string, expiresAt: Date) {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));

  return [
    `${sessionCookieName}=${token}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
    `Expires=${expiresAt.toUTCString()}`,
  ].join("; ");
}

export function buildClearedSessionCookie() {
  return [
    `${sessionCookieName}=`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ].join("; ");
}
