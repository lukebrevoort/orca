import { createHash } from "node:crypto";

import {
  organizationDescribeResponseSchema,
  organizationQueryResponseSchema,
  organizationQuerySchema,
  organizationReadScopeSchema,
  type AttentionBehavior,
  type HumanClassificationResult,
  type OrganizationDescribeResponse,
  type OrganizationQueryResponse,
  type OrganizationReadScope,
  type WorkspaceThread,
  type WorkspaceThreadMessage,
} from "@orca/shared";

export type OrganizationAttentionRule = {
  scope: "address" | "domain";
  value: string;
  behavior: AttentionBehavior;
};

export type OrganizationThreadRecord = {
  id: string;
  accountId: string;
  subject: string;
  latestReceivedAt: string;
  messageCount: number;
  readState: "read" | "unread";
  messages: WorkspaceThreadMessage[];
  attentionRules: OrganizationAttentionRule[];
};

/** Storage seam used by the provider-neutral Organization module. */
export type OrganizationRepository = {
  listAccountIds(workspaceId: string): string[];
  listThreads(accountIds: readonly string[]): OrganizationThreadRecord[];
};

export class OrganizationAccessError extends Error {
  readonly code = "account_denied" as const;

  constructor(message = "The requested Account scope is not authorized for this Workspace") {
    super(message);
    this.name = "OrganizationAccessError";
  }
}

export class OrganizationQueryError extends Error {
  readonly code = "invalid_cursor" as const;

  constructor(message: string) {
    super(message);
    this.name = "OrganizationQueryError";
  }
}

export class OrganizationOperationDisabledError extends Error {
  readonly code = "operation_disabled" as const;

  constructor(readonly operation: "simulate" | "apply" | "revert") {
    super(`Organization ${operation} is disabled in this read-only slice`);
    this.name = "OrganizationOperationDisabledError";
  }
}

const workspaceSchema = Object.freeze({
  revision: 1 as const,
  aggregate: "thread" as const,
  resources: ["account", "thread"] as const,
  filters: ["account", "thread", "attention", "classification", "sender", "text", "received_at"] as const,
});

const capabilities = Object.freeze({
  operations: {
    describe: true as const,
    query: true as const,
    simulate: false as const,
    apply: false as const,
    revert: false as const,
  },
  authority: {
    sendMail: false as const,
    deleteProviderMail: false as const,
  },
});

function authorizedAccounts(repository: OrganizationRepository, untrustedScope: unknown): {
  scope: OrganizationReadScope;
  accountIds: string[];
} {
  const scope = organizationReadScopeSchema.parse(untrustedScope);
  const owned = new Set(repository.listAccountIds(scope.workspaceId));
  if (scope.accountIds.some((accountId) => !owned.has(accountId))) throw new OrganizationAccessError();
  return { scope, accountIds: [...scope.accountIds].sort() };
}

function resolveAttention(address: string, rules: readonly OrganizationAttentionRule[]): AttentionBehavior {
  const normalized = address.trim().toLocaleLowerCase();
  const exact = rules.find((rule) => rule.scope === "address" && rule.value === normalized);
  if (exact) return exact.behavior;
  const domain = normalized.split("@")[1] ?? "";
  return rules.find((rule) => rule.scope === "domain" && rule.value === domain)?.behavior ?? "normal";
}

function matchesAttention(behavior: AttentionBehavior, filter: "focus" | "normal" | "quiet" | "hidden" | "all" | undefined): boolean {
  if (!filter) return behavior !== "quiet" && behavior !== "hidden";
  if (filter === "all") return true;
  if (filter === "focus") return behavior === "notify" || behavior === "focus";
  return behavior === filter;
}

function matchesClassification(
  classification: HumanClassificationResult | null,
  filter: "human" | "tideline" | "uncertain" | "all" | undefined,
): boolean {
  if (!filter || filter === "all") return true;
  const value = classification?.effective.classification ?? "unclassified";
  if (filter === "human") return value === "likely_human";
  if (filter === "tideline") return value === "automated_or_bulk";
  return value === "uncertain" || value === "unclassified";
}

const attentionRank: Record<AttentionBehavior, number> = {
  notify: 0,
  focus: 1,
  normal: 2,
  quiet: 3,
  hidden: 4,
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function cursorFingerprint(accountIds: readonly string[], query: ReturnType<typeof organizationQuerySchema.parse>): string {
  return sha256(JSON.stringify({
    accountIds,
    threadId: query.threadId ?? null,
    attention: query.attention ?? null,
    classification: query.classification ?? null,
    text: query.text?.trim().toLocaleLowerCase() ?? null,
    sender: query.sender?.trim().toLocaleLowerCase() ?? null,
    receivedAfter: query.receivedAfter ?? null,
    receivedBefore: query.receivedBefore ?? null,
  }));
}

function threadCursorKey(thread: Pick<WorkspaceThread, "accountId" | "id">): string {
  return sha256(JSON.stringify([thread.accountId, thread.id]));
}

function decodeCursor(cursor: string | undefined, fingerprint: string): string | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      parsed && typeof parsed === "object"
      && "version" in parsed && parsed.version === 1
      && "row" in parsed && typeof parsed.row === "string"
      && "fingerprint" in parsed && parsed.fingerprint === fingerprint
    ) return parsed.row;
  } catch { /* The caller receives one stable error below. */ }
  throw new OrganizationQueryError("The Organization cursor does not match this Account scope or filter");
}

function encodeCursor(thread: Pick<WorkspaceThread, "accountId" | "id">, fingerprint: string): string {
  return Buffer.from(JSON.stringify({ version: 1, row: threadCursorKey(thread), fingerprint }), "utf8").toString("base64url");
}

