import { createHash } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  organizationContextChangeSummarySchema,
  organizationContextQueryResponseSchema,
  type OrganizationAuthorityTrace,
  type OrganizationCommand,
  type OrganizationContextActionKind,
  type OrganizationContextApplyRequest,
  type OrganizationContextChangeSummary,
  type OrganizationContextRevertRequest,
  type OrganizationExecutionContext,
} from "@orca/shared";

import type { createDatabaseClient } from "../../db/client.ts";
import {
  oauthAccounts,
  organizationChangeActions,
  organizationChangeSets,
  organizationContextRelationshipTypes,
  organizationContexts,
  organizationContextTypes,
  organizationThreadContextRelationships,
  organizationThreadStates,
  organizationWorkspaceStates,
  threads,
} from "../../db/schema.ts";
import { digestOrganizationCommand, canonicalOrganizationJson } from "../authority.ts";
import { OrganizationAuthorityError, OrganizationRevisionConflictError } from "../module.ts";
import {
  OrganizationContextsAccessError,
  OrganizationContextsConflictError,
  OrganizationContextsNotFoundError,
  applyOrganizationContextActions,
  digestOrganizationContextActions,
  organizationContextResourceRevisions,
  type OrganizationContextAllocatedIds,
  type OrganizationContextSnapshot,
  type OrganizationContextsRepository,
} from "./module.ts";

type Database = ReturnType<typeof createDatabaseClient>["db"];

function iso(value: Date | null): string | null { return value?.toISOString() ?? null; }

function loadSnapshot(db: Database, workspaceId: string): OrganizationContextSnapshot {
  const accountIds = db.select({ id: oauthAccounts.id }).from(oauthAccounts)
    .where(eq(oauthAccounts.userId, workspaceId)).orderBy(asc(oauthAccounts.createdAt), asc(oauthAccounts.id)).all().map((row) => row.id);
  const state = db.select().from(organizationWorkspaceStates).where(eq(organizationWorkspaceStates.workspaceId, workspaceId)).get();
  const contextTypes = db.select().from(organizationContextTypes).where(eq(organizationContextTypes.workspaceId, workspaceId))
    .orderBy(asc(organizationContextTypes.position), asc(organizationContextTypes.id)).all().map((row) => ({
      id: row.id, name: row.name, position: row.position, retiredAt: iso(row.retiredAt), revision: row.revision,
      createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    }));
  const relationshipTypes = db.select().from(organizationContextRelationshipTypes).where(eq(organizationContextRelationshipTypes.workspaceId, workspaceId))
    .orderBy(asc(organizationContextRelationshipTypes.position), asc(organizationContextRelationshipTypes.id)).all().map((row) => ({
      id: row.id, contextTypeId: row.contextTypeId, name: row.name, inverseName: row.inverseName,
      direction: row.direction, position: row.position, maximumPerThread: row.maximumPerThread, retiredAt: iso(row.retiredAt), revision: row.revision,
      createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    }));
  const contexts = db.select().from(organizationContexts).where(eq(organizationContexts.workspaceId, workspaceId))
    .orderBy(asc(organizationContexts.name), asc(organizationContexts.id)).all().map((row) => ({
      id: row.id, contextTypeId: row.contextTypeId, name: row.name, retiredAt: iso(row.retiredAt), revision: row.revision,
      createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    }));
  const relationships = db.select().from(organizationThreadContextRelationships).where(eq(organizationThreadContextRelationships.workspaceId, workspaceId))
    .orderBy(asc(organizationThreadContextRelationships.relationshipTypeId), asc(organizationThreadContextRelationships.contextId), asc(organizationThreadContextRelationships.id)).all().map((row) => ({
      id: row.id, accountId: row.accountId, threadId: row.threadId, contextTypeId: row.contextTypeId, contextId: row.contextId,
      relationshipTypeId: row.relationshipTypeId, direction: row.direction, revision: row.revision,
      createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    }));
  const threadRevisions = db.select().from(organizationThreadStates).where(eq(organizationThreadStates.workspaceId, workspaceId))
    .orderBy(asc(organizationThreadStates.accountId), asc(organizationThreadStates.threadId)).all().map((row) => ({ accountId: row.accountId, threadId: row.threadId, revision: row.revision }));
  const threadInventory = accountIds.length === 0 ? [] : db.select({ accountId: threads.accountId, threadId: threads.id }).from(threads)
    .where(inArray(threads.accountId, accountIds)).orderBy(asc(threads.accountId), asc(threads.id)).all();
  const parsed = organizationContextQueryResponseSchema.parse({ workspaceId, accountIds, workspaceRevision: state?.revision ?? 1, contextTypes, relationshipTypes, contexts, relationships, threadRevisions });
  return { ...parsed, threads: threadInventory };
}

