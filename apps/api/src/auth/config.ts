const minimumSessionSecretLength = 32;
const encryptionKeyLengthBytes = 32;

export const sessionCookieName = "orca_session";
export const defaultSessionTtlMs = 1000 * 60 * 60 * 24 * 30;
export const sessionRenewalWindowMs = 1000 * 60 * 60 * 24 * 7;

export type AuthConfig = {
  sessionSecret: string;
  tokenEncryptionKey: Uint8Array;
};

export function getAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const sessionSecret = env.SESSION_SECRET;
  const tokenEncryptionKey = env.TOKEN_ENCRYPTION_KEY ?? env.OAUTH_TOKEN_ENCRYPTION_KEY;

  if (!sessionSecret || sessionSecret.length < minimumSessionSecretLength) {
    throw new Error(
      `SESSION_SECRET must be set and at least ${minimumSessionSecretLength} characters long`,
    );
  }

  if (!tokenEncryptionKey) {
    throw new Error("TOKEN_ENCRYPTION_KEY or OAUTH_TOKEN_ENCRYPTION_KEY must be set");
  }

  const keyBytes = Buffer.from(tokenEncryptionKey, "base64");

  if (keyBytes.byteLength !== encryptionKeyLengthBytes) {
    throw new Error(
      `TOKEN_ENCRYPTION_KEY must decode to ${encryptionKeyLengthBytes} bytes of key material`,
    );
  }

  return {
    sessionSecret,
    tokenEncryptionKey: new Uint8Array(keyBytes),
  };
}
