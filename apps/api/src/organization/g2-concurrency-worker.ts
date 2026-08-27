import type { OrganizationCapabilitySnapshot } from "@orca/shared";

import { createDatabaseClient } from "../db/client.ts";
import type { OrganizationAgentCapabilitySource } from "./agent-capability.ts";
import { createOrganization } from "./module.ts";
import { createSqliteOrganizationRepository } from "./sqlite-repository.ts";

type WorkerInput = {
  databasePath: string;
  actorType: "human" | "agent";
  request: {
    id: string;
    idempotencyKey: string;
    expectedWorkspaceRevision: number;
    actions: Array<{ kind: "define_workflow_state"; id: string; name: string; position: number }>;
  };
};

const actor = { id: "agent-client", type: "agent" as const };
const capability: OrganizationCapabilitySnapshot = {
  id: "g2-agent-capability",
  revision: 1,
  actor,
  scope: { workspaceId: "workspace", accountIds: ["account"] },
  operations: ["describe", "query", "simulate", "apply", "revert"],
  resourceFamilies: ["facet", "workflow_state", "change_set", "audit"],
  actionFamilies: ["organization_read", "organization_structure", "organization_thread"],
};

self.onmessage = (event: MessageEvent<WorkerInput>) => {
  const input = event.data;
  const client = createDatabaseClient(input.databasePath);
  try {
    const originalTransaction = client.db.transaction.bind(client.db);
    let transactionCount = 0;
    client.db.transaction = ((callback, config) => {
      transactionCount += 1;
      if (transactionCount !== 2) return originalTransaction(callback, config);
      return originalTransaction((transaction) => {
        self.postMessage({ kind: "locked" });
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
        return callback(transaction);
      }, config);
    }) as typeof client.db.transaction;
    const source: OrganizationAgentCapabilitySource = { load: () => ({ snapshot: capability, revokedAt: null }) };
    const service = createOrganization(createSqliteOrganizationRepository(client.db), {
      ...(input.actorType === "agent" ? { agentCapabilitySource: source } : {}),
    });
    const result = service.apply({
      scope: {
        actor: input.actorType === "agent" ? actor : { id: "workspace", type: "human" as const },
        workspaceId: "workspace",
        accountIds: ["account"],
      },
      command: input.request,
    });
    self.postMessage({ kind: "complete", result });
  } catch (error) {
    self.postMessage({
      kind: "error",
      name: error instanceof Error ? error.name : "Error",
      code: error && typeof error === "object" && "code" in error ? String(error.code) : null,
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    client.sqlite.close();
  }
};
