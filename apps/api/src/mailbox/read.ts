import { createHash } from "node:crypto";

import type { Database } from "bun:sqlite";
import {
  humanClassificationAssessmentSchema,
  humanClassificationOverrideSchema,
  humanClassificationSchema,
  type AttentionBehavior,
  type HumanClassificationAssessment,
  type HumanClassificationReasonCode,
  type HumanClassificationResult,
  type InboxClassificationResponse,
  type InboxMessage,
  type MailAccount,
  type MailProvider,
} from "@orca/shared";

export const mailboxReadTargets = Object.freeze({
  // Ticket evidence measured 1.8s at 1k and 6.8–8.8s at 5k. These gates
  // require at least a 72% and 89% reduction while retaining headroom for a
  // concurrent 8 GB development host; focus revalidation stays sub-second.
  firstPageP95Ms: Object.freeze({ 1_000: 500, 5_000: 750 }),
  focusToFreshP95Ms: Object.freeze({ 1_000: 500, 5_000: 750 }),
});

export type MailboxReadAccount = {
  id: string;
  provider: MailProvider;
  lastSyncedAt: Date | null;
  serialized: MailAccount;
};

export type MailboxReadQuery = {
  cursor?: string;
  limit: number;
  view?: "focus" | "normal" | "quiet" | "hidden" | "all";
  classification?: "human" | "tideline" | "uncertain" | "all";
  query?: string;
  sender?: string;
  receivedAfter?: string;
  receivedBefore?: string;
};

export type MailboxReadMetric = {
  durationMs: number;
  countDurationMs: number;
  pageDurationMs: number;
  enrichmentDurationMs: number;
  accountCount: number;
  limit: number;
  returnedMessages: number;
  aggregateRowsReturned: number;
  pageRowsProjected: number;
  lookaheadRowsProjected: number;
  labelAssociationRowsLoaded: number;
  effectiveOverridesProjected: number;
  revision: string;
};

export type MailboxPageQueryPlan = {
  behavior: AttentionBehavior;
  details: string[];
};

export type MailboxReadResult = {
  response: InboxClassificationResponse & {
    freshness: NonNullable<InboxClassificationResponse["freshness"]>;
  };
  metric: MailboxReadMetric;
};

export class MailboxCursorError extends Error {
  readonly code = "invalid_cursor" as const;

  constructor(message: string) {
    super(message);
    this.name = "MailboxCursorError";
  }
}

type MailboxReaderOptions = {
  clock?: () => number;
  observe?: (metric: MailboxReadMetric) => void;
  observePageQueryPlan?: (plan: MailboxPageQueryPlan) => void;
};

type RawMailboxMessage = {
  id: string;
  account_id: string;
  provider_message_id: string;
  thread_id: string;
  from_address: string | null;
  from_name: string | null;
  subject: string | null;
  snippet: string | null;
  received_at: number | null;
  is_read: number;
  human_signal: number | null;
  human_classification: string | null;
  human_classification_reasons: string | null;
  human_classifier_version: string | null;
  attention_behavior: string;
  override_id: string | null;
  override_account_id: string | null;
  override_target_type: string | null;
  override_target_value: string | null;
  override_classification: string | null;
  override_source: string | null;
  override_created_at: number | null;
  override_updated_at: number | null;
};

type RawCountRow = {
  focus_count: number | null;
  normal_count: number | null;
  quiet_count: number | null;
  hidden_count: number | null;
  likely_human_count: number | null;
  automated_or_bulk_count: number | null;
  uncertain_count: number | null;
  unclassified_count: number | null;
  all_count: number;
};

type RawLabelRow = { email_id: string; name: string };
type RawRevisionRow = { account_id: string; revision: number };
type RawQueryPlanRow = { detail: string };

type InboxCursor = {
  version: 1;
  accountId: string;
  id: string;
  attentionRank: number;
  receivedAt: number;
  view: "default" | "focus" | "normal" | "quiet" | "hidden" | "all";
  classification: "human" | "tideline" | "uncertain" | "all";
  accountIds: string[];
  scope?: string;
  revision: string;
};

