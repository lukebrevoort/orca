import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, notInArray } from "drizzle-orm";

import type { McpApplyOrganizationInput, McpRevertOrganizationInput, OrganizationActor } from "@orca/shared";

import type { createDatabaseClient } from "../db/client.ts";
import { mcpConnections, organizationMutationAttempts } from "../db/schema.ts";
import { canonicalOrganizationJson } from "./authority.ts";

type Database = ReturnType<typeof createDatabaseClient>["db"];

export const maximumMutationAttemptAuditRowsPerWorkspace = 1_000;

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalOrganizationJson(value)).digest("hex")}`;
}

export function stableMutationFailureCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    const normalized = error.code.replace(/[^a-z0-9_]/gi, "_").slice(0, 64);
    return normalized || "mutation_failed";
  }
  if (error instanceof Error && error.name === "ZodError") return "invalid_request";
  if (error instanceof Error && /SQLITE_BUSY|database is locked/i.test(error.message)) return "revision_conflict";
  return "mutation_failed";
}

function outcomeFor(reasonCode: string): "denied" | "failed" {
  return /denied|capability|scope|actor|account|workspace|approval|simulation/.test(reasonCode) ? "denied" : "failed";
}

export function recordOrganizationMutationAttempt(input: {
  db: Database;
  workspaceId: string;
  connectionId: string;
  actor: OrganizationActor & { type: "agent" };
  operation: "apply" | "revert";
  query: McpApplyOrganizationInput | McpRevertOrganizationInput;
  error: unknown;
  now?: Date;
  id?: string;
  afterRetainedSelectionForTest?: () => void;
}): void {
  const request = "target" in input.query ? input.query.target.request : input.query.request;
  const reasonCode = stableMutationFailureCode(input.error);
  input.db.transaction((tx) => {
    const ownedConnection = tx.select({ id: mcpConnections.id }).from(mcpConnections).where(and(
      eq(mcpConnections.id, input.connectionId),
      eq(mcpConnections.userId, input.workspaceId),
    )).get();
    tx.insert(organizationMutationAttempts).values({
      id: input.id ?? randomUUID(),
      workspaceId: input.workspaceId,
      connectionId: ownedConnection?.id ?? null,
      actorType: input.actor.type,
      actorId: input.actor.id.slice(0, 500),
      operation: input.operation,
      idempotencyKey: request.idempotencyKey,
      commandDigest: digest({ operation: input.operation, query: input.query }),
      accountCount: input.query.accountIds.length,
      accountIdsDigest: digest([...input.query.accountIds].sort()),
      outcome: outcomeFor(reasonCode),
      reasonCode,
      createdAt: input.now ?? new Date(),
    }).onConflictDoNothing().run();

    const retained = tx.select({ id: organizationMutationAttempts.id })
      .from(organizationMutationAttempts)
      .where(eq(organizationMutationAttempts.workspaceId, input.workspaceId))
      .orderBy(desc(organizationMutationAttempts.createdAt), desc(organizationMutationAttempts.id))
      .limit(maximumMutationAttemptAuditRowsPerWorkspace)
      .all().map(({ id }) => id);
    input.afterRetainedSelectionForTest?.();
    if (retained.length === maximumMutationAttemptAuditRowsPerWorkspace) {
      tx.delete(organizationMutationAttempts).where(and(
        eq(organizationMutationAttempts.workspaceId, input.workspaceId),
        notInArray(organizationMutationAttempts.id, retained),
      )).run();
    }
  }, { behavior: "immediate" });
}