function snapshotState(snapshot: OrganizationContextSnapshot) {
  return {
    contextTypes: snapshot.contextTypes,
    relationshipTypes: snapshot.relationshipTypes,
    contexts: snapshot.contexts,
    relationships: snapshot.relationships,
    threadRevisions: snapshot.threadRevisions,
  };
}

function snapshotStateDigest(snapshot: OrganizationContextSnapshot) {
  return canonicalOrganizationJson(snapshotState(snapshot));
}

function parseTrace(value: string): OrganizationAuthorityTrace {
  return JSON.parse(value) as OrganizationAuthorityTrace;
}

function parseCommandJson(value: string): { request?: OrganizationContextApplyRequest; allocatedIds?: OrganizationContextAllocatedIds; revert?: OrganizationContextRevertRequest } {
  return JSON.parse(value) as { request?: OrganizationContextApplyRequest; allocatedIds?: OrganizationContextAllocatedIds; revert?: OrganizationContextRevertRequest };
}

function summary(db: Database, row: typeof organizationChangeSets.$inferSelect): OrganizationContextChangeSummary {
  const command = parseCommandJson(row.commandJson);
  let actionKinds: OrganizationContextActionKind[] = command.request?.actions.map((action) => action.kind) ?? [];
  if (actionKinds.length === 0 && row.revertsChangeId) {
    const original = db.select().from(organizationChangeSets).where(and(eq(organizationChangeSets.workspaceId, row.workspaceId), eq(organizationChangeSets.id, row.revertsChangeId))).get();
    actionKinds = original ? (parseCommandJson(original.commandJson).request?.actions.map((action) => action.kind) ?? []) : [];
  }
  const reverted = db.select({ id: organizationChangeSets.id }).from(organizationChangeSets)
    .where(and(eq(organizationChangeSets.workspaceId, row.workspaceId), eq(organizationChangeSets.revertsChangeId, row.id))).get();
  return organizationContextChangeSummarySchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    actor: parseTrace(row.authorityTrace).actor,
    operation: row.operation,
    actionKinds,
    reason: row.operation === "revert" ? `Reverted Context change ${row.revertsChangeId}` : `Applied ${actionKinds.length} typed Context action${actionKinds.length === 1 ? "" : "s"}`,
    revertsChangeId: row.revertsChangeId,
    revertedByChangeId: reverted?.id ?? null,
    workspaceRevisionBefore: row.workspaceRevisionBefore,
    workspaceRevisionAfter: row.workspaceRevisionAfter,
    createdAt: row.createdAt.toISOString(),
  });
}

function assertBoundCommand(input: {
  command: OrganizationCommand;
  executionContext: OrganizationExecutionContext;
  actions?: readonly OrganizationContextApplyRequest["actions"][number][];
  allocatedIds?: OrganizationContextAllocatedIds;
}) {
  if (input.executionContext.command.digest !== digestOrganizationCommand(input.command)) {
    throw new OrganizationAuthorityError("invalid_request", "The authorized command digest does not match the Context execution payload");
  }
  if (input.actions) {
    const typedDigest = digestOrganizationContextActions(input.actions);
    const expectedAllocated = input.command.intents[0]?.changes?.allocatedIdsDigest;
    const actualAllocated = `sha256:${createHash("sha256").update(canonicalOrganizationJson(input.allocatedIds ?? [])).digest("hex")}`;
    if (input.command.intents.some((intent) => intent.changes?.typedActionsDigest !== typedDigest || intent.changes?.allocatedIdsDigest !== expectedAllocated || intent.changes?.actionCount !== input.actions!.length) || expectedAllocated !== actualAllocated) {
      throw new OrganizationAuthorityError("invalid_request", "The authorized command does not match the exact ordered typed Context actions and server identities");
    }
  }
}

