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
  syncHistoryId: string | null;
  lastSyncedAt: Date | null;
  updatedAt: Date;
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
  projectedRows: number;
  revision: string;
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
type RawOverrideRow = {
  id: string;
  account_id: string;
  target_type: string;
  target_value: string;
  classification: string;
  source: string;
  created_at: number;
  updated_at: number;
};

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

/**
 * Deep mailbox-read module. Its single read interface owns authorization scope,
 * effective Organization attention/classification, keyset pagination, counts,
 * bounded enrichment, freshness, and latency instrumentation.
 */
export function createMailboxReader(sqlite: Database, options: MailboxReaderOptions = {}) {
  const clock = options.clock ?? (() => performance.now());

  return {
    read(input: { accounts: MailboxReadAccount[]; query: MailboxReadQuery }): MailboxReadResult {
      const startedAt = clock();
      // Preserve the Account ordering chosen by the authenticated adapter; it
      // is user-visible metadata and was part of the existing inbox contract.
      const accounts = [...input.accounts];
      const accountIds = accounts.map((account) => account.id);
      if (accountIds.length === 0) throw new Error("Mailbox reads require at least one authorized account");

      const classification = input.query.classification ?? "all";
      const view = input.query.view ?? "default";
      const scope = cursorScope(input.query);
      const revision = mailboxRevision(accounts);
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
        const rows = queryAll<RawMailboxMessage>(sqlite, `
          select
            e.id, e.account_id, e.provider_message_id, e.thread_id,
            e.from_address, e.from_name, e.subject, e.snippet, e.received_at,
            e.is_read, e.human_signal, e.human_classification,
            e.human_classification_reasons, e.human_classifier_version,
            ${attentionSql} as attention_behavior
          from emails e
          ${resolvedJoinsSql}
          where ${base.sql}
            and ${attentionSql} = ?
            and ${classificationPredicate}
            ${keyset.sql}
          order by coalesce(e.received_at, 0) desc, e.account_id asc, e.id asc
          limit ?`, [...base.params, behavior, ...keyset.params, remaining]);
        pageRows.push(...rows);
      }
      const hasNextPage = pageRows.length > input.query.limit;
      const fetchedPageRowCount = pageRows.length;
      if (hasNextPage) pageRows.length = input.query.limit;
      const pageDurationMs = clock() - pageStartedAt;

      const enrichmentStartedAt = clock();
      const labelsByMessage = readLabels(sqlite, pageRows.map((row) => row.id));
      const overrides = readOverrides(sqlite, pageRows);
      const accountById = new Map(accounts.map((account) => [account.id, account]));
      const messages = pageRows.map((row): InboxMessage => {
        const account = accountById.get(row.account_id);
        if (!account) throw new Error("A mailbox row escaped its authorized Account scope");
        const humanClassification = resolveClassification(row, overrides);
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
          labels: labelsByMessage.get(row.id) ?? [],
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
        projectedRows: 1 + fetchedPageRowCount + [...labelsByMessage.values()].reduce((total, names) => total + names.length, 0) + overrides.size,
        revision,
      };
      options.observe?.(metric);
      return { response, metric };
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

function mailboxRevision(accounts: MailboxReadAccount[]) {
  const digest = createHash("sha256").update(JSON.stringify(accounts.map((account) => ({
    id: account.id,
    syncHistoryId: account.syncHistoryId,
    lastSyncedAt: account.lastSyncedAt?.getTime() ?? null,
    updatedAt: account.updatedAt.getTime(),
  })))).digest("hex");
  return `mailbox-v1:${digest}`;
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
      && typeof parsed.revision === "string" && parsed.revision.startsWith("mailbox-v1:")) {
      return parsed as InboxCursor;
    }
  } catch { /* Invalid cursors are rejected below. */ }
  throw new MailboxCursorError("The inbox cursor is invalid");
}

function readLabels(sqlite: Database, messageIds: string[]) {
  const labelsByMessage = new Map<string, string[]>();
  if (messageIds.length === 0) return labelsByMessage;
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
  return labelsByMessage;
}

function readOverrides(sqlite: Database, rows: RawMailboxMessage[]) {
  const result = new Map<string, RawOverrideRow>();
  if (rows.length === 0) return result;
  const messageIds = [...new Set(rows.map((row) => row.id))];
  const addresses = [...new Set(rows.map((row) => row.from_address?.trim().toLocaleLowerCase() ?? "").filter(Boolean))];
  const domains = [...new Set(addresses.map((address) => address.split("@")[1] ?? "").filter(Boolean))];
  const accountIds = [...new Set(rows.map((row) => row.account_id))];
  const targets: string[] = [];
  const params: Array<string | number | null> = [...accountIds];
  if (messageIds.length) {
    targets.push(`(target_type = 'message' and target_value in (${placeholders(messageIds.length)}))`);
    params.push(...messageIds);
  }
  if (addresses.length) {
    targets.push(`(target_type = 'sender_address' and target_value in (${placeholders(addresses.length)}))`);
    params.push(...addresses);
  }
  if (domains.length) {
    targets.push(`(target_type = 'sender_domain' and target_value in (${placeholders(domains.length)}))`);
    params.push(...domains);
  }
  const overrideRows = queryAll<RawOverrideRow>(sqlite, `
    select id, account_id, target_type, target_value, classification, source, created_at, updated_at
    from human_classification_overrides
    where account_id in (${placeholders(accountIds.length)}) and (${targets.join(" or ")})`, params);
  for (const row of overrideRows) result.set(`${row.account_id}:${row.target_type}:${row.target_value.toLocaleLowerCase()}`, row);
  return result;
}

function resolveClassification(row: RawMailboxMessage, overrides: ReadonlyMap<string, RawOverrideRow>): HumanClassificationResult {
  const automatic = automaticClassification(row);
  const address = row.from_address?.trim().toLocaleLowerCase() ?? "";
  const domain = address.split("@")[1] ?? "";
  const override = overrides.get(`${row.account_id}:message:${row.id}`)
    ?? (address ? overrides.get(`${row.account_id}:sender_address:${address}`) : undefined)
    ?? (domain ? overrides.get(`${row.account_id}:sender_domain:${domain}`) : undefined);
  if (override) {
    const target = override.target_type === "message"
      ? { scope: "message" as const, messageId: override.target_value }
      : override.target_type === "sender_address"
        ? { scope: "sender_address" as const, address: override.target_value }
        : { scope: "sender_domain" as const, domain: override.target_value };
    const userOverride = humanClassificationOverrideSchema.parse({
      id: override.id,
      accountId: override.account_id,
      target,
      classification: override.classification,
      source: override.source,
      createdAt: new Date(override.created_at).toISOString(),
      updatedAt: new Date(override.updated_at).toISOString(),
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
        classification: humanClassificationSchema.parse(override.classification),
        score: null,
        reasonCodes: [overrideReason[override.target_type as keyof typeof overrideReason]],
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
