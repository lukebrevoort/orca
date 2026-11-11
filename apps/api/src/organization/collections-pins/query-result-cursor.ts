import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { MailboxCursorError } from "../../mailbox/read.ts";

// The position is an existing mailbox keyset cursor, sealed inside this endpoint's
// authenticated envelope. The new route never accepts a bare old mailbox cursor.
const envelopeSchema = z.object({
  version: z.literal(1),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  mailboxRevision: z.string().regex(/^mailbox-v2:[0-9a-f]{64}$/),
  position: z.string().min(1).max(12_000),
}).strict();
type Envelope = z.infer<typeof envelopeSchema>;

function canonicalBase64(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new MailboxCursorError("Invalid saved-query cursor");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw new MailboxCursorError("Invalid saved-query cursor");
  return bytes;
}

function signature(payload: string, secret: string) {
  return createHmac("sha256", secret).update("orca.saved-query-results.v1\0").update(payload).digest();
}

export function encodeQueryResultCursor(envelope: Envelope, secret: string) {
  const payload = Buffer.from(JSON.stringify(envelopeSchema.parse(envelope))).toString("base64url");
  return `${payload}.${signature(payload, secret).toString("base64url")}`;
}

export function decodeQueryResultCursor(value: string | undefined, secret: string, fingerprint: string, mailboxRevision: string): string | undefined {
  if (value === undefined) return undefined;
  try {
    if (value.length > 16_384) throw new Error("Oversized cursor");
    const parts = value.split(".");
    if (parts.length !== 2) throw new Error("Invalid envelope");
    const payload = parts[0]!;
    const supplied = canonicalBase64(parts[1]!);
    const expected = signature(payload, secret);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error("Invalid signature");
    // Only parse/consume the position after successful integrity verification.
    const envelope = envelopeSchema.parse(JSON.parse(canonicalBase64(payload).toString("utf8")));
    if (envelope.fingerprint !== fingerprint || envelope.mailboxRevision !== mailboxRevision) throw new Error("Stale scope");
    return envelope.position;
  } catch {
    throw new MailboxCursorError("Saved-query cursor is invalid or its live scope changed");
  }
}