const attentionRank = { notify: 0, focus: 1, normal: 2, quiet: 3, hidden: 4 } as const;
const reasonCodes = new Set<HumanClassificationReasonCode>([
  "sender_no_reply_pattern", "list_id_header", "list_unsubscribe_header", "bulk_precedence_header",
  "auto_submitted_header", "provider_bulk_signal", "provider_promotions_signal", "provider_transactional_signal",
  "reply_context", "direct_recipient", "conflicting_evidence", "insufficient_evidence",
  "user_message_override", "user_sender_address_override", "user_sender_domain_override",
]);

const normalizedAddressSql = "lower(trim(coalesce(e.from_address, '')))";
const normalizedDomainSql = `case when instr(${normalizedAddressSql}, '@') > 0 then substr(${normalizedAddressSql}, instr(${normalizedAddressSql}, '@') + 1) else '' end`;
const resolvedJoinsSql = `
  left join sender_attention_rules attention_address
    on attention_address.account_id = e.account_id
    and attention_address.scope = 'address'
    and attention_address.value = ${normalizedAddressSql}
  left join sender_attention_rules attention_domain
    on attention_domain.account_id = e.account_id
    and attention_domain.scope = 'domain'
    and attention_domain.value = ${normalizedDomainSql}
  left join human_classification_overrides classification_message
    on classification_message.account_id = e.account_id
    and classification_message.target_type = 'message'
    and classification_message.target_value = e.id
  left join human_classification_overrides classification_address
    on classification_address.account_id = e.account_id
    and classification_address.target_type = 'sender_address'
    and classification_address.target_value = ${normalizedAddressSql}
  left join human_classification_overrides classification_domain
    on classification_domain.account_id = e.account_id
    and classification_domain.target_type = 'sender_domain'
    and classification_domain.target_value = ${normalizedDomainSql}`;
const attentionSql = "coalesce(attention_address.behavior, attention_domain.behavior, 'normal')";
const effectiveClassificationSql = "coalesce(classification_message.classification, classification_address.classification, classification_domain.classification, e.human_classification, 'unclassified')";
const effectiveOverrideSql = {
  id: "coalesce(classification_message.id, classification_address.id, classification_domain.id)",
  accountId: "coalesce(classification_message.account_id, classification_address.account_id, classification_domain.account_id)",
  targetType: "coalesce(classification_message.target_type, classification_address.target_type, classification_domain.target_type)",
  targetValue: "coalesce(classification_message.target_value, classification_address.target_value, classification_domain.target_value)",
  classification: "coalesce(classification_message.classification, classification_address.classification, classification_domain.classification)",
  source: "coalesce(classification_message.source, classification_address.source, classification_domain.source)",
  createdAt: "coalesce(classification_message.created_at, classification_address.created_at, classification_domain.created_at)",
  updatedAt: "coalesce(classification_message.updated_at, classification_address.updated_at, classification_domain.updated_at)",
} as const;

/**
 * Deep mailbox-read module. Its single read interface owns authorization scope,
 * effective Organization attention/classification, keyset pagination, counts,
 * bounded enrichment, freshness, and latency instrumentation.
 */
