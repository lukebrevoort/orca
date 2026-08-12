const defaultSyncIntervalMs = 15 * 60 * 1000;
const defaultWatchRenewalWindowMs = 24 * 60 * 60 * 1000;
const defaultBackfillPageSize = 25;
const defaultBackfillMaxPages = 100;

export type GmailPushConfig = {
  topicName: string | null;
  verificationToken: string | null;
  syncIntervalMs: number;
  watchRenewalWindowMs: number;
  backfillPageSize: number;
  backfillMaxPages: number;
};

export function loadGmailPushConfig(
  env: Record<string, string | undefined> = process.env,
): GmailPushConfig {
  const rawTopic = env.GMAIL_PUBSUB_TOPIC ?? env.GMAIL_PUBSUB_TOPIC_NAME;
  const topicName = rawTopic?.trim() || null;

  if (topicName && !/^projects\/[^/]+\/topics\/[^/]+$/.test(topicName)) {
    throw new Error("GMAIL_PUBSUB_TOPIC must be a full projects/{project}/topics/{topic} name");
  }

  return {
    topicName,
    verificationToken: (env.GMAIL_PUBSUB_VERIFICATION_TOKEN ?? env.GMAIL_PUBSUB_TOKEN)?.trim() || null,
    syncIntervalMs: parsePositiveInteger(env.GMAIL_SYNC_INTERVAL_MS, defaultSyncIntervalMs, "GMAIL_SYNC_INTERVAL_MS"),
    watchRenewalWindowMs: parsePositiveInteger(
      env.GMAIL_WATCH_RENEWAL_WINDOW_MS,
      defaultWatchRenewalWindowMs,
      "GMAIL_WATCH_RENEWAL_WINDOW_MS",
    ),
    backfillPageSize: parsePositiveInteger(
      env.GMAIL_BACKFILL_PAGE_SIZE,
      defaultBackfillPageSize,
      "GMAIL_BACKFILL_PAGE_SIZE",
    ),
    backfillMaxPages: parsePositiveInteger(
      env.GMAIL_BACKFILL_MAX_PAGES,
      defaultBackfillMaxPages,
      "GMAIL_BACKFILL_MAX_PAGES",
    ),
  };
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}