/**
 * The complete Organization interface. REST, MCP, sync, background work, and
 * React are adapters; organizational meaning and Account enforcement live here.
 */
export function createOrganization(repository: OrganizationRepository) {
  // One Organization instance represents one stable read transaction. Adapters
  // may page it without reloading and re-sorting the complete mailbox each time.
  const rankedSnapshots = new Map<string, {
    threads: WorkspaceThread[];
    counts: { threads: number; messages: number };
    cursorIndexes: Map<string, number>;
  }>();

  return {
    describe(input: { scope: unknown }): OrganizationDescribeResponse {
      const { scope, accountIds } = authorizedAccounts(repository, input.scope);
      return organizationDescribeResponseSchema.parse({
        workspaceId: scope.workspaceId,
        accountIds,
        workspaceSchema,
        capabilities,
      });
    },

    query(input: { scope: unknown; query: unknown }): OrganizationQueryResponse {
      const { scope, accountIds: authorizedAccountIds } = authorizedAccounts(repository, input.scope);
      const query = organizationQuerySchema.parse(input.query);
      const requestedAccountIds = query.accountIds ? [...query.accountIds].sort() : authorizedAccountIds;
      const authorized = new Set(authorizedAccountIds);
      if (requestedAccountIds.some((accountId) => !authorized.has(accountId))) throw new OrganizationAccessError();
      const fingerprint = cursorFingerprint(requestedAccountIds, query);
      let snapshot = rankedSnapshots.get(fingerprint);
      if (!snapshot) {
        const requested = new Set(requestedAccountIds);
        const text = query.text?.trim().toLocaleLowerCase() ?? "";
        const sender = query.sender?.trim().toLocaleLowerCase() ?? "";
        const after = query.receivedAfter ? Date.parse(query.receivedAfter) : null;
        const before = query.receivedBefore ? Date.parse(query.receivedBefore) : null;
        const ranked = repository.listThreads(requestedAccountIds).flatMap((record): WorkspaceThread[] => {
          if (!requested.has(record.accountId)) throw new OrganizationAccessError();
          if (query.threadId && record.id !== query.threadId) return [];
          const latest = record.messages[0];
          const attentionBehavior = resolveAttention(latest?.from.email ?? "", record.attentionRules);
          if (!matchesAttention(attentionBehavior, query.attention)) return [];
          const humanClassification = latest?.humanClassification ?? null;
          if (!matchesClassification(humanClassification, query.classification)) return [];
          const matchingMessages = record.messages.filter((message) => {
            const receivedAt = Date.parse(message.receivedAt);
            if (after !== null && receivedAt < after) return false;
            if (before !== null && receivedAt > before) return false;
            const senderText = `${message.from.name ?? ""}\n${message.from.email}`.toLocaleLowerCase();
            if (sender && !senderText.includes(sender)) return false;
            if (text && !`${senderText}\n${message.subject}\n${message.snippet}`.toLocaleLowerCase().includes(text)) return false;
            return true;
          });
          const requiresMessageMatch = Boolean(text || sender || after !== null || before !== null);
          if (matchingMessages.length === 0 && requiresMessageMatch) return [];
          const humanSignal = record.messages.reduce<number | null>((highest, message) => {
            if (message.humanSignal === null) return highest;
            return highest === null ? message.humanSignal : Math.max(highest, message.humanSignal);
          }, null);
          return [{
            id: record.id,
            accountId: record.accountId,
            subject: record.subject,
            latestReceivedAt: record.latestReceivedAt,
            messageCount: record.messageCount,
            readState: record.readState,
            organization: { attentionBehavior, humanSignal, humanClassification },
            messages: matchingMessages.length > 0 ? matchingMessages : record.messages,
          }];
        });
        ranked.sort((left, right) => attentionRank[left.organization.attentionBehavior] - attentionRank[right.organization.attentionBehavior]
          || Date.parse(right.latestReceivedAt) - Date.parse(left.latestReceivedAt)
          || left.accountId.localeCompare(right.accountId)
          || left.id.localeCompare(right.id));
        snapshot = {
          threads: ranked,
          counts: {
            threads: ranked.length,
            messages: ranked.reduce((total, thread) => total + thread.messages.length, 0),
          },
          cursorIndexes: new Map(ranked.map((thread, index) => [threadCursorKey(thread), index])),
        };
        rankedSnapshots.set(fingerprint, snapshot);
      }

      const cursorRow = decodeCursor(query.cursor, fingerprint);
      const cursorIndex = cursorRow ? (snapshot.cursorIndexes.get(cursorRow) ?? -1) : -1;
      if (cursorRow && cursorIndex < 0) throw new OrganizationQueryError("The Organization cursor is not part of this result");
      const start = cursorIndex + 1;
      const threads = snapshot.threads.slice(start, start + query.limit);
      const last = threads.at(-1);
      return organizationQueryResponseSchema.parse({
        workspaceId: scope.workspaceId,
        accountIds: requestedAccountIds,
        threads,
        counts: snapshot.counts,
        nextCursor: last && start + threads.length < snapshot.threads.length ? encodeCursor(last, fingerprint) : null,
      });
    },

    simulate(_input: { scope: unknown }): never {
      throw new OrganizationOperationDisabledError("simulate");
    },
    apply(_input: { scope: unknown }): never {
      throw new OrganizationOperationDisabledError("apply");
    },
    revert(_input: { scope: unknown }): never {
      throw new OrganizationOperationDisabledError("revert");
    },
  };
}
