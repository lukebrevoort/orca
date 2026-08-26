import { and, asc, desc, eq } from "drizzle-orm";
import {
  attentionBehaviorSchema,
  humanClassificationAssessmentSchema,
  humanClassificationOverrideSchema,
  humanClassificationSchema,
  type HumanClassificationAssessment,
  type HumanClassificationReasonCode,
  type HumanClassificationResult,
} from "@orca/shared";

import type { createDatabaseClient } from "../db/client.ts";
import {
  emailLabels,
  emails,
  humanClassificationOverrides,
  labels,
  organizationThreadFacetValues,
  organizationThreadStates,
  organizationThreadWorkflowStates,
  oauthAccounts,
  senderAttentionRules,
  threads,
} from "../db/schema.ts";
import type { OrganizationRepository, OrganizationThreadRecord } from "./module.ts";
import { createSqliteFacetWorkflowRepository } from "./facet-workflow-sqlite.ts";
import { createSqliteOrganizationCollectionsPinsRepository } from "./collections-pins/sqlite-repository.ts";
import { createSqliteOrganizationContextsRepository } from "./contexts/sqlite-repository.ts";
import { createSqliteOrganizationLanesRepository } from "./lanes/sqlite-repository.ts";

type Database = ReturnType<typeof createDatabaseClient>["db"];
type OverrideRecord = typeof humanClassificationOverrides.$inferSelect;

const reasonCodes = new Set<HumanClassificationReasonCode>([
  "sender_no_reply_pattern", "list_id_header", "list_unsubscribe_header", "bulk_precedence_header",
  "auto_submitted_header", "provider_bulk_signal", "provider_promotions_signal", "provider_transactional_signal",
  "reply_context", "direct_recipient", "conflicting_evidence", "insufficient_evidence",
  "user_message_override", "user_sender_address_override", "user_sender_domain_override",
]);

function parseReasons(value: string | null): HumanClassificationReasonCode[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is HumanClassificationReasonCode => typeof item === "string" && reasonCodes.has(item as HumanClassificationReasonCode))
      : [];
  } catch {
    return [];
  }
}

function overrideKey(type: string, value: string): string {
  return `${type}:${value}`;
}

function findOverride(overrides: ReadonlyMap<string, OverrideRecord>, message: { id: string; fromAddress: string | null }): OverrideRecord | undefined {
  const address = message.fromAddress?.trim().toLocaleLowerCase() ?? "";
  const domain = address.split("@")[1] ?? "";
  return overrides.get(overrideKey("message", message.id))
    ?? (address ? overrides.get(overrideKey("sender_address", address)) : undefined)
    ?? (domain ? overrides.get(overrideKey("sender_domain", domain)) : undefined);
}

function toOverride(record: OverrideRecord) {
  const target = record.targetType === "message"
    ? { scope: "message" as const, messageId: record.targetValue }
    : record.targetType === "sender_address"
      ? { scope: "sender_address" as const, address: record.targetValue }
      : { scope: "sender_domain" as const, domain: record.targetValue };
  return humanClassificationOverrideSchema.parse({
    id: record.id,
    accountId: record.accountId,
    target,
    classification: record.classification,
    source: record.source,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  });
}

function automaticClassification(message: {
  humanClassification: string | null;
  humanSignal: number | null;
  humanClassificationReasons: string | null;
  humanClassifierVersion: string | null;
}): HumanClassificationAssessment | null {
  if (!message.humanClassification) return null;
  const parsed = humanClassificationAssessmentSchema.safeParse({
    classification: message.humanClassification,
    score: message.humanSignal,
    reasonCodes: parseReasons(message.humanClassificationReasons),
    classifierVersion: message.humanClassifierVersion,
  });
  return parsed.success ? parsed.data : null;
}