export function createMailboxReader(sqlite: Database, options: MailboxReaderOptions = {}) {
  const clock = options.clock ?? (() => performance.now());

  return {
    read(input: { accounts: MailboxReadAccount[]; query: MailboxReadQuery }): MailboxReadResult {
      // Pin revision, counts, page, and enrichment to one SQLite snapshot so a
      // concurrent writer cannot produce a response paired with an older token.
      return sqlite.transaction(() => {
      const startedAt = clock();
      // Preserve the Account ordering chosen by the authenticated adapter; it
      // is user-visible metadata and was part of the existing inbox contract.
      const accounts = [...input.accounts];
      const accountIds = accounts.map((account) => account.id);
      if (accountIds.length === 0) throw new Error("Mailbox reads require at least one authorized account");

      const classification = input.query.classification ?? "all";
      const view = input.query.view ?? "default";
      const scope = cursorScope(input.query);
      const revision = mailboxRevision(sqlite, accountIds);
      const cursor = decodeCursor(input.query.cursor);
      validateCursor(cursor, { accountIds, classification, revision, scope, view });

      const base = buildBaseWhere(accountIds, input.query);
      const countStartedAt = clock();
      const countRows = queryAll<RawCountRow>(sqlite, `
        select
          sum(case when attention_behavior in ('notify', 'focus') then 1 else 0 end) as focus_count,
          sum(case when attention_behavior = 'normal' then 1 else 0 end) as normal_count,
          sum(case when attention_behavior = 'quiet' then 1 else 0 end) as quiet_count,
          sum(case when attention_behavior = 'hidden' then 1 else 0 end) as hidden_count,
          sum(case when effective_classification = 'likely_human' then 1 else 0 end) as likely_human_count,
          sum(case when effective_classification = 'automated_or_bulk' then 1 else 0 end) as automated_or_bulk_count,
          sum(case when effective_classification = 'uncertain' then 1 else 0 end) as uncertain_count,
          sum(case when effective_classification = 'unclassified' then 1 else 0 end) as unclassified_count,
          count(*) as all_count
        from (
          select ${attentionSql} as attention_behavior, ${effectiveClassificationSql} as effective_classification
          from emails e
          ${resolvedJoinsSql}
          where ${base.sql}
        ) resolved`, base.params);
      const counts = countRows[0] ?? emptyCounts();
      const countDurationMs = clock() - countStartedAt;

      const pageStartedAt = clock();
      const requestedRows = input.query.limit + 1;
      const pageRows: RawMailboxMessage[] = [];
      for (const behavior of behaviorsForView(input.query.view)) {
        if (pageRows.length >= requestedRows) break;
        const rank = attentionRank[behavior];
        if (cursor && rank < cursor.attentionRank) continue;
        const remaining = requestedRows - pageRows.length;
        const keyset = cursor && rank === cursor.attentionRank
          ? {
              sql: `and (
                coalesce(e.received_at, 0) < ? or
                (coalesce(e.received_at, 0) = ? and e.account_id > ?) or
                (coalesce(e.received_at, 0) = ? and e.account_id = ? and e.id > ?)
              )`,
              params: [cursor.receivedAt, cursor.receivedAt, cursor.accountId, cursor.receivedAt, cursor.accountId, cursor.id],
            }
          : { sql: "", params: [] as Array<string | number | null> };
        const classificationPredicate = classificationWhere(classification);
        const pageSql = `
          select
            e.id, e.account_id, e.provider_message_id, e.thread_id,
            e.from_address, e.from_name, e.subject, e.snippet, e.received_at,
            e.is_read, e.human_signal, e.human_classification,
            e.human_classification_reasons, e.human_classifier_version,
            ${attentionSql} as attention_behavior,
            ${effectiveOverrideSql.id} as override_id,
            ${effectiveOverrideSql.accountId} as override_account_id,
            ${effectiveOverrideSql.targetType} as override_target_type,
            ${effectiveOverrideSql.targetValue} as override_target_value,
            ${effectiveOverrideSql.classification} as override_classification,
            ${effectiveOverrideSql.source} as override_source,
            ${effectiveOverrideSql.createdAt} as override_created_at,
            ${effectiveOverrideSql.updatedAt} as override_updated_at
          from emails e
          ${resolvedJoinsSql}
          where ${base.sql}
            and ${attentionSql} = ?
            and ${classificationPredicate}
            ${keyset.sql}
          order by coalesce(e.received_at, 0) desc, e.account_id asc, e.id asc
          limit ?`;
        const pageParams = [...base.params, behavior, ...keyset.params, remaining];
        if (options.observePageQueryPlan) {
          options.observePageQueryPlan({
            behavior,
            details: queryAll<RawQueryPlanRow>(sqlite, `explain query plan ${pageSql}`, pageParams).map((row) => row.detail),
          });
        }
        const rows = queryAll<RawMailboxMessage>(sqlite, pageSql, pageParams);
        pageRows.push(...rows);
      }
      const hasNextPage = pageRows.length > input.query.limit;
      const fetchedPageRowCount = pageRows.length;
      if (hasNextPage) pageRows.length = input.query.limit;
      const pageDurationMs = clock() - pageStartedAt;

      const enrichmentStartedAt = clock();
      const labels = readLabels(sqlite, pageRows.map((row) => row.id));
      const accountById = new Map(accounts.map((account) => [account.id, account]));
      const messages = pageRows.map((row): InboxMessage => {
        const account = accountById.get(row.account_id);
        if (!account) throw new Error("A mailbox row escaped its authorized Account scope");
        const humanClassification = resolveClassification(row);
        return {
          id: row.id,
          accountId: row.account_id,
          provider: account.provider,
          providerMessageId: row.provider_message_id,
          threadId: row.thread_id,
          from: { name: row.from_name, email: row.from_address ?? "unknown@invalid" },
          subject: row.subject ?? "",
          snippet: row.snippet ?? "",
          receivedAt: new Date(row.received_at ?? 0).toISOString(),
          unread: row.is_read !== 1,
          labels: labels.byMessage.get(row.id) ?? [],
          attentionBehavior: row.attention_behavior as AttentionBehavior,
          humanSignal: humanClassification.effective.score,
          humanClassification,
        };
      });
      const enrichmentDurationMs = clock() - enrichmentStartedAt;
      const last = pageRows.at(-1);
      const response: MailboxReadResult["response"] = {
        accounts: accounts.map((account) => account.serialized),
        messages,
        counts: {
          attention: {
            focus: numberCount(counts.focus_count),
            normal: numberCount(counts.normal_count),
            quiet: numberCount(counts.quiet_count),
            hidden: numberCount(counts.hidden_count),
            all: numberCount(counts.all_count),
          },
          classification: {
            likely_human: numberCount(counts.likely_human_count),
            automated_or_bulk: numberCount(counts.automated_or_bulk_count),
            uncertain: numberCount(counts.uncertain_count),
            unclassified: numberCount(counts.unclassified_count),
            all: numberCount(counts.all_count),
          },
        },
        freshness: {
          revision,
          lastSyncedAt: mailboxFreshAt(accounts),
        },
        nextCursor: hasNextPage && last
          ? encodeCursor({
              version: 1,
              accountId: last.account_id,
              id: last.id,
              attentionRank: attentionRank[last.attention_behavior as AttentionBehavior],
              receivedAt: last.received_at ?? 0,
              view,
              classification,
              accountIds,
              ...(scope ? { scope } : {}),
              revision,
            })
          : null,
      };
      const metric: MailboxReadMetric = {
        durationMs: clock() - startedAt,
        countDurationMs,
        pageDurationMs,
        enrichmentDurationMs,
        accountCount: accounts.length,
        limit: input.query.limit,
        returnedMessages: messages.length,
        aggregateRowsReturned: countRows.length,
        pageRowsProjected: fetchedPageRowCount,
        lookaheadRowsProjected: hasNextPage ? 1 : 0,
        labelAssociationRowsLoaded: labels.rowCount,
        effectiveOverridesProjected: pageRows.reduce((total, row) => total + (row.override_id ? 1 : 0), 0),
        revision,
      };
      options.observe?.(metric);
      return { response, metric };
      })();
    },
  };
}

