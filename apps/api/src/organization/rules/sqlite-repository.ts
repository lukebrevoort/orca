import { and, asc, eq, gt, inArray, isNull, lte } from "drizzle-orm";
import { createHash } from "node:crypto";
import {
  facetCardinalitySchema,
  facetValueTypeSchema,
  organizationAuthorizationEnvelopeSchema,
  organizationCommandSchema,
  orcaCompiledRuleRevisionSchema,
  orcaRuleCompileRequestSchema,
  orcaRuleCompileResponseSchema,
  orcaRuleOrderResponseSchema,
  orcaRuleReorderRequestSchema,
  type OrcaRule,
  type OrcaRuleRevision,
} from "@orca/shared";

import type { createDatabaseClient } from "../../db/client.ts";
import {
  collections,
  oauthAccounts,
  organizationContexts,
  organizationContextTypes,
  organizationFacets,
  organizationChangeActions,
  organizationChangeSets,
  organizationLanes,
  organizationRuleRevisions,
  organizationRuleSets,
  organizationRules,
  organizationWorkflowStates,
  organizationWorkspaceStates,
} from "../../db/schema.ts";
import type { OrcaWorkspaceSnapshot } from "./compiler.ts";
import { canonicalOrganizationJson, digestOrganizationAuthorizationEnvelope, digestOrganizationCommand } from "../authority.ts";
import { isAgentOrganizationActor } from "../agent-capability.ts";
import {
  consumeRuleAuthorizationAnchor,
  digestRuleOrder,
  digestRulePersistenceIntent,
  digestRuleReorderPersistenceIntent,
  RuleAuthorityError,
  RuleIdempotencyConflictError,
  RuleRevisionConflictError,
  WorkspaceSchemaConflictError,
  type RuleRevisionRepository,
} from "./service.ts";

type Database = ReturnType<typeof createDatabaseClient>["db"];

