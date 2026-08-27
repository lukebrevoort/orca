import type { McpApplyOrganizationInput } from "@orca/shared";

import { createDatabaseClient } from "../db/client.ts";
import { recordOrganizationMutationAttempt } from "./mutation-attempt-audit.ts";

type WorkerInput = {
  databasePath: string;
  attemptNumber: 1 | 2;
  retentionBarrier?: SharedArrayBuffer;
};

self.onmessage = (event: MessageEvent<WorkerInput>) => {
  const { databasePath, attemptNumber, retentionBarrier } = event.data;
  const client = createDatabaseClient(databasePath);
  try {
    self.postMessage({ kind: "started", attemptNumber });
    recordOrganizationMutationAttempt({
      db: client.db,
      workspaceId: "workspace",
      connectionId: "connection",
      actor: { id: `client-${attemptNumber}`, type: "agent" },
      operation: "apply",
      query: {
        accountIds: ["account"],
        target: { request: { idempotencyKey: `new-key-${attemptNumber}`, actions: [] } },
      } as unknown as McpApplyOrganizationInput,
      error: Object.assign(new Error("concurrent revision conflict"), { code: "revision_conflict" }),
      id: `new-attempt-${attemptNumber}`,
      now: new Date(2_000 + attemptNumber),
      afterRetainedSelectionForTest: retentionBarrier ? () => {
        self.postMessage({ kind: "retained", attemptNumber });
        const barrier = new Int32Array(retentionBarrier);
        while (Atomics.load(barrier, 0) === 0) Atomics.wait(barrier, 0, 0);
      } : undefined,
    });
    self.postMessage({ kind: "complete", attemptNumber });
  } catch (error) {
    self.postMessage({
      kind: "error",
      attemptNumber,
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    client.sqlite.close();
  }
};
