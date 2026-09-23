export type MobilePushConfig = {
  configured: boolean;
  disabledReason: string | null;
  teamId: string | null;
  keyId: string | null;
  privateKey: string | null;
  bundleId: string | null;
  intervalMs: number;
  batchSize: number;
  staleDeviceMs: number;
  maxAttempts: number;
};

const identifierPattern = /^[A-Za-z0-9.-]+$/;

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number) {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}
/** APNs is optional: incomplete or invalid credentials disable delivery without preventing API startup. */
export function loadMobilePushConfig(env: NodeJS.ProcessEnv = process.env): MobilePushConfig {
  const teamId = env.APNS_TEAM_ID?.trim() || null;
  const keyId = env.APNS_KEY_ID?.trim() || null;
  const bundleId = env.APNS_BUNDLE_ID?.trim() || null;
  const privateKey = env.APNS_PRIVATE_KEY?.replaceAll("\\n", "\n").trim() || null;
  const supplied = [teamId, keyId, bundleId, privateKey].filter(Boolean).length;
  let disabledReason: string | null = null;
  if (supplied === 0) disabledReason = "APNs credentials are not configured";
  else if (supplied !== 4) disabledReason = "APNs credentials are incomplete";
  else if (!/^[A-Z0-9]{10}$/.test(teamId!) || !/^[A-Z0-9]{10}$/.test(keyId!)) disabledReason = "APNs team and key IDs must be 10 uppercase letters or digits";
  else if (!identifierPattern.test(bundleId!) || !bundleId!.includes(".")) disabledReason = "APNs bundle ID is invalid";
  else if (!privateKey!.includes("BEGIN PRIVATE KEY")) disabledReason = "APNs private key is invalid";

  return {
    configured: disabledReason === null,
    disabledReason,
    teamId,
    keyId,
    privateKey,
    bundleId,
    intervalMs: boundedInteger(env.MOBILE_PUSH_INTERVAL_MS, 15_000, 1_000, 3_600_000),
    batchSize: boundedInteger(env.MOBILE_PUSH_BATCH_SIZE, 100, 1, 500),
    staleDeviceMs: boundedInteger(env.MOBILE_PUSH_STALE_DAYS, 90, 7, 365) * 86_400_000,
    maxAttempts: boundedInteger(env.MOBILE_PUSH_MAX_ATTEMPTS, 8, 1, 20),
  };
}
