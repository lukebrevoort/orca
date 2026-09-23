import { createHash, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { organizationViewDefinitionSchema } from "@orca/shared";

import { createDatabaseClient } from "../db/client.ts";
import { inboxDestinationId, inboxVisibilityPredicate } from "../organization/views/inbox-policy.ts";
import { threadMatchPredicate } from "../organization/views/thread-predicate.ts";
import { createApnsTransport, type ApnsDeliveryResult, type ApnsTransport } from "./apns.ts";
import { loadMobilePushConfig, type MobilePushConfig } from "./config.ts";
import { readDeviceToken, type ApnsEnvironment } from "./store.ts";

type DeviceScanRow = {
  userId: string;
  installationId: string;
  sessionId: string;
  environment: ApnsEnvironment;
  notifyInbox: number;
  generation: number;
  eligibleAfterAt: number;
  watermarkSequence: number;
  watermarkCreatedAt: number;
  watermarkEmailId: string;
};

type CandidateRow = {
  messageId: string;
  accountId: string;
  threadId: string;
  pushSequence: number;
  createdAt: number;
  matchesSelection: number;
};

type OutboxRow = {
  id: string;
  userId: string;
  installationId: string;
  deviceGeneration: number;
  messageId: string;
  accountId: string;
  threadId: string;
  environment: ApnsEnvironment;
  payloadJson: string;
  apnsId: string;
  attemptCount: number;
};

export type MobilePushCycleResult = {
  scanned: number;
  enqueued: number;
  delivered: number;
  retried: number;
  discarded: number;
  disabledDevices: number;
  staleDevicesRemoved: number;
};

export type MobilePushSessionChecker = (sqlite: Database, input: { userId: string; sessionId: string; now: Date }) => boolean;

/** Standalone default for cookie sessions; production may compose mobile_sessions through the injected hook. */
export const isLegacySessionActive: MobilePushSessionChecker = (sqlite, input) => Boolean(sqlite.query(`SELECT 1 FROM sessions
  WHERE id=? AND user_id=? AND invalidated_at IS NULL AND expires_at>?`).get(input.sessionId, input.userId, input.now.getTime()));

const emptyResult = (): MobilePushCycleResult => ({ scanned: 0, enqueued: 0, delivered: 0, retried: 0, discarded: 0, disabledDevices: 0, staleDevicesRemoved: 0 });

function privatePayload(row: CandidateRow) {
  return {
    aps: { alert: { title: "New email", body: "You have a new message in Orca." }, sound: "default" },
    version: 1,
    accountId: row.accountId,
    threadId: row.threadId,
  };
}

function selectionPredicate(sqlite: Database, device: Pick<DeviceScanRow, "userId" | "installationId" | "notifyInbox">) {
  const parts: string[] = [];
  const params: Array<string | number> = [];
  if (device.notifyInbox) {
    const inboxId = inboxDestinationId(sqlite, device.userId);
    if (inboxId) {
      const inboxPolicy = inboxVisibilityPredicate(sqlite, device.userId, "destination");
      parts.push(`(destination.destination_id=? AND ${inboxPolicy.sql})`);
      params.push(inboxId, ...inboxPolicy.params);
    }
  }
  parts.push(`EXISTS (SELECT 1 FROM mobile_push_device_spaces selected
    JOIN organization_lanes lane ON lane.workspace_id=selected.user_id AND lane.id=selected.resource_id AND lane.retired_at IS NULL
    WHERE selected.user_id=? AND selected.installation_id=? AND selected.kind='destination'
      AND selected.resource_id=destination.destination_id)`);
  params.push(device.userId, device.installationId);
  parts.push(`EXISTS (SELECT 1 FROM mobile_push_device_spaces selected
    JOIN collections collection ON collection.id=selected.resource_id
    JOIN collection_threads membership ON membership.collection_id=collection.id
    JOIN oauth_accounts collection_account ON collection_account.id=collection.account_id AND collection_account.user_id=selected.user_id
    WHERE selected.user_id=? AND selected.installation_id=? AND selected.kind='collection'
      AND collection.account_id=e.account_id AND membership.thread_id=e.thread_id)`);
  params.push(device.userId, device.installationId);

  const accountIds = (sqlite.query("SELECT id FROM oauth_accounts WHERE user_id=? ORDER BY id").all(device.userId) as Array<{ id: string }>).map(({ id }) => id);
  const views = sqlite.query(`SELECT view.id,view.definition FROM mobile_push_device_spaces selected
    JOIN organization_views view ON view.workspace_id=selected.user_id AND view.id=selected.resource_id
    WHERE selected.user_id=? AND selected.installation_id=? AND selected.kind='view' ORDER BY view.id`)
    .all(device.userId, device.installationId) as Array<{ id: string; definition: string }>;
  for (const view of views) {
    let definitionValue: unknown;
    try { definitionValue = JSON.parse(view.definition); } catch { continue; }
    const parsed = organizationViewDefinitionSchema.safeParse(definitionValue);
    if (!parsed.success) continue;
    const definition = parsed.data;
    if (definition.accountIds) {
      const owned = definition.accountIds.filter((id) => accountIds.includes(id));
      if (!owned.length) continue;
      definition.accountIds = owned;
    }
    const predicate = threadMatchPredicate({ workspaceId: device.userId, accountIds }, { definition });
    parts.push(`EXISTS (SELECT 1 FROM threads t JOIN oauth_accounts oa ON oa.id=t.account_id
      JOIN organization_thread_lane_states lane ON lane.workspace_id=oa.user_id AND lane.account_id=t.account_id AND lane.thread_id=t.id
      WHERE t.account_id=e.account_id AND t.id=e.thread_id AND ${predicate.conditions.join(" AND ")})`);
    params.push(...predicate.params);
  }
  return { sql: parts.length ? `(${parts.join(" OR ")})` : "0", params };
}

function messageStillEligible(sqlite: Database, device: Pick<DeviceScanRow, "userId" | "installationId" | "notifyInbox">, row: OutboxRow) {
  const selection = selectionPredicate(sqlite, device);
  return Boolean(sqlite.query(`SELECT 1 FROM emails e
    JOIN oauth_accounts account ON account.id=e.account_id AND account.user_id=?
    JOIN organization_effective_destinations destination ON destination.workspace_id=?
      AND destination.account_id=e.account_id AND destination.thread_id=e.thread_id
    WHERE e.id=? AND e.account_id=? AND e.is_read=0 AND e.is_draft=0
      AND NOT EXISTS (SELECT 1 FROM email_labels el JOIN labels label ON label.id=el.label_id
        WHERE el.email_id=e.id AND upper(label.provider_label_id) IN ('SENT','DRAFT'))
      AND ${selection.sql} LIMIT 1`).get(device.userId, device.userId, row.messageId, row.accountId, ...selection.params));
}

export function scanAndEnqueue(sqlite: Database, options: { now: Date; batchSize: number; isSessionActive?: MobilePushSessionChecker }) {
  const now = options.now.getTime();
  const result = { scanned: 0, enqueued: 0 };
  const isSessionActive = options.isSessionActive ?? isLegacySessionActive;
  const devices = sqlite.query(`SELECT user_id AS userId, installation_id AS installationId, session_id AS sessionId, environment,
    notify_inbox AS notifyInbox, generation, eligible_after_at AS eligibleAfterAt, watermark_sequence AS watermarkSequence,
    watermark_created_at AS watermarkCreatedAt,
    watermark_email_id AS watermarkEmailId
    FROM mobile_push_devices WHERE disabled_at IS NULL AND (notify_inbox=1 OR EXISTS (
      SELECT 1 FROM mobile_push_device_spaces selected WHERE selected.user_id=mobile_push_devices.user_id
        AND selected.installation_id=mobile_push_devices.installation_id))
    ORDER BY user_id, installation_id`).all() as DeviceScanRow[];

  for (const device of devices) {
    if (!isSessionActive(sqlite, { userId: device.userId, sessionId: device.sessionId, now: options.now })) continue;
    sqlite.transaction(() => {
      const selection = selectionPredicate(sqlite, device);
      const candidates = sqlite.query(`SELECT e.id AS messageId, e.account_id AS accountId, e.thread_id AS threadId,
        ps.sequence AS pushSequence, e.created_at AS createdAt, ${selection.sql} AS matchesSelection
        FROM emails e
        JOIN mobile_push_email_sequence ps ON ps.email_id=e.id
        JOIN oauth_accounts a ON a.id=e.account_id AND a.user_id=?
        JOIN organization_effective_destinations destination ON destination.workspace_id=? AND destination.account_id=e.account_id AND destination.thread_id=e.thread_id
        WHERE e.is_read=0 AND e.is_draft=0
          AND ps.sequence>?
          AND COALESCE(e.received_at,e.internal_date)>=?
          AND NOT EXISTS (SELECT 1 FROM email_labels el JOIN labels l ON l.id=el.label_id WHERE el.email_id=e.id AND upper(l.provider_label_id) IN ('SENT','DRAFT'))
        ORDER BY ps.sequence LIMIT ?`)
        .all(...selection.params, device.userId, device.userId, device.watermarkSequence, device.eligibleAfterAt, options.batchSize) as CandidateRow[];
      for (const row of candidates) {
        result.scanned += 1;
        if (row.matchesSelection) {
          const inserted = sqlite.query(`INSERT OR IGNORE INTO mobile_push_outbox
            (id,user_id,installation_id,device_generation,message_id,account_id,thread_id,environment,payload_json,apns_id,state,attempt_count,available_at,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,'pending',0,?,?,?)`)
            .run(randomUUID(), device.userId, device.installationId, device.generation, row.messageId, row.accountId, row.threadId,
              device.environment, JSON.stringify(privatePayload(row)), randomUUID(), now, now, now);
          result.enqueued += inserted.changes;
        }
      }
      const last = candidates.at(-1);
      if (last) {
        sqlite.query(`UPDATE mobile_push_devices SET watermark_sequence=?, watermark_created_at=?, watermark_email_id=?, updated_at=?
          WHERE user_id=? AND installation_id=? AND generation=?`)
          .run(last.pushSequence, last.createdAt, last.messageId, now, device.userId, device.installationId, device.generation);
      }
    }).immediate();
  }
  return result;
}

// The production APNs transport aborts requests after 15 seconds, leaving a
// full timeout window before another worker may reclaim an in-flight delivery.
const deliveryLeaseMs = 30_000;

function claimNext(sqlite: Database, now: number, workerId: string, leaseMs = deliveryLeaseMs) {
  return sqlite.transaction(() => {
    const candidate = sqlite.query(`SELECT id FROM mobile_push_outbox
      WHERE (state='pending' AND available_at<=?) OR (state='delivering' AND lease_expires_at<=?)
      ORDER BY available_at, created_at, id LIMIT 1`).get(now, now) as { id: string } | null;
    if (!candidate) return null;
    const claimed = sqlite.query(`UPDATE mobile_push_outbox SET state='delivering', lease_owner=?, lease_expires_at=?, updated_at=?
      WHERE id=? AND ((state='pending' AND available_at<=?) OR (state='delivering' AND lease_expires_at<=?))`)
      .run(workerId, now + leaseMs, now, candidate.id, now, now);
    if (claimed.changes !== 1) return null;
    return sqlite.query(`SELECT id, user_id AS userId, installation_id AS installationId, device_generation AS deviceGeneration,
      message_id AS messageId, account_id AS accountId, thread_id AS threadId, environment, payload_json AS payloadJson, apns_id AS apnsId,
      attempt_count AS attemptCount FROM mobile_push_outbox WHERE id=?`).get(candidate.id) as OutboxRow;
  }).immediate();
}

function retryDelayMs(attempt: number) {
  return Math.min(3_600_000, 15_000 * (2 ** Math.max(0, attempt - 1)));
}

function finishDelivery(sqlite: Database, row: OutboxRow, delivery: ApnsDeliveryResult, now: number, config: MobilePushConfig, workerId: string) {
  return sqlite.transaction(() => {
    const ownsLease = sqlite.query("SELECT 1 FROM mobile_push_outbox WHERE id=? AND state='delivering' AND lease_owner=?").get(row.id, workerId);
    if (!ownsLease) return null;
    if (delivery.outcome === "success") {
      sqlite.query("UPDATE mobile_push_outbox SET state='sent', attempt_count=attempt_count+1, sent_at=?, updated_at=?, lease_owner=NULL, lease_expires_at=NULL, last_status=200, last_error=NULL WHERE id=?")
        .run(now, now, row.id);
      return "delivered" as const;
    }
    if (delivery.outcome === "invalid_token") {
      const disabled = sqlite.query(`UPDATE mobile_push_devices SET disabled_at=?, disabled_reason=?, updated_at=?
        WHERE user_id=? AND installation_id=? AND generation=? AND disabled_at IS NULL
          AND (? IS NULL OR last_seen_at<=?)`)
        .run(now, delivery.reason, now, row.userId, row.installationId, row.deviceGeneration, delivery.invalidatedAt, delivery.invalidatedAt).changes;
      if (!disabled) {
        sqlite.query(`UPDATE mobile_push_outbox SET state='dead', attempt_count=attempt_count+1, updated_at=?, lease_owner=NULL,
          lease_expires_at=NULL, last_status=?, last_error='stale_invalid_token_response' WHERE id=?`)
          .run(now, delivery.status, row.id);
        return "discarded" as const;
      }
      sqlite.query(`UPDATE mobile_push_outbox SET state='dead', attempt_count=attempt_count+1, updated_at=?, lease_owner=NULL,
        lease_expires_at=NULL, last_status=?, last_error=? WHERE user_id=? AND installation_id=? AND device_generation=? AND state IN ('pending','delivering')`)
        .run(now, delivery.status, delivery.reason, row.userId, row.installationId, row.deviceGeneration);
      return "disabled" as const;
    }
    const attempts = row.attemptCount + 1;
    if (delivery.outcome === "retry" && attempts < config.maxAttempts) {
      const availableAt = now + Math.max(retryDelayMs(attempts), delivery.retryAfterMs ?? 0);
      sqlite.query(`UPDATE mobile_push_outbox SET state='pending', attempt_count=?, available_at=?, updated_at=?, lease_owner=NULL,
        lease_expires_at=NULL, last_status=?, last_error=? WHERE id=?`)
        .run(attempts, availableAt, now, delivery.status, delivery.reason, row.id);
      return "retried" as const;
    }
    sqlite.query(`UPDATE mobile_push_outbox SET state='dead', attempt_count=?, updated_at=?, lease_owner=NULL,
      lease_expires_at=NULL, last_status=?, last_error=? WHERE id=?`)
      .run(attempts, now, delivery.status, delivery.reason, row.id);
    return "discarded" as const;
  }).immediate();
}

export async function deliverReady(sqlite: Database, options: { now: Date | (() => Date); batchSize: number; config: MobilePushConfig; transport: ApnsTransport; isSessionActive?: MobilePushSessionChecker }) {
  const counts = { delivered: 0, retried: 0, discarded: 0, disabledDevices: 0 };
  const readNow = () => typeof options.now === "function" ? options.now() : options.now;
  const workerId = randomUUID();
  for (let index = 0; index < options.batchSize; index += 1) {
    const claimNow = readNow();
    const row = claimNext(sqlite, claimNow.getTime(), workerId);
    if (!row) break;
    const device = sqlite.query(`SELECT session_id AS sessionId, notify_inbox AS notifyInbox, environment, disabled_at AS disabledAt,
      EXISTS (SELECT 1 FROM mobile_push_device_spaces selected WHERE selected.user_id=mobile_push_devices.user_id
        AND selected.installation_id=mobile_push_devices.installation_id) AS hasSpaces
      FROM mobile_push_devices WHERE user_id=? AND installation_id=? AND generation=?`)
      .get(row.userId, row.installationId, row.deviceGeneration) as { sessionId: string; notifyInbox: number; hasSpaces: number; environment: ApnsEnvironment; disabledAt: number | null } | null;
    const activeSession = device && (options.isSessionActive ?? isLegacySessionActive)(sqlite, { userId: row.userId, sessionId: device.sessionId, now: readNow() });
    if (!device || !activeSession || device.disabledAt !== null || (!device.notifyInbox && !device.hasSpaces) || device.environment !== row.environment) {
      const discarded = sqlite.query("UPDATE mobile_push_outbox SET state='dead', updated_at=?, lease_owner=NULL, lease_expires_at=NULL, last_error='registration_inactive' WHERE id=? AND state='delivering' AND lease_owner=?")
        .run(readNow().getTime(), row.id, workerId).changes;
      counts.discarded += discarded;
      continue;
    }
    const token = await readDeviceToken(sqlite, row.userId, row.installationId, row.deviceGeneration);
    if (!token) {
      const discarded = sqlite.query("UPDATE mobile_push_outbox SET state='dead', updated_at=?, lease_owner=NULL, lease_expires_at=NULL, last_error='token_unavailable' WHERE id=? AND state='delivering' AND lease_owner=?")
        .run(readNow().getTime(), row.id, workerId).changes;
      counts.discarded += discarded;
      continue;
    }
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(row.payloadJson) as Record<string, unknown>; }
    catch {
      const discarded = sqlite.query("UPDATE mobile_push_outbox SET state='dead', updated_at=?, lease_owner=NULL, lease_expires_at=NULL, last_error='invalid_payload' WHERE id=? AND state='delivering' AND lease_owner=?")
        .run(readNow().getTime(), row.id, workerId).changes;
      counts.discarded += discarded;
      continue;
    }
    // Recheck after async token decryption and immediately before network I/O.
    // Logout, account switching, or token refresh during claim processing must
    // suppress this old generation rather than relying on APNs to reject it.
    const current = sqlite.query(`SELECT session_id AS sessionId FROM mobile_push_devices
      WHERE user_id=? AND installation_id=? AND generation=? AND disabled_at IS NULL AND environment=? AND (notify_inbox=1 OR EXISTS (
        SELECT 1 FROM mobile_push_device_spaces selected WHERE selected.user_id=mobile_push_devices.user_id
          AND selected.installation_id=mobile_push_devices.installation_id))`)
      .get(row.userId, row.installationId, row.deviceGeneration, row.environment) as { sessionId: string } | null;
    if (!current || !(options.isSessionActive ?? isLegacySessionActive)(sqlite, { userId: row.userId, sessionId: current.sessionId, now: readNow() })) {
      const discarded = sqlite.query("UPDATE mobile_push_outbox SET state='dead', updated_at=?, lease_owner=NULL, lease_expires_at=NULL, last_error='registration_inactive' WHERE id=? AND state='delivering' AND lease_owner=?")
        .run(readNow().getTime(), row.id, workerId).changes;
      counts.discarded += discarded;
      continue;
    }
    if (!messageStillEligible(sqlite, { userId: row.userId, installationId: row.installationId, notifyInbox: device.notifyInbox }, row)) {
      const discarded = sqlite.query(`UPDATE mobile_push_outbox SET state='dead', updated_at=?, lease_owner=NULL, lease_expires_at=NULL,
        last_error='message_no_longer_eligible' WHERE id=? AND state='delivering' AND lease_owner=?`)
        .run(readNow().getTime(), row.id, workerId).changes;
      counts.discarded += discarded;
      continue;
    }
    let delivery: ApnsDeliveryResult;
    try {
      delivery = await options.transport.send({
        token, environment: row.environment, payload, apnsId: row.apnsId,
        collapseId: createHash("sha256").update(row.threadId).digest("hex"),
      });
    } catch (error) {
      delivery = { outcome: "retry", status: null, reason: error instanceof Error ? error.message : "APNs transport failed" };
    }
    const outcome = finishDelivery(sqlite, row, delivery, readNow().getTime(), options.config, workerId);
    if (!outcome) continue;
    if (outcome === "disabled") { counts.disabledDevices += 1; counts.discarded += 1; }
    else counts[outcome] += 1;
  }
  return counts;
}

