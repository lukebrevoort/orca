import { and, asc, eq, inArray } from "drizzle-orm";

import {
  organizationCollectionPinAuditEntrySchema,
  organizationCollectionPinChangeSchema,
  organizationPinTargetSchema,
  organizationSavedQueryDefinitionSchema,
  pinFilterSchema,
  type OrganizationCollection,
  type OrganizationCollectionPinAuditEntry,
  type OrganizationCollectionPinChange,
  type OrganizationPin,
  type OrganizationSavedQueryDefinition,
} from "@orca/shared";

import { createDatabaseClient } from "../../db/client.ts";
import {
  collectionThreads,
  collections,
  oauthAccounts,
  organizationCollectionPinAudits,
  organizationSavedQueries,
  pins,
  threads,
} from "../../db/schema.ts";
import {
  OrganizationCollectionsPinsAccessError,
  OrganizationCollectionsPinsConflictError,
  OrganizationCollectionsPinsNotFoundError,
  type OrganizationCollectionsPinsRepository,
} from "./module.ts";

type Database = ReturnType<typeof createDatabaseClient>["db"];
type CollectionRecord = typeof collections.$inferSelect;
type PinRecord = typeof pins.$inferSelect;
type QueryRecord = typeof organizationSavedQueries.$inferSelect;
type AuditRecord = typeof organizationCollectionPinAudits.$inferSelect;

function parseJson(value: string | null): unknown {
  return value === null ? null : JSON.parse(value);
}

function mapAudit(record: AuditRecord, revertedByChangeId: string | null = null): OrganizationCollectionPinAuditEntry {
  return organizationCollectionPinAuditEntrySchema.parse({
    id: record.id,
    workspaceId: record.workspaceId,
    accountId: record.accountId,
    actor: { id: record.actorId, type: record.actorType },
    operation: record.operation,
    changeKind: record.changeKind,
    resourceId: record.resourceId,
    before: parseJson(record.beforeJson),
    after: parseJson(record.afterJson),
    reason: record.reason,
    revertsChangeId: record.revertsChangeId,
    revertedByChangeId,
    createdAt: record.createdAt.toISOString(),
  });
}

function legacyQueryDefinition(raw: unknown): OrganizationSavedQueryDefinition {
  const current = organizationSavedQueryDefinitionSchema.safeParse(raw);
  if (current.success) return current.data;
  const legacy = pinFilterSchema.safeParse(raw);
  if (!legacy.success) return { revision: 1, filters: {} };
  const attention = legacy.data.attention === "notify" || legacy.data.attention === "focus"
    ? "focus" as const
    : legacy.data.attention === "normal"
      ? "normal" as const
      : legacy.data.mailbox === "focus"
        ? "focus" as const
        : legacy.data.mailbox === "quiet" || legacy.data.mailbox === "hidden" || legacy.data.mailbox === "all"
        ? legacy.data.mailbox
        : undefined;
  return {
    revision: 1,
    filters: {
      ...(attention ? { attention } : {}),
      ...(legacy.data.classification ? { classification: legacy.data.classification } : {}),
      ...(legacy.data.person ? { sender: legacy.data.person } : {}),
      ...(legacy.data.query ? { text: legacy.data.query } : {}),
    },
  };
}

function mapQuery(record: QueryRecord) {
  return {
    id: record.id,
    accountId: record.accountId,
    name: record.name,
    definition: legacyQueryDefinition(JSON.parse(record.definitionJson)),
    revision: record.revision,
  };
}

