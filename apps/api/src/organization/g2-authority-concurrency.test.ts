import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "bun:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { OrganizationCapabilitySnapshot } from "@orca/shared";

import { createDatabaseClient } from "../db/client.ts";
import { oauthAccounts, organizationChangeSets, organizationWorkflowStates, users } from "../db/schema.ts";
import type { OrganizationAgentCapabilitySource } from "./agent-capability.ts";
import { createOrganization, OrganizationAuthorityError } from "./module.ts";
import { createSqliteOrganizationRepository } from "./sqlite-repository.ts";

const directories: string[] = [];
afterEach(() => { while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true }); });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "orca-g2-concurrency-"));
  directories.push(directory);
  const databasePath = join(directory, "race.sqlite");
  const client = createDatabaseClient(databasePath);
  migrate(client.db, { migrationsFolder: resolve(import.meta.dir, "../../drizzle") });
  client.db.insert(users).values({ id: "workspace", email: "owner@example.com" }).run();
  client.db.insert(oauthAccounts).values({
    id: "account", userId: "workspace", provider: "gmail", providerEmail: "owner@example.com", providerId: "provider",
  }).run();
  const agent = { id: "agent-client", type: "agent" as const };
  const snapshot: OrganizationCapabilitySnapshot = {
    id: "g2-agent-capability", revision: 1, actor: agent,
    scope: { workspaceId: "workspace", accountIds: ["account"] },
    operations: ["describe", "query", "simulate", "apply", "revert"],
    resourceFamilies: ["facet", "workflow_state", "change_set", "audit"],
    actionFamilies: ["organization_read", "organization_structure", "organization_thread"],
  };
  const source: OrganizationAgentCapabilitySource = { load: () => ({ snapshot, revokedAt: null }) };
  return { ...client, databasePath, agent, source };
}

function request(id: string, name: string, idempotencyKey = id) {
  return {
    id,
    idempotencyKey,
    expectedWorkspaceRevision: 1,
    actions: [
      { kind: "define_workflow_state" as const, id: `${id}-a`, name: `${name} A`, position: 0 },
      { kind: "define_workflow_state" as const, id: `${id}-b`, name: `${name} B`, position: 1 },
    ],
  };
}

function waitForWorker(worker: Worker, kind: "locked" | "complete"): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent<Record<string, unknown>>) => {
      if (event.data.kind === "error") {
        worker.removeEventListener("message", onMessage);
        reject(new Error(JSON.stringify(event.data)));
      } else if (event.data.kind === kind) {
        worker.removeEventListener("message", onMessage);
        resolve(event.data);
      }
    };
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", reject, { once: true });
  });
}

async function startWinner(databasePath: string, actorType: "human" | "agent", winnerRequest: ReturnType<typeof request>) {
  const worker = new Worker(new URL("./g2-concurrency-worker.ts", import.meta.url).href, { type: "module" });
  const locked = waitForWorker(worker, "locked");
  worker.postMessage({ databasePath, actorType, request: winnerRequest });
  await locked;
  return worker;
}

describe("BRE-319 authority and concurrency", () => {
  for (const winnerType of ["human", "agent"] as const) {
    test(`serializes a ${winnerType}-winner two-connection human-v-agent race as an explicit revision conflict`, async () => {
      const f = fixture();
      const winnerRequest = request(`${winnerType}-winner`, `${winnerType} winner`);
      const worker = await startWinner(f.databasePath, winnerType, winnerRequest);
      const complete = waitForWorker(worker, "complete");
      const loserType = winnerType === "human" ? "agent" : "human";
      const loser = createOrganization(createSqliteOrganizationRepository(f.db), {
        ...(loserType === "agent" ? { agentCapabilitySource: f.source } : {}),
      });
      assert.throws(() => loser.apply({
        scope: {
          actor: loserType === "agent" ? f.agent : { id: "workspace", type: "human" as const },
          workspaceId: "workspace",
          accountIds: ["account"],
        },
        command: request(`${loserType}-loser`, `${loserType} loser`),
      }), (error) => error instanceof OrganizationAuthorityError && error.code === "revision_conflict");
      await complete;
      worker.terminate();
      assert.equal(f.db.select().from(organizationChangeSets).all().length, 1);
      assert.equal(f.db.select().from(organizationWorkflowStates).all().length, 2);
      assert.deepEqual(f.db.select().from(organizationChangeSets).all().map((row) => row.idempotencyKey), [winnerRequest.idempotencyKey]);
      f.sqlite.close();
    });
  }

  test("returns one identical result for the same concurrent agent key/body and rejects reordered reuse", async () => {
    const f = fixture();
    const exact = request("same-agent", "Same agent");
    const worker = await startWinner(f.databasePath, "agent", exact);
    const complete = waitForWorker(worker, "complete");
    const service = createOrganization(createSqliteOrganizationRepository(f.db), { agentCapabilitySource: f.source });
    const replay = service.apply({
      scope: { actor: f.agent, workspaceId: "workspace", accountIds: ["account"] },
      command: exact,
    });
    const workerResult = (await complete).result;
    worker.terminate();
    assert.deepEqual(replay, workerResult);
    assert.equal(f.db.select().from(organizationChangeSets).all().length, 1);
    assert.equal(f.db.select().from(organizationWorkflowStates).all().length, 2);
    assert.throws(() => service.apply({
      scope: { actor: f.agent, workspaceId: "workspace", accountIds: ["account"] },
      command: { ...exact, actions: [...exact.actions].reverse() },
    }), (error) => error instanceof OrganizationAuthorityError && error.code === "duplicate_idempotency_key");
    assert.equal(f.db.select().from(organizationChangeSets).all().length, 1);
    f.sqlite.close();
  });
});