function resolveClassification(
  message: {
    id: string;
    fromAddress: string | null;
    humanClassification: string | null;
    humanSignal: number | null;
    humanClassificationReasons: string | null;
    humanClassifierVersion: string | null;
  },
  overrides: ReadonlyMap<string, OverrideRecord>,
): HumanClassificationResult {
  const automatic = automaticClassification(message);
  const override = findOverride(overrides, message);
  if (override) {
    const userOverride = toOverride(override);
    const reasons = {
      message: "user_message_override",
      sender_address: "user_sender_address_override",
      sender_domain: "user_sender_domain_override",
    } as const;
    return {
      automatic,
      userOverride,
      effective: {
        classification: humanClassificationSchema.parse(override.classification),
        score: null,
        reasonCodes: [reasons[override.targetType as keyof typeof reasons]],
        classifierVersion: null,
        source: "user_override",
        userOverride,
      },
    };
  }
  const effective = automatic ?? {
    classification: "unclassified" as const,
    score: null,
    reasonCodes: ["insufficient_evidence" as const],
    classifierVersion: null,
  };
  return {
    automatic,
    userOverride: null,
    effective: { ...effective, source: "automatic_heuristic", userOverride: null },
  };
}

/** SQLite adapter. Provider identities are deliberately projected out here. */
export function createSqliteOrganizationRepository(db: Database): OrganizationRepository {
  const threadCache = new Map<string, OrganizationThreadRecord[]>();
  const facetWorkflow = createSqliteFacetWorkflowRepository(db);
  const lanes = createSqliteOrganizationLanesRepository(db);
  return {
    collectionsPins: createSqliteOrganizationCollectionsPinsRepository(db),
    contexts: createSqliteOrganizationContextsRepository(db),
    lanes,
    getFacetWorkflowSnapshot: facetWorkflow.getFacetWorkflowSnapshot,
    getFacetWorkflowAuthorityState: facetWorkflow.getFacetWorkflowAuthorityState,
    readOrganizationSnapshot(workspaceId, accountIds, filter) {
      return db.transaction((transaction) => {
        const repository = createSqliteOrganizationRepository(transaction as unknown as Database);
        return {
          facetWorkflow: repository.getFacetWorkflowSnapshot!(workspaceId),
          contexts: repository.contexts?.getSnapshot(workspaceId) ?? null,
          lanes: repository.lanes!.getSnapshot(workspaceId, accountIds),
          threads: repository.listThreads(accountIds, filter),
        };
      });
    },
    applyFacetWorkflow(input) {
      const result = facetWorkflow.applyFacetWorkflow(input);
      threadCache.clear();
      return result;
    },
    listAccountIds(workspaceId) {
      return db.select({ id: oauthAccounts.id }).from(oauthAccounts)
        .where(eq(oauthAccounts.userId, workspaceId))
        .orderBy(asc(oauthAccounts.createdAt), asc(oauthAccounts.id))
        .all()
        .map((account) => account.id);
    },

    listThreads(accountIds, filter) {
      const cacheKey = `${[...new Set(accountIds)].sort().join("\u0000")}\u0001${filter?.threadId ?? "*"}`;
      const cached = threadCache.get(cacheKey);
      if (cached) return cached;
      const records: OrganizationThreadRecord[] = [];
      for (const accountId of [...new Set(accountIds)]) {
        const account = db.select({ workspaceId: oauthAccounts.userId }).from(oauthAccounts)
          .where(eq(oauthAccounts.id, accountId)).get();
        if (!account) continue;
        const accountThreads = db.select().from(threads)
          .where(and(
            eq(threads.accountId, accountId),
            ...(filter?.threadId ? [eq(threads.id, filter.threadId)] : []),
          ))
          .orderBy(desc(threads.latestReceivedAt), asc(threads.id))
          .all();
        const messageRows = db.select({
          id: emails.id,
          accountId: emails.accountId,
          threadId: emails.threadId,
          sourceId: emails.providerMessageId,
          fromName: emails.fromName,
          fromAddress: emails.fromAddress,
          subject: emails.subject,
          snippet: emails.snippet,
          receivedAt: emails.receivedAt,
          isRead: emails.isRead,
          humanSignal: emails.humanSignal,
          humanClassification: emails.humanClassification,
          humanClassificationReasons: emails.humanClassificationReasons,
          humanClassifierVersion: emails.humanClassifierVersion,
          labelName: labels.name,
        }).from(emails)
          .leftJoin(emailLabels, eq(emailLabels.emailId, emails.id))
          .leftJoin(labels, eq(labels.id, emailLabels.labelId))
          .where(and(
            eq(emails.accountId, accountId),
            ...(filter?.threadId ? [eq(emails.threadId, filter.threadId)] : []),
          ))
          .orderBy(desc(emails.receivedAt), desc(emails.createdAt), asc(emails.id), asc(labels.name))
          .all();
        const overrideRecords = db.select().from(humanClassificationOverrides)
          .where(eq(humanClassificationOverrides.accountId, accountId)).all();
        const overrides = new Map(overrideRecords.map((record) => [overrideKey(record.targetType, record.targetValue), record]));
        const attentionRules = db.select().from(senderAttentionRules)
          .where(eq(senderAttentionRules.accountId, accountId))
          .orderBy(asc(senderAttentionRules.scope), asc(senderAttentionRules.value))
          .all()
          .map((rule) => ({
            scope: rule.scope === "address" ? "address" as const : "domain" as const,
            value: rule.value,
            behavior: attentionBehaviorSchema.parse(rule.behavior),
          }));
        const facetValues = db.select().from(organizationThreadFacetValues)
          .where(and(
            eq(organizationThreadFacetValues.workspaceId, account.workspaceId),
            eq(organizationThreadFacetValues.accountId, accountId),
          )).all();
        const workflowStates = db.select().from(organizationThreadWorkflowStates)
          .where(and(
            eq(organizationThreadWorkflowStates.workspaceId, account.workspaceId),
            eq(organizationThreadWorkflowStates.accountId, accountId),
          )).all();
        const threadStates = db.select().from(organizationThreadStates)
          .where(and(
            eq(organizationThreadStates.workspaceId, account.workspaceId),
            eq(organizationThreadStates.accountId, accountId),
          )).all();
        const messagesById = new Map<string, OrganizationThreadRecord["messages"][number]>();
        const threadIdByMessageId = new Map<string, string>();
        for (const row of messageRows) {
          threadIdByMessageId.set(row.id, row.threadId);
          const current = messagesById.get(row.id);
          if (current) {
            if (row.labelName && !current.labels.includes(row.labelName)) current.labels.push(row.labelName);
            continue;
          }
          const humanClassification = resolveClassification(row, overrides);
          messagesById.set(row.id, {
            id: row.id,
            sourceId: row.sourceId,
            from: { name: row.fromName, email: row.fromAddress ?? "unknown@invalid" },
            subject: row.subject ?? "",
            snippet: row.snippet ?? "",
            receivedAt: (row.receivedAt ?? new Date(0)).toISOString(),
            unread: !row.isRead,
            labels: row.labelName ? [row.labelName] : [],
            humanSignal: humanClassification.effective.score,
            humanClassification,
          });
        }
        const messagesByThread = new Map<string, OrganizationThreadRecord["messages"]>();
        for (const message of messagesById.values()) {
          const threadId = threadIdByMessageId.get(message.id);
          if (!threadId) continue;
          const grouped = messagesByThread.get(threadId) ?? [];
          grouped.push(message);
          messagesByThread.set(threadId, grouped);
        }
        for (const thread of accountThreads) {
          records.push({
            id: thread.id,
            accountId: thread.accountId,
            subject: thread.subject ?? "",
            latestReceivedAt: (thread.latestReceivedAt ?? new Date(0)).toISOString(),
            messageCount: thread.messageCount,
            readState: thread.isRead ? "read" : "unread",
            messages: messagesByThread.get(thread.id) ?? [],
            attentionRules,
            facetValues: facetValues.filter((value) => value.threadId === thread.id).map((value) => ({
                facetId: value.facetId,
                value: JSON.parse(value.value) as string | number | boolean | Array<string | number | boolean>,
                updatedAt: value.updatedAt.toISOString(),
              })),
            workflowState: (() => {
              const value = workflowStates.find((candidate) => candidate.threadId === thread.id);
              return value ? { stateId: value.stateId, updatedAt: value.updatedAt.toISOString() } : null;
            })(),
            organizationRevision: threadStates.find((candidate) => candidate.threadId === thread.id)?.revision ?? null,
          });
        }
      }
      threadCache.set(cacheKey, records);
      return records;
    },
  };
}