function toRule(row: typeof organizationRules.$inferSelect): OrcaRule {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    latestRevision: row.latestRevision,
    activeRevisionId: row.activeRevisionId,
    position: row.position,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toRevision(row: typeof organizationRuleRevisions.$inferSelect): OrcaRuleRevision {
  return {
    id: row.id,
    ruleId: row.ruleId,
    workspaceId: row.workspaceId,
    revision: row.revision,
    source: row.source,
    sourceDigest: row.sourceDigest,
    compiled: orcaCompiledRuleRevisionSchema.parse(JSON.parse(row.compiledJson)),
    actor: { id: row.actorId, type: row.actorType as "human" | "agent" | "system" },
    createdAt: row.createdAt.toISOString(),
  };
}

function loadWorkspaceSnapshot(executor: Database, workspaceId: string): OrcaWorkspaceSnapshot {
  const state = executor.select().from(organizationWorkspaceStates).where(eq(organizationWorkspaceStates.workspaceId, workspaceId)).get();
  const accountIds = executor.select({ id: oauthAccounts.id }).from(oauthAccounts).where(eq(oauthAccounts.userId, workspaceId)).all().map((row) => row.id);
  const facets = executor.select().from(organizationFacets)
    .where(and(eq(organizationFacets.workspaceId, workspaceId), isNull(organizationFacets.retiredAt)))
    .orderBy(asc(organizationFacets.position), asc(organizationFacets.id)).all().map((row) => {
      const valueType = facetValueTypeSchema.parse(JSON.parse(row.valueType));
      const cardinality = facetCardinalitySchema.parse(JSON.parse(row.cardinality));
      return {
        id: row.id,
        name: row.name,
        valueType,
        cardinality: cardinality.kind,
        optional: row.isOptional,
      };
    });
  return {
    workspaceId,
    revision: state?.revision ?? 1,
    lanes: executor.select({ id: organizationLanes.id, name: organizationLanes.name }).from(organizationLanes)
      .where(and(eq(organizationLanes.workspaceId, workspaceId), isNull(organizationLanes.retiredAt))).orderBy(asc(organizationLanes.position), asc(organizationLanes.id)).all(),
    workflowStates: executor.select({ id: organizationWorkflowStates.id, name: organizationWorkflowStates.name }).from(organizationWorkflowStates)
      .where(and(eq(organizationWorkflowStates.workspaceId, workspaceId), isNull(organizationWorkflowStates.retiredAt))).orderBy(asc(organizationWorkflowStates.position), asc(organizationWorkflowStates.id)).all(),
    facets,
    collections: accountIds.length === 0 ? [] : executor.select({ id: collections.id, accountId: collections.accountId, name: collections.name }).from(collections)
      .where(inArray(collections.accountId, accountIds)).orderBy(asc(collections.position), asc(collections.id)).all(),
    contextTypes: executor.select({ id: organizationContextTypes.id, name: organizationContextTypes.name }).from(organizationContextTypes)
      .where(and(eq(organizationContextTypes.workspaceId, workspaceId), isNull(organizationContextTypes.retiredAt))).orderBy(asc(organizationContextTypes.position), asc(organizationContextTypes.id)).all(),
    contexts: executor.select({ id: organizationContexts.id, contextTypeId: organizationContexts.contextTypeId, name: organizationContexts.name }).from(organizationContexts)
      .where(and(eq(organizationContexts.workspaceId, workspaceId), isNull(organizationContexts.retiredAt))).orderBy(asc(organizationContexts.id)).all(),
  };
}

export function createSqliteRuleRevisionRepository(db: Database): RuleRevisionRepository {
  const getRule = (workspaceId: string, ruleId: string) => {
    const ruleRow = db.select().from(organizationRules).where(and(eq(organizationRules.workspaceId, workspaceId), eq(organizationRules.id, ruleId))).get();
    return ruleRow ? toRule(ruleRow) : null;
  };
  const readOrder = (executor: Database, workspaceId: string) => {
    const items = executor.select({ id: organizationRules.id, position: organizationRules.position, revision: organizationRules.latestRevision })
      .from(organizationRules).where(eq(organizationRules.workspaceId, workspaceId)).orderBy(asc(organizationRules.position)).all();
    const root = executor.select().from(organizationRuleSets).where(eq(organizationRuleSets.workspaceId, workspaceId)).get();
    const actualDigest = digestRuleOrder(items.map(({ id }) => id));
    if (items.some(({ position }, index) => position !== index)
      || (!root && items.length > 0)
      || (root && (root.orderDigest !== actualDigest || root.ruleCount !== items.length))) {
      throw new RuleAuthorityError("invalid_live_authority", "The persisted Rule Set root and canonical positions are inconsistent");
    }
    return {
      revision: root?.revision ?? 1,
      orderDigest: root?.orderDigest ?? actualDigest,
      ruleCount: root?.ruleCount ?? items.length,
      items,
    };
  };
  const getOrder = (workspaceId: string) => readOrder(db, workspaceId);
  return {
    loadWorkspaceSnapshot(workspaceId) { return loadWorkspaceSnapshot(db, workspaceId); },
    getAuthorityState(workspaceId, lookup) {
      const state = db.select().from(organizationWorkspaceStates).where(eq(organizationWorkspaceStates.workspaceId, workspaceId)).get();
      const rule = db.select({ revision: organizationRules.latestRevision }).from(organizationRules).where(and(
        eq(organizationRules.workspaceId, workspaceId),
        eq(organizationRules.id, lookup.ruleId),
      )).get();
      const reserved = db.select({ id: organizationChangeSets.id }).from(organizationChangeSets).where(and(
        eq(organizationChangeSets.workspaceId, workspaceId),
        eq(organizationChangeSets.idempotencyKey, lookup.idempotencyKey),
      )).get();
      const order = getOrder(workspaceId);
      return {
        accountIds: db.select({ id: oauthAccounts.id }).from(oauthAccounts).where(eq(oauthAccounts.userId, workspaceId)).all().map((row) => row.id),
        workspaceRevision: state?.revision ?? 1,
        resourceRevisions: { ...(rule ? { [`rule:${lookup.ruleId}`]: rule.revision } : {}), [`rule_order:${workspaceId}`]: order.revision },
        idempotencyKeyReserved: Boolean(reserved),
      };
    },
    getIdempotent(workspaceId, idempotencyKey) {
      const row = db.select({ commandJson: organizationChangeSets.commandJson }).from(organizationChangeSets).where(and(
        eq(organizationChangeSets.workspaceId, workspaceId),
        eq(organizationChangeSets.idempotencyKey, idempotencyKey),
        eq(organizationChangeSets.resourceFamily, "rule"),
      )).get();
      if (!row) return null;
      const stored = JSON.parse(row.commandJson) as { request: unknown; response: unknown };
      const parsedRequest = orcaRuleCompileRequestSchema.safeParse(stored.request);
      if (!parsedRequest.success) return null;
      const response = orcaRuleCompileResponseSchema.parse(stored.response);
      if (!response.ok) throw new Error("Persisted Rule idempotency evidence must contain a successful response");
      return { request: parsedRequest.data, response };
    },
    getOrder,
    getIdempotentReorder(workspaceId, idempotencyKey) {
      const row = db.select({ commandJson: organizationChangeSets.commandJson }).from(organizationChangeSets).where(and(
        eq(organizationChangeSets.workspaceId, workspaceId), eq(organizationChangeSets.idempotencyKey, idempotencyKey), eq(organizationChangeSets.resourceFamily, "rule"),
      )).get();
      if (!row) return null;
      const stored = JSON.parse(row.commandJson) as { request: unknown; response: unknown };
      const request = orcaRuleReorderRequestSchema.safeParse(stored.request);
      if (!request.success) return null;
      return { request: request.data, response: orcaRuleOrderResponseSchema.parse(stored.response) };
    },
    getRule,
    listRevisions(workspaceId, ruleId, query) {
      return db.select().from(organizationRuleRevisions).where(and(
        eq(organizationRuleRevisions.workspaceId, workspaceId),
        eq(organizationRuleRevisions.ruleId, ruleId),
        gt(organizationRuleRevisions.revision, query.afterRevision),
        lte(organizationRuleRevisions.revision, query.throughRevision),
      )).orderBy(asc(organizationRuleRevisions.revision)).limit(query.limit).all().map(toRevision);
    },
    append(input) {
      return db.transaction((transaction) => {
        // This process-memory capability is consumed only after SQLite enters the command
        // transaction, but intentionally is not restored when that transaction rolls back.
        // A failed command must receive fresh authority rather than reuse a one-shot anchor.
        const authorizationBinding = consumeRuleAuthorizationAnchor(input.authorizationAnchor);
        if (!authorizationBinding) throw new RuleAuthorityError("invalid_request", "The authenticated Rule authorization anchor is missing or expired");
        if (digestRulePersistenceIntent(input) !== authorizationBinding.persistenceIntentDigest) {
          throw new RuleAuthorityError("invalid_request", "The Rule persistence intent does not match its authenticated authorization anchor");
        }
        const executor = transaction as unknown as Database;
        const commandResult = organizationCommandSchema.safeParse(input.command);
        const envelopeResult = organizationAuthorizationEnvelopeSchema.safeParse({ executionContext: input.executionContext, trace: input.authorityTrace });
        if (!commandResult.success || !envelopeResult.success) throw new RuleAuthorityError("invalid_request", "The Rule authorization envelope failed runtime validation");
        const command = commandResult.data;
        const envelope = envelopeResult.data;
        const envelopeDigest = digestOrganizationAuthorizationEnvelope(envelope);
        const expectedCommand = {
          id: input.changeId,
          intents: [{
            kind: "mutate_rule" as const,
            resourceId: `rule:${input.rule.id}`,
            mutation: input.expectedRuleRevision === null ? "create" as const : "update" as const,
            changes: { sourceDigest: input.revision.sourceDigest, revision: input.revision.revision },
          }, ...(input.orderPlan ? [{
            kind: "mutate_rule" as const,
            resourceId: `rule_order:${input.rule.workspaceId}`,
            mutation: "update" as const,
            changes: { clientRequestDigest: `sha256:${createHash("sha256").update(canonicalOrganizationJson(input.request)).digest("hex")}`, orderDigest: input.orderPlan.targetOrderDigest, ruleCount: input.orderPlan.orderedRuleIds.length, revision: input.orderPlan.expected.revision + 1 },
          }] : [])],
        };
        if (envelopeDigest !== input.authorizationEnvelopeDigest
          || envelopeDigest !== authorizationBinding.authorizationEnvelopeDigest
          || canonicalOrganizationJson(envelope.executionContext.actor) !== canonicalOrganizationJson(authorizationBinding.actor)
          || envelope.executionContext.workspaceId !== authorizationBinding.workspaceId
          || canonicalOrganizationJson([...envelope.executionContext.accountIds].sort()) !== canonicalOrganizationJson([...authorizationBinding.accountIds].sort())
          || envelope.executionContext.operation !== "apply"
          || envelope.trace.operation !== "apply"
          || envelope.trace.decision !== "allowed"
          || envelope.executionContext.expectedRevisions.workspace !== input.request.workspaceSchemaRevision
          || envelope.executionContext.idempotencyKey !== input.request.idempotencyKey
          || command.id !== input.changeId
          || canonicalOrganizationJson(command) !== canonicalOrganizationJson(expectedCommand)
          || input.executionContext.command.digest !== digestOrganizationCommand(command)
          || input.authorityTrace.command.digest !== input.executionContext.command.digest) {
          throw new RuleAuthorityError("invalid_request", "The Rule request does not match its authenticated authorization envelope");
        }
        const liveAccountIds = executor.select({ id: oauthAccounts.id }).from(oauthAccounts)
          .where(eq(oauthAccounts.userId, input.rule.workspaceId)).all().map((row) => row.id).sort();
        const boundAccountIds = [...authorizationBinding.accountIds].sort();
        const agentCapability = isAgentOrganizationActor(authorizationBinding.actor)
          ? authorizationBinding.agentCapabilitySource?.load({
              actor: authorizationBinding.actor,
              workspaceId: authorizationBinding.workspaceId,
              accountIds: boundAccountIds,
            }, executor) ?? null
          : null;
        const accountsRemainAuthorized = isAgentOrganizationActor(authorizationBinding.actor)
          ? agentCapability !== null
            && agentCapability.revokedAt === null
            && boundAccountIds.every((accountId) => liveAccountIds.includes(accountId))
            && canonicalOrganizationJson(agentCapability.snapshot) === canonicalOrganizationJson(envelope.trace.capabilitySnapshot)
          : canonicalOrganizationJson(liveAccountIds) === canonicalOrganizationJson(boundAccountIds);
        if (input.revision.actor.id !== authorizationBinding.actor.id
          || input.revision.actor.type !== authorizationBinding.actor.type
          || input.revision.workspaceId !== input.rule.workspaceId
          || input.revision.ruleId !== input.rule.id
          || input.revision.compiled.workspaceId !== input.rule.workspaceId
          || !accountsRemainAuthorized) {
          throw new RuleAuthorityError("account_denied", "The Rule authorization scope is not currently owned");
        }
        const duplicate = executor.select({ commandJson: organizationChangeSets.commandJson }).from(organizationChangeSets).where(and(
          eq(organizationChangeSets.workspaceId, input.rule.workspaceId),
          eq(organizationChangeSets.idempotencyKey, input.request.idempotencyKey),
        )).get();
        if (duplicate) {
          const stored = JSON.parse(duplicate.commandJson) as { request?: unknown; response?: unknown };
          if (canonicalOrganizationJson(stored.request) !== canonicalOrganizationJson(input.request)) throw new RuleIdempotencyConflictError();
          const response = orcaRuleCompileResponseSchema.parse(stored.response);
          if (!response.ok) throw new Error("Persisted Rule idempotency evidence must contain a successful response");
          return response;
        }
        const currentWorkspace = executor.select().from(organizationWorkspaceStates).where(eq(organizationWorkspaceStates.workspaceId, input.rule.workspaceId)).get();
        const actualWorkspaceRevision = currentWorkspace?.revision ?? 1;
        if (actualWorkspaceRevision !== input.expectedWorkspaceSchemaRevision) {
          throw new WorkspaceSchemaConflictError(input.expectedWorkspaceSchemaRevision, actualWorkspaceRevision);
        }
        const currentRule = executor.select().from(organizationRules).where(and(
          eq(organizationRules.workspaceId, input.rule.workspaceId), eq(organizationRules.id, input.rule.id),
        )).get();
        const actualRuleRevision = currentRule?.latestRevision ?? null;
        if (actualRuleRevision !== input.expectedRuleRevision) throw new RuleRevisionConflictError(input.expectedRuleRevision, actualRuleRevision);
        const actualOrder = readOrder(executor, input.rule.workspaceId);
        const actualOrderItems = actualOrder.items;
        const actualRoot = executor.select().from(organizationRuleSets).where(eq(organizationRuleSets.workspaceId, input.rule.workspaceId)).get();
        if (input.orderPlan && (canonicalOrganizationJson(actualOrder) !== canonicalOrganizationJson(input.orderPlan.expected)
          || input.orderPlan.orderedRuleIds.at(-1) !== input.rule.id
          || input.orderPlan.targetOrderDigest !== digestRuleOrder(input.orderPlan.orderedRuleIds)
          || input.orderPlan.orderedRuleIds.length !== actualOrderItems.length + 1)) {
          throw new RuleRevisionConflictError(input.orderPlan.expected.revision, actualOrder.revision);
        }
        const response = orcaRuleCompileResponseSchema.parse({ ok: true, rule: input.rule, revision: input.revision, diagnostics: [] });
        if (currentRule) {
          executor.update(organizationRules).set({ name: input.rule.name, latestRevision: input.rule.latestRevision, updatedAt: new Date(input.rule.updatedAt) })
            .where(and(eq(organizationRules.workspaceId, input.rule.workspaceId), eq(organizationRules.id, input.rule.id))).run();
        } else {
          executor.insert(organizationRules).values({
            workspaceId: input.rule.workspaceId, id: input.rule.id, name: input.rule.name, latestRevision: input.rule.latestRevision,
            activeRevisionId: input.rule.activeRevisionId, position: input.rule.position, createdAt: new Date(input.rule.createdAt), updatedAt: new Date(input.rule.updatedAt),
          }).run();
        }
        executor.insert(organizationRuleRevisions).values({
          workspaceId: input.revision.workspaceId,
          id: input.revision.id,
          ruleId: input.revision.ruleId,
          revision: input.revision.revision,
          workspaceSchemaRevision: input.revision.compiled.workspaceSchemaRevision,
          languageVersion: input.revision.compiled.languageVersion,
          source: input.revision.source,
          sourceDigest: input.revision.sourceDigest,
          compiledJson: JSON.stringify(input.revision.compiled),
          compilationWorkspaceJson: JSON.stringify(input.compilationWorkspace),
          requiredCapabilities: JSON.stringify(input.revision.compiled.requiredCapabilities),
          risk: input.revision.compiled.risk,
          actorId: input.revision.actor.id,
          actorType: input.revision.actor.type,
          createdAt: new Date(input.revision.createdAt),
        }).run();
        if (input.orderPlan) {
          if (actualRoot) {
            const advanced = executor.update(organizationRuleSets).set({ revision: actualRoot.revision + 1, orderDigest: input.orderPlan.targetOrderDigest, ruleCount: input.orderPlan.orderedRuleIds.length, updatedAt: new Date(input.revision.createdAt) })
              .where(and(eq(organizationRuleSets.workspaceId, input.rule.workspaceId), eq(organizationRuleSets.revision, actualRoot.revision), eq(organizationRuleSets.orderDigest, actualRoot.orderDigest)))
              .returning({ revision: organizationRuleSets.revision }).get();
            if (!advanced) throw new RuleRevisionConflictError(actualRoot.revision, actualRoot.revision + 1);
          } else {
            executor.insert(organizationRuleSets).values({ workspaceId: input.rule.workspaceId, revision: 2, orderDigest: input.orderPlan.targetOrderDigest, ruleCount: 1, createdAt: new Date(input.revision.createdAt), updatedAt: new Date(input.revision.createdAt) }).run();
          }
        }
        const workspaceRevisionAfter = actualWorkspaceRevision + 1;
        if (currentWorkspace) {
          executor.update(organizationWorkspaceStates).set({ revision: workspaceRevisionAfter, updatedAt: new Date(input.revision.createdAt) })
            .where(eq(organizationWorkspaceStates.workspaceId, input.rule.workspaceId)).run();
        } else {
          executor.insert(organizationWorkspaceStates).values({ workspaceId: input.rule.workspaceId, revision: workspaceRevisionAfter, updatedAt: new Date(input.revision.createdAt) }).run();
        }
        executor.insert(organizationChangeSets).values({
          workspaceId: input.rule.workspaceId,
          id: input.changeId,
          idempotencyKey: input.request.idempotencyKey,
          commandDigest: input.executionContext.command.digest,
          authorityTrace: JSON.stringify(input.authorityTrace),
          resourceFamily: "rule",
          operation: "apply",
          commandJson: JSON.stringify({ request: input.request, response }),
          revertsChangeId: null,
          workspaceRevisionBefore: actualWorkspaceRevision,
          workspaceRevisionAfter,
          createdAt: new Date(input.revision.createdAt),
        }).run();
        executor.insert(organizationChangeActions).values({
          workspaceId: input.rule.workspaceId,
          changeId: input.changeId,
          position: 0,
          actionKind: currentRule ? "append_rule_revision" : "create_rule",
          resourceFamily: "rule",
          resourceId: input.rule.id,
          beforeJson: currentRule ? JSON.stringify(toRule(currentRule)) : null,
          afterJson: JSON.stringify({ rule: input.rule, revisionId: input.revision.id }),
        }).run();
        if (input.orderPlan) executor.insert(organizationChangeActions).values({
          workspaceId: input.rule.workspaceId, changeId: input.changeId, position: 1, actionKind: "rule_order_update", resourceFamily: "rule",
          resourceId: `rule_order:${input.rule.workspaceId}`,
          beforeJson: JSON.stringify({ revision: actualOrder.revision, orderDigest: actualOrder.orderDigest, ruleCount: actualOrder.ruleCount }),
          afterJson: JSON.stringify({ revision: actualOrder.revision + 1, orderDigest: input.orderPlan.targetOrderDigest, ruleCount: input.orderPlan.orderedRuleIds.length }),
        }).run();
        return response as ReturnType<RuleRevisionRepository["append"]>;
      });
    },
    reorder(input) {
      return db.transaction((transaction) => {
        const authorizationBinding = consumeRuleAuthorizationAnchor(input.authorizationAnchor);
        if (!authorizationBinding || digestRuleReorderPersistenceIntent(input) !== authorizationBinding.persistenceIntentDigest) throw new RuleAuthorityError("invalid_request", "The Rule reorder intent does not match its authenticated authorization anchor");
        const executor = transaction as unknown as Database;
        const commandResult = organizationCommandSchema.safeParse(input.command);
        const envelopeResult = organizationAuthorizationEnvelopeSchema.safeParse({ executionContext: input.executionContext, trace: input.authorityTrace });
        if (!commandResult.success || !envelopeResult.success) throw new RuleAuthorityError("invalid_request", "The Rule reorder authorization envelope failed runtime validation");
        const envelope = envelopeResult.data;
        const expectedCommand = { id: input.changeId, intents: [{ kind: "mutate_rule" as const, resourceId: `rule_order:${authorizationBinding.workspaceId}`, mutation: "update" as const, changes: { clientRequestDigest: `sha256:${createHash("sha256").update(canonicalOrganizationJson(input.request)).digest("hex")}`, orderDigest: input.plan.targetOrderDigest, ruleCount: input.plan.orderedRuleIds.length, revision: input.plan.expected.revision + 1 } }] };
        if (digestOrganizationAuthorizationEnvelope(envelope) !== input.authorizationEnvelopeDigest
          || input.authorizationEnvelopeDigest !== authorizationBinding.authorizationEnvelopeDigest
          || digestOrganizationCommand(commandResult.data) !== envelope.executionContext.command.digest
          || canonicalOrganizationJson(commandResult.data) !== canonicalOrganizationJson(expectedCommand)
          || canonicalOrganizationJson(envelope.executionContext.actor) !== canonicalOrganizationJson(authorizationBinding.actor)
          || envelope.executionContext.workspaceId !== authorizationBinding.workspaceId
          || envelope.executionContext.idempotencyKey !== input.request.idempotencyKey) throw new RuleAuthorityError("invalid_request", "The Rule reorder command was modified before commit");
        const duplicate = executor.select({ commandJson: organizationChangeSets.commandJson }).from(organizationChangeSets).where(and(eq(organizationChangeSets.workspaceId, authorizationBinding.workspaceId), eq(organizationChangeSets.idempotencyKey, input.request.idempotencyKey))).get();
        if (duplicate) {
          const stored = JSON.parse(duplicate.commandJson) as { request: unknown; response: unknown };
          if (canonicalOrganizationJson(stored.request) !== canonicalOrganizationJson(input.request)) throw new RuleIdempotencyConflictError();
          return orcaRuleOrderResponseSchema.parse(stored.response);
        }
        const workspace = executor.select().from(organizationWorkspaceStates).where(eq(organizationWorkspaceStates.workspaceId, authorizationBinding.workspaceId)).get();
        const workspaceRevision = workspace?.revision ?? 1;
        if (workspaceRevision !== input.request.expectedWorkspaceRevision) throw new WorkspaceSchemaConflictError(input.request.expectedWorkspaceRevision, workspaceRevision);
        const actual = readOrder(executor, authorizationBinding.workspaceId);
        const rows = actual.items;
        const root = executor.select().from(organizationRuleSets).where(eq(organizationRuleSets.workspaceId, authorizationBinding.workspaceId)).get();
        if (canonicalOrganizationJson(actual) !== canonicalOrganizationJson(input.plan.expected)
          || input.plan.targetOrderDigest !== digestRuleOrder(input.plan.orderedRuleIds)
          || input.plan.orderedRuleIds.length !== rows.length
          || new Set(input.plan.orderedRuleIds).size !== rows.length) throw new RuleRevisionConflictError(input.plan.expected.revision, actual.revision);
        const temporaryBase = Math.max(rows.length, ...rows.map(({ position }) => position + 1)) + rows.length + 1;
        rows.forEach((row, index) => executor.update(organizationRules).set({ position: temporaryBase + index }).where(and(eq(organizationRules.workspaceId, authorizationBinding.workspaceId), eq(organizationRules.id, row.id))).run());
        input.plan.orderedRuleIds.forEach((ruleId, position) => executor.update(organizationRules).set({ position }).where(and(eq(organizationRules.workspaceId, authorizationBinding.workspaceId), eq(organizationRules.id, ruleId))).run());
        if (!root) throw new RuleRevisionConflictError(input.request.expectedRuleSetRevision, 1);
        const advancedRoot = executor.update(organizationRuleSets).set({ revision: root.revision + 1, orderDigest: input.plan.targetOrderDigest, ruleCount: rows.length, updatedAt: new Date() })
          .where(and(eq(organizationRuleSets.workspaceId, authorizationBinding.workspaceId), eq(organizationRuleSets.revision, root.revision), eq(organizationRuleSets.orderDigest, root.orderDigest))).returning({ revision: organizationRuleSets.revision }).get();
        if (!advancedRoot) throw new RuleRevisionConflictError(root.revision, root.revision + 1);
        const workspaceAfter = workspaceRevision + 1;
        if (workspace) {
          const advancedWorkspace = executor.update(organizationWorkspaceStates).set({ revision: workspaceAfter, updatedAt: new Date() }).where(and(eq(organizationWorkspaceStates.workspaceId, authorizationBinding.workspaceId), eq(organizationWorkspaceStates.revision, workspaceRevision))).returning({ revision: organizationWorkspaceStates.revision }).get();
          if (!advancedWorkspace) throw new WorkspaceSchemaConflictError(workspaceRevision, workspaceRevision + 1);
        } else executor.insert(organizationWorkspaceStates).values({ workspaceId: authorizationBinding.workspaceId, revision: workspaceAfter, updatedAt: new Date() }).run();
        executor.insert(organizationChangeSets).values({ workspaceId: authorizationBinding.workspaceId, id: input.changeId, idempotencyKey: input.request.idempotencyKey, commandDigest: input.executionContext.command.digest, authorityTrace: JSON.stringify(input.authorityTrace), resourceFamily: "rule", operation: "apply", commandJson: JSON.stringify({ request: input.request, response: input.response }), revertsChangeId: null, workspaceRevisionBefore: workspaceRevision, workspaceRevisionAfter: workspaceAfter, createdAt: new Date() }).run();
        executor.insert(organizationChangeActions).values({ workspaceId: authorizationBinding.workspaceId, changeId: input.changeId, position: 0, actionKind: "rule_order_update", resourceFamily: "rule", resourceId: `rule_order:${authorizationBinding.workspaceId}`, beforeJson: JSON.stringify({ revision: actual.revision, orderDigest: actual.orderDigest, ruleCount: actual.ruleCount }), afterJson: JSON.stringify({ revision: actual.revision + 1, orderDigest: input.plan.targetOrderDigest, ruleCount: rows.length }) }).run();
        return input.response;
      });
    },
  };
}
