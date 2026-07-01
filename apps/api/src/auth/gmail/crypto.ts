import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const ALGORITHM = "aes-256-gcm";
const ENCRYPTION_VERSION = "v1";

export function encryptSecret(value: string, secret: string): string {
  const key = deriveKey(secret);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    ENCRYPTION_VERSION,
    toBase64Url(iv),
    toBase64Url(tag),
    toBase64Url(encrypted),
  ].join(":");
}

export function decryptSecret(value: string, secret: string): string {
  const [version, ivPart, tagPart, encryptedPart] = value.split(":");

  if (version !== ENCRYPTION_VERSION || !ivPart || !tagPart || !encryptedPart) {
    throw new Error("Unsupported encrypted secret format");
  }

  const key = deriveKey(secret);
  const decipher = createDecipheriv(ALGORITHM, key, fromBase64Url(ivPart));
  decipher.setAuthTag(fromBase64Url(tagPart));

  const decrypted = Buffer.concat([
    decipher.update(fromBase64Url(encryptedPart)),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

function deriveKey(secret: string): Buffer {
  return createHash("sha256").update(secret).digest().subarray(0, KEY_LENGTH);
}

function toBase64Url(value: Uint8Array): string {
  return Buffer.from(value)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(value: string): Buffer {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padding = (4 - (normalized.length % 4 || 4)) % 4;
  return Buffer.from(`${normalized}${"=".repeat(padding)}`, "base64");
}