function assertLiveResources(current: OrganizationContextSnapshot, executionContext: OrganizationExecutionContext, command: OrganizationCommand) {
  const live = organizationContextResourceRevisions(current);
  for (const intent of command.intents) {
    if (intent.mutation === "create" && live[intent.resourceId] !== undefined) throw new OrganizationAuthorityError("revision_conflict", `Create target ${intent.resourceId} now exists`);
    if (intent.mutation === "update" && live[intent.resourceId] !== executionContext.expectedRevisions.resources[intent.resourceId]) throw new OrganizationAuthorityError("revision_conflict", `Update target ${intent.resourceId} changed before commit`);
  }
}

function reserveChange(db: Database, input: {
  workspaceId: string;
  changeId: string;
  idempotencyKey: string;
  commandDigest: string;
  authorityTrace: OrganizationAuthorityTrace;
  operation: "apply" | "revert";
  commandJson: unknown;
  revertsChangeId: string | null;
  workspaceRevisionBefore: number;
  workspaceRevisionAfter: number;
  before: OrganizationContextSnapshot;
  after: OrganizationContextSnapshot;
  now: Date;
  actionKind: string;
}) {
  db.insert(organizationChangeSets).values({
    workspaceId: input.workspaceId, id: input.changeId, idempotencyKey: input.idempotencyKey,
    commandDigest: input.commandDigest, authorityTrace: JSON.stringify(input.authorityTrace), resourceFamily: "context",
    operation: input.operation, commandJson: JSON.stringify(input.commandJson), revertsChangeId: input.revertsChangeId,
    workspaceRevisionBefore: input.workspaceRevisionBefore, workspaceRevisionAfter: input.workspaceRevisionAfter, createdAt: input.now,
  }).run();
  db.insert(organizationChangeActions).values({
    workspaceId: input.workspaceId, changeId: input.changeId, position: 0, actionKind: input.actionKind,
    resourceFamily: "context", resourceId: `context_snapshot:${input.workspaceId}`,
    beforeJson: JSON.stringify(input.before), afterJson: JSON.stringify(input.after),
  }).run();
}

