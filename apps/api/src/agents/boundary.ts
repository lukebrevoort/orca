import {
  orcaMcpMaximumAccessTokenLifetimeSeconds,
  orcaMcpReadOnlyTools,
  type MailAccount,
  type OrcaAgentExposure,
  type OrcaMcpAuthorizationContext,
  type OrcaMcpScope,
  type OrcaMcpToolName,
  type PropagatedAgentEvent,
} from "@orca/shared";

import { getAgentFeatureFlags } from "./config.ts";

const REDACTED = "[REDACTED]";
const MAX_AGENT_TEXT_LENGTH = 20_000;
const MAX_AGENT_DATA_DEPTH = 8;

const sensitiveKeyNames = new Set([
  "accesstoken",
  "apikey",
  "authorization",
  "bearertoken",
  "clientsecret",
  "cookie",
  "credential",
  "credentials",
  "idtoken",
  "password",
  "privatekey",
  "refreshtoken",
  "secret",
  "session",
  "sessionid",
  "setcookie",
  "token",
]);

const credentialValuePatterns: ReadonlyArray<RegExp> = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:sk|rk|sess)-[A-Za-z0-9_-]{8,}\b/g,
  /\bya29\.[A-Za-z0-9._-]{8,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b(?:access[_ -]?token|refresh[_ -]?token|api[_ -]?key|client[_ -]?secret|password)\s*[:=]\s*["']?[^\s,"';]+/gi,
  /\b(?:authorization|cookie|set-cookie)\s*:\s*[^\r\n]+/gi,
];

export type OrcaAgentBoundaryPolicy =
  | { enabled: false; issuer: null; resource: null }
  | { enabled: true; issuer: string; resource: string };

export type AgentBoundaryDenialCode =
  | "integration_disabled"
  | "invalid_authorization_time"
  | "token_expired"
  | "token_lifetime_exceeded"
  | "grant_revoked"
  | "issuer_mismatch"
  | "resource_mismatch"
  | "user_mismatch"
  | "scope_escalation"
  | "missing_scope"
  | "unsupported_tool"
  | "no_current_accounts"
  | "account_denied";

export type AgentBoundaryDecision =
  | {
      allowed: true;
      allowedAccountIds: string[];
      exposure: OrcaAgentExposure;
      requiredScope: OrcaMcpScope;
      toolName: OrcaMcpToolName;
    }
  | {
      allowed: false;
      code: AgentBoundaryDenialCode;
    };

export type AllowedAgentBoundaryDecision = Extract<AgentBoundaryDecision, { allowed: true }>;

export type OrcaAgentAuthorizationInput = {
  authorization: OrcaMcpAuthorizationContext;
  currentAccountIds: readonly string[];
  expectedUserId: string;
  grantRevokedAt?: string | null;
  now?: Date;
  requestedAccountId?: string;
  toolName: string;
};

type RedactionState = {
  redacted: boolean;
  truncated: boolean;
};

export type AgentMailProjectionSource = {
  id: string;
  accountId: string;
  provider: string;
  threadId: string;
  from: { name: string | null; email: string };
  subject: string;
  snippet: string;
  receivedAt: string;
  unread: boolean;
  labels: readonly string[];
  attentionBehavior?: string;
  humanSignal?: number | null;
  humanClassification?: unknown;
  to?: ReadonlyArray<{ name: string | null; email: string }>;
  cc?: ReadonlyArray<{ name: string | null; email: string }>;
  bodyText?: string | null;
  [key: string]: unknown;
};

function requireCanonicalAgentUrl(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required when ORCA_M6_MCP_ENABLED=true`);

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }

  const isLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${name} must be a credential-free HTTPS URL without query or fragment (HTTP is development-only on loopback)`);
  }

  return value;
}

/**
 * The ChatGPT/Codex surface is fail-closed. Merely configuring an issuer and
 * resource does not enable it; the explicit M6 feature flag is also required.
 */
export function getOrcaAgentBoundaryPolicy(
  env: NodeJS.ProcessEnv = process.env,
): OrcaAgentBoundaryPolicy {
  if (!getAgentFeatureFlags(env).mcpEnabled) {
    return { enabled: false, issuer: null, resource: null };
  }

  return {
    enabled: true,
    issuer: requireCanonicalAgentUrl(env.ORCA_M6_MCP_ISSUER, "ORCA_M6_MCP_ISSUER"),
    resource: requireCanonicalAgentUrl(env.ORCA_M6_MCP_RESOURCE, "ORCA_M6_MCP_RESOURCE"),
  };
}

function deny(code: AgentBoundaryDenialCode): AgentBoundaryDecision {
  return { allowed: false, code };
}

/**
 * Authorizes one contract operation after signature verification has produced
 * an OrcaMcpAuthorizationContext. Every handler must use the returned account
 * intersection for its query; claims alone never establish current ownership.
 */