function buildBaseWhere(accountIds: string[], query: MailboxReadQuery) {
  const clauses = [`e.account_id in (${placeholders(accountIds.length)})`];
  const params: Array<string | number | null> = [...accountIds];
  if (query.query?.trim()) {
    clauses.push(`lower(coalesce(e.from_name, '') || char(10) || coalesce(e.from_address, '') || char(10) || coalesce(e.subject, '') || char(10) || coalesce(e.snippet, '')) like ? escape '\\'`);
    params.push(`%${escapeLike(query.query.trim().toLocaleLowerCase())}%`);
  }
  if (query.sender?.trim()) {
    clauses.push(`lower(coalesce(e.from_name, '') || char(10) || coalesce(e.from_address, '')) like ? escape '\\'`);
    params.push(`%${escapeLike(query.sender.trim().toLocaleLowerCase())}%`);
  }
  if (query.receivedAfter) {
    clauses.push("coalesce(e.received_at, 0) >= ?");
    params.push(Date.parse(query.receivedAfter));
  }
  if (query.receivedBefore) {
    clauses.push("coalesce(e.received_at, 0) <= ?");
    params.push(Date.parse(query.receivedBefore));
  }
  return { sql: clauses.join(" and "), params };
}

function classificationWhere(classification: MailboxReadQuery["classification"] | "all") {
  if (classification === "human") return `${effectiveClassificationSql} = 'likely_human'`;
  if (classification === "tideline") return `${effectiveClassificationSql} = 'automated_or_bulk'`;
  if (classification === "uncertain") return `${effectiveClassificationSql} in ('uncertain', 'unclassified')`;
  return "1 = 1";
}