export async function runMobilePushCycle(options: {
  dbFactory?: typeof createDatabaseClient;
  config?: MobilePushConfig;
  transport?: ApnsTransport;
  now?: () => Date;
  logger?: Pick<Console, "warn" | "error">;
  isSessionActive?: MobilePushSessionChecker;
} = {}): Promise<MobilePushCycleResult> {
  const dbFactory = options.dbFactory ?? createDatabaseClient;
  const config = options.config ?? loadMobilePushConfig();
  const now = options.now ?? (() => new Date());
  const ownsTransport = !options.transport;
  const transport = options.transport ?? createApnsTransport(config, { now });
  const client = dbFactory();
  const result = emptyResult();
  try {
    const scanned = scanAndEnqueue(client.sqlite, { now: now(), batchSize: config.batchSize, isSessionActive: options.isSessionActive });
    result.scanned = scanned.scanned;
    result.enqueued = scanned.enqueued;
    if (config.configured) {
      const delivered = await deliverReady(client.sqlite, { now, batchSize: config.batchSize, config, transport, isSessionActive: options.isSessionActive });
      Object.assign(result, { ...result, ...delivered });
    }
    result.staleDevicesRemoved = client.sqlite.query("DELETE FROM mobile_push_devices WHERE last_seen_at<?").run(now().getTime() - config.staleDeviceMs).changes;
    return result;
  } catch (error) {
    options.logger?.error("Mobile push cycle failed", { error: error instanceof Error ? error.message : String(error) });
    return result;
  } finally {
    client.sqlite.close();
    if (ownsTransport) transport.close?.();
  }
}

export function createMobilePushScheduler(options: {
  dbFactory?: typeof createDatabaseClient;
  config?: MobilePushConfig;
  transport?: ApnsTransport;
  now?: () => Date;
  logger?: Pick<Console, "warn" | "error">;
  isSessionActive?: MobilePushSessionChecker;
} = {}) {
  const config = options.config ?? loadMobilePushConfig();
  const transport = options.transport ?? createApnsTransport(config, { now: options.now });
  let stopped = false;
  let running: Promise<MobilePushCycleResult> | null = null;
  const runNow = () => {
    if (stopped) return Promise.resolve(emptyResult());
    running ??= runMobilePushCycle({ ...options, config, transport }).finally(() => { running = null; });
    return running;
  };
  const timer = setInterval(() => { void runNow(); }, config.intervalMs);
  timer.unref?.();
  void runNow();
  return {
    runNow,
    stop() { stopped = true; clearInterval(timer); transport.close?.(); },
  };
}