function mapPin(record: PinRecord): OrganizationPin {
  const target = organizationPinTargetSchema.parse(record.targetType === "query" || record.savedQueryId
    ? { type: "query" as const, queryId: record.savedQueryId ?? record.targetId }
    : {
      type: "resource" as const,
      resource: {
        family: (record.resourceFamily ?? record.kind) as "thread" | "view" | "collection" | "sender",
        id: record.targetId,
      },
    });
  return {
    id: record.id,
    accountId: record.accountId,
    label: record.label,
    icon: record.icon as OrganizationPin["icon"],
    color: record.color,
    position: record.position,
    target,
    revision: record.revision,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function listCollections(executor: Database, accountIds: string[]): OrganizationCollection[] {
  if (accountIds.length === 0) return [];
  const records = executor.select().from(collections)
    .where(inArray(collections.accountId, accountIds))
    .orderBy(asc(collections.accountId), asc(collections.position), asc(collections.id)).all();
  const ids = records.map((record) => record.id);
  const memberships = ids.length === 0 ? [] : executor.select().from(collectionThreads)
    .where(inArray(collectionThreads.collectionId, ids))
    .orderBy(asc(collectionThreads.createdAt), asc(collectionThreads.id)).all();
  const threadIds = new Map<string, string[]>();
  for (const membership of memberships) {
    const values = threadIds.get(membership.collectionId) ?? [];
    values.push(membership.threadId);
    threadIds.set(membership.collectionId, values);
  }
  return records.map((record) => ({
    id: record.id,
    accountId: record.accountId,
    name: record.name,
    color: record.color,
    position: record.position,
    threadIds: threadIds.get(record.id) ?? [],
    revision: record.revision,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }));
}

function requireCollection(executor: Database, accountId: string, collectionId: string) {
  const record = executor.select().from(collections)
    .where(and(eq(collections.accountId, accountId), eq(collections.id, collectionId))).get();
  if (!record) throw new OrganizationCollectionsPinsNotFoundError("Collection not found in the requested Account");
  return record;
}

function requireThread(executor: Database, accountId: string, threadId: string) {
  const record = executor.select().from(threads)
    .where(and(eq(threads.accountId, accountId), eq(threads.id, threadId))).get();
  if (!record) throw new OrganizationCollectionsPinsAccessError("Thread and Collection must belong to the same authorized Account");
  return record;
}

function requirePin(executor: Database, accountId: string, pinId: string) {
  const record = executor.select().from(pins)
    .where(and(eq(pins.accountId, accountId), eq(pins.id, pinId))).get();
  if (!record) throw new OrganizationCollectionsPinsNotFoundError("Pin not found in the requested Account");
  return record;
}

function requireQuery(executor: Database, accountId: string, queryId: string) {
  const record = executor.select().from(organizationSavedQueries)
    .where(and(eq(organizationSavedQueries.accountId, accountId), eq(organizationSavedQueries.id, queryId))).get();
  if (!record) throw new OrganizationCollectionsPinsNotFoundError("Saved query not found in the requested Account");
  return record;
}

function compactPositions(executor: Database, table: typeof collections | typeof pins, accountId: string, removedPosition: number) {
  const rows = executor.select().from(table).where(eq(table.accountId, accountId)).orderBy(asc(table.position)).all();
  for (const row of rows) {
    if (row.position > removedPosition) executor.update(table).set({ position: row.position - 1 }).where(eq(table.id, row.id)).run();
  }
}

function openPosition(executor: Database, table: typeof collections | typeof pins, accountId: string, position: number) {
  const rows = executor.select().from(table).where(eq(table.accountId, accountId)).orderBy(asc(table.position)).all();
  for (const row of [...rows].reverse()) {
    if (row.position >= position) executor.update(table).set({ position: row.position + 1 }).where(eq(table.id, row.id)).run();
  }
}

function collectionSnapshot(executor: Database, record: CollectionRecord) {
  return listCollections(executor, [record.accountId]).find((collection) => collection.id === record.id)!;
}

function pinSnapshot(record: PinRecord) {
  return mapPin(record);
}

function validatePinTarget(executor: Database, accountId: string, target: OrganizationPin["target"]) {
  if (target.type === "query") {
    requireQuery(executor, accountId, target.queryId);
    return;
  }
  if (target.resource.family === "thread") requireThread(executor, accountId, target.resource.id);
  if (target.resource.family === "collection") requireCollection(executor, accountId, target.resource.id);
  if (target.resource.family === "view" && !["inbox", "focus", "quiet", "hidden", "all"].includes(target.resource.id)) {
    throw new OrganizationCollectionsPinsNotFoundError("View shortcuts require a stable Orca view identity");
  }
  if (target.resource.family === "sender" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(target.resource.id)) {
    throw new OrganizationCollectionsPinsNotFoundError("Sender shortcuts require a stable email identity");
  }
}

function requireTrustedResourceId(value: string | null): string {
  if (!value) throw new Error("Trusted resource identity is required for create operations");
  return value;
}

function applyChange(executor: Database, change: OrganizationCollectionPinChange, trustedResourceId: string | null, now: Date) {
  if (change.kind === "collection_membership") {
    const collection = requireCollection(executor, change.accountId, change.collectionId);
    requireThread(executor, change.accountId, change.threadId);
    const current = executor.select().from(collectionThreads).where(and(
      eq(collectionThreads.collectionId, change.collectionId),
      eq(collectionThreads.threadId, change.threadId),
    )).get();
    const before = { member: Boolean(current), collectionRevision: collection.revision };
    if (change.action === "add" && !current) {
      executor.insert(collectionThreads).values({ id: `collection-thread:${crypto.randomUUID()}`, collectionId: change.collectionId, threadId: change.threadId, createdAt: now }).run();
    }
    if (change.action === "remove" && current) executor.delete(collectionThreads).where(eq(collectionThreads.id, current.id)).run();
    executor.update(collections).set({ revision: collection.revision + 1, updatedAt: now }).where(eq(collections.id, collection.id)).run();
    return {
      resourceId: `${change.collectionId}:${change.threadId}`,
      before,
      after: { member: change.action === "add", collectionRevision: collection.revision + 1 },
      reason: `${change.action === "add" ? "Added" : "Removed"} explicit Thread membership`,
    };
  }

  if (change.kind === "collection") {
    if (change.action === "create") {
      const position = executor.select().from(collections).where(eq(collections.accountId, change.accountId)).all().length;
      const id = requireTrustedResourceId(trustedResourceId);
      executor.insert(collections).values({ id, ...change.collection, accountId: change.accountId, position, revision: 1, createdAt: now, updatedAt: now }).run();
      const created = requireCollection(executor, change.accountId, id);
      return { resourceId: created.id, before: null, after: collectionSnapshot(executor, created), reason: "Created curated Collection" };
    }
    const current = requireCollection(executor, change.accountId, change.collectionId);
    const before = collectionSnapshot(executor, current);
    executor.delete(collections).where(eq(collections.id, current.id)).run();
    compactPositions(executor, collections, change.accountId, current.position);
    return { resourceId: current.id, before, after: null, reason: "Removed curated Collection metadata" };
  }

  if (change.kind === "saved_query") {
    if (change.action === "create") {
      executor.insert(organizationSavedQueries).values({
        id: requireTrustedResourceId(trustedResourceId),
        accountId: change.accountId,
        name: change.query.name,
        definitionJson: JSON.stringify(change.query.definition),
        revision: 1,
        createdAt: now,
        updatedAt: now,
      }).run();
      const created = requireQuery(executor, change.accountId, requireTrustedResourceId(trustedResourceId));
      return { resourceId: created.id, before: null, after: mapQuery(created), reason: "Created versioned saved query identity" };
    }
    const current = requireQuery(executor, change.accountId, change.queryId);
    const referenced = executor.select().from(pins).where(and(eq(pins.accountId, change.accountId), eq(pins.savedQueryId, current.id))).get();
    if (referenced) throw new OrganizationCollectionsPinsConflictError("Remove Pins before removing their saved query identity");
    const before = mapQuery(current);
    executor.delete(organizationSavedQueries).where(eq(organizationSavedQueries.id, current.id)).run();
    return { resourceId: current.id, before, after: null, reason: "Removed saved query identity" };
  }

  if (change.action === "create") {
    validatePinTarget(executor, change.accountId, change.pin.target);
    const position = executor.select().from(pins).where(eq(pins.accountId, change.accountId)).all().length;
    const targetId = change.pin.target.type === "query" ? change.pin.target.queryId : change.pin.target.resource.id;
    const kind = change.pin.target.type === "query" ? "filter" : change.pin.target.resource.family;
    executor.insert(pins).values({
      id: requireTrustedResourceId(trustedResourceId),
      accountId: change.accountId,
      kind,
      targetId,
      targetType: change.pin.target.type,
      resourceFamily: change.pin.target.type === "resource" ? change.pin.target.resource.family : null,
      savedQueryId: change.pin.target.type === "query" ? change.pin.target.queryId : null,
      label: change.pin.label,
      icon: change.pin.icon,
      color: change.pin.color,
      position,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }).run();
    const created = requirePin(executor, change.accountId, requireTrustedResourceId(trustedResourceId));
    return { resourceId: created.id, before: null, after: pinSnapshot(created), reason: "Created stable shortcut" };
  }
  const current = requirePin(executor, change.accountId, change.pinId);
  const before = pinSnapshot(current);
  executor.delete(pins).where(eq(pins.id, current.id)).run();
  compactPositions(executor, pins, change.accountId, current.position);
  return { resourceId: current.id, before, after: null, reason: "Removed stable shortcut" };
}

function restoreCollection(executor: Database, snapshot: OrganizationCollection, now: Date) {
  openPosition(executor, collections, snapshot.accountId, snapshot.position);
  executor.insert(collections).values({
    id: snapshot.id, accountId: snapshot.accountId, name: snapshot.name, color: snapshot.color,
    position: snapshot.position, revision: snapshot.revision + 1, createdAt: new Date(snapshot.createdAt), updatedAt: now,
  }).run();
  for (const threadId of snapshot.threadIds) {
    requireThread(executor, snapshot.accountId, threadId);
    executor.insert(collectionThreads).values({ id: `collection-thread:${crypto.randomUUID()}`, collectionId: snapshot.id, threadId, createdAt: now }).run();
  }
}

function restorePin(executor: Database, snapshot: OrganizationPin, now: Date) {
  validatePinTarget(executor, snapshot.accountId, snapshot.target);
  openPosition(executor, pins, snapshot.accountId, snapshot.position);
  const targetId = snapshot.target.type === "query" ? snapshot.target.queryId : snapshot.target.resource.id;
  executor.insert(pins).values({
    id: snapshot.id,
    accountId: snapshot.accountId,
    kind: snapshot.target.type === "query" ? "filter" : snapshot.target.resource.family,
    targetId,
    targetType: snapshot.target.type,
    resourceFamily: snapshot.target.type === "resource" ? snapshot.target.resource.family : null,
    savedQueryId: snapshot.target.type === "query" ? snapshot.target.queryId : null,
    label: snapshot.label,
    icon: snapshot.icon,
    color: snapshot.color,
    position: snapshot.position,
    revision: snapshot.revision + 1,
    createdAt: new Date(snapshot.createdAt),
    updatedAt: now,
  }).run();
}

function sameSnapshot(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertStillAtPostImage(executor: Database, original: AuditRecord) {
  const command = organizationCollectionPinChangeSchema.parse(JSON.parse(original.commandJson));
  const after = parseJson(original.afterJson) as Record<string, unknown> | null;
  let current: unknown = null;

  if (command.kind === "collection_membership") {
    const collection = executor.select().from(collections).where(and(
      eq(collections.accountId, command.accountId),
      eq(collections.id, command.collectionId),
    )).get();
    const membership = executor.select().from(collectionThreads).where(and(
      eq(collectionThreads.collectionId, command.collectionId),
      eq(collectionThreads.threadId, command.threadId),
    )).get();
    current = collection ? { member: Boolean(membership), collectionRevision: collection.revision } : null;
  } else if (command.kind === "collection") {
    const record = executor.select().from(collections).where(and(
      eq(collections.accountId, command.accountId),
      eq(collections.id, original.resourceId),
    )).get();
    current = record ? collectionSnapshot(executor, record) : null;
  } else if (command.kind === "saved_query") {
    const record = executor.select().from(organizationSavedQueries).where(and(
      eq(organizationSavedQueries.accountId, command.accountId),
      eq(organizationSavedQueries.id, original.resourceId),
    )).get();
    current = record ? mapQuery(record) : null;
  } else {
    const record = executor.select().from(pins).where(and(
      eq(pins.accountId, command.accountId),
      eq(pins.id, original.resourceId),
    )).get();
    current = record ? mapPin(record) : null;
  }

  if (!sameSnapshot(current, after)) {
    throw new OrganizationCollectionsPinsConflictError("Current state has diverged from the Organization change");
  }
}

function compensate(executor: Database, original: AuditRecord, now: Date) {
  assertStillAtPostImage(executor, original);
  const command = organizationCollectionPinChangeSchema.parse(JSON.parse(original.commandJson));
  const before = parseJson(original.beforeJson) as Record<string, unknown> | null;
  if (command.kind === "collection_membership") {
    const collection = requireCollection(executor, command.accountId, command.collectionId);
    requireThread(executor, command.accountId, command.threadId);
    const current = executor.select().from(collectionThreads).where(and(eq(collectionThreads.collectionId, command.collectionId), eq(collectionThreads.threadId, command.threadId))).get();
    const shouldExist = before?.member === true;
    if (shouldExist && !current) executor.insert(collectionThreads).values({ id: `collection-thread:${crypto.randomUUID()}`, collectionId: command.collectionId, threadId: command.threadId, createdAt: now }).run();
    if (!shouldExist && current) executor.delete(collectionThreads).where(eq(collectionThreads.id, current.id)).run();
    executor.update(collections).set({ revision: collection.revision + 1, updatedAt: now }).where(eq(collections.id, collection.id)).run();
    return;
  }
  if (command.kind === "collection") {
    if (command.action === "create") {
      const current = requireCollection(executor, command.accountId, original.resourceId);
      executor.delete(collections).where(eq(collections.id, current.id)).run();
      compactPositions(executor, collections, command.accountId, current.position);
    } else {
      restoreCollection(executor, before as OrganizationCollection, now);
    }
    return;
  }
  if (command.kind === "saved_query") {
    if (command.action === "create") {
      const current = requireQuery(executor, command.accountId, original.resourceId);
      if (executor.select().from(pins).where(eq(pins.savedQueryId, current.id)).get()) throw new OrganizationCollectionsPinsConflictError("Cannot revert a saved query while a Pin references it");
      executor.delete(organizationSavedQueries).where(eq(organizationSavedQueries.id, current.id)).run();
    } else {
      const snapshot = before as ReturnType<typeof mapQuery>;
      executor.insert(organizationSavedQueries).values({ id: snapshot.id, accountId: snapshot.accountId, name: snapshot.name, definitionJson: JSON.stringify(snapshot.definition), revision: snapshot.revision + 1, createdAt: now, updatedAt: now }).run();
    }
    return;
  }
  if (command.action === "create") {
    const current = requirePin(executor, command.accountId, original.resourceId);
    executor.delete(pins).where(eq(pins.id, current.id)).run();
    compactPositions(executor, pins, command.accountId, current.position);
  } else {
    restorePin(executor, before as OrganizationPin, now);
  }
}

function insertAudit(executor: Database, input: {
  id: string;
  workspaceId: string;
  accountId: string;
  actor: { id: string; type: "human" | "agent" | "system" };
  operation: "apply" | "revert";
  changeKind: OrganizationCollectionPinChange["kind"];
  resourceId: string;
  before: unknown;
  after: unknown;
  command: unknown;
  reason: string;
  revertsChangeId: string | null;
  idempotencyKey: string;
  now: Date;
}) {
  executor.insert(organizationCollectionPinAudits).values({
    id: input.id,
    workspaceId: input.workspaceId,
    accountId: input.accountId,
    actorId: input.actor.id,
    actorType: input.actor.type,
    operation: input.operation,
    changeKind: input.changeKind,
    resourceId: input.resourceId,
    beforeJson: input.before === null ? null : JSON.stringify(input.before),
    afterJson: input.after === null ? null : JSON.stringify(input.after),
    commandJson: JSON.stringify(input.command),
    reason: input.reason,
    revertsChangeId: input.revertsChangeId,
    idempotencyKey: input.idempotencyKey,
    createdAt: input.now,
  }).run();
  return mapAudit(executor.select().from(organizationCollectionPinAudits).where(eq(organizationCollectionPinAudits.id, input.id)).get()!);
}

function translateExpectedConstraint(error: unknown): never {
  if (error instanceof OrganizationCollectionsPinsConflictError) throw error;
  if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) {
    throw new OrganizationCollectionsPinsConflictError("Organization Collections/Pins state conflicts with an existing Account resource");
  }
  throw error;
}

export function createSqliteOrganizationCollectionsPinsRepository(db: Database): OrganizationCollectionsPinsRepository {
  return {
    listAccountIds(workspaceId) {
      return db.select({ id: oauthAccounts.id }).from(oauthAccounts)
        .where(eq(oauthAccounts.userId, workspaceId)).orderBy(asc(oauthAccounts.id)).all().map((record) => record.id);
    },
    query({ workspaceId, accountIds, query }) {
      const collectionsResult = listCollections(db, accountIds).filter((collection) => {
        if (query.collectionId && collection.id !== query.collectionId) return false;
        if (query.threadId && !collection.threadIds.includes(query.threadId)) return false;
        return true;
      });
      const pinRecords = accountIds.length === 0 ? [] : db.select().from(pins).where(inArray(pins.accountId, accountIds))
        .orderBy(asc(pins.accountId), asc(pins.position), asc(pins.id)).all();
      const queryRecords = accountIds.length === 0 ? [] : db.select().from(organizationSavedQueries).where(inArray(organizationSavedQueries.accountId, accountIds))
        .orderBy(asc(organizationSavedQueries.accountId), asc(organizationSavedQueries.name), asc(organizationSavedQueries.id)).all();
      return {
        workspaceId,
        accountIds,
        collections: collectionsResult,
        pins: pinRecords.map(mapPin),
        queries: queryRecords.map(mapQuery),
      };
    },
    apply({ scope, request, changeId, trustedResourceId, now }) {
      try {
        return db.transaction((transaction) => {
          const executor = transaction as unknown as Database;
          const commandJson = JSON.stringify(request.change);
          const duplicate = executor.select().from(organizationCollectionPinAudits).where(and(
            eq(organizationCollectionPinAudits.workspaceId, scope.workspaceId),
            eq(organizationCollectionPinAudits.idempotencyKey, request.idempotencyKey),
          )).get();
          if (duplicate) {
            if (duplicate.commandJson !== commandJson) throw new OrganizationCollectionsPinsConflictError("Idempotency key was already used for a different Organization change");
            return mapAudit(duplicate);
          }
          const outcome = applyChange(executor, request.change, trustedResourceId, now);
          return insertAudit(executor, {
            id: changeId,
            workspaceId: scope.workspaceId,
            accountId: request.change.accountId,
            actor: scope.actor,
            operation: "apply",
            changeKind: request.change.kind,
            resourceId: outcome.resourceId,
            before: outcome.before,
            after: outcome.after,
            command: request.change,
            reason: outcome.reason,
            revertsChangeId: null,
            idempotencyKey: request.idempotencyKey,
            now,
          });
        });
      } catch (error) {
        return translateExpectedConstraint(error);
      }
    },
    revert({ scope, request, changeId, now }) {
      try {
        return db.transaction((transaction) => {
          const executor = transaction as unknown as Database;
          const commandJson = JSON.stringify({ revert: request.changeId });
          const duplicate = executor.select().from(organizationCollectionPinAudits).where(and(
            eq(organizationCollectionPinAudits.workspaceId, scope.workspaceId),
            eq(organizationCollectionPinAudits.idempotencyKey, request.idempotencyKey),
          )).get();
          if (duplicate) {
            if (duplicate.commandJson !== commandJson) throw new OrganizationCollectionsPinsConflictError("Idempotency key was already used for a different Organization change");
            return mapAudit(duplicate);
          }
          const original = executor.select().from(organizationCollectionPinAudits).where(and(
            eq(organizationCollectionPinAudits.workspaceId, scope.workspaceId),
            eq(organizationCollectionPinAudits.id, request.changeId),
          )).get();
          if (!original || !scope.accountIds.includes(original.accountId)) throw new OrganizationCollectionsPinsNotFoundError("Organization change not found in the authorized Account scope");
          if (original.operation !== "apply") throw new OrganizationCollectionsPinsConflictError("Only applied Organization changes can be reverted");
          if (executor.select().from(organizationCollectionPinAudits).where(eq(organizationCollectionPinAudits.revertsChangeId, original.id)).get()) {
            throw new OrganizationCollectionsPinsConflictError("Organization change was already reverted");
          }
          compensate(executor, original, now);
          return insertAudit(executor, {
            id: changeId,
            workspaceId: scope.workspaceId,
            accountId: original.accountId,
            actor: scope.actor,
            operation: "revert",
            changeKind: original.changeKind as OrganizationCollectionPinChange["kind"],
            resourceId: original.resourceId,
            before: parseJson(original.afterJson),
            after: parseJson(original.beforeJson),
            command: { revert: original.id },
            reason: `Compensated ${original.reason.toLocaleLowerCase()}`,
            revertsChangeId: original.id,
            idempotencyKey: request.idempotencyKey,
            now,
          });
        });
      } catch (error) {
        return translateExpectedConstraint(error);
      }
    },
    audit({ workspaceId, accountIds }) {
      if (accountIds.length === 0) return [];
      const records = db.select().from(organizationCollectionPinAudits).where(and(
        eq(organizationCollectionPinAudits.workspaceId, workspaceId),
        inArray(organizationCollectionPinAudits.accountId, accountIds),
      )).orderBy(asc(organizationCollectionPinAudits.createdAt), asc(organizationCollectionPinAudits.id)).all();
      const revertedBy = new Map(records.filter((record) => record.revertsChangeId).map((record) => [record.revertsChangeId!, record.id]));
      return records.map((record) => mapAudit(record, revertedBy.get(record.id) ?? null));
    },
  };
}
