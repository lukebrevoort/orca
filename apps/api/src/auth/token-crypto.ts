import { getAuthConfig } from "./config.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64Url(bytes: Uint8Array) {
  return Buffer.from(bytes)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function fromBase64Url(value: string) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padding = (4 - (normalized.length % 4)) % 4;

  return new Uint8Array(Buffer.from(`${normalized}${"=".repeat(padding)}`, "base64"));
}

async function importEncryptionKey() {
  const keyBytes = Uint8Array.from(getAuthConfig().tokenEncryptionKey);

  return crypto.subtle.importKey(
    "raw",
    keyBytes.buffer,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptToken(token: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importEncryptionKey();
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(token),
  );

  return `${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ciphertext))}`;
}

export async function decryptToken(payload: string) {
  const [ivEncoded, ciphertextEncoded] = payload.split(".");

  if (!ivEncoded || !ciphertextEncoded) {
    throw new Error("Encrypted token payload is invalid");
  }

  const key = await importEncryptionKey();
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(ivEncoded) },
    key,
    fromBase64Url(ciphertextEncoded),
  );

  return decoder.decode(plaintext);
}
