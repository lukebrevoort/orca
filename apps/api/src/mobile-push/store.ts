import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";

import { decryptToken, encryptToken } from "../auth/token-crypto.ts";

export type NotificationMode = "human" | "all" | "off";
export type ApnsEnvironment = "sandbox" | "production";

export type MobilePushDevice = {
  userId: string;
  installationId: string;
  sessionId: string;
  environment: ApnsEnvironment;
  notificationMode: NotificationMode;
  generation: number;
  registeredAt: number;
  lastSeenAt: number;
  updatedAt: number;
  disabledAt: number | null;
  disabledReason: string | null;
};

type DeviceRow = MobilePushDevice & { tokenEncrypted: string; tokenHash: string; eligibleAfterAt: number; watermarkCreatedAt: number; watermarkEmailId: string };

const deviceProjection = `user_id AS userId, installation_id AS installationId, session_id AS sessionId, token_encrypted AS tokenEncrypted,
  token_hash AS tokenHash, environment, notification_mode AS notificationMode, generation, eligible_after_at AS eligibleAfterAt,
  watermark_created_at AS watermarkCreatedAt, watermark_email_id AS watermarkEmailId,
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
  notificationMode: NotificationMode;
  now: Date;
}) {
  const tokenEncrypted = await encryptToken(input.token.toLowerCase());
  const tokenHash = hashDeviceToken(input.token);
  const now = input.now.getTime();
  sqlite.transaction(() => {
    const current = sqlite.query(`SELECT ${deviceProjection} FROM mobile_push_devices WHERE user_id = ? AND installation_id = ?`)
      .get(input.userId, input.installationId) as DeviceRow | null;
    const registrationChanged = current
      ? current.tokenHash !== tokenHash || current.environment !== input.environment || current.sessionId !== input.sessionId
      : true;
    const modeEnabled = current?.notificationMode === "off" && input.notificationMode !== "off";
    const resetWatermark = !current || modeEnabled || current.sessionId !== input.sessionId;
    const generation = current ? current.generation + (registrationChanged ? 1 : 0) : 1;
    // One APNs token/environment has exactly one authenticated owner. Account
    // switching atomically removes the prior registration and cascades its outbox.
    sqlite.query("DELETE FROM mobile_push_devices WHERE token_hash=? AND environment=? AND NOT (user_id=? AND installation_id=?)")
      .run(tokenHash, input.environment, input.userId, input.installationId);
    sqlite.query(`INSERT INTO mobile_push_devices (
      user_id, installation_id, session_id, token_encrypted, token_hash, environment, notification_mode, generation, eligible_after_at,
      watermark_created_at, watermark_email_id, registered_at, last_seen_at, updated_at, disabled_at, disabled_reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, NULL, NULL)
    ON CONFLICT(user_id, installation_id) DO UPDATE SET
      session_id=excluded.session_id, token_encrypted=excluded.token_encrypted, token_hash=excluded.token_hash, environment=excluded.environment,
      notification_mode=excluded.notification_mode, generation=excluded.generation,
      eligible_after_at=CASE WHEN ? THEN excluded.eligible_after_at ELSE mobile_push_devices.eligible_after_at END,
      watermark_created_at=CASE WHEN ? THEN excluded.watermark_created_at ELSE mobile_push_devices.watermark_created_at END,
      watermark_email_id=CASE WHEN ? THEN '' ELSE mobile_push_devices.watermark_email_id END,
      last_seen_at=excluded.last_seen_at, updated_at=excluded.updated_at, disabled_at=NULL, disabled_reason=NULL`)
      .run(input.userId, input.installationId, input.sessionId, tokenEncrypted, tokenHash, input.environment, input.notificationMode, generation,
        now, now, current?.registeredAt ?? now, now, now, resetWatermark ? 1 : 0, resetWatermark ? 1 : 0, resetWatermark ? 1 : 0);
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
  return sqlite.query(`SELECT ${deviceProjection} FROM mobile_push_devices WHERE user_id=? AND installation_id=?`)
    .get(userId, installationId) as DeviceRow | null;
}

export function listDevices(sqlite: Database, userId: string, installationId?: string) {
  const rows = (installationId
    ? sqlite.query(`SELECT ${deviceProjection} FROM mobile_push_devices WHERE user_id=? AND installation_id=? ORDER BY installation_id`).all(userId, installationId)
    : sqlite.query(`SELECT ${deviceProjection} FROM mobile_push_devices WHERE user_id=? ORDER BY installation_id`).all(userId)) as DeviceRow[];
  return rows.map(({ tokenEncrypted: _tokenEncrypted, tokenHash: _tokenHash, eligibleAfterAt: _eligibleAfterAt, watermarkCreatedAt: _watermarkCreatedAt, watermarkEmailId: _watermarkEmailId, sessionId: _sessionId, ...device }) => device);
}

export async function readDeviceToken(sqlite: Database, userId: string, installationId: string, generation: number) {
  const row = sqlite.query("SELECT token_encrypted AS tokenEncrypted FROM mobile_push_devices WHERE user_id=? AND installation_id=? AND generation=? AND disabled_at IS NULL")
    .get(userId, installationId, generation) as { tokenEncrypted: string } | null;
  return row ? decryptToken(row.tokenEncrypted) : null;
}
