import type { Database } from "bun:sqlite";
import { importanceKey, readImportance } from "../importance/store.ts";
import type { GmailMessage } from "../providers/gmail/types.ts";

export type ArrivalEvidence = { evidence: "gmail_smtp_metadata" | "unknown"; reason: string; receivedAt: number | null };
const unknown = (reason: string): ArrivalEvidence => ({ evidence: "unknown", reason, receivedAt: null });
/**
 * Provider-observed metadata evidence, NOT authenticated SMTP proof. Gmail API
 * imports can contain indistinguishable forged trace headers. We rely on the
 * provider's ordered, prepended envelope trace for ordinary SMTP delivery only.
 * Never promote a later sender-supplied trace over the first external hop.
 */
export function gmailArrivalEvidence(message: GmailMessage, accountEmail: string, now: number): ArrivalEvidence {
  const primary = accountEmail.trim().toLowerCase();
  if (!primary || !/^[^\s<>@]+@[^\s<>@]+$/.test(primary)) return unknown("invalid_account_address");
  const labels = message.labelIds ?? [];
  if (labels.some(x => ["SENT", "DRAFT"].includes(x.toUpperCase()))) return unknown("sent_or_draft");
  const headers = message.payload?.headers ?? [];
  if (headers.length > 200 || headers.reduce((n, h) => n + h.name.length + h.value.length, 0) > 65536) return unknown("oversized_headers");
  const values = (name: string) => headers.filter(h => h.name.toLowerCase() === name).map(h => h.value.replace(/\r?\n[ \t]+/g, " ").trim());
  const from = values("from");
  if (from.length !== 1) return unknown("ambiguous_sender");
  const address = from[0]!.match(/<([^<>]+)>/)?.[1]?.trim().toLowerCase() ?? from[0]!.trim().toLowerCase();
  if (address === primary) return unknown("own_primary_sender");
  const deliveries = values("delivered-to");
  if (!deliveries.length || deliveries.some(value => value.toLowerCase() !== primary)) return unknown("missing_or_contradictory_recipient");
  const received = headers.filter(h => h.name.toLowerCase() === "received");
  const externalIndex = received.findIndex(h => /^\s*from\s/i.test(h.value));
  if (externalIndex < 0) return unknown("missing_smtp_trace");
  const hop = received[externalIndex]!.value.replace(/\r?\n[ \t]+/g, " ").trim();
  // Exact receiving host and SMTP recipient; substring/domain inference is unsafe.
  const match = hop.match(/^from\s+.+?\s+by\s+mx\.google\.com\s+with\s+ESMTPS?\b[^;]*?\sfor\s+<([^<>]+)>\s*;\s*(.+)$/i);
  if (!match || match[1]!.trim().toLowerCase() !== primary) return unknown("untrusted_or_contradictory_smtp_hop");
  const firstDelivery = headers.findIndex(h => h.name.toLowerCase() === "delivered-to");
  const externalPosition = headers.indexOf(received[externalIndex]!);
  if (firstDelivery > externalPosition) return unknown("invalid_envelope_order");
  const accepted = Date.parse(match[2]!);
  const internal = typeof message.internalDate === "string" && /^\d+$/.test(message.internalDate) ? Number(message.internalDate) : NaN;
  if (!Number.isSafeInteger(accepted) || !Number.isSafeInteger(internal)) return unknown("invalid_receiving_time");
  if (accepted > now + 60_000 || internal > now + 60_000) return unknown("future_receiving_time");
  if (accepted < now - 300_000 || internal < now - 300_000) return unknown("old_receiving_time");
  if (Math.abs(internal - accepted) > 120_000) return unknown("contradictory_receiving_time");
  return { evidence: "gmail_smtp_metadata", reason: "provider_observed_primary_smtp", receivedAt: accepted };
}
/** Called once for NEW messages inside the authorized Gmail persistence transaction,
 * after every message/label write. Routine resync cannot upgrade unknown/old mail. */
export function captureArrivals(sqlite: Database, input: { accountId: string; accountEmail: string; messages: GmailMessage[]; now: number }) {
  if (!input.messages.length) return;
  const owner = sqlite.query("SELECT provider_email FROM oauth_accounts WHERE id=? AND provider='gmail'").get(input.accountId) as { provider_email: string } | null;
  if (!owner || owner.provider_email.toLowerCase() !== input.accountEmail.toLowerCase()) throw Error("Arrival account mismatch");
  for (let start = 0; start < input.messages.length; start += 100) {
    const messages = input.messages.slice(start, start + 100);
    const targets = messages.map(message => ({ accountId: input.accountId, threadId: `gmail:${input.accountId}:${message.threadId}` }));
    const importance = readImportance(sqlite, targets);
    const values = messages.map(message => {
      const threadId = `gmail:${input.accountId}:${message.threadId}`, messageId = `gmail:${input.accountId}:${message.id}`;
      const proof = gmailArrivalEvidence(message, owner.provider_email, input.now);
      return [messageId, input.accountId, threadId, input.now, proof.receivedAt, proof.evidence, proof.reason,
        Number(message.labelIds?.includes("UNREAD")), Number(importance.get(importanceKey(input.accountId, threadId))?.effective === "important")];
    });
    sqlite.query(`WITH arrivals(message_id,account_id,thread_id,observed_at,received_at,evidence,reason,unread_at_arrival,important_at_arrival) AS
      (VALUES ${values.map(() => "(?,?,?,?,?,?,?,?,?)").join(",")})
      INSERT OR IGNORE INTO important_notification_arrivals(message_id,account_id,thread_id,observed_at,received_at,sequence,evidence,reason,unread_at_arrival,important_at_arrival)
      SELECT a.message_id,a.account_id,a.thread_id,a.observed_at,a.received_at,s.sequence,a.evidence,a.reason,a.unread_at_arrival,a.important_at_arrival
      FROM arrivals a JOIN mobile_push_email_sequence s ON s.email_id=a.message_id`).run(...values.flat());
  }
}