function behaviorsForView(view: MailboxReadQuery["view"]): AttentionBehavior[] {
  if (view === "focus") return ["notify", "focus"];
  if (view === "normal") return ["normal"];
  if (view === "quiet") return ["quiet"];
  if (view === "hidden") return ["hidden"];
  if (view === "all") return ["notify", "focus", "normal", "quiet", "hidden"];
  return ["notify", "focus", "normal"];
}

function mailboxRevision(sqlite: Database, accountIds: string[]) {
  const rows = queryAll<RawRevisionRow>(sqlite, `
    select account_id, revision
    from mailbox_revisions
    where account_id in (${placeholders(accountIds.length)})`, accountIds);
  const revisions = new Map(rows.map((row) => [row.account_id, row.revision]));
  if (revisions.size !== accountIds.length) throw new Error("Mailbox revision state is missing for an authorized Account");
  const digest = createHash("sha256")
    .update(JSON.stringify(accountIds.map((id) => ({ id, revision: revisions.get(id) }))))
    .digest("hex");
  return `mailbox-v2:${digest}`;
}

function mailboxFreshAt(accounts: MailboxReadAccount[]) {
  if (accounts.some((account) => account.lastSyncedAt === null)) return null;
  const oldest = Math.min(...accounts.map((account) => account.lastSyncedAt!.getTime()));
  return new Date(oldest).toISOString();
}

function cursorScope(query: MailboxReadQuery) {
  return query.query || query.sender || query.receivedAfter || query.receivedBefore
    ? JSON.stringify({
        query: query.query?.trim() ?? null,
        sender: query.sender?.trim().toLocaleLowerCase() ?? null,
        receivedAfter: query.receivedAfter ?? null,
        receivedBefore: query.receivedBefore ?? null,
      })
    : undefined;
}

function validateCursor(
  cursor: InboxCursor | null,
  expected: Pick<InboxCursor, "accountIds" | "classification" | "revision" | "scope" | "view">,
) {
  if (!cursor) return;
  if (cursor.view !== expected.view
    || cursor.classification !== expected.classification
    || cursor.revision !== expected.revision
    || cursor.scope !== expected.scope
    || JSON.stringify(cursor.accountIds) !== JSON.stringify(expected.accountIds)
    || !expected.accountIds.includes(cursor.accountId)) {
    throw new MailboxCursorError("The inbox cursor does not match this mailbox revision, Account scope, or filter");
  }
}

