import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";

import { decryptToken, encryptToken } from "../auth/token-crypto.ts";
import { resolveNotificationSpaceSelection } from "./catalog.ts";

export type ApnsEnvironment = "sandbox" | "production";
export type NotificationSelection = { inbox: boolean; spaceIds: string[] };

export type MobilePushDevice = {
  userId: string;
  installationId: string;
  sessionId: string;
  environment: ApnsEnvironment;
  notificationSelection: NotificationSelection;
  generation: number;
  registeredAt: number;
  lastSeenAt: number;
  updatedAt: number;
  disabledAt: number | null;
  disabledReason: string | null;
};

type StoredDeviceRow = Omit<MobilePushDevice, "notificationSelection"> & {
  tokenEncrypted: string;
  tokenHash: string;
  notifyInbox: number;
  eligibleAfterAt: number;
  watermarkSequence: number;
  watermarkCreatedAt: number;
  watermarkEmailId: string;
};

const deviceProjection = `user_id AS userId, installation_id AS installationId, session_id AS sessionId, token_encrypted AS tokenEncrypted,
  token_hash AS tokenHash, environment, notify_inbox AS notifyInbox, generation, eligible_after_at AS eligibleAfterAt,
  watermark_sequence AS watermarkSequence, watermark_created_at AS watermarkCreatedAt, watermark_email_id AS watermarkEmailId,
  registered_at AS registeredAt, last_seen_at AS lastSeenAt, updated_at AS updatedAt,
  disabled_at AS disabledAt, disabled_reason AS disabledReason`;

export function hashDeviceToken(token: string) {
  return createHash("sha256").update(token.toLowerCase()).digest("hex");
}

export async function registerDevice(sqlite: Database, input: {
  userId: string;
  installationId: string;
  sessionId: string;
  token: string;
  environment: ApnsEnvironment;
  notificationSelection: NotificationSelection;
  now: Date;
}) {
  const tokenEncrypted = await encryptToken(input.token.toLowerCase());
  const tokenHash = hashDeviceToken(input.token);
  const now = input.now.getTime();
  sqlite.transaction(() => {
    const spaces = resolveNotificationSpaceSelection(sqlite, input.userId, input.notificationSelection.spaceIds);
    const current = sqlite.query(`SELECT ${deviceProjection} FROM mobile_push_devices WHERE user_id = ? AND installation_id = ?`)
      .get(input.userId, input.installationId) as StoredDeviceRow | null;
    const currentSpaceIds = current ? listDeviceSpaceIds(sqlite, input.userId, input.installationId) : [];
    const nextSpaceIds = spaces.map((space) => space.id).sort();
    const selectionChanged = current
      ? Boolean(current.notifyInbox) !== input.notificationSelection.inbox || JSON.stringify(currentSpaceIds) !== JSON.stringify(nextSpaceIds)
      : true;
    const registrationChanged = current
      ? current.tokenHash !== tokenHash || current.environment !== input.environment || current.sessionId !== input.sessionId || selectionChanged
      : true;
    const wasEnabled = current ? Boolean(current.notifyInbox) || currentSpaceIds.length > 0 : false;
    const isEnabled = input.notificationSelection.inbox || nextSpaceIds.length > 0;
    const modeEnabled = Boolean(current) && !wasEnabled && isEnabled;
    const resetWatermark = !current || modeEnabled || current.sessionId !== input.sessionId;
    const generation = current ? current.generation + (registrationChanged ? 1 : 0) : 1;
    const currentPushSequence = (sqlite.query("SELECT COALESCE(MAX(sequence),0) AS value FROM mobile_push_email_sequence").get() as { value: number }).value;
    // One APNs token/environment has exactly one authenticated owner. Account
    // switching atomically removes the prior registration and cascades its outbox.
    sqlite.query("DELETE FROM mobile_push_devices WHERE token_hash=? AND environment=? AND NOT (user_id=? AND installation_id=?)")
      .run(tokenHash, input.environment, input.userId, input.installationId);
    sqlite.query(`INSERT INTO mobile_push_devices (
      user_id, installation_id, session_id, token_encrypted, token_hash, environment, notification_mode, notify_inbox, generation, eligible_after_at,
      watermark_sequence, watermark_created_at, watermark_email_id, registered_at, last_seen_at, updated_at, disabled_at, disabled_reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, NULL, NULL)
    ON CONFLICT(user_id, installation_id) DO UPDATE SET
      session_id=excluded.session_id, token_encrypted=excluded.token_encrypted, token_hash=excluded.token_hash, environment=excluded.environment,
      notification_mode=excluded.notification_mode, notify_inbox=excluded.notify_inbox, generation=excluded.generation,
      eligible_after_at=CASE WHEN ? THEN excluded.eligible_after_at ELSE mobile_push_devices.eligible_after_at END,
      watermark_sequence=CASE WHEN ? THEN excluded.watermark_sequence ELSE mobile_push_devices.watermark_sequence END,
      watermark_created_at=CASE WHEN ? THEN excluded.watermark_created_at ELSE mobile_push_devices.watermark_created_at END,
      watermark_email_id=CASE WHEN ? THEN '' ELSE mobile_push_devices.watermark_email_id END,
      last_seen_at=excluded.last_seen_at, updated_at=excluded.updated_at, disabled_at=NULL, disabled_reason=NULL`)
      .run(input.userId, input.installationId, input.sessionId, tokenEncrypted, tokenHash, input.environment, isEnabled ? "all" : "off",
        input.notificationSelection.inbox ? 1 : 0, generation,
        now, currentPushSequence, now, current?.registeredAt ?? now, now, now, resetWatermark ? 1 : 0, resetWatermark ? 1 : 0,
        resetWatermark ? 1 : 0, resetWatermark ? 1 : 0);
    sqlite.query("DELETE FROM mobile_push_device_spaces WHERE user_id=? AND installation_id=?").run(input.userId, input.installationId);
    const insertSpace = sqlite.query(`INSERT INTO mobile_push_device_spaces
      (user_id,installation_id,space_id,kind,resource_id) VALUES (?,?,?,?,?)`);
    for (const space of spaces) insertSpace.run(input.userId, input.installationId, space.id, space.kind, space.resourceId);
    if (registrationChanged && current) {
      sqlite.query("UPDATE mobile_push_outbox SET state='dead', last_error='registration_updated', updated_at=? WHERE user_id=? AND installation_id=? AND state IN ('pending','delivering') AND device_generation<>?")
        .run(now, input.userId, input.installationId, generation);
    }
  }).immediate();
  return getDevice(sqlite, input.userId, input.installationId)!;
}

