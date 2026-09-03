import { createDatabaseClient } from "../../db/client.ts";
import { createGmailSyncCoordinator } from "./sync-coordinator.ts";

const [, , databasePath, ownerId] = Bun.argv;
if (!databasePath || !ownerId) throw new Error("database path and owner id are required");

const dbFactory = () => createDatabaseClient(databasePath);
const coordinator = createGmailSyncCoordinator({
  dbFactory,
  ownerId,
  leaseMs: 2_000,
  worker: async ({ lease }) => {
    const client = dbFactory();
    try {
      lease.assert(client.db);
      client.sqlite.query("INSERT INTO process_sync_executions(owner_id) VALUES (?)").run(ownerId);
      await Bun.sleep(100);
      return {};
    } finally {
      client.sqlite.close();
    }
  },
});

coordinator.enqueue({ accountId: "account-a", source: "fallback" });
const result = await coordinator.drainAccount("account-a");
if (result.error) throw result.error;
