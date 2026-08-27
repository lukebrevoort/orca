import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, test } from "bun:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

import type { McpApplyOrganizationInput } from "@orca/shared";

import { createDatabaseClient } from "../db/client.ts";
import { organizationMutationAttempts } from "../db/schema.ts";
import {
  maximumMutationAttemptAuditRowsPerWorkspace,
  recordOrganizationMutationAttempt,
} from "./mutation-attempt-audit.ts";

describe("BRE-319 bounded mutation-attempt audit", () => {
  test("retains only the newest 1,000 redacted records in one Workspace without pruning another tenant", () => {
    const directory = mkdtempSync(join(tmpdir(), "orca-g2-attempt-audit-"));
    const client = createDatabaseClient(join(directory, "audit.sqlite"));
    try {
      migrate(client.db, { migrationsFolder: resolve(import.meta.dir, "../../drizzle") });
      client.sqlite.exec(`
        INSERT INTO users (id,email) VALUES ('workspace','owner@example.com'),('other-workspace','other@example.com');
        INSERT INTO mcp_oauth_clients (id,name,redirect_uris) VALUES ('client','Client','[]');
        INSERT INTO mcp_connections (id,user_id,client_id,resource,scopes)
          VALUES ('connection','workspace','client','https://api.orca.test/mcp','organization:control');
        WITH RECURSIVE sequence(value) AS (
          VALUES(1) UNION ALL SELECT value + 1 FROM sequence WHERE value < 1000
        )
        INSERT INTO organization_mutation_attempts (
          id,workspace_id,connection_id,actor_type,actor_id,operation,idempotency_key,
          command_digest,account_count,account_ids_digest,outcome,reason_code,created_at
        ) SELECT
          printf('old-%04d',value),'workspace','connection','agent','client','apply',printf('old-key-%04d',value),
          'sha256:redacted',1,'sha256:redacted','failed','revision_conflict',value
        FROM sequence;
        INSERT INTO organization_mutation_attempts (
          id,workspace_id,connection_id,actor_type,actor_id,operation,idempotency_key,
          command_digest,account_count,account_ids_digest,outcome,reason_code,created_at
        ) VALUES (
          'other-attempt','other-workspace',NULL,'agent','foreign-client','apply','other-key',
          'sha256:redacted',1,'sha256:redacted','denied','account_denied',1
        );
      `);

      const query = {
        workspaceId: "workspace",
        accountIds: ["account"],
        expectedWorkspaceRevision: 1,
        resourceFamily: "lane",
        target: {
          kind: "lanes",
          request: { id: "new-request", idempotencyKey: "new-key", expectedWorkspaceRevision: 1, actions: [] },
        },
      } as unknown as McpApplyOrganizationInput;
      recordOrganizationMutationAttempt({
        db: client.db,
        workspaceId: "workspace",
        connectionId: "connection",
        actor: { id: "client", type: "agent" },
        operation: "apply",
        query,
        error: Object.assign(new Error("Bearer secret mail body must not persist"), { code: "revision_conflict" }),
        now: new Date(2_000),
        id: "new-attempt",
      });

      const workspaceRows = client.db.select().from(organizationMutationAttempts).all()
        .filter((row) => row.workspaceId === "workspace");
      assert.equal(workspaceRows.length, maximumMutationAttemptAuditRowsPerWorkspace);
      assert.equal(workspaceRows.some((row) => row.id === "old-0001"), false);
      const newest = workspaceRows.find((row) => row.id === "new-attempt");
      assert.ok(newest);
      assert.match(newest.commandDigest, /^sha256:[0-9a-f]{64}$/);
      assert.doesNotMatch(JSON.stringify(newest), /Bearer|secret|mail body/);
      assert.equal(client.db.select().from(organizationMutationAttempts).all()
        .filter((row) => row.workspaceId === "other-workspace").length, 1);
    } finally {
      client.sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