function writeSnapshot(db: Database, workspaceId: string, current: OrganizationContextSnapshot, next: OrganizationContextSnapshot, now: Date) {
  const currentTypes = new Map(current.contextTypes.map((item) => [item.id, item]));
  for (const item of next.contextTypes) {
    if (!currentTypes.has(item.id)) db.insert(organizationContextTypes).values({ workspaceId, id: item.id, name: item.name, position: item.position, retiredAt: item.retiredAt ? new Date(item.retiredAt) : null, revision: item.revision, createdAt: new Date(item.createdAt), updatedAt: new Date(item.updatedAt) }).run();
    else db.update(organizationContextTypes).set({ name: item.name, position: item.position, retiredAt: item.retiredAt ? new Date(item.retiredAt) : null, revision: item.revision, updatedAt: new Date(item.updatedAt) }).where(and(eq(organizationContextTypes.workspaceId, workspaceId), eq(organizationContextTypes.id, item.id))).run();
  }
  for (const item of current.contextTypes) if (!next.contextTypes.some((candidate) => candidate.id === item.id)) db.delete(organizationContextTypes).where(and(eq(organizationContextTypes.workspaceId, workspaceId), eq(organizationContextTypes.id, item.id))).run();

  const currentRelationshipTypes = new Set(current.relationshipTypes.map((item) => item.id));
  for (const item of next.relationshipTypes) {
    const values = { workspaceId, id: item.id, contextTypeId: item.contextTypeId, name: item.name, inverseName: item.inverseName, direction: item.direction, position: item.position, maximumPerThread: item.maximumPerThread, retiredAt: item.retiredAt ? new Date(item.retiredAt) : null, revision: item.revision, createdAt: new Date(item.createdAt), updatedAt: new Date(item.updatedAt) };
    if (!currentRelationshipTypes.has(item.id)) db.insert(organizationContextRelationshipTypes).values(values).run();
    else db.update(organizationContextRelationshipTypes).set({ contextTypeId: item.contextTypeId, name: item.name, inverseName: item.inverseName, direction: item.direction, position: item.position, maximumPerThread: item.maximumPerThread, retiredAt: item.retiredAt ? new Date(item.retiredAt) : null, revision: item.revision, updatedAt: new Date(item.updatedAt) }).where(and(eq(organizationContextRelationshipTypes.workspaceId, workspaceId), eq(organizationContextRelationshipTypes.id, item.id))).run();
  }
  for (const item of current.relationshipTypes) if (!next.relationshipTypes.some((candidate) => candidate.id === item.id)) db.delete(organizationContextRelationshipTypes).where(and(eq(organizationContextRelationshipTypes.workspaceId, workspaceId), eq(organizationContextRelationshipTypes.id, item.id))).run();

  const currentContexts = new Set(current.contexts.map((item) => item.id));
  for (const item of next.contexts) {
    const values = { workspaceId, id: item.id, contextTypeId: item.contextTypeId, name: item.name, retiredAt: item.retiredAt ? new Date(item.retiredAt) : null, revision: item.revision, createdAt: new Date(item.createdAt), updatedAt: new Date(item.updatedAt) };
    if (!currentContexts.has(item.id)) db.insert(organizationContexts).values(values).run();
    else db.update(organizationContexts).set({ contextTypeId: item.contextTypeId, name: item.name, retiredAt: item.retiredAt ? new Date(item.retiredAt) : null, revision: item.revision, updatedAt: new Date(item.updatedAt) }).where(and(eq(organizationContexts.workspaceId, workspaceId), eq(organizationContexts.id, item.id))).run();
  }
  for (const item of current.contexts) if (!next.contexts.some((candidate) => candidate.id === item.id)) db.delete(organizationContexts).where(and(eq(organizationContexts.workspaceId, workspaceId), eq(organizationContexts.id, item.id))).run();

  const currentRelationships = new Set(current.relationships.map((item) => item.id));
  for (const item of next.relationships) {
    const values = { workspaceId, id: item.id, accountId: item.accountId, threadId: item.threadId, contextTypeId: item.contextTypeId, contextId: item.contextId, relationshipTypeId: item.relationshipTypeId, direction: item.direction, revision: item.revision, createdAt: new Date(item.createdAt), updatedAt: new Date(item.updatedAt) };
    if (!currentRelationships.has(item.id)) db.insert(organizationThreadContextRelationships).values(values).run();
    else db.update(organizationThreadContextRelationships).set({ accountId: item.accountId, threadId: item.threadId, contextTypeId: item.contextTypeId, contextId: item.contextId, relationshipTypeId: item.relationshipTypeId, direction: item.direction, revision: item.revision, updatedAt: new Date(item.updatedAt) }).where(and(eq(organizationThreadContextRelationships.workspaceId, workspaceId), eq(organizationThreadContextRelationships.id, item.id))).run();
  }
  for (const item of current.relationships) if (!next.relationships.some((candidate) => candidate.id === item.id)) db.delete(organizationThreadContextRelationships).where(and(eq(organizationThreadContextRelationships.workspaceId, workspaceId), eq(organizationThreadContextRelationships.id, item.id))).run();

  const nextThreadKeys = new Set(next.threadRevisions.map((item) => `${item.accountId}\0${item.threadId}`));
  for (const item of next.threadRevisions) db.insert(organizationThreadStates).values({ workspaceId, accountId: item.accountId, threadId: item.threadId, revision: item.revision, updatedAt: now }).onConflictDoUpdate({ target: [organizationThreadStates.workspaceId, organizationThreadStates.accountId, organizationThreadStates.threadId], set: { revision: item.revision, updatedAt: now } }).run();
  for (const item of current.threadRevisions) if (!nextThreadKeys.has(`${item.accountId}\0${item.threadId}`)) db.delete(organizationThreadStates).where(and(eq(organizationThreadStates.workspaceId, workspaceId), eq(organizationThreadStates.accountId, item.accountId), eq(organizationThreadStates.threadId, item.threadId))).run();
}

function compensation(before: OrganizationContextSnapshot, current: OrganizationContextSnapshot, now: string): OrganizationContextSnapshot {
  const next = structuredClone(before);
  next.workspaceRevision = current.workspaceRevision + 1;
  next.threads = current.threads;
  const advance = <T extends { id: string; revision: number; updatedAt: string }>(items: T[], liveItems: readonly T[]) => {
    for (const item of items) {
      const live = liveItems.find((candidate) => candidate.id === item.id);
      item.revision = (live?.revision ?? item.revision) + 1;
      item.updatedAt = now;
    }
  };
  advance(next.contextTypes, current.contextTypes);
  advance(next.relationshipTypes, current.relationshipTypes);
  advance(next.contexts, current.contexts);
  advance(next.relationships, current.relationships);
  for (const thread of next.threadRevisions) {
    const live = current.threadRevisions.find((candidate) => candidate.accountId === thread.accountId && candidate.threadId === thread.threadId);
    thread.revision = (live?.revision ?? thread.revision) + 1;
  }
  for (const live of current.threadRevisions) if (!next.threadRevisions.some((thread) => thread.accountId === live.accountId && thread.threadId === live.threadId)) next.threadRevisions.push({ ...live, revision: live.revision + 1 });
  return next;
}

