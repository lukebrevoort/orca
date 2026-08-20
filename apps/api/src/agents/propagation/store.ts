import { createHash, randomUUID } from "node:crypto";

import {
  agentEventListPageSchema,
  agentEventLifecycleStateSchema,
  agentPropagationAssessmentSchema,
  agentPropagationPolicySchema,
  conservativeAgentPropagationPolicy,
  propagatedAgentEventSchema,
  type AgentEventKind,
  type AgentEventListPage,
  type AgentPropagationAssessment,
  type AgentPropagationMuteRule,
  type AgentPropagationPolicy,
  type PropagatedAgentEvent,
  type UpdateAgentEventLifecycle,
} from "@orca/shared";
import { and, desc, eq, inArray, lt, or } from "drizzle-orm";

import type { createDatabaseClient } from "../../db/client.ts";
import {
  agentEvents,
  agentPropagationMutes,
  agentPropagationPolicyOverrides,
  emails,
  oauthAccounts,
  threads,
} from "../../db/schema.ts";
import type { AgentEventListQuery, AgentEventStore } from "../interfaces.ts";
import type { PropagationWriteResult } from "./service.ts";

type DatabaseClient = ReturnType<typeof createDatabaseClient>["db"];
type AgentEventRow = typeof agentEvents.$inferSelect;

export class AgentEventNotFoundError extends Error {
  constructor() {
    super("Agent event not found");
    this.name = "AgentEventNotFoundError";
  }
}

export class AgentEventRevisionConflictError extends Error {
  constructor() {
    super("Agent event revision changed");
    this.name = "AgentEventRevisionConflictError";
  }
}