export function authorizeAgentToolRequest(
  policy: OrcaAgentBoundaryPolicy,
  input: OrcaAgentAuthorizationInput,
): AgentBoundaryDecision {
  if (!policy.enabled) return deny("integration_disabled");

  const tool = orcaMcpReadOnlyTools.find((candidate) => candidate.name === input.toolName);
  if (!tool) return deny("unsupported_tool");

  const supportedScopes = new Set(orcaMcpReadOnlyTools.map((candidate) => candidate.requiredScope));
  if (input.authorization.scopes.some((scope) => !supportedScopes.has(scope))) {
    return deny("scope_escalation");
  }
  if (!input.authorization.scopes.includes(tool.requiredScope)) return deny("missing_scope");

  const now = (input.now ?? new Date()).getTime();
  const issuedAt = Date.parse(input.authorization.issuedAt);
  const expiresAt = Date.parse(input.authorization.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || issuedAt > now) {
    return deny("invalid_authorization_time");
  }
  if (expiresAt <= now) return deny("token_expired");
  if (expiresAt - issuedAt > orcaMcpMaximumAccessTokenLifetimeSeconds * 1_000) {
    return deny("token_lifetime_exceeded");
  }
  if (input.grantRevokedAt) return deny("grant_revoked");

  if (input.authorization.issuer !== policy.issuer) return deny("issuer_mismatch");
  if (input.authorization.resource !== policy.resource) return deny("resource_mismatch");
  if (input.authorization.userId !== input.expectedUserId) return deny("user_mismatch");

  const claimedAccountIds = new Set(input.authorization.accountIds);
  const allowedAccountIds = [...new Set(input.currentAccountIds)].filter((accountId) =>
    claimedAccountIds.has(accountId),
  );
  if (allowedAccountIds.length === 0) return deny("no_current_accounts");
  if (input.requestedAccountId && !allowedAccountIds.includes(input.requestedAccountId)) {
    return deny("account_denied");
  }

  return {
    allowed: true,
    allowedAccountIds: input.requestedAccountId
      ? [input.requestedAccountId]
      : allowedAccountIds,
    exposure: tool.exposure,
    requiredScope: tool.requiredScope,
    toolName: tool.name,
  };
}

function normalizeSensitiveKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function redactTextWithState(value: string, maximumLength = MAX_AGENT_TEXT_LENGTH): {
  value: string;
  state: RedactionState;
} {
  let result = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  let redacted = false;

  for (const pattern of credentialValuePatterns) {
    result = result.replace(pattern, () => {
      redacted = true;
      return REDACTED;
    });
  }

  const truncated = result.length > maximumLength;
  if (truncated) result = `${result.slice(0, maximumLength)}…[TRUNCATED]`;

  return { value: result, state: { redacted, truncated } };
}

/** Best-effort lexical redaction complements, but never replaces, allowlists. */
export function redactAgentText(value: string, maximumLength = MAX_AGENT_TEXT_LENGTH): string {
  return redactTextWithState(value, maximumLength).value;
}

/**
 * Sanitizes diagnostic/derived values before they cross the agent boundary.
 * Mail and event results must still use the explicit projection functions.
 */
export function redactAgentData(value: unknown): unknown {
  const active = new WeakSet<object>();

  function visit(current: unknown, depth: number): unknown {
    if (depth > MAX_AGENT_DATA_DEPTH) return "[MAX_DEPTH]";
    if (typeof current === "string") return redactAgentText(current);
    if (current === null || typeof current === "number" || typeof current === "boolean") return current;
    if (typeof current === "bigint") return current.toString();
    if (typeof current === "undefined") return null;
    if (typeof current === "function" || typeof current === "symbol") return `[${typeof current}]`;
    if (current instanceof Date) return current.toISOString();
    if (current instanceof Error) return { name: current.name, message: redactAgentText(current.message) };
    if (typeof current !== "object") return String(current);
    if (active.has(current)) return "[CIRCULAR]";
    active.add(current);
    try {
      if (Array.isArray(current)) return current.map((item) => visit(item, depth + 1));

      return Object.fromEntries(
        Object.entries(current).map(([key, item]) => [
          key,
          sensitiveKeyNames.has(normalizeSensitiveKey(key)) ? REDACTED : visit(item, depth + 1),
        ]),
      );
    } finally {
      active.delete(current);
    }
  }

  return visit(value, 0);
}

function redactFields(fields: Record<string, string | null | undefined>): {
  fields: Record<string, string | null>;
  redacted: boolean;
  truncatedFields: string[];
} {
  let redacted = false;
  const truncatedFields: string[] = [];
  const entries = Object.entries(fields).map(([key, value]) => {
    if (value === null || value === undefined) return [key, null] as const;
    const result = redactTextWithState(value);
    redacted ||= result.state.redacted;
    if (result.state.truncated) truncatedFields.push(key);
    return [key, result.value] as const;
  });
  return { fields: Object.fromEntries(entries), redacted, truncatedFields };
}

