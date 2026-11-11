import { createHash, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { ImportantNotificationClaim, ImportantNotificationClaimResponse, ImportantNotificationEnvelope, ImportantNotificationReport } from "@orca/shared";
import { activePolicy, importantPayload, reserveCooldown, scanCandidates, stillEligibleBatch } from "./eligibility.ts";
import { fingerprint, NotificationError, policyRow, type Scope } from "./policy.ts";
const claimLeaseMs = 30_000;
function requirePolicy(sqlite: Database, scope: Scope, sessionId: string, now: number) {
  const policy = policyRow(sqlite, scope);
  if (!policy) throw new NotificationError("not_found", "Installation not found");
  if (!activePolicy(sqlite, scope, now, sessionId)) throw new NotificationError("stale_revision", "Notification delivery is unavailable for this session or policy");
  return policy;
}
type Delivery = { id: string; message_id: string; generation: number; created_at: number; state: string; envelope_json: string };
export function claimBrowser(sqlite: Database, scope: Scope, sessionId: string, input: ImportantNotificationClaim, now: number): ImportantNotificationClaimResponse {
  return sqlite.transaction(() => {
    const policy = requirePolicy(sqlite, scope, sessionId, now);
    const hash = fingerprint({ installationId: scope.installationId, ...input });
    const old = sqlite.query("SELECT installation_id,fingerprint,generation FROM important_notification_web_claims WHERE user_id=? AND operation_id=?").get(scope.userId, input.operationId) as { installation_id: string; fingerprint: string; generation: number } | null;
    if (old && (old.fingerprint !== hash || old.installation_id !== scope.installationId)) throw new NotificationError("operation_conflict", "Claim operation already identifies a different request");
    if (!old && policy.revision !== input.expectedRevision) throw new NotificationError("stale_revision", "Read current settings before claiming notifications");
    if (old && old.generation !== policy.generation) throw new NotificationError("stale_revision", "Claim belongs to a superseded policy");
    if (!old) {
      sqlite.query("INSERT INTO important_notification_web_claims VALUES(?,'open_app',?,?,?,?,?)").run(scope.userId, scope.installationId, input.operationId, hash, policy.generation, now);
      let accepted = 0;
      scanCandidates(sqlite, scope, now, 20, row => {
        // Stop before advancing over more eligible arrivals than one bounded claim.
        // The scan budget is fixed at 20 for this path, so it never drops a 21st alert.
        if (accepted >= 20) return false;
        const id = randomUUID();
        if (!reserveCooldown(sqlite, scope, row, id, now)) return false;
        const payload = importantPayload(row), alert = payload.aps.alert;
        const envelope: ImportantNotificationEnvelope = { id, accountId: row.accountId, threadId: row.threadId, title: alert.title, subtitle: alert.subtitle, body: alert.body,
          tag: createHash("sha256").update(JSON.stringify([scope.userId, scope.installationId, row.accountId, row.threadId])).digest("hex") };
        sqlite.query(`INSERT INTO important_notification_web_deliveries(id,user_id,channel,installation_id,generation,claim_operation_id,message_id,account_id,thread_id,state,created_at,updated_at,envelope_json)
          VALUES(?,?,'open_app',?,?,?,?,?,?,'claimed',?,?,?)`).run(id, scope.userId, scope.installationId, policy.generation, input.operationId, row.messageId, row.accountId, row.threadId, now, now, JSON.stringify(envelope));
        accepted++;
        return true;
      });
    }
    const deliveries = sqlite.query("SELECT id,message_id,generation,created_at,state,envelope_json FROM important_notification_web_deliveries WHERE user_id=? AND installation_id=? AND claim_operation_id=? ORDER BY id LIMIT 20").all(scope.userId, scope.installationId, input.operationId) as Delivery[];
    const eligible = stillEligibleBatch(sqlite, scope, deliveries.filter(row => row.state === "claimed").map(row => row.message_id), policy.generation, now);
    const notifications: ImportantNotificationEnvelope[] = [];
    for (const row of deliveries) {
      if (row.state !== "claimed") continue;
      if (now > row.created_at + claimLeaseMs || !eligible.has(row.message_id)) {
        sqlite.query("UPDATE important_notification_web_deliveries SET state='dead',updated_at=? WHERE id=?").run(now, row.id);
      } else notifications.push(JSON.parse(row.envelope_json));
    }
    return { operationId: input.operationId, installationId: scope.installationId, policyRevision: policy.revision, scope: "open_app" as const, notifications };
  }).immediate();
}
export function reportBrowser(sqlite: Database, scope: Scope, sessionId: string, input: ImportantNotificationReport, now: number) {
  return sqlite.transaction(() => {
    const policy = requirePolicy(sqlite, scope, sessionId, now);
    const claim = sqlite.query("SELECT generation FROM important_notification_web_claims WHERE user_id=? AND installation_id=? AND operation_id=?").get(scope.userId, scope.installationId, input.operationId) as { generation: number } | null;
    if (!claim) throw new NotificationError("not_found", "Claim not found");
    if (claim.generation !== policy.generation) throw new NotificationError("stale_revision", "Claim belongs to an older policy");
    const rows = input.notificationIds.length ? sqlite.query(`SELECT id,message_id,generation,created_at,state,envelope_json FROM important_notification_web_deliveries WHERE user_id=? AND installation_id=? AND claim_operation_id=? AND id IN (${input.notificationIds.map(() => "?").join(",")})`).all(scope.userId, scope.installationId, input.operationId, ...input.notificationIds) as Delivery[] : [];
    if (rows.length !== input.notificationIds.length) throw new NotificationError("not_found", "Notification not found in this claim");
    const eligible = stillEligibleBatch(sqlite, scope, rows.filter(row => row.state === "claimed").map(row => row.message_id), policy.generation, now);
    for (const row of rows) {
      const id = row.id;
      if (row.state !== "claimed" && row.state !== input.outcome) throw new NotificationError("operation_conflict", "Notification already has a different terminal report");
      if (row.state === "claimed" && (now > row.created_at + claimLeaseMs || !eligible.has(row.message_id))) throw new NotificationError("stale_revision", "Claim expired or is no longer eligible");
      // A report records the client constructor outcome, never OS display proof.
      if (row.state === "claimed") sqlite.query("UPDATE important_notification_web_deliveries SET state=?,updated_at=? WHERE id=?").run(input.outcome, now, id);
    }
    return { operationId: input.operationId, outcome: input.outcome, reported: input.notificationIds.length, displayConfirmed: false };
  }).immediate();
}