export function createSqliteOrganizationContextsRepository(db: Database): OrganizationContextsRepository {
  return {
    listAccountIds(workspaceId) {
      return db.select({ id: oauthAccounts.id }).from(oauthAccounts).where(eq(oauthAccounts.userId, workspaceId)).orderBy(asc(oauthAccounts.createdAt), asc(oauthAccounts.id)).all().map((row) => row.id);
    },
    getSnapshot(workspaceId) { return loadSnapshot(db, workspaceId); },
    getAuthorityState(workspaceId) {
      const snapshot = loadSnapshot(db, workspaceId);
      return { workspaceRevision: snapshot.workspaceRevision, resourceRevisions: organizationContextResourceRevisions(snapshot), reservedIdempotencyKeys: db.select({ key: organizationChangeSets.idempotencyKey }).from(organizationChangeSets).where(eq(organizationChangeSets.workspaceId, workspaceId)).all().map((row) => row.key) };
    },
    getIdempotentChange(workspaceId, idempotencyKey) {
      const row = db.select().from(organizationChangeSets).where(and(eq(organizationChangeSets.workspaceId, workspaceId), eq(organizationChangeSets.idempotencyKey, idempotencyKey))).get();
      if (!row || row.resourceFamily !== "context") return null;
      const command = parseCommandJson(row.commandJson);
      const request = command.request ?? (command.revert ? { revert: command.revert } : null);
      return request ? { request, change: summary(db, row) } : null;
    },
    apply(input) {
      return db.transaction((transaction) => {
        const executor = transaction as unknown as Database;
        transaction.insert(organizationWorkspaceStates).values({ workspaceId: input.scope.workspaceId }).onConflictDoNothing().run();
        const current = loadSnapshot(executor, input.scope.workspaceId);
        if (current.workspaceRevision !== input.request.expectedWorkspaceRevision) throw new OrganizationRevisionConflictError(input.request.expectedWorkspaceRevision, current.workspaceRevision);
        assertBoundCommand({ command: input.authorization.command, executionContext: input.authorization.executionContext, actions: input.request.actions, allocatedIds: input.allocatedIds });
        assertLiveResources(current, input.authorization.executionContext, input.authorization.command);
        if (transaction.select({ id: organizationChangeSets.id }).from(organizationChangeSets).where(and(eq(organizationChangeSets.workspaceId, input.scope.workspaceId), eq(organizationChangeSets.idempotencyKey, input.request.idempotencyKey))).get()) throw new OrganizationContextsConflictError("The idempotency key is already reserved");
        const next = applyOrganizationContextActions({ snapshot: current, actions: input.request.actions, allocatedIds: input.allocatedIds, authorizedAccountIds: input.authorization.executionContext.accountIds, now: input.now.toISOString() });
        writeSnapshot(executor, input.scope.workspaceId, current, next, input.now);
        reserveChange(executor, { workspaceId: input.scope.workspaceId, changeId: input.changeId, idempotencyKey: input.request.idempotencyKey, commandDigest: input.authorization.executionContext.command.digest, authorityTrace: input.authorization.trace, operation: "apply", commandJson: { request: input.request, allocatedIds: input.allocatedIds }, revertsChangeId: null, workspaceRevisionBefore: current.workspaceRevision, workspaceRevisionAfter: next.workspaceRevision, before: current, after: next, now: input.now, actionKind: "context_change_set" });
        const updated = transaction.update(organizationWorkspaceStates).set({ revision: next.workspaceRevision, updatedAt: input.now }).where(and(eq(organizationWorkspaceStates.workspaceId, input.scope.workspaceId), eq(organizationWorkspaceStates.revision, current.workspaceRevision))).returning({ id: organizationWorkspaceStates.workspaceId }).get();
        if (!updated) throw new OrganizationRevisionConflictError(current.workspaceRevision, current.workspaceRevision + 1);
        return { snapshot: next, change: summary(executor, transaction.select().from(organizationChangeSets).where(and(eq(organizationChangeSets.workspaceId, input.scope.workspaceId), eq(organizationChangeSets.id, input.changeId))).get()!) };
      });
    },
    revert(input) {
      return db.transaction((transaction) => {
        const executor = transaction as unknown as Database;
        const original = transaction.select().from(organizationChangeSets).where(and(eq(organizationChangeSets.workspaceId, input.scope.workspaceId), eq(organizationChangeSets.id, input.request.changeId), eq(organizationChangeSets.resourceFamily, "context"))).get();
        if (!original) throw new OrganizationContextsNotFoundError("Context change was not found in this Workspace");
        if (transaction.select({ id: organizationChangeSets.id }).from(organizationChangeSets).where(and(eq(organizationChangeSets.workspaceId, input.scope.workspaceId), eq(organizationChangeSets.revertsChangeId, original.id))).get()) throw new OrganizationContextsConflictError("Context change was already reverted");
        const evidence = transaction.select().from(organizationChangeActions).where(and(eq(organizationChangeActions.workspaceId, input.scope.workspaceId), eq(organizationChangeActions.changeId, original.id), eq(organizationChangeActions.position, 0))).get();
        if (!evidence?.beforeJson || !evidence.afterJson) throw new OrganizationContextsConflictError("Context change does not contain compensating evidence");
        const current = loadSnapshot(executor, input.scope.workspaceId);
        if (current.workspaceRevision !== input.request.expectedWorkspaceRevision) throw new OrganizationRevisionConflictError(input.request.expectedWorkspaceRevision, current.workspaceRevision);
        const after = JSON.parse(evidence.afterJson) as OrganizationContextSnapshot;
        if (snapshotStateDigest(current) !== snapshotStateDigest(after)) throw new OrganizationContextsConflictError("Context state changed after the requested change; refresh before reverting");
        const originalScope = parseTrace(original.authorityTrace).scope.accountIds;
        if (originalScope.some((accountId) => !input.authorization.executionContext.accountIds.includes(accountId))) throw new OrganizationContextsAccessError();
        assertBoundCommand({ command: input.authorization.command, executionContext: input.authorization.executionContext });
        if (transaction.select({ id: organizationChangeSets.id }).from(organizationChangeSets).where(and(eq(organizationChangeSets.workspaceId, input.scope.workspaceId), eq(organizationChangeSets.idempotencyKey, input.request.idempotencyKey))).get()) throw new OrganizationContextsConflictError("The idempotency key is already reserved");
        const before = JSON.parse(evidence.beforeJson) as OrganizationContextSnapshot;
        const next = compensation(before, current, input.now.toISOString());
        writeSnapshot(executor, input.scope.workspaceId, current, next, input.now);
        reserveChange(executor, { workspaceId: input.scope.workspaceId, changeId: input.changeId, idempotencyKey: input.request.idempotencyKey, commandDigest: input.authorization.executionContext.command.digest, authorityTrace: input.authorization.trace, operation: "revert", commandJson: { revert: input.request }, revertsChangeId: original.id, workspaceRevisionBefore: current.workspaceRevision, workspaceRevisionAfter: next.workspaceRevision, before: current, after: next, now: input.now, actionKind: "context_revert" });
        const updated = transaction.update(organizationWorkspaceStates).set({ revision: next.workspaceRevision, updatedAt: input.now }).where(and(eq(organizationWorkspaceStates.workspaceId, input.scope.workspaceId), eq(organizationWorkspaceStates.revision, current.workspaceRevision))).returning({ id: organizationWorkspaceStates.workspaceId }).get();
        if (!updated) throw new OrganizationRevisionConflictError(current.workspaceRevision, current.workspaceRevision + 1);
        return { snapshot: next, change: summary(executor, transaction.select().from(organizationChangeSets).where(and(eq(organizationChangeSets.workspaceId, input.scope.workspaceId), eq(organizationChangeSets.id, input.changeId))).get()!) };
      });
    },
    audit(workspaceId) {
      return db.select().from(organizationChangeSets).where(and(eq(organizationChangeSets.workspaceId, workspaceId), eq(organizationChangeSets.resourceFamily, "context"))).orderBy(asc(organizationChangeSets.createdAt), asc(organizationChangeSets.id)).all().map((row) => summary(db, row));
    },
  };
}
