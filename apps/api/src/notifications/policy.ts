import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { ImportantNotificationCommand, ImportantNotificationInstallation, ImportantNotificationOperation, NotificationChannel } from "@orca/shared";
import { isMobilePushSessionActive } from "../mobile-session-policy.ts";
import type { MobilePushConfig } from "../mobile-push/config.ts";

export class NotificationError extends Error {
  constructor(readonly code: "not_found" | "stale_revision" | "operation_conflict" | "validation_error" | "installation_limit", message: string) { super(message); }
}
export type Scope = { userId: string; installationId: string; channel: NotificationChannel };
export type PolicyRow = { user_id: string; channel: NotificationChannel; installation_id: string; session_id: string; enabled: number; permission: "granted" | "denied" | "default" | "unavailable"; revision: number; generation: number; previous_selection: string | null };
export const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function policyRow(sqlite: Database, scope: Scope) {
  return sqlite.query("SELECT * FROM important_notification_installations WHERE user_id=? AND channel=? AND installation_id=?").get(scope.userId, scope.channel, scope.installationId) as PolicyRow | null;
}
export function currentSequence(sqlite: Database) {
  return (sqlite.query("SELECT value FROM mobile_push_sequence_counter WHERE id=1").get() as { value: number }).value;
}
export function accountIds(sqlite: Database, scope: Scope) {
  return (sqlite.query(`SELECT a.account_id FROM important_notification_accounts a JOIN oauth_accounts o ON o.user_id=a.user_id AND o.id=a.account_id
    WHERE a.user_id=? AND a.channel=? AND a.installation_id=? ORDER BY a.account_id LIMIT 100`).all(scope.userId, scope.channel, scope.installationId) as { account_id: string }[]).map(row => row.account_id);
}
function ensureOwner(sqlite: Database, scope: Scope) {
  if (sqlite.query("SELECT 1 FROM important_notification_installations WHERE channel=? AND installation_id=? AND user_id<>? LIMIT 1").get(scope.channel, scope.installationId, scope.userId)) throw new NotificationError("not_found", "Installation not found");
  if (scope.channel === "apns" && sqlite.query("SELECT 1 FROM mobile_push_devices WHERE installation_id=? AND user_id<>? LIMIT 1").get(scope.installationId, scope.userId)) throw new NotificationError("not_found", "Installation not found");
}
export function readInstallation(sqlite: Database, scope: Scope, sessionId: string, config: Pick<MobilePushConfig, "configured">, now: number): ImportantNotificationInstallation {
  ensureOwner(sqlite, scope);
  const row = policyRow(sqlite, scope);
  const ids = row ? accountIds(sqlite, scope) : [];
  const device = scope.channel === "apns" ? sqlite.query(`SELECT session_id,disabled_at,notify_inbox FROM mobile_push_devices WHERE user_id=? AND installation_id=?`).get(scope.userId, scope.installationId) as { session_id: string; disabled_at: number | null; notify_inbox: number } | null : null;
  let previous: ImportantNotificationInstallation["previousSelection"] = row?.previous_selection ? JSON.parse(row.previous_selection) : null;
  if (!row && device) previous = { inbox: Boolean(device.notify_inbox), spaceIds: (sqlite.query("SELECT space_id FROM mobile_push_device_spaces WHERE user_id=? AND installation_id=? ORDER BY space_id LIMIT 100").all(scope.userId, scope.installationId) as { space_id: string }[]).map(x => x.space_id) };
  let reason: ImportantNotificationInstallation["delivery"]["reason"] = !row ? "not_adopted" : !row.enabled ? "disabled" : !ids.length ? "no_accounts" : row.permission !== "granted" ? "permission_required" : null;
  if (!reason && row && (row.session_id !== sessionId || !isMobilePushSessionActive(sqlite, { userId: scope.userId, sessionId: row.session_id, now: new Date(now) }))) reason = "registration_required";
  if (!reason && scope.channel === "apns") reason = !device || device.disabled_at !== null || device.session_id !== sessionId ? "registration_required" : !config.configured ? "server_unavailable" : null;
  return { installationId: scope.installationId, channel: scope.channel, revision: row?.revision ?? 0,
    policy: row ? { version: 1, kind: "important_only", enabled: Boolean(row.enabled), accountIds: ids } : null,
    permission: row?.permission ?? "unknown", previousSelection: previous,
    delivery: { available: reason === null, scope: scope.channel, reason }, cooldownSeconds: 900 };
}
export function reconcileOperation(sqlite: Database, userId: string, operationId: string, sessionId: string, config: Pick<MobilePushConfig, "configured">, now: number): ImportantNotificationOperation {
  const op = sqlite.query("SELECT channel,installation_id,applied_revision FROM important_notification_operations WHERE user_id=? AND operation_id=?").get(userId, operationId) as { channel: NotificationChannel; installation_id: string; applied_revision: number } | null;
  if (!op) throw new NotificationError("not_found", "Operation not found");
  const current = readInstallation(sqlite, { userId, channel: op.channel, installationId: op.installation_id }, sessionId, config, now);
  return { operationId, appliedRevision: op.applied_revision, status: current.revision === op.applied_revision ? "current" : "superseded", current };
}
/** All invalidation keeps the installation/receipt tombstones: revisions cannot return to zero. */
export function invalidatePending(sqlite: Database, scope: Scope, now: number) {
  if (scope.channel === "apns") sqlite.query(`UPDATE mobile_push_outbox SET state='dead',lease_owner=NULL,lease_expires_at=NULL,last_error='policy_changed',updated_at=? WHERE user_id=? AND installation_id=? AND state IN ('pending','delivering')`).run(now, scope.userId, scope.installationId);
  else sqlite.query("UPDATE important_notification_web_deliveries SET state='dead',updated_at=? WHERE user_id=? AND installation_id=? AND state='claimed'").run(now, scope.userId, scope.installationId);
}
export function applyCommand(sqlite: Database, scope: Scope, sessionId: string, command: ImportantNotificationCommand, config: Pick<MobilePushConfig, "configured">, now: number) {
  return sqlite.transaction(() => {
    ensureOwner(sqlite, scope);
    const hash = fingerprint({ installationId: scope.installationId, ...command, accountIds: [...command.accountIds].sort() });
    const old = sqlite.query("SELECT fingerprint FROM important_notification_operations WHERE user_id=? AND operation_id=?").get(scope.userId, command.operationId) as { fingerprint: string } | null;
    if (old) {
      if (old.fingerprint !== hash) throw new NotificationError("operation_conflict", "Operation ID already identifies a different command");
      return reconcileOperation(sqlite, scope.userId, command.operationId, sessionId, config, now);
    }
    for (const id of command.accountIds) if (!sqlite.query("SELECT 1 FROM oauth_accounts WHERE id=? AND user_id=?").get(id, scope.userId)) throw new NotificationError("not_found", "Account not found");
    const row = policyRow(sqlite, scope);
    if ((row?.revision ?? 0) !== command.expectedRevision) throw new NotificationError("stale_revision", "Read current notification settings before saving again");
    if (!row && (sqlite.query("SELECT count(*) count FROM important_notification_installations WHERE user_id=?").get(scope.userId) as { count: number }).count >= 20) throw new NotificationError("installation_limit", "Installation limit reached");
    const previous = readInstallation(sqlite, scope, sessionId, config, now).previousSelection;
    const ids = row ? accountIds(sqlite, scope) : [];
    const scopeChanged = JSON.stringify(ids) !== JSON.stringify([...command.accountIds].sort());
    const sessionChanged = Boolean(row && row.session_id !== sessionId);
    const changed = !row || Boolean(row.enabled) !== command.enabled || row.permission !== command.permission || scopeChanged || sessionChanged;
    const reset = !row || sessionChanged || (!row.enabled && command.enabled) || (row.permission !== "granted" && command.permission === "granted");
    const revision = (row?.revision ?? 0) + 1, generation = (row?.generation ?? 0) + Number(changed);
    sqlite.query(`INSERT INTO important_notification_installations(user_id,channel,installation_id,session_id,enabled,permission,revision,generation,previous_selection,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,channel,installation_id) DO UPDATE SET session_id=excluded.session_id,enabled=excluded.enabled,permission=excluded.permission,revision=excluded.revision,generation=excluded.generation,updated_at=excluded.updated_at`)
      .run(scope.userId, scope.channel, scope.installationId, sessionId, Number(command.enabled), command.permission, revision, generation, previous ? JSON.stringify(previous) : null, now, now);
    if (changed) invalidatePending(sqlite, scope, now);
    const sequence = currentSequence(sqlite);
    const removed = ids.filter(id => !command.accountIds.includes(id));
    for (const id of removed) sqlite.query("DELETE FROM important_notification_accounts WHERE user_id=? AND channel=? AND installation_id=? AND account_id=?").run(scope.userId, scope.channel, scope.installationId, id);
    for (const id of command.accountIds) {
      sqlite.query(`INSERT INTO important_notification_accounts VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id,channel,installation_id,account_id) DO UPDATE SET
        eligible_after_at=CASE WHEN ? THEN excluded.eligible_after_at ELSE eligible_after_at END,boundary_sequence=CASE WHEN ? THEN excluded.boundary_sequence ELSE boundary_sequence END,
        watermark_sequence=CASE WHEN ? THEN excluded.watermark_sequence ELSE watermark_sequence END`).run(scope.userId, scope.channel, scope.installationId, id, now, sequence, sequence, Number(reset), Number(reset), Number(reset));
    }
    sqlite.query("INSERT INTO important_notification_operations(user_id,operation_id,channel,installation_id,fingerprint,applied_revision,created_at) VALUES(?,?,?,?,?,?,?)").run(scope.userId, command.operationId, scope.channel, scope.installationId, hash, revision, now);
    return reconcileOperation(sqlite, scope.userId, command.operationId, sessionId, config, now);
  }).immediate();
}

/** Token/session replacement is a delivery barrier, never a policy adoption or opt-in. */
export function registrationBarrier(sqlite: Database, userId: string, installationId: string, sessionId: string, now: number) {
  const scope: Scope = { userId, installationId, channel: "apns" };
  if (!policyRow(sqlite, scope)) return;
  sqlite.query(`UPDATE important_notification_installations SET generation=generation+1,revision=revision+1,session_id=?,updated_at=?
    WHERE user_id=? AND channel='apns' AND installation_id=?`).run(sessionId, now, userId, installationId);
  sqlite.query(`UPDATE important_notification_accounts SET eligible_after_at=?,boundary_sequence=?,watermark_sequence=?
    WHERE user_id=? AND channel='apns' AND installation_id=?`).run(now, currentSequence(sqlite), currentSequence(sqlite), userId, installationId);
  invalidatePending(sqlite, scope, now);
}