export function unregisterDevice(sqlite: Database, userId: string, installationId: string) {
  return sqlite.query("DELETE FROM mobile_push_devices WHERE user_id=? AND installation_id=? RETURNING installation_id AS installationId")
    .get(userId, installationId) as { installationId: string } | null;
}

export function getDevice(sqlite: Database, userId: string, installationId: string) {
  const row = sqlite.query(`SELECT ${deviceProjection} FROM mobile_push_devices WHERE user_id=? AND installation_id=?`)
    .get(userId, installationId) as StoredDeviceRow | null;
  return row ? hydrateDevice(sqlite, row) : null;
}

export function listDevices(sqlite: Database, userId: string, installationId?: string) {
  const rows = (installationId
    ? sqlite.query(`SELECT ${deviceProjection} FROM mobile_push_devices WHERE user_id=? AND installation_id=? ORDER BY installation_id`).all(userId, installationId)
    : sqlite.query(`SELECT ${deviceProjection} FROM mobile_push_devices WHERE user_id=? ORDER BY installation_id`).all(userId)) as StoredDeviceRow[];
  return rows.map((row) => {
    const { tokenEncrypted: _tokenEncrypted, tokenHash: _tokenHash, eligibleAfterAt: _eligibleAfterAt, watermarkSequence: _watermarkSequence,
      watermarkCreatedAt: _watermarkCreatedAt, watermarkEmailId: _watermarkEmailId, sessionId: _sessionId, notifyInbox: _notifyInbox, ...device } = hydrateDevice(sqlite, row);
    return device;
  });
}

function listDeviceSpaceIds(sqlite: Database, userId: string, installationId: string) {
  return (sqlite.query(`SELECT space_id AS id FROM mobile_push_device_spaces
    WHERE user_id=? AND installation_id=? ORDER BY space_id`).all(userId, installationId) as Array<{ id: string }>).map((row) => row.id);
}

function hydrateDevice(sqlite: Database, row: StoredDeviceRow): StoredDeviceRow & { notificationSelection: NotificationSelection } {
  return { ...row, notificationSelection: { inbox: Boolean(row.notifyInbox), spaceIds: listDeviceSpaceIds(sqlite, row.userId, row.installationId) } };
}

export async function readDeviceToken(sqlite: Database, userId: string, installationId: string, generation: number) {
  const row = sqlite.query("SELECT token_encrypted AS tokenEncrypted FROM mobile_push_devices WHERE user_id=? AND installation_id=? AND generation=? AND disabled_at IS NULL")
    .get(userId, installationId, generation) as { tokenEncrypted: string } | null;
  return row ? decryptToken(row.tokenEncrypted) : null;
}
