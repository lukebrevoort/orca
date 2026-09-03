import { eq } from "drizzle-orm";

import { createDatabaseClient } from "../../db/client.ts";
import { oauthAccounts } from "../../db/schema.ts";
import { createGmailClient, type GmailClient } from "./client.ts";
import { loadGmailPushConfig, type GmailPushConfig } from "./push-config.ts";
import type { GmailSyncCoordinator } from "./sync-coordinator.ts";
import { createDefaultGmailSyncCoordinator } from "./sync-runtime.ts";

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
  coordinator?: GmailSyncCoordinator;
} = {}): Promise<GmailPeriodicSyncResult> {
  const dbFactory = options.dbFactory ?? createDatabaseClient;
  const gmailClient = options.gmailClient ?? createGmailClient();
  const config = options.config ?? loadGmailPushConfig();
  const now = options.now ?? (() => new Date());
  const logger = options.logger ?? console;
  const coordinator = options.coordinator ?? createDefaultGmailSyncCoordinator({
    dbFactory,
    gmailClient,
    config,
    now,
    logger,
  });
  const { db, sqlite } = dbFactory();
  const results: GmailPeriodicSyncAccountResult[] = [];

  try {
    const accounts = db
      .select({ id: oauthAccounts.id })
      .from(oauthAccounts)
      .where(eq(oauthAccounts.provider, "gmail"))
      .all();

    for (const account of accounts) {
      coordinator.enqueue({ accountId: account.id, source: "fallback", freshnessAt: now() });
      const drained = await coordinator.drainAccount(account.id);
      if (drained.error) {
        const message = drained.error instanceof Error ? drained.error.message : "Unknown Gmail periodic sync failure";
        logger.warn("Gmail periodic sync failed", { accountId: account.id, error: message });
        results.push({ accountId: account.id, ok: false, pages: Number(drained.result?.pageCount ?? 0), error: message });
      } else {
        results.push({ accountId: account.id, ok: true, pages: Number(drained.result?.pageCount ?? 0), error: null });
      }
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
  coordinator?: GmailSyncCoordinator;
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