/** Account-scoped SQLite implementation shared by sync, UI, and MCP reads. */
export class SqliteAgentEventStore implements AgentEventStore {
  constructor(
    private readonly db: DatabaseClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async upsert(assessment: AgentPropagationAssessment): Promise<PropagatedAgentEvent> {
    return (await this.upsertWithResult(assessment)).event;
  }

  async upsertWithResult(assessmentInput: AgentPropagationAssessment): Promise<PropagationWriteResult> {
    const assessment = agentPropagationAssessmentSchema.parse(assessmentInput);
    if (assessment.destination === "none") {
      throw new Error("Suppressed propagation assessments cannot be persisted");
    }
    this.assertSourceOwnership(assessment);

    const fingerprint = buildAssessmentFingerprint(assessment);
    const existing = this.db.select().from(agentEvents).where(and(
      eq(agentEvents.ownerUserId, assessment.source.ownerUserId),
      eq(agentEvents.accountId, assessment.source.accountId),
      eq(agentEvents.deduplicationKey, assessment.deduplicationKey),
    )).get();

    if (existing?.assessmentFingerprint === fingerprint) {
      return { event: toPropagatedAgentEvent(existing), outcome: "duplicate" };
    }

    const evaluatedAt = new Date(assessment.evaluatedAt);
    if (existing) {
      this.db.update(agentEvents).set({
        ...assessmentColumns(assessment),
        assessmentFingerprint: fingerprint,
        revision: existing.revision + 1,
        lastTransition: "updated",
        updatedAt: evaluatedAt,
      }).where(and(
        eq(agentEvents.id, existing.id),
        eq(agentEvents.ownerUserId, assessment.source.ownerUserId),
        eq(agentEvents.accountId, assessment.source.accountId),
        eq(agentEvents.revision, existing.revision),
      )).run();

      const updated = this.readOwned(existing.id, assessment.source.ownerUserId, assessment.source.accountId);
      if (!updated || updated.revision !== existing.revision + 1) {
        throw new AgentEventRevisionConflictError();
      }
      return { event: toPropagatedAgentEvent(updated), outcome: "updated" };
    }

    const id = randomUUID();
    this.db.insert(agentEvents).values({
      id,
      ...assessmentColumns(assessment),
      assessmentFingerprint: fingerprint,
      lifecycleState: "new",
      lastTransition: "created",
      revision: 1,
      seenAt: null,
      snoozedUntil: null,
      createdAt: evaluatedAt,
      updatedAt: evaluatedAt,
    }).run();

    const created = this.readOwned(id, assessment.source.ownerUserId, assessment.source.accountId);
    if (!created) throw new AgentEventNotFoundError();
    return { event: toPropagatedAgentEvent(created), outcome: "created" };
  }

  async list(query: AgentEventListQuery): Promise<AgentEventListPage> {
    const limit = Math.max(1, Math.min(100, Math.trunc(query.limit)));
    if (query.accountIds.length === 0) {
      return { events: [], nextCursor: null };
    }
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    const conditions = [
      eq(agentEvents.ownerUserId, query.ownerUserId),
      inArray(agentEvents.accountId, [...query.accountIds]),
    ];
    if (query.states?.length) {
      conditions.push(inArray(
        agentEvents.lifecycleState,
        query.states.map((state) => agentEventLifecycleStateSchema.parse(state)),
      ));
    }
    if (cursor) {
      const cursorDate = new Date(cursor.updatedAt);
      conditions.push(or(
        lt(agentEvents.updatedAt, cursorDate),
        and(eq(agentEvents.updatedAt, cursorDate), lt(agentEvents.id, cursor.id)),
      )!);
    }

    const rows = this.db.select().from(agentEvents)
      .where(and(...conditions))
      .orderBy(desc(agentEvents.updatedAt), desc(agentEvents.id))
      .limit(limit + 1)
      .all();
    const pageRows = rows.slice(0, limit);
    const last = pageRows.at(-1);
    return agentEventListPageSchema.parse({
      events: pageRows.map(toPropagatedAgentEvent),
      nextCursor: rows.length > limit && last
        ? encodeCursor({ updatedAt: last.updatedAt.getTime(), id: last.id })
        : null,
    });
  }

  async updateLifecycle(input: {
    ownerUserId: string;
    accountId: string;
    eventId: string;
    update: UpdateAgentEventLifecycle;
  }): Promise<PropagatedAgentEvent> {
    const existing = this.readOwned(input.eventId, input.ownerUserId, input.accountId);
    if (!existing) throw new AgentEventNotFoundError();
    if (existing.revision !== input.update.expectedRevision) {
      throw new AgentEventRevisionConflictError();
    }

    const now = this.now();
    const transition = lifecycleColumns(input.update, existing, now);
    this.db.transaction((tx) => {
      if (input.update.action === "mute") {
        tx.insert(agentPropagationMutes).values({
          id: randomUUID(),
          accountId: input.accountId,
          targetScope: input.update.target.scope,
          targetValue: input.update.target.value,
          createdAt: now,
          updatedAt: now,
        }).onConflictDoUpdate({
          target: [
            agentPropagationMutes.accountId,
            agentPropagationMutes.targetScope,
            agentPropagationMutes.targetValue,
          ],
          set: { updatedAt: now },
        }).run();
      }
      tx.update(agentEvents).set({
        ...transition,
        revision: existing.revision + 1,
        updatedAt: now,
      }).where(and(
        eq(agentEvents.id, input.eventId),
        eq(agentEvents.ownerUserId, input.ownerUserId),
        eq(agentEvents.accountId, input.accountId),
        eq(agentEvents.revision, existing.revision),
      )).run();
    });

    const updated = this.readOwned(input.eventId, input.ownerUserId, input.accountId);
    if (!updated || updated.revision !== existing.revision + 1) {
      throw new AgentEventRevisionConflictError();
    }
    return toPropagatedAgentEvent(updated);
  }

  private readOwned(eventId: string, ownerUserId: string, accountId: string) {
    return this.db.select().from(agentEvents).where(and(
      eq(agentEvents.id, eventId),
      eq(agentEvents.ownerUserId, ownerUserId),
      eq(agentEvents.accountId, accountId),
    )).get();
  }

  private assertSourceOwnership(assessment: AgentPropagationAssessment) {
    const source = assessment.source;
    const row = this.db.select({
      accountId: oauthAccounts.id,
      ownerUserId: oauthAccounts.userId,
      provider: oauthAccounts.provider,
      messageId: emails.id,
      providerMessageId: emails.providerMessageId,
      threadId: threads.id,
    }).from(oauthAccounts)
      .innerJoin(threads, and(eq(threads.accountId, oauthAccounts.id), eq(threads.id, source.threadId)))
      .innerJoin(emails, and(
        eq(emails.accountId, oauthAccounts.id),
        eq(emails.threadId, threads.id),
        eq(emails.id, source.messageId),
      ))
      .where(and(
        eq(oauthAccounts.id, source.accountId),
        eq(oauthAccounts.userId, source.ownerUserId),
      )).get();

    if (
      !row
      || row.provider !== source.provider
      || row.providerMessageId !== source.providerMessageId
    ) {
      throw new AgentEventNotFoundError();
    }
  }
}

export function buildAssessmentFingerprint(assessment: AgentPropagationAssessment): string {
  const canonical = {
    source: assessment.source,
    provenance: {
      policyVersion: assessment.provenance.policyVersion,
      agentId: assessment.provenance.agentId,
      agentVersion: assessment.provenance.agentVersion,
      executionMode: assessment.provenance.executionMode,
    },
    eventKind: assessment.eventKind,
    importance: assessment.importance,
    relevance: assessment.relevance,
    destination: assessment.destination,
    reasonCodes: assessment.reasonCodes,
    title: assessment.title,
    summary: assessment.summary,
    whyThisMatters: assessment.whyThisMatters,
    suggestedNextStep: assessment.suggestedNextStep,
    humanClassification: assessment.humanClassification,
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

export function resolveAgentPropagationPolicy(
  db: DatabaseClient,
  accountId: string,
): AgentPropagationPolicy {
  const policy = { ...conservativeAgentPropagationPolicy };
  const overrides = db.select().from(agentPropagationPolicyOverrides)
    .where(eq(agentPropagationPolicyOverrides.accountId, accountId)).all();
  for (const override of overrides) {
    setPolicyCategory(policy, override.category as AgentEventKind, override.enabled);
  }
  return agentPropagationPolicySchema.parse(policy);
}

export function listAgentPropagationMutes(
  db: DatabaseClient,
  accountId: string,
): AgentPropagationMuteRule[] {
  return db.select().from(agentPropagationMutes)
    .where(eq(agentPropagationMutes.accountId, accountId)).all()
    .map((row) => ({
      id: row.id,
      accountId: row.accountId,
      target: { scope: row.targetScope, value: row.targetValue },
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })) as AgentPropagationMuteRule[];
}

/** Reverses a local mute only when the account belongs to the requesting user. */
export function deleteAgentPropagationMute(
  db: DatabaseClient,
  input: { ownerUserId: string; accountId: string; muteId: string },
): boolean {
  const ownedAccount = db.select({ id: oauthAccounts.id }).from(oauthAccounts).where(and(
    eq(oauthAccounts.id, input.accountId),
    eq(oauthAccounts.userId, input.ownerUserId),
  )).get();
  if (!ownedAccount) return false;
  const existingMute = db.select({ id: agentPropagationMutes.id }).from(agentPropagationMutes).where(and(
    eq(agentPropagationMutes.id, input.muteId),
    eq(agentPropagationMutes.accountId, input.accountId),
  )).get();
  if (!existingMute) return false;
  db.delete(agentPropagationMutes).where(and(
    eq(agentPropagationMutes.id, input.muteId),
    eq(agentPropagationMutes.accountId, input.accountId),
  )).run();
  return true;
}

function assessmentColumns(assessment: AgentPropagationAssessment) {
  return {
    ownerUserId: assessment.source.ownerUserId,
    accountId: assessment.source.accountId,
    messageId: assessment.source.messageId,
    providerMessageId: assessment.source.providerMessageId,
    threadId: assessment.source.threadId,
    provider: assessment.source.provider,
    senderName: assessment.source.sender.name,
    senderAddress: assessment.source.sender.email,
    sourceSubject: assessment.source.subject,
    sourceReceivedAt: new Date(assessment.source.receivedAt),
    sourceUrl: assessment.source.sourceUrl,
    trigger: assessment.provenance.trigger,
    policyVersion: assessment.provenance.policyVersion,
    agentId: assessment.provenance.agentId,
    agentVersion: assessment.provenance.agentVersion,
    executionMode: assessment.provenance.executionMode,
    eventKind: assessment.eventKind,
    importance: assessment.importance,
    relevance: assessment.relevance,
    destination: assessment.destination,
    reasonCodes: JSON.stringify(assessment.reasonCodes),
    title: assessment.title,
    summary: assessment.summary,
    whyThisMatters: assessment.whyThisMatters,
    suggestedNextStep: assessment.suggestedNextStep,
    humanClassification: assessment.humanClassification?.classification ?? null,
    humanSignal: assessment.humanClassification?.score ?? null,
    humanClassificationReasons: assessment.humanClassification
      ? JSON.stringify(assessment.humanClassification.reasonCodes)
      : null,
    humanClassifierVersion: assessment.humanClassification?.classifierVersion ?? null,
    humanClassificationSource: assessment.humanClassification?.source ?? null,
    deduplicationKey: assessment.deduplicationKey,
    evaluatedAt: new Date(assessment.evaluatedAt),
  };
}

function toPropagatedAgentEvent(row: AgentEventRow): PropagatedAgentEvent {
  return propagatedAgentEventSchema.parse({
    id: row.id,
    source: {
      ownerUserId: row.ownerUserId,
      accountId: row.accountId,
      provider: row.provider,
      messageId: row.messageId,
      providerMessageId: row.providerMessageId,
      threadId: row.threadId,
      sender: { name: row.senderName, email: row.senderAddress },
      subject: row.sourceSubject,
      receivedAt: row.sourceReceivedAt.toISOString(),
      sourceUrl: row.sourceUrl,
    },
    provenance: {
      trigger: row.trigger,
      policyVersion: row.policyVersion,
      agentId: row.agentId,
      agentVersion: row.agentVersion,
      executionMode: row.executionMode,
    },
    eventKind: row.eventKind,
    importance: row.importance,
    relevance: row.relevance,
    destination: row.destination,
    reasonCodes: JSON.parse(row.reasonCodes),
    title: row.title,
    summary: row.summary,
    whyThisMatters: row.whyThisMatters,
    suggestedNextStep: row.suggestedNextStep,
    humanClassification: row.humanClassification
      ? {
          classification: row.humanClassification,
          score: row.humanSignal,
          reasonCodes: JSON.parse(row.humanClassificationReasons ?? "[]"),
          classifierVersion: row.humanClassifierVersion,
          source: row.humanClassificationSource,
        }
      : null,
    deduplicationKey: row.deduplicationKey,
    evaluatedAt: row.evaluatedAt.toISOString(),
    lifecycle: {
      state: row.lifecycleState,
      lastTransition: row.lastTransition,
      revision: row.revision,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      lastTransitionAt: row.updatedAt.toISOString(),
      seenAt: row.seenAt?.toISOString() ?? null,
      snoozedUntil: row.snoozedUntil?.toISOString() ?? null,
    },
  });
}

function lifecycleColumns(update: UpdateAgentEventLifecycle, row: AgentEventRow, now: Date) {
  switch (update.action) {
    case "mark_seen":
      return { lifecycleState: "seen", lastTransition: "seen", seenAt: now, snoozedUntil: null };
    case "dismiss":
      return { lifecycleState: "dismissed", lastTransition: "dismissed", snoozedUntil: null };
    case "restore":
      return { lifecycleState: "new", lastTransition: "restored", snoozedUntil: null };
    case "snooze":
      return { lifecycleState: "snoozed", lastTransition: "snoozed", snoozedUntil: new Date(update.until) };
    case "mute":
      return { lifecycleState: "muted", lastTransition: "muted", snoozedUntil: null };
    case "mark_false_positive":
      return { lifecycleState: "false_positive", lastTransition: "false_positive", snoozedUntil: null };
    case "retract":
      return { lifecycleState: "retracted", lastTransition: "retracted", snoozedUntil: null };
  }
}

function setPolicyCategory(policy: AgentPropagationPolicy, category: AgentEventKind, enabled: boolean) {
  switch (category) {
    case "release_available": policy.releaseAvailable = enabled; break;
    case "ci_or_deploy_failure": policy.ciOrDeployFailure = enabled; break;
    case "security_or_account_alert": policy.securityOrAccountAlert = enabled; break;
    case "receipt_or_renewal": policy.receiptOrRenewal = enabled; break;
    case "travel_or_booking_change": policy.travelOrBookingChange = enabled; break;
    case "marketing_or_newsletter": policy.marketingOrNewsletter = enabled; break;
    case "other": policy.other = enabled; break;
  }
}

function encodeCursor(cursor: { updatedAt: number; id: string }): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(value: string): { updatedAt: number; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (
      typeof parsed === "object"
      && parsed !== null
      && typeof (parsed as { updatedAt?: unknown }).updatedAt === "number"
      && Number.isFinite((parsed as { updatedAt: number }).updatedAt)
      && typeof (parsed as { id?: unknown }).id === "string"
      && (parsed as { id: string }).id.length > 0
    ) {
      return parsed as { updatedAt: number; id: string };
    }
  } catch {
    // Return the same stable input error for malformed base64 and JSON.
  }
  throw new Error("Invalid agent event cursor");
}
