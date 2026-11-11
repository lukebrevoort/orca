import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { activePolicy, importantPayload, reserveCooldown, scanCandidates, stillEligible } from "./eligibility.ts";
import { type Scope } from "./policy.ts";

/** Reuses the mature encrypted-device/outbox/lease/retry transport. */
export function scanImportantApns(sqlite: Database, now: number, maximum: number) {
  const result = { scanned: 0, enqueued: 0 };
  const installations = sqlite.query(`SELECT user_id,installation_id FROM important_notification_installations
    WHERE channel='apns' AND enabled=1 AND permission='granted' ORDER BY last_scan_at,user_id,installation_id LIMIT 100`).all() as { user_id: string; installation_id: string }[];
  for (const installation of installations) {
    if (result.scanned >= Math.min(500, maximum)) break;
    sqlite.transaction(() => {
      const scope: Scope = { userId: installation.user_id, installationId: installation.installation_id, channel: "apns" };
      sqlite.query("UPDATE important_notification_installations SET last_scan_at=? WHERE user_id=? AND channel='apns' AND installation_id=?").run(now, scope.userId, scope.installationId);
      const policy = activePolicy(sqlite, scope, now);
      const device = sqlite.query("SELECT generation,session_id,environment FROM mobile_push_devices WHERE user_id=? AND installation_id=? AND disabled_at IS NULL").get(scope.userId, scope.installationId) as { generation: number; session_id: string; environment: string } | null;
      if (!policy || !device || device.session_id !== policy.session_id) return;
      const counts = scanCandidates(sqlite, scope, now, Math.min(500, maximum) - result.scanned, row => {
        const id = randomUUID();
        if (!reserveCooldown(sqlite, scope, row, id, now)) return false;
        return sqlite.query(`INSERT OR IGNORE INTO mobile_push_outbox
          (id,user_id,installation_id,device_generation,message_id,account_id,thread_id,environment,payload_json,apns_id,state,attempt_count,available_at,created_at,updated_at,important_generation)
          VALUES(?,?,?,?,?,?,?,?,?,?,'pending',0,?,?,?,?)`).run(id, scope.userId, scope.installationId, device.generation, row.messageId, row.accountId, row.threadId, device.environment,
            JSON.stringify(importantPayload(row)), randomUUID(), now, now, now, policy.generation).changes === 1;
      });
      result.scanned += counts.scanned; result.enqueued += counts.enqueued;
    }).immediate();
  }
  return result;
}
export function apnsPolicyEligible(sqlite: Database, row: { userId: string; installationId: string; messageId: string; importantGeneration: number | null }, now: number) {
  const scope: Scope = { userId: row.userId, installationId: row.installationId, channel: "apns" };
  const adopted = sqlite.query("SELECT 1 FROM important_notification_installations WHERE user_id=? AND channel='apns' AND installation_id=?").get(row.userId, row.installationId);
  if (row.importantGeneration === null) return !adopted;
  return sqlite.transaction(() => stillEligible(sqlite, scope, row.messageId, row.importantGeneration!, now)).deferred();
}
