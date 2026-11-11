import type { Database } from "bun:sqlite";
import { importanceKey, readImportance } from "../importance/store.ts";
import { isMobilePushSessionActive } from "../mobile-session-policy.ts";
import { policyRow, type Scope } from "./policy.ts";
import { notificationPayload } from "../mobile-push/payload.ts";

export const cooldownMs = 900_000;
export const arrivalMaxAgeMs = 300_000;
export type Candidate = { messageId: string; accountId: string; threadId: string; sequence: number; receivedAt: number | null; observedAt: number; evidence: string; importantAtArrival: number; unreadAtArrival: number; revokedAt: number | null; isRead: number; isDraft: number; excluded: number; fromName: string | null; fromAddress: string | null; subject: string | null };
const projection = `e.id messageId,e.account_id accountId,e.thread_id threadId,a.sequence,a.received_at receivedAt,a.observed_at observedAt,a.evidence,a.important_at_arrival importantAtArrival,a.unread_at_arrival unreadAtArrival,a.revoked_at revokedAt,e.is_read isRead,e.is_draft isDraft,
  EXISTS(SELECT 1 FROM email_labels el JOIN labels l ON l.id=el.label_id AND l.account_id=e.account_id WHERE el.email_id=e.id AND upper(l.provider_label_id) IN ('SENT','DRAFT')) OR EXISTS(SELECT 1 FROM oauth_accounts own WHERE own.id=e.account_id AND lower(trim(own.provider_email))=lower(trim(e.from_address))) excluded,
  substr(e.from_name,1,240) fromName,substr(e.from_address,1,240) fromAddress,substr(e.subject,1,480) subject`;
export function activePolicy(sqlite: Database, scope: Scope, now: number, sessionId?: string) {
  const row = policyRow(sqlite, scope);
  return row && row.enabled && row.permission === "granted" && (!sessionId || row.session_id === sessionId)
    && isMobilePushSessionActive(sqlite, { userId: scope.userId, sessionId: row.session_id, now: new Date(now) }) ? row : null;
}
function baseEligible(row: Candidate, now: number, boundary: number) {
  return row.evidence === "gmail_smtp_metadata" && row.importantAtArrival === 1 && row.unreadAtArrival === 1 && row.revokedAt === null && !row.isRead && !row.isDraft && !row.excluded
    && row.receivedAt !== null && row.receivedAt >= boundary && row.receivedAt <= now + 60_000 && row.receivedAt >= now - arrivalMaxAgeMs;
}
/** Bounded metadata-only scan. Caller holds an IMMEDIATE authorized snapshot. Every
 * examined arrival advances its account cursor, including quiet/cooldown cases. */
export function scanCandidates(sqlite: Database, scope: Scope, now: number, maximum: number, accept: (row: Candidate) => boolean) {
  const limit = Math.max(1, Math.min(500, maximum));
  let scanned = 0, enqueued = 0;
  const accounts = sqlite.query(`SELECT account_id FROM important_notification_accounts WHERE user_id=? AND channel=? AND installation_id=?
    ORDER BY watermark_sequence,account_id LIMIT 100`).all(scope.userId, scope.channel, scope.installationId) as { account_id: string }[];
  for (const { account_id: id } of accounts) {
    if (scanned >= limit) break;
    const boundary = sqlite.query("SELECT eligible_after_at,watermark_sequence FROM important_notification_accounts WHERE user_id=? AND channel=? AND installation_id=? AND account_id=?").get(scope.userId, scope.channel, scope.installationId, id) as { eligible_after_at: number; watermark_sequence: number };
    const rows = sqlite.query(`SELECT ${projection} FROM important_notification_arrivals a JOIN emails e ON e.id=a.message_id AND e.account_id=a.account_id AND e.thread_id=a.thread_id
      WHERE a.account_id=? AND a.sequence>? ORDER BY a.sequence LIMIT ?`).all(id, boundary.watermark_sequence, limit - scanned) as Candidate[];
    const importance = readImportance(sqlite, rows.map(row => ({ accountId: row.accountId, threadId: row.threadId })));
    for (const row of rows) {
      scanned++;
      if (baseEligible(row, now, boundary.eligible_after_at) && importance.get(importanceKey(row.accountId, row.threadId))?.effective === "important" && accept(row)) enqueued++;
    }
    const last = rows.at(-1);
    if (last) sqlite.query("UPDATE important_notification_accounts SET watermark_sequence=? WHERE user_id=? AND channel=? AND installation_id=? AND account_id=?").run(last.sequence, scope.userId, scope.channel, scope.installationId, id);
  }
  return { scanned, enqueued };
}
export function reserveCooldown(sqlite: Database, scope: Scope, row: Candidate, reservationId: string, now: number) {
  const old = sqlite.query("SELECT attempted_at FROM important_notification_cooldowns WHERE user_id=? AND channel=? AND installation_id=? AND account_id=? AND thread_id=?").get(scope.userId, scope.channel, scope.installationId, row.accountId, row.threadId) as { attempted_at: number } | null;
  if (old && row.receivedAt! < old.attempted_at + cooldownMs) return false;
  sqlite.query(`INSERT INTO important_notification_cooldowns VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id,channel,installation_id,account_id,thread_id)
    DO UPDATE SET reservation_id=excluded.reservation_id,attempted_at=excluded.attempted_at`).run(scope.userId, scope.channel, scope.installationId, row.accountId, row.threadId, reservationId, now);
  return true;
}
export function stillEligible(sqlite: Database, scope: Scope, messageId: string, generation: number, now: number) {
  const policy = activePolicy(sqlite, scope, now);
  if (!policy || policy.generation !== generation) return false;
  const row = sqlite.query(`SELECT ${projection},s.eligible_after_at boundary,s.boundary_sequence boundarySequence
    FROM important_notification_arrivals a JOIN emails e ON e.id=a.message_id AND e.account_id=a.account_id AND e.thread_id=a.thread_id
    JOIN important_notification_accounts s ON s.user_id=? AND s.channel=? AND s.installation_id=? AND s.account_id=e.account_id
    JOIN oauth_accounts o ON o.user_id=s.user_id AND o.id=s.account_id WHERE a.message_id=?`).get(scope.userId, scope.channel, scope.installationId, messageId) as (Candidate & { boundary: number; boundarySequence: number }) | null;
  return Boolean(row && row.sequence > row.boundarySequence && baseEligible(row, now, row.boundary) && readImportance(sqlite, [row]).get(importanceKey(row.accountId, row.threadId))?.effective === "important");
}
/** No body, snippet, HTML, attachments or recipient data enters this payload. */
export function importantPayload(row: Candidate) { return notificationPayload({ ...row, snippet: null, bodyText: null }); }
