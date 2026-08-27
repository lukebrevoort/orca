import { createHash } from "node:crypto";

import { and, desc, eq } from "drizzle-orm";
import {
  orcaThreadCorrectionRequestSchema,
  orcaThreadCorrectionResponseSchema,
  type OrcaThreadCorrectionResponse,
  type OrganizationActor,
  type OrganizationCapabilitySnapshot,
} from "@orca/shared";

import type { createDatabaseClient } from "../../db/client.ts";
import {
  emails,
  oauthAccounts,
  organizationChangeSets,
  organizationCorrectionReceipts,
  organizationThreadStates,
  organizationWorkspaceStates,
  threads,
} from "../../db/schema.ts";
import type { OrganizationAgentCapabilitySource } from "../agent-capability.ts";
import { canonicalOrganizationJson } from "../authority.ts";
import type { OrganizationSystemCapabilityAdapter } from "../system-capability.ts";
import { evaluateAndPersistLiveContext, loadLiveEvaluationInput } from "./evaluation-sqlite.ts";

type Database = ReturnType<typeof createDatabaseClient>["db"];
type CorrectionActor = { id: OrganizationActor["id"]; type: "human" } | { id: OrganizationActor["id"]; type: "agent" };
type HumanCorrectionActor = Extract<CorrectionActor, { type: "human" }>;

export class OrcaThreadCorrectionError extends Error {
  constructor(readonly code: "account_denied" | "thread_not_found" | "revision_conflict" | "capability_denied" | "idempotency_conflict" | "evaluation_exhausted", message: string) {
    super(message);
    this.name = "OrcaThreadCorrectionError";
  }
}