function encodeCursor(cursor: InboxCursor) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined): InboxCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<InboxCursor>;
    if (parsed.version === 1
      && typeof parsed.accountId === "string" && parsed.accountId.length > 0
      && typeof parsed.id === "string" && parsed.id.length > 0
      && Number.isInteger(parsed.attentionRank) && parsed.attentionRank! >= 0 && parsed.attentionRank! <= 4
      && typeof parsed.receivedAt === "number" && Number.isFinite(parsed.receivedAt)
      && ["default", "focus", "normal", "quiet", "hidden", "all"].includes(parsed.view ?? "")
      && ["human", "tideline", "uncertain", "all"].includes(parsed.classification ?? "")
      && Array.isArray(parsed.accountIds) && parsed.accountIds.length > 0
      && parsed.accountIds.every((accountId) => typeof accountId === "string" && accountId.length > 0)
      && (parsed.scope === undefined || typeof parsed.scope === "string")
      && typeof parsed.revision === "string" && parsed.revision.startsWith("mailbox-v2:")) {
      return parsed as InboxCursor;
    }
  } catch { /* Invalid cursors are rejected below. */ }
  throw new MailboxCursorError("The inbox cursor is invalid");
}

function readLabels(sqlite: Database, messageIds: string[]) {
  const labelsByMessage = new Map<string, string[]>();
  if (messageIds.length === 0) return { byMessage: labelsByMessage, rowCount: 0 };
  const rows = queryAll<RawLabelRow>(sqlite, `
    select el.email_id, l.name
    from email_labels el
    inner join labels l on l.id = el.label_id
    where el.email_id in (${placeholders(messageIds.length)})
    order by el.email_id, l.name`, messageIds);
  for (const row of rows) {
    const names = labelsByMessage.get(row.email_id) ?? [];
    if (!names.includes(row.name)) names.push(row.name);
    labelsByMessage.set(row.email_id, names);
  }
  return { byMessage: labelsByMessage, rowCount: rows.length };
}

function resolveClassification(row: RawMailboxMessage): HumanClassificationResult {
  const automatic = automaticClassification(row);
  if (row.override_id && row.override_account_id && row.override_target_type && row.override_target_value
    && row.override_classification && row.override_source && row.override_created_at !== null && row.override_updated_at !== null) {
    const target = row.override_target_type === "message"
      ? { scope: "message" as const, messageId: row.override_target_value }
      : row.override_target_type === "sender_address"
        ? { scope: "sender_address" as const, address: row.override_target_value }
        : { scope: "sender_domain" as const, domain: row.override_target_value };
    const userOverride = humanClassificationOverrideSchema.parse({
      id: row.override_id,
      accountId: row.override_account_id,
      target,
      classification: row.override_classification,
      source: row.override_source,
      createdAt: new Date(row.override_created_at).toISOString(),
      updatedAt: new Date(row.override_updated_at).toISOString(),
    });
    const overrideReason = {
      message: "user_message_override",
      sender_address: "user_sender_address_override",
      sender_domain: "user_sender_domain_override",
    } as const;
    return {
      automatic,
      userOverride,
      effective: {
        classification: humanClassificationSchema.parse(row.override_classification),
        score: null,
        reasonCodes: [overrideReason[row.override_target_type as keyof typeof overrideReason]],
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
  return { automatic, userOverride: null, effective: { ...effective, source: "automatic_heuristic", userOverride: null } };
}

function automaticClassification(row: RawMailboxMessage): HumanClassificationAssessment | null {
  if (!row.human_classification) return null;
  const parsed = humanClassificationAssessmentSchema.safeParse({
    classification: row.human_classification,
    score: row.human_signal,
    reasonCodes: parseReasons(row.human_classification_reasons),
    classifierVersion: row.human_classifier_version,
  });
  return parsed.success ? parsed.data : null;
}

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

function queryAll<T>(sqlite: Database, statement: string, params: Array<string | number | null>): T[] {
  return sqlite.query(statement).all(...params) as T[];
}

function placeholders(count: number) {
  return Array.from({ length: count }, () => "?").join(", ");
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function numberCount(value: number | null | undefined) {
  return Number(value ?? 0);
}

function emptyCounts(): RawCountRow {
  return {
    focus_count: 0,
    normal_count: 0,
    quiet_count: 0,
    hidden_count: 0,
    likely_human_count: 0,
    automated_or_bulk_count: 0,
    uncertain_count: 0,
    unclassified_count: 0,
    all_count: 0,
  };
}
