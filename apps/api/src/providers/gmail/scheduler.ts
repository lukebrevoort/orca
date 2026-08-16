import { eq } from "drizzle-orm";

import { createDatabaseClient } from "../../db/client.ts";
import { oauthAccounts } from "../../db/schema.ts";
import { createGmailClient, type GmailClient } from "./client.ts";
import { loadGmailPushConfig, type GmailPushConfig } from "./push-config.ts";
import { backfillGmailAccount, ensureGmailWatch } from "./push.ts";
import {
  getGmailAccount,
  syncGmailAccountPage,
  withGmailSyncLock,
  type GmailSyncResult,
} from "./sync.ts";

type DatabaseFactory = typeof createDatabaseClient;

export type GmailPeriodicSyncAccountResult = {
  accountId: string;
  ok: boolean;
  pages: number;
  error: string | null;
};

export type GmailPeriodicSyncResult = {
  accounts: GmailPeriodicSyncAccountResult[];
};

export async function runGmailPeriodicSync(options: {
  dbFactory?: DatabaseFactory;
  gmailClient?: GmailClient;
  config?: GmailPushConfig;
  now?: () => Date;
  logger?: Pick<Console, "error" | "warn">;
} = {}): Promise<GmailPeriodicSyncResult> {
  const dbFactory = options.dbFactory ?? createDatabaseClient;
  const gmailClient = options.gmailClient ?? createGmailClient();
  const config = options.config ?? loadGmailPushConfig();
  const now = options.now ?? (() => new Date());
  const logger = options.logger ?? console;
  const { db, sqlite } = dbFactory();
  const results: GmailPeriodicSyncAccountResult[] = [];

  try {
    const accounts = db
      .select({ id: oauthAccounts.id })
      .from(oauthAccounts)
      .where(eq(oauthAccounts.provider, "gmail"))
      .all();

    for (const account of accounts) {
      const result = await withGmailSyncLock(account.id, async () => {
        const accountNow = now();
        let pages = 0;
        try {
          const current = getGmailAccount(db, account.id);
          const wasLegacyAccount = !current.syncHistoryId;
          const shouldEnsureWatch = Boolean(config.topicName && config.verificationToken) && (
            !current.syncHistoryId ||
            !current.watchExpirationAt ||
            current.watchExpirationAt <= new Date(accountNow.getTime() + config.watchRenewalWindowMs) ||
            current.watchTopic !== config.topicName
          );

          if (shouldEnsureWatch) {
            try {
              await ensureGmailWatch(db, {
                accountId: account.id,
                gmailClient,
                config,
                now: accountNow,
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : "Unknown Gmail watch setup failure";
              logger.warn("Gmail push watch setup failed; continuing periodic fallback", {
                accountId: account.id,
                error: message,
              });
            }
          }

          const afterWatch = getGmailAccount(db, account.id);
          const watchEstablishedForLegacyAccount = wasLegacyAccount && Boolean(afterWatch.syncHistoryId);

          // A newly connected account, and an account first seen before Gmail
          // history push was enabled, are deliberately backfilled from the
          // beginning after the watch cursor is established. That ordering
          // keeps messages arriving during the backfill recoverable via history
          // and repairs legacy accounts whose cached checkpoint predates push.
          if (
            (!afterWatch.lastSyncedAt && !afterWatch.syncCursor) ||
            watchEstablishedForLegacyAccount
          ) {
            const backfill = await backfillGmailAccount(db, {
              accountId: account.id,
              gmailClient,
              now: accountNow,
              pageSize: config.backfillPageSize,
              maxPages: config.backfillMaxPages,
            });
            pages = backfill.pages;
          } else {
            pages = await syncIncrementalPages(db, account.id, gmailClient, accountNow, config.backfillPageSize, config.backfillMaxPages);
          }

          return { accountId: account.id, ok: true, pages, error: null };
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown Gmail periodic sync failure";
          logger.warn("Gmail periodic sync failed", { accountId: account.id, error: message });
          return { accountId: account.id, ok: false, pages, error: message };
        }
      });
      results.push(result);
    }
  } finally {
    sqlite.close();
  }

  return { accounts: results };
}

export function startGmailSyncScheduler(options: {
  dbFactory?: DatabaseFactory;
  gmailClient?: GmailClient;
  config?: GmailPushConfig;
  now?: () => Date;
  logger?: Pick<Console, "error" | "warn">;
} = {}): { stop: () => void; runNow: () => Promise<GmailPeriodicSyncResult> } {
  const config = options.config ?? loadGmailPushConfig();
  let stopped = false;
  let running: Promise<GmailPeriodicSyncResult> | null = null;

  const runNow = async () => {
    if (stopped) return { accounts: [] };
    if (running) return running;
    running = runGmailPeriodicSync(options).finally(() => {
      running = null;
    });
    return running;
  };

  const timer = setInterval(() => {
    void runNow();
  }, config.syncIntervalMs);
  timer.unref?.();
  void runNow();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    runNow,
  };
}

async function syncIncrementalPages(
  db: ReturnType<typeof createDatabaseClient>["db"],
  accountId: string,
  gmailClient: GmailClient,
  now: Date,
  pageSize: number,
  maxPages: number,
): Promise<number> {
  let pages = 0;
  let result: GmailSyncResult;
  do {
    result = await syncGmailAccountPage(db, {
      accountId,
      gmailClient,
      now,
      pageSize,
    });
    pages += 1;
  } while (result.nextCursor && pages < maxPages);
  return pages;
}
