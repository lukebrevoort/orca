import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const keyLengthBytes = 32;
const ivLengthBytes = 12;
const algorithm = "aes-256-gcm";
const encryptionVersion = "v1";

export function encryptSecret(value: string, encodedKey: string): string {
  const key = decodeKey(encodedKey);
  const iv = randomBytes(ivLengthBytes);
  const cipher = createCipheriv(algorithm, key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    encryptionVersion,
    toBase64Url(iv),
    toBase64Url(tag),
    toBase64Url(encrypted),
  ].join(":");
}

export function decryptSecret(value: string, encodedKey: string): string {
  const [version, ivPart, tagPart, encryptedPart] = value.split(":");

  if (version !== encryptionVersion || !ivPart || !tagPart || !encryptedPart) {
    throw new Error("Unsupported encrypted secret format");
  }

  const key = decodeKey(encodedKey);
  const decipher = createDecipheriv(algorithm, key, fromBase64Url(ivPart));
  decipher.setAuthTag(fromBase64Url(tagPart));

  const decrypted = Buffer.concat([
    decipher.update(fromBase64Url(encryptedPart)),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

function decodeKey(encodedKey: string): Buffer {
  const key = Buffer.from(encodedKey, "base64");

  if (key.byteLength !== keyLengthBytes) {
    throw new Error(`TOKEN_ENCRYPTION_KEY must decode to ${keyLengthBytes} bytes of key material`);
  }

  return key;
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
