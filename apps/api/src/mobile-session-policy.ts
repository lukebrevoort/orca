import type { Database } from "bun:sqlite";

/** Push authorization expires with the credential that registered the device. */
export function isMobilePushSessionActive(
  sqlite: Database,
  input: { userId: string; sessionId: string; now: Date },
): boolean {
  const now = input.now.getTime();
  if (input.sessionId.startsWith("mobile_session_")) {
    return Boolean(sqlite.query(`SELECT 1 FROM mobile_sessions
      WHERE id=? AND user_id=? AND revoked_at IS NULL AND expires_at>?`)
      .get(input.sessionId, input.userId, now));
  }
  return Boolean(sqlite.query(`SELECT 1 FROM sessions
    WHERE id=? AND user_id=? AND invalidated_at IS NULL AND expires_at>?`)
    .get(input.sessionId, input.userId, now));
}