function digestCorrection(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalOrganizationJson(value)).digest("hex")}`;
}

function humanSnapshot(actor: HumanCorrectionActor, workspaceId: string, accountId: string): OrganizationCapabilitySnapshot {
  return {
    id: `first_party:correction:${actor.id}`,
    revision: 1,
    actor,
    scope: { workspaceId, accountIds: [accountId] },
    operations: ["apply"],
    resourceFamilies: ["mail", "thread", "lane", "collection", "facet", "context", "workflow_state", "trace", "change_set", "audit"],
    actionFamilies: ["organization_thread", "organization_attention"],
  };
}

export function humanCorrectionCapabilityAdapter(actor: HumanCorrectionActor, workspaceId: string, accountId: string): OrganizationSystemCapabilityAdapter {
  const snapshot = humanSnapshot(actor, workspaceId, accountId);
  return { snapshot: () => snapshot, live: () => ({ snapshot, revokedAt: null }) };
}

export function agentCorrectionCapabilityAdapter(input: {
  actor: OrganizationActor & { type: "agent" };
  workspaceId: string;
  accountId: string;
  source: OrganizationAgentCapabilitySource;
}): OrganizationSystemCapabilityAdapter {
  const scope = { actor: input.actor, workspaceId: input.workspaceId, accountIds: [input.accountId] };
  const load = (executor?: unknown) => {
    const live = input.source.load(scope, executor);
    if (!live || live.revokedAt !== null
      || !live.snapshot.operations.includes("apply")
      || !live.snapshot.resourceFamilies.includes("thread")
      || !live.snapshot.resourceFamilies.includes("trace")
      || !live.snapshot.actionFamilies.includes("organization_thread")) {
      throw new OrcaThreadCorrectionError("capability_denied", "The live Organization correction Capability is unavailable");
    }
    return live;
  };
  return {
    snapshot: () => load().snapshot,
    live: ({ executor }) => load(executor),
  };
}

export function correctOrganizationThread(db: Database, input: {
  actor: CorrectionActor;
  workspaceId: string;
  request: unknown;
  capabilityAdapter?: OrganizationSystemCapabilityAdapter;
  now?: Date;
}): OrcaThreadCorrectionResponse {
  const request = orcaThreadCorrectionRequestSchema.parse(input.request);
  const commandDigest = digestCorrection({ workspaceId: input.workspaceId, actor: input.actor, request });
  const receiptIdentity = { workspaceId: input.workspaceId, actor: input.actor, idempotencyKey: request.idempotencyKey };
  const receiptId = `correction:${digestCorrection(receiptIdentity).slice("sha256:".length)}`;
  const eventId = `user.corrected:${receiptId.slice("correction:".length)}`;
  const adapter = input.capabilityAdapter ?? (input.actor.type === "human"
    ? humanCorrectionCapabilityAdapter(input.actor, input.workspaceId, request.accountId)
    : null);
  if (!adapter) {
    throw new OrcaThreadCorrectionError("capability_denied", "Agent correction requires a live Organization Capability adapter");
  }

  return db.transaction((transaction) => {
    const executor = transaction as unknown as Database;
    const existing = executor.select().from(organizationCorrectionReceipts).where(and(
      eq(organizationCorrectionReceipts.workspaceId, input.workspaceId),
      eq(organizationCorrectionReceipts.actorType, input.actor.type),
      eq(organizationCorrectionReceipts.actorId, input.actor.id),
      eq(organizationCorrectionReceipts.idempotencyKey, request.idempotencyKey),
    )).get();
    if (existing) {
      if (existing.commandDigest !== commandDigest) {
        throw new OrcaThreadCorrectionError("idempotency_conflict", "This correction idempotency key is already bound to a different exact request");
      }
      if (input.actor.type === "agent") {
        adapter.live({ workspaceId: input.workspaceId, accountId: request.accountId, executor });
      }
      return orcaThreadCorrectionResponseSchema.parse(JSON.parse(existing.responseJson));
    }

    const account = executor.select({ id: oauthAccounts.id }).from(oauthAccounts).where(and(
      eq(oauthAccounts.id, request.accountId), eq(oauthAccounts.userId, input.workspaceId),
    )).get();
    if (!account) throw new OrcaThreadCorrectionError("account_denied", "The correction Account is outside this Workspace");
    const workspace = executor.select().from(organizationWorkspaceStates).where(eq(organizationWorkspaceStates.workspaceId, input.workspaceId)).get();
    const workspaceRevision = workspace?.revision ?? 1;
    if (workspaceRevision !== request.expectedWorkspaceRevision) {
      throw new OrcaThreadCorrectionError("revision_conflict", `Expected Workspace revision ${request.expectedWorkspaceRevision}, found ${workspaceRevision}`);
    }
    const thread = executor.select({ id: threads.id }).from(threads).where(and(eq(threads.accountId, request.accountId), eq(threads.id, request.threadId))).get();
    if (!thread) throw new OrcaThreadCorrectionError("thread_not_found", "The corrected Thread is unavailable in this Account");
    const threadState = executor.select().from(organizationThreadStates).where(and(
      eq(organizationThreadStates.workspaceId, input.workspaceId), eq(organizationThreadStates.accountId, request.accountId), eq(organizationThreadStates.threadId, request.threadId),
    )).get();
    if ((threadState?.revision ?? null) !== request.expectedThreadRevision) {
      throw new OrcaThreadCorrectionError("revision_conflict", `Expected Thread revision ${request.expectedThreadRevision ?? "none"}, found ${threadState?.revision ?? "none"}`);
    }
    const message = executor.select({ id: emails.id }).from(emails).where(and(eq(emails.accountId, request.accountId), eq(emails.threadId, request.threadId)))
      .orderBy(desc(emails.receivedAt), desc(emails.id)).get();
    if (!message) throw new OrcaThreadCorrectionError("thread_not_found", "The corrected Thread has no evaluable message");

    const context = loadLiveEvaluationInput(executor, { accountId: request.accountId, messageId: message.id, eventKind: "user.corrected" }, adapter);
    if (!context) throw new OrcaThreadCorrectionError("thread_not_found", "The corrected Thread could not be loaded for evaluation");
    const occurredAt = (input.now ?? new Date()).toISOString();
    context.event = {
      id: eventId, kind: "user.corrected", cause: "user", occurredAt,
      workspaceId: input.workspaceId, accountId: request.accountId, threadId: request.threadId,
    };
    context.actor = input.actor;
    context.capabilities = adapter.snapshot({ workspaceId: input.workspaceId, accountId: request.accountId });
    context.logicalTime = occurredAt;
    let response: OrcaThreadCorrectionResponse | null = null;
    const trace = evaluateAndPersistLiveContext(executor, context, adapter, { alreadyInTransaction: true, onPersist: (receiptExecutor, persistedTrace) => {
      const changeSet = receiptExecutor.select({ id: organizationChangeSets.id }).from(organizationChangeSets).where(and(
        eq(organizationChangeSets.workspaceId, input.workspaceId), eq(organizationChangeSets.id, persistedTrace.id),
      )).get();
      response = orcaThreadCorrectionResponseSchema.parse({
        eventId, eventKind: "user.corrected", workspaceId: input.workspaceId,
        accountId: request.accountId, threadId: request.threadId, actor: input.actor,
        reason: request.reason, trace: persistedTrace, changeSetId: changeSet?.id ?? null,
      });
      receiptExecutor.insert(organizationCorrectionReceipts).values({
        id: receiptId, workspaceId: input.workspaceId, actorType: input.actor.type, actorId: input.actor.id,
        idempotencyKey: request.idempotencyKey, commandDigest, responseJson: JSON.stringify(response), createdAt: new Date(occurredAt),
      }).run();
    } });
    if (trace.budget.exhausted || response === null) {
      throw new OrcaThreadCorrectionError("evaluation_exhausted", "The correction evaluator exhausted its bounded budget and persisted nothing");
    }
    return response;
  });
}