function assertProjectionAccount(accountId: string, allowedAccountIds: readonly string[]): void {
  if (!allowedAccountIds.includes(accountId)) {
    throw new Error("Agent projection denied for an account outside the authorized intersection");
  }
}

function projectContact(contact: { name: string | null; email: string }): {
  name: string | null;
  email: string;
} {
  return {
    name: contact.name === null ? null : redactAgentText(contact.name, 200),
    email: redactAgentText(contact.email, 320),
  };
}

function projectSourceUrl(value: string): string {
  try {
    const url = new URL(value);
    const threadId = url.searchParams.get("thread");
    const accountId = url.searchParams.get("accountId");
    url.username = "";
    url.password = "";
    url.search = "";
    if (threadId) url.searchParams.set("thread", threadId);
    if (accountId) url.searchParams.set("accountId", accountId);
    url.hash = "";
    return url.toString();
  } catch {
    return REDACTED;
  }
}

/**
 * Projects mail through a fixed allowlist. Provider payloads, HTML, headers,
 * BCC, attachment contents, and provider/auth identifiers cannot pass through.
 */
export function projectMailForAgent(
  source: AgentMailProjectionSource,
  decision: AllowedAgentBoundaryDecision,
): Record<string, unknown> {
  if (decision.exposure !== "mail_metadata" && decision.exposure !== "mail_content") {
    throw new Error("Agent mail projection requires an authorized mail exposure");
  }
  assertProjectionAccount(source.accountId, decision.allowedAccountIds);

  const textual = redactFields({
    subject: source.subject,
    snippet: source.snippet,
    ...(decision.exposure === "mail_content" ? { bodyText: source.bodyText ?? null } : {}),
  });

  return {
    id: source.id,
    accountId: source.accountId,
    provider: source.provider,
    threadId: source.threadId,
    from: projectContact(source.from),
    subject: textual.fields.subject,
    snippet: textual.fields.snippet,
    receivedAt: source.receivedAt,
    unread: source.unread,
    labels: source.labels.map((label) => redactAgentText(label, 200)),
    attentionBehavior: source.attentionBehavior ?? null,
    humanSignal: source.humanSignal ?? null,
    humanClassification: redactAgentData(source.humanClassification ?? null),
    ...(decision.exposure === "mail_content"
      ? {
          to: (source.to ?? []).map(projectContact),
          cc: (source.cc ?? []).map(projectContact),
          bodyText: textual.fields.bodyText,
        }
      : {}),
    safety: {
      contentTrust: "untrusted_external_content",
      redactionsApplied: textual.redacted,
      truncatedFields: textual.truncatedFields,
    },
  };
}

/** Agent events expose their explanation and source, never the owner id. */
export function projectAgentEventForAgent(
  event: PropagatedAgentEvent,
  decision: AllowedAgentBoundaryDecision,
): Record<string, unknown> {
  if (decision.exposure !== "agent_event") {
    throw new Error("Agent event projection requires an authorized event exposure");
  }
  assertProjectionAccount(event.source.accountId, decision.allowedAccountIds);
  const textual = redactFields({
    subject: event.source.subject,
    title: event.title,
    summary: event.summary,
    whyThisMatters: event.whyThisMatters,
    suggestedNextStep: event.suggestedNextStep,
  });

  return {
    id: event.id,
    source: {
      accountId: event.source.accountId,
      provider: event.source.provider,
      messageId: event.source.messageId,
      threadId: event.source.threadId,
      sender: projectContact(event.source.sender),
      subject: textual.fields.subject,
      receivedAt: event.source.receivedAt,
      sourceUrl: projectSourceUrl(event.source.sourceUrl),
    },
    provenance: event.provenance,
    eventKind: event.eventKind,
    importance: event.importance,
    relevance: event.relevance,
    destination: event.destination,
    reasonCodes: event.reasonCodes,
    title: textual.fields.title,
    summary: textual.fields.summary,
    whyThisMatters: textual.fields.whyThisMatters,
    suggestedNextStep: textual.fields.suggestedNextStep,
    humanClassification: event.humanClassification,
    evaluatedAt: event.evaluatedAt,
    lifecycle: event.lifecycle,
    safety: {
      contentTrust: "untrusted_external_content",
      redactionsApplied: textual.redacted,
      truncatedFields: textual.truncatedFields,
    },
  };
}

/** Connection status reveals identity needed to choose an account, not grants. */
export function projectConnectionStatusForAgent(
  accounts: readonly MailAccount[],
  decision: AllowedAgentBoundaryDecision,
): Array<Record<string, unknown>> {
  if (decision.exposure !== "connection_status") {
    throw new Error("Connection projection requires an authorized connection-status exposure");
  }
  const allowed = new Set(decision.allowedAccountIds);
  return accounts
    .filter((account) => allowed.has(account.id))
    .map((account) => ({
      id: account.id,
      provider: account.provider,
      email: redactAgentText(account.email, 320),
      displayName: redactAgentText(account.displayName, 200),
      connectedForRead: account.capabilities.read,
      agentAccess: "read_only",
    }));
}
