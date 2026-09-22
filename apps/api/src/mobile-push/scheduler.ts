import { createHash, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { humanClassificationEvidenceSchema } from "@orca/shared";

import { createDatabaseClient } from "../db/client.ts";
import { automaticClassificationColumns, classifyHumanSignal, humanClassifierVersion } from "../classification/human-signal.ts";
import { createApnsTransport, type ApnsDeliveryResult, type ApnsTransport } from "./apns.ts";
import { loadMobilePushConfig, type MobilePushConfig } from "./config.ts";
import { readDeviceToken, type ApnsEnvironment, type NotificationMode } from "./store.ts";

type DeviceScanRow = {
  userId: string;
  installationId: string;
  sessionId: string;
  environment: ApnsEnvironment;
  notificationMode: NotificationMode;
  generation: number;
  eligibleAfterAt: number;
  watermarkCreatedAt: number;
  watermarkEmailId: string;
};

type CandidateRow = {
  messageId: string;
  accountId: string;
  threadId: string;
  createdAt: number;
  fromAddress: string | null;
  humanClassification: string | null;
  humanClassificationEvidence: string | null;
  humanClassifierVersion: string | null;
  overrideClassification: string | null;
};

type OutboxRow = {
  id: string;
  userId: string;
  installationId: string;
  deviceGeneration: number;
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

function parseEvidence(value: string | null) {
  if (!value) return undefined;
  try {
    const parsed = humanClassificationEvidenceSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  } catch { return undefined; }
}

function classifyCandidate(sqlite: Database, row: CandidateRow, now: number) {
  let automatic = row.humanClassification ?? "unclassified";
  if (row.humanClassifierVersion !== humanClassifierVersion) {
    const classification = classifyHumanSignal(parseEvidence(row.humanClassificationEvidence));
    const columns = automaticClassificationColumns(classification);
    sqlite.query(`UPDATE emails SET human_signal=?, human_classification=?, human_classification_reasons=?, human_classifier_version=?, updated_at=?
      WHERE id=? AND account_id=? AND COALESCE(human_classification_evidence,'')=COALESCE(?,'') AND COALESCE(human_classifier_version,'')=COALESCE(?,'')`)
      .run(columns.humanSignal, columns.humanClassification, columns.humanClassificationReasons, columns.humanClassifierVersion,
        now, row.messageId, row.accountId, row.humanClassificationEvidence, row.humanClassifierVersion);
    automatic = classification.classification;
  }
  return row.overrideClassification ?? automatic;
}

function privatePayload(row: CandidateRow) {
  return {
    aps: { alert: { title: "New email", body: "You have a new message in Orca." }, sound: "default" },
    version: 1,
    accountId: row.accountId,
    threadId: row.threadId,
  };
}

export function scanAndEnqueue(sqlite: Database, options: { now: Date; batchSize: number; isSessionActive?: MobilePushSessionChecker }) {
  const now = options.now.getTime();
  const result = { scanned: 0, enqueued: 0 };
  const isSessionActive = options.isSessionActive ?? isLegacySessionActive;
  const devices = sqlite.query(`SELECT user_id AS userId, installation_id AS installationId, session_id AS sessionId, environment,
    notification_mode AS notificationMode, generation, eligible_after_at AS eligibleAfterAt, watermark_created_at AS watermarkCreatedAt,
    watermark_email_id AS watermarkEmailId
    FROM mobile_push_devices WHERE disabled_at IS NULL AND notification_mode <> 'off'
    ORDER BY user_id, installation_id`).all() as DeviceScanRow[];

  for (const device of devices) {
    if (!isSessionActive(sqlite, { userId: device.userId, sessionId: device.sessionId, now: options.now })) continue;
    sqlite.transaction(() => {
      const candidates = sqlite.query(`SELECT e.id AS messageId, e.account_id AS accountId, e.thread_id AS threadId,
        e.created_at AS createdAt, e.from_address AS fromAddress, e.human_classification AS humanClassification,
        e.human_classification_evidence AS humanClassificationEvidence, e.human_classifier_version AS humanClassifierVersion,
        COALESCE(cm.classification, ca.classification, cd.classification) AS overrideClassification
        FROM emails e
        JOIN oauth_accounts a ON a.id=e.account_id AND a.user_id=?
        LEFT JOIN human_classification_overrides cm ON cm.account_id=e.account_id AND cm.target_type='message' AND cm.target_value=e.id
        LEFT JOIN human_classification_overrides ca ON ca.account_id=e.account_id AND ca.target_type='sender_address' AND ca.target_value=lower(trim(COALESCE(e.from_address,'')))
        LEFT JOIN human_classification_overrides cd ON cd.account_id=e.account_id AND cd.target_type='sender_domain' AND cd.target_value=CASE WHEN instr(lower(trim(COALESCE(e.from_address,''))),'@')>0 THEN substr(lower(trim(e.from_address)),instr(lower(trim(e.from_address)),'@')+1) ELSE '' END
        LEFT JOIN thread_attention_overrides at ON at.account_id=e.account_id AND at.thread_id=e.thread_id
        LEFT JOIN account_attention_routing aa ON aa.account_id=e.account_id
        LEFT JOIN sender_attention_rules asa ON asa.account_id=e.account_id AND asa.scope='address' AND asa.value=lower(trim(COALESCE(e.from_address,'')))
        LEFT JOIN sender_attention_rules asd ON asd.account_id=e.account_id AND asd.scope='domain' AND asd.value=CASE WHEN instr(lower(trim(COALESCE(e.from_address,''))),'@')>0 THEN substr(lower(trim(e.from_address)),instr(lower(trim(e.from_address)),'@')+1) ELSE '' END
        WHERE e.is_read=0 AND e.is_draft=0
          AND (e.created_at>? OR (e.created_at=? AND e.id>?))
          AND COALESCE(e.received_at,e.internal_date)>=?
          AND COALESCE(at.behavior,asa.behavior,asd.behavior,aa.default_behavior,'normal') NOT IN ('quiet','hidden')
          AND EXISTS (SELECT 1 FROM email_labels el JOIN labels l ON l.id=el.label_id WHERE el.email_id=e.id AND upper(l.provider_label_id)='INBOX')
          AND NOT EXISTS (SELECT 1 FROM email_labels el JOIN labels l ON l.id=el.label_id WHERE el.email_id=e.id AND upper(l.provider_label_id) IN ('SENT','DRAFT'))
        ORDER BY e.created_at, e.id LIMIT ?`)
        .all(device.userId, device.watermarkCreatedAt, device.watermarkCreatedAt, device.watermarkEmailId, device.eligibleAfterAt, options.batchSize) as CandidateRow[];
      for (const row of candidates) {
        result.scanned += 1;
        const effectiveClassification = classifyCandidate(sqlite, row, now);
        if (device.notificationMode === "all" || effectiveClassification === "likely_human") {
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
        sqlite.query(`UPDATE mobile_push_devices SET watermark_created_at=?, watermark_email_id=?, updated_at=?
          WHERE user_id=? AND installation_id=? AND generation=?`)
          .run(last.createdAt, last.messageId, now, device.userId, device.installationId, device.generation);
      }
    }).immediate();
  }
  return result;
}

function claimNext(sqlite: Database, now: number, workerId: string, leaseMs = 30_000) {
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
      account_id AS accountId, thread_id AS threadId, environment, payload_json AS payloadJson, apns_id AS apnsId,
      attempt_count AS attemptCount FROM mobile_push_outbox WHERE id=?`).get(candidate.id) as OutboxRow;
  }).immediate();
}

function retryDelayMs(attempt: number) {
  return Math.min(3_600_000, 15_000 * (2 ** Math.max(0, attempt - 1)));
}

function finishDelivery(sqlite: Database, row: OutboxRow, delivery: ApnsDeliveryResult, now: number, config: MobilePushConfig) {
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
}

export async function deliverReady(sqlite: Database, options: { now: Date; batchSize: number; config: MobilePushConfig; transport: ApnsTransport; isSessionActive?: MobilePushSessionChecker }) {
  const counts = { delivered: 0, retried: 0, discarded: 0, disabledDevices: 0 };
  const now = options.now.getTime();
  const workerId = randomUUID();
  for (let index = 0; index < options.batchSize; index += 1) {
    const row = claimNext(sqlite, now, workerId);
    if (!row) break;
    const device = sqlite.query(`SELECT session_id AS sessionId, notification_mode AS notificationMode, environment, disabled_at AS disabledAt
      FROM mobile_push_devices WHERE user_id=? AND installation_id=? AND generation=?`)
      .get(row.userId, row.installationId, row.deviceGeneration) as { sessionId: string; notificationMode: NotificationMode; environment: ApnsEnvironment; disabledAt: number | null } | null;
    const activeSession = device && (options.isSessionActive ?? isLegacySessionActive)(sqlite, { userId: row.userId, sessionId: device.sessionId, now: options.now });
    if (!device || !activeSession || device.disabledAt !== null || device.notificationMode === "off" || device.environment !== row.environment) {
      sqlite.query("UPDATE mobile_push_outbox SET state='dead', updated_at=?, lease_owner=NULL, lease_expires_at=NULL, last_error='registration_inactive' WHERE id=?")
        .run(now, row.id);
      counts.discarded += 1;
      continue;
    }
    const token = await readDeviceToken(sqlite, row.userId, row.installationId, row.deviceGeneration);
    if (!token) {
      sqlite.query("UPDATE mobile_push_outbox SET state='dead', updated_at=?, lease_owner=NULL, lease_expires_at=NULL, last_error='token_unavailable' WHERE id=?")
        .run(now, row.id);
      counts.discarded += 1;
      continue;
    }
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(row.payloadJson) as Record<string, unknown>; }
    catch {
      sqlite.query("UPDATE mobile_push_outbox SET state='dead', updated_at=?, lease_owner=NULL, lease_expires_at=NULL, last_error='invalid_payload' WHERE id=?").run(now, row.id);
      counts.discarded += 1;
      continue;
    }
    // Recheck after async token decryption and immediately before network I/O.
    // Logout, account switching, or token refresh during claim processing must
    // suppress this old generation rather than relying on APNs to reject it.
    const current = sqlite.query(`SELECT session_id AS sessionId FROM mobile_push_devices
      WHERE user_id=? AND installation_id=? AND generation=? AND disabled_at IS NULL AND notification_mode<>'off' AND environment=?`)
      .get(row.userId, row.installationId, row.deviceGeneration, row.environment) as { sessionId: string } | null;
    if (!current || !(options.isSessionActive ?? isLegacySessionActive)(sqlite, { userId: row.userId, sessionId: current.sessionId, now: options.now })) {
      sqlite.query("UPDATE mobile_push_outbox SET state='dead', updated_at=?, lease_owner=NULL, lease_expires_at=NULL, last_error='registration_inactive' WHERE id=?")
        .run(now, row.id);
      counts.discarded += 1;
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
    const outcome = finishDelivery(sqlite, row, delivery, now, options.config);
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
      const delivered = await deliverReady(client.sqlite, { now: now(), batchSize: config.batchSize, config, transport, isSessionActive: options.isSessionActive });
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
