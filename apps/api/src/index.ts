import { createHash } from "node:crypto";

import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { validator } from "hono/validator";
import sanitizeHtml from "sanitize-html";
import {
  type AttentionBehavior,
  type ResolvedSenderAttention,
  type HumanClassificationResult,
  type HumanClassificationAssessment,
  type HumanClassificationReasonCode,
  type InboxMessage,
  type CalendarAvailabilityResponse,
  type CalendarWorkingHours,
  type MailAccount,
  type MailProvider,
  type McpGetConnectionStatusInput,
  type McpGetThreadInput,
  type McpListAgentEventsInput,
  type McpSearchMailInput,
  type OrganizationActor,
  type ThreadDetail,
  agentEventLifecycleStateSchema,
  agentEventListPageSchema,
  agentPropagationMuteRuleSchema,
  attentionBehaviorSchema,
  batchSenderAttentionChangeSchema,
  attentionViewSettingSchema,
  authSessionSchema,
  calendarWorkingHoursSchema,
  collectionSchema,
  createCollectionSchema,
  createHumanClassificationOverrideSchema,
  createMessageDraftSchema,
  deliveryResultSchema,
  deleteHumanClassificationOverrideSchema,
  gmailLabelMigrationSchema,
  importGmailLabelsSchema,
  humanClassificationAssessmentSchema,
  humanClassificationSchema,
  humanClassificationOverrideSchema,
  humanClassificationResultSchema,
  createPinSchema,
  createReminderSchema,
  createSenderAttentionRuleSchema,
  inboxQuerySchema,
  inboxResponseSchema,
  mailAccountPageSchema,
  mailAccountSchema,
  messageDraftSchema,
  legacyPinFilterFromOrganizationSavedQueryDefinition,
  normalizeOrganizationSavedQueryDefinition,
  organizationSavedQueryDefinitionFromLegacyPinFilter,
  organizationAuthorityTraceSchema,
  pinFilterSchema,
  listHumanClassificationOverridesSchema,
  resolveHumanClassificationSchema,
  resolveSenderAttentionSchema,
  resolvedSenderAttentionSchema,
  pinSchema,
  propagatedAgentEventSchema,
  reminderSchema,
  reminderViewSettingsSchema,
  replyBriefOutputSchema,
  senderAttentionRuleSchema,
  senderAttentionBatchResultSchema,
  syncStatusSchema,
  sendMessageDraftSchema,
  threadDetailSchema,
  threadQuerySchema,
  updateAttentionViewSettingSchema,
  updateAgentEventLifecycleSchema,
  updateCollectionSchema,
  updateHumanClassificationOverrideSchema,
  updatePinSchema,
  updateReminderSchema,
  updateMessageDraftSchema,
  updateSenderAttentionRuleSchema,
  updateUserPreferencesSchema,
  userPreferencesSchema,
} from "@orca/shared";

import { requireAuth, type AuthVariables } from "./auth/middleware.ts";
import { applySenderAttentionBatch } from "./attention/batch.ts";
import { getMcpOAuthConfig, type McpOAuthConfig } from "./auth/mcp/config.ts";
import { registerMcpOAuthRoutes } from "./auth/mcp/routes.ts";
import { getServerConfig } from "./config/server.ts";
import { createDatabaseClient } from "./db/client.ts";
import { attentionViewSettings, calendarPreferences, collections, collectionThreads, emailAttachments, emailLabels, emails, gmailLabelCollectionImports, gmailLabelMigrations, humanClassificationOverrides, labels, mcpConnectionAccounts, mcpConnections, messageDrafts, oauthAccounts, organizationChangeSets, organizationSavedQueries, pins, reminderViewSettings, senderAttentionRules, threadReminders, threads, userPreferences, users } from "./db/schema.ts";
import { GmailSyncError, syncGmailAccountPage, withGmailSyncLock } from "./providers/gmail/sync.ts";
import { createGmailClient, type GmailClient } from "./providers/gmail/client.ts";
import { loadGmailPushConfig, type GmailPushConfig } from "./providers/gmail/push-config.ts";
import {
  GmailPushError,
  parseGmailPubSubNotification,
  verifyGmailPushToken,
} from "./providers/gmail/push.ts";
import type { GmailSyncCoordinator } from "./providers/gmail/sync-coordinator.ts";
import { createDefaultGmailSyncCoordinator } from "./providers/gmail/sync-runtime.ts";
import { startGmailSyncScheduler } from "./providers/gmail/scheduler.ts";
import type { GmailDraftMirrorInput, GmailDraftMirrorResult } from "./providers/gmail/drafts.ts";
import { GmailTransportError, type GmailTransport } from "./providers/gmail/transport.ts";
import { providerRegistry as defaultProviderRegistry, type ProviderRegistry } from "./providers/registry.ts";
import { ProviderNotImplementedError, type ProviderTransport } from "./providers/shared/interfaces.ts";
import { createOnDemandReplyBrief, interpretRequestedAvailabilityWindows, replyBriefInvocationRequestSchema, type ReplyBriefInvocationRequest } from "./reply-brief.ts";
import { handleFeedbackRequest } from "./feedback.ts";
import { createLinearFeedbackSubmitter } from "./integrations/linear.ts";
import { getOrcaAgentBoundaryPolicy, type OrcaAgentBoundaryPolicy } from "./agents/boundary.ts";
import { createOrcaMcpHttpHandler, McpReadError, type OrcaMcpDataSource } from "./agents/mcp.ts";
import { createOrcaMcpAccessTokenVerifier, type OrcaMcpTokenVerifier } from "./agents/access-token.ts";
import type { OrcaAgentAuthorizationContext } from "./agents/authorization.ts";
import { organizationRouteLimits } from "./agents/request-guards.ts";
import type { AgentEventStore } from "./agents/interfaces.ts";
import {
  AgentEventNotFoundError,
  AgentEventRevisionConflictError,
  deleteAgentPropagationMute,
  listAgentPropagationMutes,
  SqliteAgentEventStore,
} from "./agents/propagation/store.ts";
import { createCalendarApp } from "./auth/calendar/routes.ts";
import type { GoogleCalendarOAuthConfig } from "./auth/calendar/config.ts";
import type { CalendarFetch } from "./calendar/google-client.ts";
import { createCalendarAvailabilityResolver } from "./calendar/resolver.ts";
import {
  OrganizationAccessError,
  OrganizationAuthorityError,
  OrganizationOperationDisabledError,
  OrganizationQueryError,
  OrganizationRevisionConflictError,
  createOrganization,
} from "./organization/module.ts";
import { createSqliteOrganizationRepository } from "./organization/sqlite-repository.ts";
import { FacetWorkflowValidationError } from "./organization/facet-workflow.ts";
import { registerOrganizationCollectionsPinsRoutes } from "./organization/collections-pins/routes.ts";
import { registerOrganizationContextRoutes } from "./organization/contexts/routes.ts";
import { registerOrganizationViewRoutes } from "./organization/views/routes.ts";
import { registerOrganizationRuleRoutes } from "./organization/rules/routes.ts";
import { OrganizationLaneValidationError, OrganizationSafetyLockError } from "./organization/lanes/module.ts";
import { createMailboxReader, MailboxCursorError, MailboxScopeError, type MailboxReadMetric } from "./mailbox/read.ts";
import { createOrganizationViews } from "./organization/views/module.ts";
import { createSqliteOrganizationViewsRepository } from "./organization/views/sqlite-repository.ts";
import { createRuleRevisionService } from "./organization/rules/service.ts";
import { createSqliteRuleRevisionRepository } from "./organization/rules/sqlite-repository.ts";
import { createHistoricalRuleSimulationService } from "./organization/rules/simulation.ts";
import { createSqliteHistoricalRuleSimulationRepository } from "./organization/rules/simulation-sqlite.ts";
import {
  agentCorrectionCapabilityAdapter,
  correctOrganizationThread,
} from "./organization/rules/correction.ts";
import {
  createSqliteRuleChangeSetService,
  type McpOrganizationApprovalGrant,
  type RuleChangeSetCapabilitySource,
} from "./organization/rules/change-set-sqlite.ts";
import { recordOrganizationMutationAttempt } from "./organization/mutation-attempt-audit.ts";
import type { OrganizationAgentCapabilitySource } from "./organization/agent-capability.ts";
import {
  OrganizationCollectionsPinsAccessError,
  OrganizationCollectionsPinsConflictError,
  OrganizationCollectionsPinsNotFoundError,
} from "./organization/collections-pins/module.ts";

const serverConfig = getServerConfig();
const linearFeedbackSubmitter = createLinearFeedbackSubmitter();

type CreateAppOptions = {
  dbFactory?: typeof createDatabaseClient;
  syncPage?: typeof syncGmailAccountPage;
  gmailTransport?: GmailTransport;
  gmailClient?: GmailClient;
  gmailPushConfig?: GmailPushConfig;
  providerRegistry?: ProviderRegistry;
  now?: () => Date;
  mirrorDraft?: (db: Database, input: GmailDraftMirrorInput) => Promise<GmailDraftMirrorResult>;
  deleteProviderDraft?: (db: Database, accountId: string, providerDraftId: string) => Promise<void>;
  agentEventStore?: Pick<AgentEventStore, "list"> & Partial<Pick<AgentEventStore, "updateLifecycle">>;
  mcpBoundaryPolicy?: OrcaAgentBoundaryPolicy;
  mcpTokenVerifier?: OrcaMcpTokenVerifier;
  mcpEnv?: NodeJS.ProcessEnv;
  mcpOAuthConfig?: McpOAuthConfig;
  calendarOAuthConfig?: GoogleCalendarOAuthConfig;
  calendarFetch?: CalendarFetch;
  replyBriefAvailability?: (input: { userId: string; request: ReplyBriefInvocationRequest; thread: ThreadDetail }) => Promise<CalendarAvailabilityResponse | null>;
  mailboxReadObserver?: (metric: MailboxReadMetric) => void;
  gmailSyncCoordinator?: GmailSyncCoordinator;
};

const defaultViewSettings = [
  { behavior: "notify", displayName: "Notify", icon: "bell", color: "#dc2626", position: 0 },
  { behavior: "focus", displayName: "Focus", icon: "sparkles", color: "#2563eb", position: 1 },
  { behavior: "normal", displayName: "Normal", icon: "inbox", color: "#64748b", position: 2 },
  { behavior: "quiet", displayName: "Quiet", icon: "moon", color: "#7c3aed", position: 3 },
  { behavior: "hidden", displayName: "Hidden", icon: "eye-off", color: "#475569", position: 4 },
] as const;

const defaultInboxLimit = 100;

const collectionColors = ["#70867d", "#a87360", "#6c8195", "#83728d", "#a18757", "#6d716f"] as const;
const agentPropagationMuteListSchema = agentPropagationMuteRuleSchema.array();

const providerAuthRoutePrefixes: Record<MailProvider, string> = {
  gmail: "/v1/auth/gmail",
  outlook: "/v1/auth/outlook",
};

export function createApp(options: CreateAppOptions = {}): Hono<{
  Variables: AuthVariables;
}> {
  const dbFactory = options.dbFactory ?? createDatabaseClient;
  const providerRegistry = options.providerRegistry ?? defaultProviderRegistry;
  const providerTransports = new Map<MailProvider, ProviderTransport>();
  const providerFor = (account: ConnectedAccount) => providerRegistry.get(account.provider);
  const serializeMailAccount = (account: ConnectedAccount) => ({
    id: account.id,
    provider: account.provider,
    email: account.providerEmail,
    displayName: account.displayName ?? account.providerEmail.split("@")[0] ?? account.providerEmail,
    ...(account.profileImageUrl ? { avatarUrl: `/v1/accounts/${encodeURIComponent(account.id)}/avatar` } : {}),
    capabilities: providerFor(account).detectCapabilities(account.scope),
  });
  const mailboxCapabilitiesFor = (provider: MailProvider, scope: string | null) => providerRegistry.get(provider).detectCapabilities(scope);
  const transportFor = (account: ConnectedAccount) => {
    if (account.provider === "gmail" && options.gmailTransport) return options.gmailTransport;
    const existing = providerTransports.get(account.provider);
    if (existing) return existing;
    const transport = providerFor(account).createTransport();
    providerTransports.set(account.provider, transport);
    return transport;
  };
  const capabilitiesFor = (account: ConnectedAccount) => providerFor(account).detectCapabilities(account.scope);
  const now = options.now ?? (() => new Date());
  const gmailClient = options.gmailClient ?? createGmailClient();
  const gmailPushConfig = options.gmailPushConfig ?? loadGmailPushConfig();
  const gmailSyncCoordinator = options.gmailSyncCoordinator ?? createDefaultGmailSyncCoordinator({
    dbFactory,
    gmailClient,
    config: gmailPushConfig,
    now,
    syncPage: options.syncPage ?? (providerRegistry.has("gmail")
      ? providerRegistry.get("gmail").syncPage as typeof syncGmailAccountPage
      : syncGmailAccountPage),
  });
  const draftMirrorJobs = new Set<string>();

  const app = new Hono<{ Variables: AuthVariables }>();

  app.use(
    "*",
    cors({
      origin: [serverConfig.webOrigin],
    }),
  );

  app.use("/v1/organization/*", requireAuth({ dbFactory }));
  app.use("/v1/organization/*", bodyLimit({
    maxSize: organizationRouteLimits.maximumBodyBytes,
    onError: (c) => c.json({ error: { code: "payload_limit", message: "The Organization request body exceeds the 512 KiB limit" } }, 413),
  }));

  registerOrganizationCollectionsPinsRoutes(app, { dbFactory });
  registerOrganizationContextRoutes(app, { dbFactory });
  registerOrganizationViewRoutes(app, { dbFactory });
  registerOrganizationRuleRoutes(app, { dbFactory });

  const mcpPolicy = options.mcpBoundaryPolicy ?? getOrcaAgentBoundaryPolicy(options.mcpEnv);
  const mcpOAuthConfig = options.mcpOAuthConfig ?? getMcpOAuthConfig(options.mcpEnv ?? process.env);
  const agentCapabilitySourceFor = (
    db: Database,
    authorization: OrcaAgentAuthorizationContext,
    actor: OrganizationActor & { type: "agent" },
    workspaceId: string,
    accountIds: readonly string[],
  ): OrganizationAgentCapabilitySource => ({
    load(scope, transactionExecutor) {
      if (scope.workspaceId !== workspaceId || scope.actor.id !== actor.id || scope.actor.type !== "agent") return null;
      if (authorization.connectionId.length === 0
        || authorization.clientId !== actor.id
        || authorization.userId !== workspaceId
        || authorization.issuer !== (mcpPolicy.enabled ? mcpPolicy.issuer : authorization.issuer)
        || authorization.resource !== (mcpPolicy.enabled ? mcpPolicy.resource : authorization.resource)
        || authorization.expiresAt <= now()
        || !authorization.scopes.some((scope) => scope === "orca:organization:control" || scope === "orca:mail.metadata:read")) return null;
      const granted = [...new Set(accountIds)].sort();
      if (JSON.stringify([...scope.accountIds].sort()) !== JSON.stringify(granted)) return null;
      if (granted.some((accountId) => !authorization.accountIds.includes(accountId))) return null;
      type PersistedConnection = { id: string; userId: string; clientId: string; resource: string; scopes: string; revokedAt: Date | null; updatedAt: Date };
      let connection: PersistedConnection | undefined;
      let persistedAccountIds: string[];
      if (transactionExecutor && typeof transactionExecutor === "object" && "query" in transactionExecutor && !("select" in transactionExecutor)) {
        const sqliteExecutor = transactionExecutor as { query(sql: string): { get(...params: unknown[]): Record<string, unknown> | null; all(...params: unknown[]): Array<Record<string, unknown>> } };
        const row = sqliteExecutor.query("SELECT id,user_id AS userId,client_id AS clientId,resource,scopes,revoked_at AS revokedAt,updated_at AS updatedAt FROM mcp_connections WHERE id=?").get(authorization.connectionId);
        connection = row ? {
          id: String(row.id), userId: String(row.userId), clientId: String(row.clientId), resource: String(row.resource), scopes: String(row.scopes),
          revokedAt: row.revokedAt === null ? null : new Date(Number(row.revokedAt)), updatedAt: new Date(Number(row.updatedAt)),
        } : undefined;
        persistedAccountIds = sqliteExecutor.query("SELECT oa.id AS id FROM mcp_connection_accounts mca JOIN oauth_accounts oa ON oa.id=mca.account_id WHERE mca.connection_id=? AND oa.user_id=? ORDER BY oa.id").all(authorization.connectionId, workspaceId).map((row) => String(row.id));
      } else {
        const executor = (transactionExecutor as Database | undefined) ?? db;
        connection = executor.select({
          id: mcpConnections.id,
          userId: mcpConnections.userId,
          clientId: mcpConnections.clientId,
          resource: mcpConnections.resource,
          scopes: mcpConnections.scopes,
          revokedAt: mcpConnections.revokedAt,
          updatedAt: mcpConnections.updatedAt,
        }).from(mcpConnections).where(eq(mcpConnections.id, authorization.connectionId)).get();
        persistedAccountIds = executor.select({ id: oauthAccounts.id })
          .from(mcpConnectionAccounts)
          .innerJoin(oauthAccounts, eq(mcpConnectionAccounts.accountId, oauthAccounts.id))
          .where(and(eq(mcpConnectionAccounts.connectionId, authorization.connectionId), eq(oauthAccounts.userId, workspaceId)))
          .all().map(({ id }) => id);
      }
      if (!connection
        || connection.userId !== workspaceId
        || connection.clientId !== actor.id
        || connection.resource !== authorization.resource) return null;
      const persistedScopes = new Set(connection.scopes.split(/\s+/).filter(Boolean));
      const hasControl = authorization.scopes.includes("orca:organization:control") && persistedScopes.has("organization:control");
      const hasOrganizationRead = hasControl
        || (authorization.scopes.includes("orca:mail.metadata:read") && persistedScopes.has("mail:read"));
      if (!hasOrganizationRead) return null;
      const persisted = new Set(persistedAccountIds);
      if (granted.length === 0 || granted.some((accountId) => !persisted.has(accountId))) return null;
      return {
        snapshot: {
          id: `mcp:organization:${connection.id}`,
          revision: Math.max(1, connection.updatedAt.getTime()),
          actor,
          scope: { workspaceId, accountIds: granted },
          operations: hasControl ? ["describe", "query", "simulate", "apply", "revert"] : ["describe", "query"],
          resourceFamilies: ["workspace_schema", "mail", "thread", "lane", "view", "collection", "shortcut", "saved_query", "facet", "context", "workflow_state", "rule", "change_set", "trace", "audit"],
          actionFamilies: hasControl ? ["organization_read", "organization_structure", "organization_thread", "organization_attention"] : ["organization_read"],
        },
        revokedAt: connection.revokedAt?.toISOString() ?? null,
      };
    },
  });
  const ruleChangeSetCapabilitySourceFor = (
    source: OrganizationAgentCapabilitySource,
    actor: OrganizationActor & { type: "agent" },
    accountIds: readonly string[],
  ): RuleChangeSetCapabilitySource => ({
    load(executor, { workspaceId }) {
      return source.load({ actor, workspaceId, accountIds: [...accountIds] }, executor);
    },
  });
  const mcpDataSource: OrcaMcpDataSource = {
    getCurrentAccountIds(userId) {
      const { db, sqlite } = dbFactory();
      try {
        return getUnifiedInboxAccounts(db, userId).map((account) => account.id);
      } finally {
        sqlite.close();
      }
    },
    describeOrganization({ authorization, userId, actor, allowedAccountIds }) {
      const { db, sqlite } = dbFactory();
      try {
        const repository = createSqliteOrganizationRepository(db);
        return createOrganization(repository, { agentCapabilitySource: agentCapabilitySourceFor(db, authorization, actor, userId, allowedAccountIds) }).describe({
          scope: { actor, workspaceId: userId, accountIds: [...allowedAccountIds] },
        });
      } catch (error) {
        if (error instanceof OrganizationAccessError) throw new McpReadError("account_denied", error.message);
        throw error;
      } finally {
        sqlite.close();
      }
    },
    queryOrganization({ authorization, userId, actor, allowedAccountIds, query }) {
      const { db, sqlite } = dbFactory();
      try {
        const repository = createSqliteOrganizationRepository(db);
        return createOrganization(repository, { agentCapabilitySource: agentCapabilitySourceFor(db, authorization, actor, userId, allowedAccountIds) }).query({
          scope: { actor, workspaceId: userId, accountIds: [...allowedAccountIds] },
          query: {
            accountIds: [...query.accountIds],
            ...(query.threadId ? { threadId: query.threadId } : {}),
            ...(query.attention ? { attention: query.attention } : {}),
            ...(query.classification ? { classification: query.classification } : {}),
            ...(query.text ? { text: query.text } : {}),
            ...(query.sender ? { sender: query.sender } : {}),
            ...(query.receivedAfter ? { receivedAfter: query.receivedAfter } : {}),
            ...(query.receivedBefore ? { receivedBefore: query.receivedBefore } : {}),
            ...(query.contextFilters ? { contextFilters: query.contextFilters } : {}),
            ...(query.limit ? { limit: query.limit } : {}),
            ...(query.cursor ? { cursor: query.cursor } : {}),
          },
        });
      } catch (error) {
        if (error instanceof OrganizationAccessError) throw new McpReadError("account_denied", error.message);
        if (error instanceof OrganizationQueryError) throw new McpReadError("invalid_cursor", error.message);
        throw error;
      } finally {
        sqlite.close();
      }
    },
    simulateOrganization({ authorization, userId, actor, allowedAccountIds, query }) {
      const { db, sqlite } = dbFactory();
      try {
        const scope = { actor, workspaceId: userId, accountIds: [...allowedAccountIds] };
        const capability = agentCapabilitySourceFor(db, authorization, actor, userId, allowedAccountIds).load(scope);
        if (!capability) throw new McpReadError("account_denied", "The scoped Organization Capability is unavailable");
        const preparation = createHistoricalRuleSimulationService(createSqliteHistoricalRuleSimulationRepository(db)).prepare({
          actor,
          workspaceId: userId,
          request: query.request,
          capabilitySnapshot: capability.snapshot,
        });
        if (preparation.report.binding.workspaceRevision !== query.expectedWorkspaceRevision) {
          throw new Error(`Expected Workspace revision ${query.expectedWorkspaceRevision}, found ${preparation.report.binding.workspaceRevision}`);
        }
        const wins = new Map<string, { ruleId: string; revisionId: string; wins: number }>();
        for (const { result } of preparation.evaluations) {
          for (const winner of result.trace.winners) {
            if (!winner.revisionId) continue;
            const considered = result.trace.consideredRevisions.find((revision) => revision.revisionId === winner.revisionId);
            if (!considered) continue;
            const key = `${considered.ruleId}\0${winner.revisionId}`;
            const current = wins.get(key) ?? { ruleId: considered.ruleId, revisionId: winner.revisionId, wins: 0 };
            current.wins += 1;
            wins.set(key, current);
          }
        }
        return {
          ...preparation.report,
          winningRules: [...wins.values()].sort((left, right) => left.ruleId.localeCompare(right.ruleId) || left.revisionId.localeCompare(right.revisionId)),
          observedReasons: preparation.evaluations.slice(0, 20).map(({ context, result }) => ({
            accountId: context.thread.accountId,
            threadId: context.thread.id,
            traceId: result.trace.id,
            reason: result.trace.reason,
            winningRuleIds: [...new Set(result.trace.winners.flatMap((winner) => {
              const considered = winner.revisionId ? result.trace.consideredRevisions.find((revision) => revision.revisionId === winner.revisionId) : undefined;
              return considered ? [considered.ruleId] : [];
            }))],
            observedFields: result.trace.observedValues.map(({ field }) => field),
          })),
        };
      } finally { sqlite.close(); }
    },
    applyOrganization({ authorization, userId, actor, allowedAccountIds, query }) {
      const { db, sqlite } = dbFactory();
      try {
        const repository = createSqliteOrganizationRepository(db);
        const scope = { actor, workspaceId: userId, accountIds: [...allowedAccountIds] };
        const agentCapabilitySource = agentCapabilitySourceFor(db, authorization, actor, userId, allowedAccountIds);
        const live = agentCapabilitySource.load(scope);
        if (!live) throw new McpReadError("account_denied", "The scoped Organization Capability is unavailable");
        const organization = createOrganization(repository, { agentCapabilitySource });
        let result: unknown;
        let risk: "low" | "medium" | "high" | "destructive" | null = null;
        let capabilityId = live.snapshot.id;
        if (query.target.kind === "lanes" || query.target.kind === "facets_workflow") {
          result = organization.apply({ scope, command: query.target.request });
        } else if (query.target.kind === "view_create") {
          result = createOrganizationViews(createSqliteOrganizationViewsRepository(sqlite), { agentCapabilitySource }).create({ scope, request: query.target.request });
        } else if (query.target.kind === "view_update") {
          result = createOrganizationViews(createSqliteOrganizationViewsRepository(sqlite), { agentCapabilitySource }).update({ scope, viewId: query.target.viewId, request: query.target.request });
        } else if (query.target.kind === "collection") {
          if (!organization.collectionsPins) throw new Error("Collections Organization module is unavailable");
          result = organization.collectionsPins.apply({ scope, request: query.target.request, expectedWorkspaceRevision: query.expectedWorkspaceRevision });
        } else if (query.target.kind === "context") {
          if (!organization.contexts) throw new Error("Context Organization module is unavailable");
          result = organization.contexts.apply({ scope, request: query.target.request });
        } else if (query.target.kind === "rule_revision") {
          result = createRuleRevisionService(createSqliteRuleRevisionRepository(db), { agentCapabilitySource }).compile({ actor, workspaceId: userId, accountIds: [...allowedAccountIds], request: query.target.request });
          if (result && typeof result === "object" && "ok" in result && result.ok && "revision" in result) risk = (result.revision as { compiled: { risk: typeof risk } }).compiled.risk;
        } else if (query.target.kind === "thread_correction") {
          const capabilityAdapter = agentCorrectionCapabilityAdapter({
            actor, workspaceId: userId, accountId: query.target.request.accountId, source: agentCapabilitySource,
          });
          result = correctOrganizationThread(db, {
            actor, workspaceId: userId, request: query.target.request, capabilityAdapter, now: now(),
          });
          risk = "low";
        } else {
          const capabilitySource = ruleChangeSetCapabilitySourceFor(agentCapabilitySource, actor, allowedAccountIds);
          const capability = capabilitySource.load(db, { workspaceId: userId });
          if (!capability) throw new McpReadError("account_denied", "The Rule Change Set Capability is unavailable");
          capabilityId = capability.snapshot.id;
          result = createSqliteRuleChangeSetService(db, { capabilitySource }).activate({
            actor,
            capabilitySnapshot: capability.snapshot,
            workspaceId: userId,
            request: query.target.request,
            approval: query.target.approval,
            approvalGrant: {
              connectionId: authorization.connectionId,
              clientId: authorization.clientId,
              approverUserId: authorization.userId,
              expiresAt: authorization.expiresAt,
            } satisfies McpOrganizationApprovalGrant,
          });
          risk = (result as { risk: typeof risk }).risk;
        }
        const resultRecord = result && typeof result === "object" ? result as Record<string, unknown> : {};
        const idempotencyKey = query.target.request.idempotencyKey;
        const correctionChangeSetId = query.target.kind === "thread_correction" && resultRecord.changeSetId !== null
          ? String(resultRecord.changeSetId) : null;
        const persistedChangeSet = correctionChangeSetId
          ? db.select({ id: organizationChangeSets.id, authorityTrace: organizationChangeSets.authorityTrace }).from(organizationChangeSets).where(and(
            eq(organizationChangeSets.workspaceId, userId), eq(organizationChangeSets.id, correctionChangeSetId),
          )).get()
          : db.select({ id: organizationChangeSets.id, authorityTrace: organizationChangeSets.authorityTrace }).from(organizationChangeSets).where(and(
            eq(organizationChangeSets.workspaceId, userId), eq(organizationChangeSets.idempotencyKey, idempotencyKey),
          )).get();
        const rejected = query.target.kind === "rule_revision" && resultRecord.ok === false;
        if (!rejected && !persistedChangeSet && query.target.kind !== "thread_correction") throw new Error(`Successful ${query.target.kind} mutation did not persist its Change Set`);
        const resourceFamilies = query.target.kind === "thread_correction"
          ? ["thread" as const, "trace" as const, "change_set" as const, "audit" as const]
          : persistedChangeSet
            ? organizationAuthorityTraceSchema.parse(JSON.parse(persistedChangeSet.authorityTrace)).requestedResourceFamilies
            : ["rule" as const];
        return { operation: "apply" as const, workspaceId: userId, accountIds: [...allowedAccountIds], targetKind: query.targetKind, resourceFamilies, actor, capabilityId, expectedWorkspaceRevision: query.expectedWorkspaceRevision, risk, changeSetIds: { applied: persistedChangeSet ? [persistedChangeSet.id] : [], rejected: [] }, result };
      } catch (error) {
        recordOrganizationMutationAttempt({
          db,
          workspaceId: userId,
          connectionId: authorization.connectionId,
          actor,
          operation: "apply",
          query,
          error,
          now: now(),
        });
        throw error;
      } finally { sqlite.close(); }
    },
    revertOrganization({ authorization, userId, actor, allowedAccountIds, query }) {
      const { db, sqlite } = dbFactory();
      try {
        const agentCapabilitySource = agentCapabilitySourceFor(db, authorization, actor, userId, allowedAccountIds);
        const capabilitySource = ruleChangeSetCapabilitySourceFor(agentCapabilitySource, actor, allowedAccountIds);
        const capability = capabilitySource.load(db, { workspaceId: userId });
        if (!capability) throw new McpReadError("account_denied", "The Rule Change Set Capability is unavailable");
        const result = createSqliteRuleChangeSetService(db, { capabilitySource }).revert({ actor, capabilitySnapshot: capability.snapshot, workspaceId: userId, request: query.request });
        const persistedChangeSet = db.select({ authorityTrace: organizationChangeSets.authorityTrace }).from(organizationChangeSets).where(and(
          eq(organizationChangeSets.workspaceId, userId), eq(organizationChangeSets.id, result.changeSetId),
        )).get();
        if (!persistedChangeSet) throw new Error("Successful Rule Change Set revert did not persist authority evidence");
        const resourceFamilies = organizationAuthorityTraceSchema.parse(JSON.parse(persistedChangeSet.authorityTrace)).requestedResourceFamilies;
        return { operation: "revert" as const, workspaceId: userId, accountIds: [...allowedAccountIds], targetKind: query.targetKind, resourceFamilies, actor, capabilityId: capability.snapshot.id, expectedWorkspaceRevision: query.expectedWorkspaceRevision, risk: result.risk, changeSetIds: { applied: [result.changeSetId], rejected: [] }, result };
      } catch (error) {
        recordOrganizationMutationAttempt({
          db,
          workspaceId: userId,
          connectionId: authorization.connectionId,
          actor,
          operation: "revert",
          query,
          error,
          now: now(),
        });
        throw error;
      } finally { sqlite.close(); }
    },
    searchMail({ userId, allowedAccountIds, query }) {
      const { sqlite } = dbFactory();
      try {
        try {
          return createMailboxReader(sqlite, {
            capabilitiesFor: mailboxCapabilitiesFor,
            observe: options.mailboxReadObserver,
          }).read({
            authorization: { userId, accountIds: allowedAccountIds },
            query: {
              cursor: query.cursor,
              limit: query.limit ?? 25,
              view: query.attention,
              classification: query.classification,
              query: query.query,
              sender: query.sender,
              receivedAfter: query.receivedAfter,
              receivedBefore: query.receivedBefore,
            },
          }).response;
        } catch (error) {
          if (error instanceof MailboxCursorError) throw new McpReadError("invalid_cursor", error.message);
          if (error instanceof MailboxScopeError) throw new McpReadError("account_denied", error.message);
          throw error;
        }
      } finally {
        sqlite.close();
      }
    },
    getThread({ userId, allowedAccountIds, query }) {
      const { db, sqlite } = dbFactory();
      try {
        const account = getConnectedAccountById(db, userId, query.accountId);
        if (!account || !allowedAccountIds.includes(account.id)) {
          throw new McpReadError("not_found", "Thread not found");
        }
        const organized = createOrganization(createSqliteOrganizationRepository(db)).query({
          scope: { actor: { id: userId, type: "agent" }, workspaceId: userId, accountIds: [...allowedAccountIds] },
          query: { accountIds: [query.accountId], threadId: query.threadId, attention: "all", classification: "all", limit: 1 },
        });
        if (organized.threads.length === 0) throw new McpReadError("not_found", "Thread not found");
        return readThreadDetail(db, account, serializeMailAccount(account), query.threadId);
      } finally {
        sqlite.close();
      }
    },
    async listAgentEvents({ userId, allowedAccountIds, query }) {
      const { db, sqlite } = dbFactory();
      try {
        const store = options.agentEventStore ?? new SqliteAgentEventStore(db, now);
        return await store.list({
          ownerUserId: userId,
          accountIds: allowedAccountIds,
          states: query.states,
          limit: query.limit ?? 25,
          cursor: query.cursor,
        });
      } finally {
        sqlite.close();
      }
    },
    getConnectionStatus({ userId, allowedAccountIds }) {
      const { db, sqlite } = dbFactory();
      try {
        const allowed = new Set(allowedAccountIds);
        const connectedAccounts = getUnifiedInboxAccounts(db, userId)
          .filter((account) => allowed.has(account.id));
        const durableSyncJobs = new Map(gmailSyncCoordinator.jobsForAccounts(connectedAccounts.map((account) => account.id))
          .map((job) => [job.accountId, job]));
        return connectedAccounts
          .map((account) => {
            const durableStatus = durableSyncJobs.get(account.id);
            const authNeeded = !account.accessTokenEncrypted || !account.refreshTokenEncrypted;
            const syncState = authNeeded
              ? "auth_needed"
              : durableStatus?.lastError
              ? "error"
              : durableStatus?.state === "queued" || durableStatus?.state === "running"
              ? "syncing"
              : "idle";
            const serialized = serializeMailAccount(account);
            return {
              account: serialized,
              syncState,
              ready: serialized.capabilities.read && syncState !== "auth_needed" && syncState !== "error",
              lastSyncedAt: account.lastSyncedAt?.toISOString() ?? null,
            };
          });
      } finally {
        sqlite.close();
      }
    },
    sourceUrl(accountId, threadId) {
      const url = new URL("/", serverConfig.webOrigin);
      url.searchParams.set("thread", threadId);
      url.searchParams.set("accountId", accountId);
      return url.toString();
    },
  };
  let mcpTokenVerifier = options.mcpTokenVerifier;
  if (mcpPolicy.enabled && !mcpTokenVerifier) {
    if (mcpOAuthConfig.issuer !== mcpPolicy.issuer || mcpOAuthConfig.resource !== mcpPolicy.resource) {
      throw new Error("The /mcp boundary and OAuth server must use the same issuer and resource identifiers");
    }
    mcpTokenVerifier = createOrcaMcpAccessTokenVerifier(mcpOAuthConfig, dbFactory);
  }
  const mcpHandler = createOrcaMcpHttpHandler({
    dataSource: mcpDataSource,
    env: options.mcpEnv,
    policy: mcpPolicy,
    verifier: mcpTokenVerifier,
  });
  for (const metadataPath of mcpHandler.metadataPaths) {
    app.get(metadataPath, (c) => c.json(mcpHandler.metadata!));
  }
  app.all("/mcp", (c) => mcpHandler.fetch(c.req.raw));
  registerMcpOAuthRoutes(app, {
    dbFactory,
    config: mcpOAuthConfig,
    now,
  });
  app.route("/", createCalendarApp({
    dbFactory,
    config: options.calendarOAuthConfig,
    fetch: options.calendarFetch,
    now,
  }));
  const replyBriefCalendarResolver = createCalendarAvailabilityResolver({
    dbFactory,
    config: options.calendarOAuthConfig,
    fetch: options.calendarFetch,
    now,
  });

  app.get("/health", (c) =>
    c.json({
      ok: true,
      service: "orca-api",
    }),
  );

  function organizationFor(db: Database, workspaceId: string) {
    const repository = createSqliteOrganizationRepository(db);
    const accountIds = repository.listAccountIds(workspaceId);
    return {
      organization: createOrganization(repository),
      scope: {
        actor: { id: workspaceId, type: "human" as const },
        workspaceId,
        accountIds,
      },
    };
  }

  function collectionsPinsFor(db: Database, workspaceId: string) {
    const { organization, scope } = organizationFor(db, workspaceId);
    if (!organization.collectionsPins) throw new Error("Collections/Pins Organization composition is unavailable");
    return { organization: organization.collectionsPins, scope };
  }

  function legacyOrganizationIdempotencyKey(c: Context) {
    return c.req.header("Idempotency-Key")?.trim() || `legacy-collections-pins:${crypto.randomUUID()}`;
  }

  function legacyOrganizationError(c: Context, error: unknown, conflictMessage: string) {
    if (error instanceof OrganizationCollectionsPinsAccessError) {
      return c.json({ error: { code: error.code, message: "The requested Account scope is not authorized" } }, 403);
    }
    if (error instanceof OrganizationCollectionsPinsNotFoundError) {
      return c.json({ error: { code: error.code, message: error.message } }, 404);
    }
    if (error instanceof OrganizationCollectionsPinsConflictError) {
      return c.json({ error: { code: error.code, message: conflictMessage } }, 409);
    }
    if (error instanceof Error && error.name === "ZodError") {
      return c.json({ error: { code: "validation_error", message: "Invalid Collections/Pins change" } }, 400);
    }
    throw error;
  }

  app.get("/v1/organization/describe", requireAuth({ dbFactory }), (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const { organization, scope } = organizationFor(db, c.get("auth").userId);
      return c.json(organization.describe({ scope }));
    } finally {
      sqlite.close();
    }
  });

  app.get("/v1/organization/query", requireAuth({ dbFactory }), (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const { organization, scope } = organizationFor(db, c.get("auth").userId);
      const accountId = c.req.query("accountId");
      const limit = c.req.query("limit");
      const facetId = c.req.query("facetId");
      const facetOperator = c.req.query("facetOperator");
      const facetValueJson = c.req.query("facetValueJson");
      const contextId = c.req.query("contextId");
      const contextTypeId = c.req.query("contextTypeId");
      const contextRelationshipTypeId = c.req.query("contextRelationshipTypeId");
      const contextDirection = c.req.query("contextDirection");
      try {
        let parsedFacetValue: unknown;
        if (facetValueJson !== undefined) {
          try {
            parsedFacetValue = JSON.parse(facetValueJson) as unknown;
          } catch {
            return c.json({ error: { code: "validation_error", message: "facetValueJson must be a valid JSON scalar" } }, 400);
          }
        }
        const contextFilterParts = [contextId, contextTypeId, contextRelationshipTypeId].filter((value) => value !== undefined).length;
        if (contextFilterParts > 0 && contextFilterParts < 3) {
          return c.json({ error: { code: "validation_error", message: "Context queries require contextId, contextTypeId, and contextRelationshipTypeId together" } }, 400);
        }
        if (contextDirection && contextFilterParts < 3) {
          return c.json({ error: { code: "validation_error", message: "contextDirection requires a complete stable Context relationship filter" } }, 400);
        }
        return c.json(organization.query({
          scope,
          query: {
            ...(accountId ? { accountIds: [accountId] } : {}),
            ...(c.req.query("threadId") ? { threadId: c.req.query("threadId") } : {}),
            ...(c.req.query("attention") ? { attention: c.req.query("attention") } : {}),
            ...(c.req.query("classification") ? { classification: c.req.query("classification") } : {}),
            ...(c.req.query("text") ? { text: c.req.query("text") } : {}),
            ...(c.req.query("sender") ? { sender: c.req.query("sender") } : {}),
            ...(c.req.query("receivedAfter") ? { receivedAfter: c.req.query("receivedAfter") } : {}),
            ...(c.req.query("receivedBefore") ? { receivedBefore: c.req.query("receivedBefore") } : {}),
            ...(facetId && facetOperator ? {
              facetFilters: [{
                facetId,
                operator: facetOperator,
                ...((facetOperator === "equals" || facetOperator === "contains") ? { value: parsedFacetValue } : {}),
              }],
            } : {}),
            ...(c.req.query("workflowStateId") ? { workflowStateIds: [c.req.query("workflowStateId")] } : {}),
            ...(c.req.query("laneId") ? { laneIds: [c.req.query("laneId")] } : {}),
            ...(contextId && contextTypeId && contextRelationshipTypeId ? { contextFilters: [{ context: { contextId, contextTypeId }, relationshipTypeId: contextRelationshipTypeId, ...(contextDirection ? { direction: contextDirection } : {}) }] } : {}),
            ...(limit ? { limit: Number(limit) } : {}),
            ...(c.req.query("cursor") ? { cursor: c.req.query("cursor") } : {}),
          },
        }));
      } catch (error) {
        if (error instanceof OrganizationAccessError) {
          return c.json({ error: { code: error.code, message: "The requested Account scope is not authorized" } }, 403);
        }
        if (error instanceof OrganizationQueryError) {
          return c.json({ error: { code: error.code, message: error.message } }, 400);
        }
        if (error instanceof FacetWorkflowValidationError) {
          return c.json({ error: { code: error.code, message: error.message, issues: error.issues } }, 400);
        }
        if (error instanceof Error && error.name === "ZodError") {
          return c.json({ error: { code: "validation_error", message: "Invalid Organization query parameters" } }, 400);
        }
        throw error;
      }
    } finally {
      sqlite.close();
    }
  });

  app.post("/v1/organization/apply", requireAuth({ dbFactory }), async (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const { organization, scope } = organizationFor(db, c.get("auth").userId);
      let command: unknown;
      try {
        command = await c.req.json();
      } catch {
        return c.json({ error: { code: "validation_error", message: "Organization apply requires a valid JSON command", issues: [] } }, 400);
      }
      try {
        return c.json(organization.apply({ scope, command }));
      } catch (error) {
        if (error instanceof FacetWorkflowValidationError) {
          const denied = error.issues.some((issue) => issue.code === "account_denied");
          return c.json({ error: { code: denied ? "account_denied" : error.code, message: error.message, issues: error.issues } }, denied ? 403 : 400);
        }
        if (error instanceof OrganizationRevisionConflictError) {
          return c.json({ error: { code: error.code, message: error.message, expectedRevision: error.expectedRevision, actualRevision: error.actualRevision } }, 409);
        }
        if (error instanceof OrganizationAuthorityError) {
          const status = error.code === "revision_conflict" || error.code === "duplicate_idempotency_key" ? 409
            : error.code === "invalid_request" || error.code === "idempotency_key_required" || error.code === "expected_revision_required" ? 400
              : 403;
          return c.json({ error: { code: error.code, message: error.message } }, status);
        }
        if (error instanceof OrganizationLaneValidationError) {
          return c.json({ error: { code: error.code, message: error.message } }, 400);
        }
        if (error instanceof OrganizationSafetyLockError) {
          return c.json({ error: { code: error.code, message: error.message } }, 409);
        }
        if (error instanceof Error && error.name === "ZodError") {
          const issues = "issues" in error ? error.issues : [];
          return c.json({ error: { code: "validation_error", message: "Invalid Organization apply command", issues } }, 400);
        }
        throw error;
      }
    } finally {
      sqlite.close();
    }
  });

  for (const operation of ["simulate", "revert"] as const) {
    app.post(`/v1/organization/${operation}`, requireAuth({ dbFactory }), (c) => {
      const { db, sqlite } = dbFactory();
      try {
        const { organization, scope } = organizationFor(db, c.get("auth").userId);
        try {
          organization[operation]({ scope });
        } catch (error) {
          if (error instanceof OrganizationOperationDisabledError) {
            return c.json({ error: { code: error.code, message: error.message } }, 405);
          }
          throw error;
        }
        throw new Error(`Organization ${operation} unexpectedly returned while disabled`);
      } finally {
        sqlite.close();
      }
    });
  }

  const handleGmailPush = async (c: Context<{ Variables: AuthVariables }>) => {
    if (!gmailPushConfig.verificationToken) {
      return c.json({ error: { code: "push_not_configured", message: "Gmail push verification is not configured" } }, 503);
    }
    if (!verifyGmailPushToken(c.req.raw, gmailPushConfig)) {
      return c.json({ error: { code: "unauthorized", message: "Gmail push verification failed" } }, 401);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: "invalid_notification", message: "Gmail push notification was not valid JSON" } }, 400);
    }

    const notification = parseGmailPubSubNotification(body);
    if (!notification) {
      return c.json({ error: { code: "invalid_notification", message: "Gmail push notification was malformed" } }, 400);
    }

    const { db, sqlite } = dbFactory();
    try {
      const accounts = db
        .select({ id: oauthAccounts.id, providerEmail: oauthAccounts.providerEmail })
        .from(oauthAccounts)
        .where(eq(oauthAccounts.provider, "gmail"))
        .all()
        .filter((candidate) => candidate.providerEmail.trim().toLowerCase() === notification.emailAddress);

      // Pub/Sub retries are not useful for an account that has been removed.
      // Acknowledge unknown addresses without disclosing account existence.
      if (accounts.length === 0) {
        return c.body(null, 204);
      }

      for (const account of accounts) {
        gmailSyncCoordinator.enqueue({
          accountId: account.id,
          source: "push",
          historyId: notification.historyId,
          freshnessAt: notification.publishedAt ?? now(),
        });
      }

      for (const account of accounts) gmailSyncCoordinator.kick(account.id);
      return c.body(null, 204);
    } catch (error) {
      const publicError = toPublicPushError(error);
      return c.json({ error: { code: publicError.code, message: publicError.message } }, publicError.status);
    } finally {
      sqlite.close();
    }
  };

  // Keep the canonical webhook path stable while accepting the shorter path
  // during local Pub/Sub emulator setup.
  app.post("/v1/webhooks/gmail", handleGmailPush);
  app.post("/v1/gmail/push", handleGmailPush);

  app.all("/v1/feedback", (c) => handleFeedbackRequest(c.req.raw, {
    allowedOrigin: serverConfig.webOrigin,
    enabled: process.env.NODE_ENV !== "production",
    onReport: linearFeedbackSubmitter,
  }));

  app.get("/v1/auth/session", requireAuth({ dbFactory }), (c) => {
    const auth = c.get("auth");
    const { db, sqlite } = dbFactory();
    try {
      const user = db.select().from(users).where(eq(users.id, auth.userId)).get();
      if (!user) {
        return c.json({ error: { code: "unauthorized", message: "Authentication required" } }, 401);
      }
      return jsonWithSchema(c, authSessionSchema, {
        isAuthenticated: true,
        user: { id: user.id, email: user.email, name: user.displayName },
        expiresAt: auth.expiresAt.toISOString(),
        onboardingCompletedAt: user.onboardingCompletedAt?.toISOString() ?? null,
      });
    } finally {
      sqlite.close();
    }
  });

  app.post("/v1/auth/onboarding/complete", requireAuth({ dbFactory }), (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const userId = c.get("auth").userId;
      const updated = db.update(users)
        .set({ onboardingCompletedAt: now() })
        .where(eq(users.id, userId))
        .returning({ id: users.id })
        .get();
      if (!updated) {
        return c.json({ error: { code: "unauthorized", message: "Authentication required" } }, 401);
      }
      return c.json({ ok: true });
    } finally {
      sqlite.close();
    }
  });

  app.get("/v1/me", requireAuth({ dbFactory }), (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const account = getPreferredConnectedAccount(db, c.get("auth").userId);
      if (!account) {
        return c.json({ error: { code: "not_found", message: "No Gmail account is connected" } }, 404);
      }
      return jsonWithSchema(c, mailAccountSchema, serializeMailAccount(account));
    } finally {
      sqlite.close();
    }
  });

  app.get("/v1/agent-events", requireAuth({ dbFactory }), async (c) => {
    const ownerUserId = c.get("auth").userId;
    const requestedAccountId = c.req.query("accountId")?.trim();
    const rawLimit = c.req.query("limit");
    const limit = rawLimit === undefined ? 50 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return c.json({ error: { code: "invalid_request", message: "limit must be an integer from 1 to 100" } }, 400);
    }
    const rawStates = c.req.query("states")?.split(",").map((state) => state.trim()).filter(Boolean);
    const parsedStates = rawStates?.map((state) => agentEventLifecycleStateSchema.safeParse(state));
    if (parsedStates?.some((state) => !state.success)) {
      return c.json({ error: { code: "invalid_request", message: "states contains an unsupported lifecycle state" } }, 400);
    }

    const { db, sqlite } = dbFactory();
    try {
      const ownedIds = getUnifiedInboxAccounts(db, ownerUserId).map((account) => account.id);
      if (requestedAccountId && !ownedIds.includes(requestedAccountId)) {
        return c.json({ error: { code: "not_found", message: "Mail account not found" } }, 404);
      }
      const accountIds = requestedAccountId ? [requestedAccountId] : ownedIds;
      if (accountIds.length === 0) return jsonWithSchema(c, agentEventListPageSchema, { events: [], nextCursor: null });
      const store = options.agentEventStore ?? new SqliteAgentEventStore(db, now);
      const page = await store.list({
        ownerUserId,
        accountIds,
        states: parsedStates?.map((state) => state.success ? state.data : "new"),
        limit,
        cursor: c.req.query("cursor"),
      });
      return jsonWithSchema(c, agentEventListPageSchema, page);
    } catch (error) {
      return c.json({ error: { code: "agent_events_unavailable", message: publicAgentEventError(error) } }, 503);
    } finally {
      sqlite.close();
    }
  });

  app.patch(
    "/v1/agent-events/:id/lifecycle",
    validator("json", (value, c) => validateJson(c, updateAgentEventLifecycleSchema, value)),
    requireAuth({ dbFactory }),
    async (c) => {
      const ownerUserId = c.get("auth").userId;
      const accountId = c.req.query("accountId")?.trim();
      if (!accountId) return c.json({ error: { code: "invalid_request", message: "accountId is required" } }, 400);
      const { db, sqlite } = dbFactory();
      try {
        if (!getConnectedAccountById(db, ownerUserId, accountId)) {
          return c.json({ error: { code: "not_found", message: "Agent event not found" } }, 404);
        }
        const store = options.agentEventStore?.updateLifecycle
          ? options.agentEventStore as Pick<AgentEventStore, "list" | "updateLifecycle">
          : new SqliteAgentEventStore(db, now);
        const event = await store.updateLifecycle({
          ownerUserId,
          accountId,
          eventId: c.req.param("id"),
          update: c.req.valid("json"),
        });
        return jsonWithSchema(c, propagatedAgentEventSchema, event);
      } catch (error) {
        const kind = agentEventMutationErrorKind(error);
        if (kind === "not_found") return c.json({ error: { code: "not_found", message: "Agent event not found" } }, 404);
        if (kind === "conflict") return c.json({ error: { code: "revision_conflict", message: publicAgentEventError(error) } }, 409);
        return c.json({ error: { code: "agent_event_update_failed", message: publicAgentEventError(error) } }, 503);
      } finally {
        sqlite.close();
      }
    },
  );

  app.get("/v1/agent-event-mutes", requireAuth({ dbFactory }), (c) => {
    const ownerUserId = c.get("auth").userId;
    const requestedAccountId = c.req.query("accountId")?.trim();
    const { db, sqlite } = dbFactory();
    try {
      const ownedIds = getUnifiedInboxAccounts(db, ownerUserId).map((account) => account.id);
      if (requestedAccountId && !ownedIds.includes(requestedAccountId)) {
        return c.json({ error: { code: "not_found", message: "Mail account not found" } }, 404);
      }
      const accountIds = requestedAccountId ? [requestedAccountId] : ownedIds;
      return jsonWithSchema(c, agentPropagationMuteListSchema, accountIds.flatMap((accountId) => listAgentPropagationMutes(db, accountId)));
    } finally {
      sqlite.close();
    }
  });

  app.delete("/v1/agent-event-mutes/:id", requireAuth({ dbFactory }), (c) => {
    const ownerUserId = c.get("auth").userId;
    const accountId = c.req.query("accountId")?.trim();
    if (!accountId) return c.json({ error: { code: "invalid_request", message: "accountId is required" } }, 400);
    const { db, sqlite } = dbFactory();
    try {
      const deleted = deleteAgentPropagationMute(db, { ownerUserId, accountId, muteId: c.req.param("id") });
      return deleted ? c.body(null, 204) : c.json({ error: { code: "not_found", message: "Local mute not found" } }, 404);
    } finally {
      sqlite.close();
    }
  });

  app.get("/v1/accounts", requireAuth({ dbFactory }), (c) => {
    const { db, sqlite } = dbFactory();
    try {
      return jsonWithSchema(c, mailAccountPageSchema, {
        items: getUnifiedInboxAccounts(db, c.get("auth").userId).map(serializeMailAccount),
        nextCursor: null,
      });
    } finally {
      sqlite.close();
    }
  });

  app.get("/v1/accounts/:id/avatar", requireAuth({ dbFactory }), (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const account = getConnectedAccountById(db, c.get("auth").userId, c.req.param("id"));
      if (!account?.profileImageUrl) return c.body(null, 404);
      const dataImage = /^data:(image\/(?:gif|jpe?g|png|webp));base64,([a-z0-9+/]+={0,2})$/i.exec(account.profileImageUrl);
      if (dataImage) {
        return new Response(Buffer.from(dataImage[2]!, "base64"), {
          headers: {
            "cache-control": "private, max-age=3600",
            "content-type": dataImage[1]!.toLowerCase(),
          },
        });
      }
      try {
        const imageUrl = new URL(account.profileImageUrl);
        if (imageUrl.protocol === "https:") return c.redirect(imageUrl.toString(), 302);
      } catch {
        // Invalid legacy values fall through to a bounded not-found response.
      }
      return c.body(null, 404);
    } finally {
      sqlite.close();
    }
  });

  app.delete("/v1/accounts/:id", requireAuth({ dbFactory }), (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const deleted = db.delete(oauthAccounts)
        .where(and(eq(oauthAccounts.id, c.req.param("id")), eq(oauthAccounts.userId, c.get("auth").userId)))
        .returning({ id: oauthAccounts.id })
        .get();
      if (!deleted) {
        return c.json({ error: { code: "not_found", message: "Connected account not found" } }, 404);
      }
      return c.body(null, 204);
    } finally {
      sqlite.close();
    }
  });

  app.get("/v1/preferences", requireAuth({ dbFactory }), (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const preference = db.select().from(userPreferences).where(eq(userPreferences.userId, c.get("auth").userId)).get();
      return jsonWithSchema(c, userPreferencesSchema, { signature: preference?.signature ?? "", composeFormat: preference?.composeFormat ?? "plain", replyBehavior: preference?.replyBehavior ?? "reply", notifyByDefault: preference?.notifyByDefault ?? false, firstViewGuidanceCompletedAt: preference?.firstViewGuidanceCompletedAt ?? null });
    } finally { sqlite.close(); }
  });

  app.patch("/v1/preferences", validator("json", (value, c) => validateJson(c, updateUserPreferencesSchema, value)), requireAuth({ dbFactory }), (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const input = c.req.valid("json");
      const userId = c.get("auth").userId;
      const current = db.select().from(userPreferences).where(eq(userPreferences.userId, userId)).get();
      // Completion is monotonic. A stale full Settings payload cannot reset it,
      // and the client timestamp is only an intent; the server owns the time.
      const next = { signature: current?.signature ?? "", composeFormat: current?.composeFormat ?? "plain", replyBehavior: current?.replyBehavior ?? "reply", notifyByDefault: current?.notifyByDefault ?? false, ...input,
        firstViewGuidanceCompletedAt: current?.firstViewGuidanceCompletedAt ?? (input.firstViewGuidanceCompletedAt ? now().toISOString() : null) };
      db.insert(userPreferences).values({ userId, ...next, updatedAt: now() }).onConflictDoUpdate({ target: userPreferences.userId, set: { ...next, firstViewGuidanceCompletedAt: sql`coalesce(${userPreferences.firstViewGuidanceCompletedAt}, ${next.firstViewGuidanceCompletedAt})`, updatedAt: now() } }).run();
      const saved = db.select().from(userPreferences).where(eq(userPreferences.userId, userId)).get()!;
      return jsonWithSchema(c, userPreferencesSchema, { ...next, firstViewGuidanceCompletedAt: saved.firstViewGuidanceCompletedAt });
    } finally { sqlite.close(); }
  });

  const getSyncStatus = (c: Context<{ Variables: AuthVariables }>) => {
    const { db, sqlite } = dbFactory();
    try {
      const accounts = getConnectedAccounts(db, c.get("auth").userId);
      const durableSyncJobs = new Map(gmailSyncCoordinator.jobsForAccounts(accounts.map((account) => account.id))
        .map((job) => [job.accountId, job]));
      return jsonWithSchema(c, syncStatusSchema, {
        accounts: accounts.map((account) => {
          const durableStatus = durableSyncJobs.get(account.id);
          const authNeeded = !account.accessTokenEncrypted || !account.refreshTokenEncrypted;
          return {
            ...serializeMailAccount(account),
            state: authNeeded
              ? "auth_needed"
              : durableStatus?.lastError
              ? "error"
              : durableStatus?.state === "queued" || durableStatus?.state === "running"
              ? "syncing"
              : "idle",
            lastSyncedAt: account.lastSyncedAt?.toISOString() ?? null,
            error: durableStatus?.lastError ?? null,
          };
        }),
      });
    } finally {
      sqlite.close();
    }
  };
  app.get("/v1/sync/status", requireAuth({ dbFactory }), getSyncStatus);
  app.get("/api/sync/status", requireAuth({ dbFactory }), getSyncStatus);

  app.get("/v1/attention/rules", requireAuth({ dbFactory }), (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const account = getConnectedAccountByProvider(db, c.get("auth").userId, "gmail");
      if (!account) return noConnectedAccount(c);
      return c.json(listSenderRules(db, account.id).map(toSenderRule));
    } finally {
      sqlite.close();
    }
  });

  app.post(
    "/v1/attention/rules/batch",
    validator("json", (value, c) => validateJson(c, batchSenderAttentionChangeSchema, value)),
    requireAuth({ dbFactory }),
    async (c) => {
      const { db, sqlite } = dbFactory();
      try {
        const input = c.req.valid("json");
        const accountById = new Map(
          getUnifiedInboxAccounts(db, c.get("auth").userId).map((account) => [account.id, account]),
        );
        if (input.targets.some((target) => !accountById.has(target.accountId))) {
          return c.json({ error: { code: "not_found", message: "Mail account was not found" } }, 404);
        }
        const result = await applySenderAttentionBatch(input, {
          write(targets, behavior) {
            const updatedAt = new Date();
            db.transaction((transaction) => {
              for (const target of targets) {
                const account = accountById.get(target.accountId)!;
                transaction.insert(senderAttentionRules).values({
                  id: `sender-rule:${crypto.randomUUID()}`,
                  accountId: account.id,
                  scope: "address",
                  value: target.address,
                  behavior,
                  source: "user_choice",
                  updatedAt,
                }).onConflictDoUpdate({
                  target: [senderAttentionRules.accountId, senderAttentionRules.scope, senderAttentionRules.value],
                  set: { behavior, source: "user_choice", updatedAt },
                }).run();
              }
            });
          },
          resolve(target) {
            const account = accountById.get(target.accountId)!;
            return resolveSenderAttention(db, account.id, target.address);
          },
        });
        return jsonWithSchema(c, senderAttentionBatchResultSchema, result);
      } finally {
        sqlite.close();
      }
    },
  );

  app.post(
    "/v1/attention/rules",
    validator("json", (value, c) => validateJson(c, createSenderAttentionRuleSchema, value)),
    requireAuth({ dbFactory }),
    (c) => {
      const { db, sqlite } = dbFactory();
      try {
        const account = getConnectedAccountByProvider(db, c.get("auth").userId, "gmail");
        if (!account) return noConnectedAccount(c);
        const input = normalizeRuleInput(c.req.valid("json"));
        const id = `sender-rule:${crypto.randomUUID()}`;
        db.insert(senderAttentionRules).values({ id, accountId: account.id, ...input }).run();
        return jsonWithSchema(c, senderAttentionRuleSchema, toSenderRule(getSenderRule(db, account.id, id)!));
      } catch (error) {
        return uniqueRuleError(c, error);
      } finally {
        sqlite.close();
      }
    },
  );

  app.patch(
    "/v1/attention/rules/:id",
    validator("json", (value, c) => validateJson(c, updateSenderAttentionRuleSchema, value)),
    requireAuth({ dbFactory }),
    (c) => {
      const { db, sqlite } = dbFactory();
      try {
        const account = getConnectedAccountByProvider(db, c.get("auth").userId, "gmail");
        if (!account) return noConnectedAccount(c);
        const existing = getSenderRule(db, account.id, c.req.param("id"));
        if (!existing) return c.json({ error: { code: "not_found", message: "Sender rule was not found" } }, 404);
        const input = normalizeRuleInput({ ...existing, ...c.req.valid("json") });
        db.update(senderAttentionRules).set({ ...input, updatedAt: new Date() })
          .where(and(eq(senderAttentionRules.accountId, account.id), eq(senderAttentionRules.id, existing.id))).run();
        return jsonWithSchema(c, senderAttentionRuleSchema, toSenderRule(getSenderRule(db, account.id, existing.id)!));
      } catch (error) {
        return uniqueRuleError(c, error);
      } finally {
        sqlite.close();
      }
    },
  );

  app.delete("/v1/attention/rules/:id", requireAuth({ dbFactory }), (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const account = getConnectedAccountByProvider(db, c.get("auth").userId, "gmail");
      if (!account) return noConnectedAccount(c);
      const existing = getSenderRule(db, account.id, c.req.param("id"));
      if (!existing) return c.json({ error: { code: "not_found", message: "Sender rule was not found" } }, 404);
      db.delete(senderAttentionRules).where(eq(senderAttentionRules.id, existing.id)).run();
      return c.body(null, 204);
    } finally {
      sqlite.close();
    }
  });

  app.get(
    "/v1/attention/resolve",
    validator("query", (value, c) => validateJson(c, resolveSenderAttentionSchema, value)),
    requireAuth({ dbFactory }),
    (c) => {
      const { db, sqlite } = dbFactory();
      try {
        const account = getConnectedAccountByProvider(db, c.get("auth").userId, "gmail");
        if (!account) return noConnectedAccount(c);
        const address = c.req.valid("query").address.toLowerCase();
        return jsonWithSchema(c, resolvedSenderAttentionSchema, resolveSenderAttention(db, account.id, address));
      } finally {
        sqlite.close();
      }
    },
  );

  app.get(
    "/v1/classification/overrides",
    validator("query", (value, c) => validateJson(c, listHumanClassificationOverridesSchema, value)),
    requireAuth({ dbFactory }),
    (c) => {
      const { db, sqlite } = dbFactory();
      try {
        const input = c.req.valid("query");
        const account = getConnectedAccountById(db, c.get("auth").userId, input.accountId);
        if (!account) return classificationAccountNotFound(c);
        return c.json(listHumanClassificationOverrides(db, account.id).map(toHumanClassificationOverride));
      } finally {
        sqlite.close();
      }
    },
  );

  app.post(
    "/v1/classification/overrides",
    validator("json", (value, c) => validateJson(c, createHumanClassificationOverrideSchema, value)),
    requireAuth({ dbFactory }),
    (c) => {
      const { db, sqlite } = dbFactory();
      try {
        const input = c.req.valid("json");
        const account = getConnectedAccountById(db, c.get("auth").userId, input.accountId);
        if (!account) return classificationAccountNotFound(c);
        const target = normalizeHumanClassificationOverrideTarget(input.target);
        if (target.scope === "message" && !getEmailByAccountId(db, account.id, target.value)) {
          return classificationTargetNotFound(c);
        }
        const id = `classification-override:${crypto.randomUUID()}`;
        db.insert(humanClassificationOverrides).values({
          id,
          accountId: account.id,
          targetType: target.scope,
          targetValue: target.value,
          classification: input.classification,
          source: "user_choice",
        }).run();
        return c.json(humanClassificationOverrideSchema.parse(toHumanClassificationOverride(
          getHumanClassificationOverride(db, account.id, id)!,
        )), 201);
      } catch (error) {
        return classificationOverrideConflict(c, error);
      } finally {
        sqlite.close();
      }
    },
  );

  app.patch(
    "/v1/classification/overrides/:id",
    validator("query", (value, c) => validateJson(c, deleteHumanClassificationOverrideSchema, value)),
    validator("json", (value, c) => validateJson(c, updateHumanClassificationOverrideSchema, value)),
    requireAuth({ dbFactory }),
    (c) => {
      const { db, sqlite } = dbFactory();
      try {
        const accountId = c.req.valid("query").accountId;
        const account = getConnectedAccountById(db, c.get("auth").userId, accountId);
        if (!account) return classificationAccountNotFound(c);
        const existing = getHumanClassificationOverride(db, account.id, c.req.param("id"));
        if (!existing) return classificationOverrideNotFound(c);
        db.update(humanClassificationOverrides)
          .set({ classification: c.req.valid("json").classification, updatedAt: new Date() })
          .where(and(eq(humanClassificationOverrides.accountId, account.id), eq(humanClassificationOverrides.id, existing.id)))
          .run();
        return jsonWithSchema(c, humanClassificationOverrideSchema, toHumanClassificationOverride(
          getHumanClassificationOverride(db, account.id, existing.id)!,
        ));
      } finally {
        sqlite.close();
      }
    },
  );

  app.delete(
    "/v1/classification/overrides/:id",
    validator("query", (value, c) => validateJson(c, deleteHumanClassificationOverrideSchema, value)),
    requireAuth({ dbFactory }),
    (c) => {
      const { db, sqlite } = dbFactory();
      try {
        const account = getConnectedAccountById(db, c.get("auth").userId, c.req.valid("query").accountId);
        if (!account) return classificationAccountNotFound(c);
        const existing = getHumanClassificationOverride(db, account.id, c.req.param("id"));
        if (!existing) return classificationOverrideNotFound(c);
        db.delete(humanClassificationOverrides).where(eq(humanClassificationOverrides.id, existing.id)).run();
        return c.body(null, 204);
      } finally {
        sqlite.close();
      }
    },
  );

  app.get(
    "/v1/classification/resolve",
    validator("query", (value, c) => validateJson(c, resolveHumanClassificationSchema, value)),
    requireAuth({ dbFactory }),
    (c) => {
      const { db, sqlite } = dbFactory();
      try {
        const input = c.req.valid("query");
        const account = getConnectedAccountById(db, c.get("auth").userId, input.accountId);
        if (!account) return classificationAccountNotFound(c);
        const message = getEmailByAccountId(db, account.id, input.messageId);
        if (!message) return classificationTargetNotFound(c);
        const resolve = createHumanClassificationOverrideResolver(listHumanClassificationOverrides(db, account.id));
        return jsonWithSchema(c, humanClassificationResultSchema, resolveHumanClassification(message, resolve));
      } finally {
        sqlite.close();
      }
    },
  );

  app.get("/v1/attention/view-settings", requireAuth({ dbFactory }), (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const account = getConnectedAccountByProvider(db, c.get("auth").userId, "gmail");
      if (!account) return noConnectedAccount(c);
      ensureViewSettings(db, account.id);
      return c.json(listViewSettings(db, account.id).map(toViewSetting));
    } finally {
      sqlite.close();
    }
  });

  app.patch(
    "/v1/attention/view-settings/:behavior",
    validator("json", (value, c) => validateJson(c, updateAttentionViewSettingSchema, value)),
    requireAuth({ dbFactory }),
    (c) => {
      const behavior = attentionBehaviorSchema.safeParse(c.req.param("behavior"));
      if (!behavior.success) return c.json({ error: { code: "validation_error", message: "Unknown attention behavior" } }, 400);
      const { db, sqlite } = dbFactory();
      try {
        const account = getConnectedAccountByProvider(db, c.get("auth").userId, "gmail");
        if (!account) return noConnectedAccount(c);
        ensureViewSettings(db, account.id);
        const current = db.select().from(attentionViewSettings).where(and(eq(attentionViewSettings.accountId, account.id), eq(attentionViewSettings.behavior, behavior.data))).get()!;
        const input = c.req.valid("json");
        updateViewSetting(db, account.id, current, input);
        const updated = db.select().from(attentionViewSettings).where(eq(attentionViewSettings.id, current.id)).get()!;
        return jsonWithSchema(c, attentionViewSettingSchema, toViewSetting(updated));
      } finally {
        sqlite.close();
      }
    },
  );

  app.get("/v1/collections", requireAuth({ dbFactory }), (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const account = getConnectedAccountByProvider(db, c.get("auth").userId, "gmail");
      if (!account) return noConnectedAccount(c);
      return c.json(listCollections(db, account.id).map((collection) => collectionSchema.parse(collection)));
    } finally {
      sqlite.close();
    }
  });

  app.get("/v1/gmail-label-migration", requireAuth({ dbFactory }), (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const account = getConnectedGmailAccount(db, c.get("auth").userId, c.req.query("accountId"));
      if (!account) return noConnectedAccount(c);
      return jsonWithSchema(c, gmailLabelMigrationSchema, getGmailLabelMigration(db, account));
    } finally {
      sqlite.close();
    }
  });

  app.post("/v1/gmail-label-migration/skip", requireAuth({ dbFactory }), (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const account = getConnectedGmailAccount(db, c.get("auth").userId, c.req.query("accountId"));
      if (!account) return noConnectedAccount(c);
      const current = db.select().from(gmailLabelMigrations).where(eq(gmailLabelMigrations.accountId, account.id)).get();
      if (current?.status !== "completed") {
        const timestamp = now();
        db.insert(gmailLabelMigrations).values({ accountId: account.id, status: "skipped", updatedAt: timestamp })
          .onConflictDoUpdate({ target: gmailLabelMigrations.accountId, set: { status: "skipped", completedAt: null, updatedAt: timestamp } }).run();
      }
      return jsonWithSchema(c, gmailLabelMigrationSchema, getGmailLabelMigration(db, account));
    } finally {
      sqlite.close();
    }
  });

  app.post(
    "/v1/gmail-label-migration/import",
    validator("json", (value, c) => validateJson(c, importGmailLabelsSchema, value)),
    requireAuth({ dbFactory }),
    (c) => {
      const { db, sqlite } = dbFactory();
      try {
        const account = getConnectedGmailAccount(db, c.get("auth").userId, c.req.query("accountId"));
        if (!account) return noConnectedAccount(c);
        if (!account.lastSyncedAt) {
          return c.json({ error: { code: "sync_incomplete", message: "Gmail must finish its initial sync before labels can be imported" } }, 409);
        }
        const current = db.select().from(gmailLabelMigrations).where(eq(gmailLabelMigrations.accountId, account.id)).get();
        if (current?.status === "completed") {
          return jsonWithSchema(c, gmailLabelMigrationSchema, getGmailLabelMigration(db, account));
        }

        const selectedIds = [...new Set(c.req.valid("json").labelIds)];
        const userLabels = db.select().from(labels).where(and(eq(labels.accountId, account.id), eq(labels.type, "user"))).all();
        const selectedLabels = selectedIds.map((id) => userLabels.find((label) => label.id === id));
        if (selectedLabels.some((label) => !label)) {
          return c.json({ error: { code: "validation_error", message: "Only user-created labels from this Gmail account can be imported" } }, 400);
        }

        const timestamp = now();
        const existingNames = new Set(db.select({ name: collections.name }).from(collections).where(eq(collections.accountId, account.id)).all().map((item) => item.name));
        db.transaction((tx) => {
          const executor = tx as unknown as Database;
          const { organization, scope } = collectionsPinsFor(executor, c.get("auth").userId);
          selectedLabels.forEach((label, index) => {
            if (!label) return;
            const name = uniqueImportedCollectionName(label.name, existingNames);
            const created = organization.apply({
              scope,
              request: {
                idempotencyKey: collectionImportIdempotencyKey(account.id, label.id),
                change: {
                  kind: "collection",
                  action: "create",
                  accountId: account.id,
                  collection: { name, color: collectionColors[index % collectionColors.length] },
                },
              },
            });
            const collectionId = created.change.resourceId;
            existingNames.add(name);
            tx.insert(gmailLabelCollectionImports).values({ labelId: label.id, collectionId }).onConflictDoNothing().run();
            const memberships = tx.select({ threadId: emails.threadId }).from(emailLabels)
              .innerJoin(emails, eq(emails.id, emailLabels.emailId)).where(eq(emailLabels.labelId, label.id)).all();
            for (const threadId of [...new Set(memberships.map((membership) => membership.threadId))].sort()) {
              organization.apply({
                scope,
                request: {
                  idempotencyKey: collectionImportIdempotencyKey(account.id, label.id, threadId),
                  change: { kind: "collection_membership", action: "add", accountId: account.id, collectionId, threadId },
                },
              });
            }
          });
          tx.insert(gmailLabelMigrations).values({ accountId: account.id, status: "completed", completedAt: timestamp, updatedAt: timestamp })
            .onConflictDoUpdate({ target: gmailLabelMigrations.accountId, set: { status: "completed", completedAt: timestamp, updatedAt: timestamp } }).run();
        });
        return jsonWithSchema(c, gmailLabelMigrationSchema, getGmailLabelMigration(db, account));
      } finally {
        sqlite.close();
      }
    },
  );

  app.post(
    "/v1/collections",
    validator("json", (value, c) => validateJson(c, createCollectionSchema, value)),
    requireAuth({ dbFactory }),
    (c) => {
      const { db, sqlite } = dbFactory();
      try {
        const account = getConnectedAccountByProvider(db, c.get("auth").userId, "gmail");
        if (!account) return noConnectedAccount(c);
        const input = c.req.valid("json");
        const { organization, scope } = collectionsPinsFor(db, c.get("auth").userId);
        const result = organization.apply({
          scope,
          request: {
            idempotencyKey: legacyOrganizationIdempotencyKey(c),
            change: {
              kind: "collection",
              action: "create",
              accountId: account.id,
              collection: { name: input.name.trim(), color: input.color ?? "#70867d" },
            },
          },
        });
        const id = result.change.resourceId;
        return c.json(collectionSchema.parse(listCollections(db, account.id).find((item) => item.id === id)!), 201);
      } catch (error) {
        return legacyOrganizationError(c, error, "A collection with that name already exists");
      } finally {
        sqlite.close();
      }
    },
  );

  app.patch(
    "/v1/collections/:id",
    validator("json", (value, c) => validateJson(c, updateCollectionSchema, value)),
    requireAuth({ dbFactory }),
    (c) => {
      const { db, sqlite } = dbFactory();
      try {
        const account = getConnectedAccountByProvider(db, c.get("auth").userId, "gmail");
        if (!account) return noConnectedAccount(c);
        const current = getCollection(db, account.id, c.req.param("id"));
        if (!current) return c.json({ error: { code: "not_found", message: "Collection not found" } }, 404);
        const { organization, scope } = collectionsPinsFor(db, c.get("auth").userId);
        organization.apply({
          scope,
          request: {
            idempotencyKey: legacyOrganizationIdempotencyKey(c),
            change: {
              kind: "collection",
              action: "update",
              accountId: account.id,
              collectionId: current.id,
              patch: c.req.valid("json"),
            },
          },
        });
        return jsonWithSchema(c, collectionSchema, listCollections(db, account.id).find((item) => item.id === current.id)!);
      } catch (error) {
        return legacyOrganizationError(c, error, "A collection with that name already exists");
      } finally {
        sqlite.close();
      }
    },
  );

  app.delete("/v1/collections/:id", requireAuth({ dbFactory }), (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const account = getConnectedAccountByProvider(db, c.get("auth").userId, "gmail");
      if (!account) return noConnectedAccount(c);
      const current = getCollection(db, account.id, c.req.param("id"));
      if (!current) return c.json({ error: { code: "not_found", message: "Collection not found" } }, 404);
      const { organization, scope } = collectionsPinsFor(db, c.get("auth").userId);
      organization.apply({
        scope,
        request: {
          idempotencyKey: legacyOrganizationIdempotencyKey(c),
          change: { kind: "collection", action: "remove", accountId: account.id, collectionId: current.id },
        },
      });
      return c.body(null, 204);
    } catch (error) {
      return legacyOrganizationError(c, error, "Collection state changed; refresh and try again");
    } finally {
      sqlite.close();
    }
  });

  app.put("/v1/collections/:id/threads/:threadId", requireAuth({ dbFactory }), (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const account = getConnectedAccountByProvider(db, c.get("auth").userId, "gmail");
      if (!account) return noConnectedAccount(c);
      const collection = getCollection(db, account.id, c.req.param("id"));
      const thread = db.select().from(threads).where(and(eq(threads.accountId, account.id), eq(threads.id, c.req.param("threadId")))).get();
      if (!collection || !thread) return c.json({ error: { code: "not_found", message: "Collection or thread not found" } }, 404);
      const { organization, scope } = collectionsPinsFor(db, c.get("auth").userId);
      organization.apply({
        scope,
        request: {
          idempotencyKey: legacyOrganizationIdempotencyKey(c),
          change: { kind: "collection_membership", action: "add", accountId: account.id, collectionId: collection.id, threadId: thread.id },
        },
      });
      return jsonWithSchema(c, collectionSchema, listCollections(db, account.id).find((item) => item.id === collection.id)!);
    } catch (error) {
      return legacyOrganizationError(c, error, "Collection membership changed; refresh and try again");
    } finally {
      sqlite.close();
    }
  });

  app.delete("/v1/collections/:id/threads/:threadId", requireAuth({ dbFactory }), (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const account = getConnectedAccountByProvider(db, c.get("auth").userId, "gmail");
      if (!account) return noConnectedAccount(c);
      const collection = getCollection(db, account.id, c.req.param("id"));
      if (!collection) return c.json({ error: { code: "not_found", message: "Collection not found" } }, 404);
      const { organization, scope } = collectionsPinsFor(db, c.get("auth").userId);
      organization.apply({
        scope,
        request: {
          idempotencyKey: legacyOrganizationIdempotencyKey(c),
          change: {
            kind: "collection_membership",
            action: "remove",
            accountId: account.id,
            collectionId: collection.id,
            threadId: c.req.param("threadId"),
          },
        },
      });
      return c.body(null, 204);
    } catch (error) {
      return legacyOrganizationError(c, error, "Collection membership changed; refresh and try again");
    } finally {
      sqlite.close();
    }
  });

  app.get("/v1/pins", requireAuth({ dbFactory }), (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const account = getConnectedAccountByProvider(db, c.get("auth").userId, "gmail");
      if (!account) return noConnectedAccount(c);
      return c.json(listPins(db, account.id).map((pin) => toPin(db, pin)));
    } finally {
      sqlite.close();
    }
  });

  app.post(
    "/v1/pins",
    validator("json", (value, c) => validateJson(c, createPinSchema, value)),
    requireAuth({ dbFactory }),
    (c) => {
      const { db, sqlite } = dbFactory();
      try {
        const account = getConnectedAccountByProvider(db, c.get("auth").userId, "gmail");
        if (!account) return noConnectedAccount(c);
        const input = c.req.valid("json");
        const target = input.kind === "filter"
          ? {
              type: "new_query" as const,
              name: input.label.trim(),
              definition: organizationSavedQueryDefinitionFromLegacyPinFilter(JSON.parse(input.targetId)),
            }
          : {
              type: "resource" as const,
              resource: { family: input.kind, id: input.targetId.trim() },
            };
        const { organization, scope } = collectionsPinsFor(db, c.get("auth").userId);
        const result = organization.apply({
          scope,
          request: {
            idempotencyKey: legacyOrganizationIdempotencyKey(c),
            change: {
              kind: "pin",
              action: "create",
              accountId: account.id,
              pin: {
                label: input.label.trim(),
                icon: input.icon ?? defaultPinIcon(input.kind),
                color: input.color ?? "#70867d",
                target,
              },
            },
          },
        });
        const created = db.select().from(pins).where(eq(pins.id, result.change.resourceId)).get()!;
        return c.json(pinSchema.parse(toPin(db, created)), 201);
      } catch (error) {
        if (error instanceof SyntaxError) return c.json({ error: { code: "validation_error", message: "Filter pins must contain a valid filter definition" } }, 400);
        return legacyOrganizationError(c, error, "That item is already pinned");
      } finally {
        sqlite.close();
      }
    },
  );

  app.patch(
    "/v1/pins/:id",
    validator("json", (value, c) => validateJson(c, updatePinSchema, value)),
    requireAuth({ dbFactory }),
    (c) => {
      const { db, sqlite } = dbFactory();
      try {
        const account = getConnectedAccountByProvider(db, c.get("auth").userId, "gmail");
        if (!account) return noConnectedAccount(c);
        const current = getPin(db, account.id, c.req.param("id"));
        if (!current) return c.json({ error: { code: "not_found", message: "Pin not found" } }, 404);
        const { organization, scope } = collectionsPinsFor(db, c.get("auth").userId);
        organization.apply({
          scope,
          request: {
            idempotencyKey: legacyOrganizationIdempotencyKey(c),
            change: { kind: "pin", action: "update", accountId: account.id, pinId: current.id, patch: c.req.valid("json") },
          },
        });
        const updatedPin = getPin(db, account.id, current.id);
        if (!updatedPin) return c.json({ error: { code: "not_found", message: "Pin not found" } }, 404);
        return jsonWithSchema(c, pinSchema, toPin(db, updatedPin));
      } catch (error) {
        return legacyOrganizationError(c, error, "That pin order changed. Try moving it again.");
      } finally {
        sqlite.close();
      }
    },
  );

  app.delete("/v1/pins/:id", requireAuth({ dbFactory }), (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const account = getConnectedAccountByProvider(db, c.get("auth").userId, "gmail");
      if (!account) return noConnectedAccount(c);
      const current = getPin(db, account.id, c.req.param("id"));
      if (!current) return c.json({ error: { code: "not_found", message: "Pin not found" } }, 404);
      const { organization, scope } = collectionsPinsFor(db, c.get("auth").userId);
      organization.apply({
        scope,
        request: {
          idempotencyKey: legacyOrganizationIdempotencyKey(c),
          change: { kind: "pin", action: "remove", accountId: account.id, pinId: current.id },
        },
      });
      return c.body(null, 204);
    } catch (error) {
      return legacyOrganizationError(c, error, "Pin state changed; refresh and try again");
    } finally {
      sqlite.close();
    }
  });

  app.get("/v1/reminders/view-settings", requireAuth({ dbFactory }), (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const account = getConnectedAccountByProvider(db, c.get("auth").userId, "gmail");
      if (!account) return noConnectedAccount(c);
      return jsonWithSchema(c, reminderViewSettingsSchema, getReminderViewSettings(db, account.id));
    } finally { sqlite.close(); }
  });

  app.patch("/v1/reminders/view-settings", validator("json", (value, c) => validateJson(c, reminderViewSettingsSchema, value)), requireAuth({ dbFactory }), (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const account = getConnectedAccountByProvider(db, c.get("auth").userId, "gmail");
      if (!account) return noConnectedAccount(c);
      const setting = c.req.valid("json");
      db.insert(reminderViewSettings).values({ accountId: account.id, displayName: setting.displayName })
        .onConflictDoUpdate({ target: reminderViewSettings.accountId, set: { displayName: setting.displayName, updatedAt: now() } }).run();
      return jsonWithSchema(c, reminderViewSettingsSchema, getReminderViewSettings(db, account.id));
    } finally { sqlite.close(); }
  });

  app.get("/v1/reminders", requireAuth({ dbFactory }), (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const account = getConnectedAccountByProvider(db, c.get("auth").userId, "gmail");
      if (!account) return noConnectedAccount(c);
      resurfaceDueReminders(db, account.id, now());
      const records = db.select().from(threadReminders).where(eq(threadReminders.accountId, account.id)).orderBy(asc(threadReminders.scheduledFor), asc(threadReminders.id)).all();
      return c.json(records.map(toReminder));
    } finally { sqlite.close(); }
  });

  app.post("/v1/reminders", validator("json", (value, c) => validateJson(c, createReminderSchema, value)), requireAuth({ dbFactory }), (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const account = getConnectedAccountByProvider(db, c.get("auth").userId, "gmail");
      if (!account) return noConnectedAccount(c);
      const input = c.req.valid("json");
      const scheduledFor = validateReminderTime(c, input.scheduledFor, input.timezone, now());
      if (!scheduledFor) return c.json({ error: { code: "validation_error", message: "Choose a future time in a valid timezone" } }, 400);
      const thread = db.select().from(threads).where(and(eq(threads.id, input.threadId), eq(threads.accountId, account.id))).get();
      if (!thread) return c.json({ error: { code: "not_found", message: "Thread not found" } }, 404);
      const existing = db.select().from(threadReminders).where(and(eq(threadReminders.accountId, account.id), eq(threadReminders.threadId, input.threadId), eq(threadReminders.status, "scheduled"))).get();
      const id = existing?.id ?? `reminder:${crypto.randomUUID()}`;
      db.insert(threadReminders).values({ id, accountId: account.id, threadId: input.threadId, scheduledFor, timezone: input.timezone, notify: input.notify ?? false, status: "scheduled" })
        .onConflictDoUpdate({ target: threadReminders.id, set: { scheduledFor, timezone: input.timezone, notify: input.notify ?? false, status: "scheduled", resurfacedAt: null, completedAt: null, cancelledAt: null, updatedAt: now() } }).run();
      return jsonWithSchema(c, reminderSchema, toReminder(db.select().from(threadReminders).where(eq(threadReminders.id, id)).get()!));
    } finally { sqlite.close(); }
  });

  app.patch("/v1/reminders/:id", validator("json", (value, c) => validateJson(c, updateReminderSchema, value)), requireAuth({ dbFactory }), (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const account = getConnectedAccountByProvider(db, c.get("auth").userId, "gmail");
      if (!account) return noConnectedAccount(c);
      const record = db.select().from(threadReminders).where(and(eq(threadReminders.id, c.req.param("id")), eq(threadReminders.accountId, account.id))).get();
      if (!record) return c.json({ error: { code: "not_found", message: "Reminder not found" } }, 404);
      const input = c.req.valid("json");
      const timezone = input.timezone ?? record.timezone;
      const scheduledFor = input.scheduledFor ? validateReminderTime(c, input.scheduledFor, timezone, now()) : record.scheduledFor;
      if (!scheduledFor) return c.json({ error: { code: "validation_error", message: "Choose a future time in a valid timezone" } }, 400);
      db.update(threadReminders).set({ scheduledFor, timezone, notify: input.notify ?? record.notify, status: "scheduled", resurfacedAt: null, completedAt: null, cancelledAt: null, updatedAt: now() }).where(eq(threadReminders.id, record.id)).run();
      return jsonWithSchema(c, reminderSchema, toReminder(db.select().from(threadReminders).where(eq(threadReminders.id, record.id)).get()!));
    } finally { sqlite.close(); }
  });

  app.post("/v1/reminders/:id/done", requireAuth({ dbFactory }), (c) => updateReminderTerminal(c, dbFactory, now, "completed"));
  app.delete("/v1/reminders/:id", requireAuth({ dbFactory }), (c) => updateReminderTerminal(c, dbFactory, now, "cancelled"));

  app.get("/v1/drafts", requireAuth({ dbFactory }), (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const account = getConnectedAccountByProvider(db, c.get("auth").userId, "gmail");
      if (!account) return noConnectedAccount(c);
      const drafts = db.select().from(messageDrafts)
        .where(eq(messageDrafts.accountId, account.id))
        .orderBy(desc(messageDrafts.updatedAt), asc(messageDrafts.id)).all();
      for (const draft of drafts) {
        if (draft.providerSyncStatus === "pending") scheduleDraftMirror(draft.id, draft.revision);
      }
      return c.json(drafts.map(toMessageDraft));
    } finally { sqlite.close(); }
  });

  app.post("/v1/drafts", validator("json", (value, c) => validateJson(c, createMessageDraftSchema, value)), requireAuth({ dbFactory }), async (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const account = getConnectedAccountByProvider(db, c.get("auth").userId, "gmail");
      if (!account) return noConnectedAccount(c);
      const id = crypto.randomUUID();
      const input = c.req.valid("json");
      if (!hasMeaningfulDraftContent(input)) {
        return c.json({
          error: {
            code: "validation_error",
            message: "A draft is created after you add a recipient, subject, message, or attachment",
            retryable: false,
          },
        }, 400);
      }
      const mirrorsToProvider = capabilitiesFor(account).draft;
      db.insert(messageDrafts).values({
        id,
        accountId: account.id,
        ...draftStorage(input),
        providerSyncStatus: mirrorsToProvider ? "pending" : "not_applicable",
      }).run();
      if (mirrorsToProvider) scheduleDraftMirror(id, 0);
      return c.json(messageDraftSchema.parse(toMessageDraft(getMessageDraft(db, account.id, id)!)), 201);
    } finally { sqlite.close(); }
  });

  app.get("/v1/drafts/:id", requireAuth({ dbFactory }), (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const account = getConnectedAccountByProvider(db, c.get("auth").userId, "gmail");
      if (!account) return noConnectedAccount(c);
      const draft = getMessageDraft(db, account.id, c.req.param("id"));
      if (!draft) return noDraft(c);
      if (draft.providerSyncStatus === "pending") scheduleDraftMirror(draft.id, draft.revision);
      return jsonWithSchema(c, messageDraftSchema, toMessageDraft(draft));
    } finally { sqlite.close(); }
  });

  app.patch("/v1/drafts/:id", validator("json", (value, c) => validateJson(c, updateMessageDraftSchema, value)), requireAuth({ dbFactory }), async (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const account = getConnectedAccountByProvider(db, c.get("auth").userId, "gmail");
      if (!account) return noConnectedAccount(c);
      const draft = getMessageDraft(db, account.id, c.req.param("id"));
      if (!draft) return noDraft(c);
      const update = c.req.valid("json");
      if (draft.revision !== update.revision) return staleDraft(c, draft.revision);
      if (draft.deliveryStatus !== "draft") {
        return c.json({ error: { code: "ambiguous_delivery", message: "A draft that has begun delivery cannot be edited", retryable: false } }, 409);
      }
      const current = toMessageDraft(draft);
      const content = createMessageDraftSchema.parse({
        to: update.to ?? current.to,
        cc: update.cc ?? current.cc,
        bcc: update.bcc ?? current.bcc,
        subject: update.subject ?? current.subject,
        body: update.body ?? current.body,
        context: update.context ?? current.context,
        attachments: update.attachments ?? current.attachments,
      });
      const mirrorsToProvider = capabilitiesFor(account).draft;
      const result = db.update(messageDrafts).set({
        ...draftStorage(content),
        revision: sql`${messageDrafts.revision} + 1`,
        providerSyncStatus: mirrorsToProvider ? "pending" : "not_applicable",
        providerSyncError: null,
        updatedAt: now(),
      })
        .where(and(
          eq(messageDrafts.id, draft.id),
          eq(messageDrafts.accountId, account.id),
          eq(messageDrafts.revision, update.revision),
          eq(messageDrafts.deliveryStatus, "draft"),
          isNull(messageDrafts.sendIdempotencyKey),
        ))
        .returning({ id: messageDrafts.id }).get();
      if (!result) {
        const latest = getMessageDraft(db, account.id, draft.id);
        if (!latest) return noDraft(c);
        if (latest.revision !== update.revision) return staleDraft(c, latest.revision);
        return deliveryStarted(c);
      }
      if (mirrorsToProvider) scheduleDraftMirror(draft.id, update.revision + 1);
      return jsonWithSchema(c, messageDraftSchema, toMessageDraft(getMessageDraft(db, account.id, draft.id)!));
    } finally { sqlite.close(); }
  });

  app.delete("/v1/drafts/:id", requireAuth({ dbFactory }), async (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const account = getConnectedAccountByProvider(db, c.get("auth").userId, "gmail");
      if (!account) return noConnectedAccount(c);
      const draft = getMessageDraft(db, account.id, c.req.param("id"));
      if (!draft) return noDraft(c);
      if (draft.deliveryStatus !== "draft" || draft.sendIdempotencyKey !== null) return deliveryStarted(c);
      if (draft.providerDraftId && capabilitiesFor(account).draft) {
        try {
          if (account.provider === "gmail" && options.deleteProviderDraft) {
            await options.deleteProviderDraft(db, account.id, draft.providerDraftId);
          } else {
            await transportFor(account).deleteDraft(db, account.id, draft.providerDraftId);
          }
        } catch {
          db.update(messageDrafts).set({
            providerSyncStatus: "failed",
            providerSyncError: `${providerDisplayName(account.provider)} could not discard its mirrored copy. Try again.`,
            updatedAt: now(),
          }).where(and(eq(messageDrafts.id, draft.id), eq(messageDrafts.accountId, account.id))).run();
          return c.json({
            error: {
              code: "provider_rejected",
              message: `${providerDisplayName(account.provider)} could not discard its mirrored copy. The Orca draft was kept so you can retry.`,
              retryable: true,
            },
          }, 502);
        }
      }
      const deleted = db.delete(messageDrafts)
        .where(and(
          eq(messageDrafts.id, draft.id),
          eq(messageDrafts.accountId, account.id),
          eq(messageDrafts.deliveryStatus, "draft"),
          isNull(messageDrafts.sendIdempotencyKey),
        ))
        .returning({ id: messageDrafts.id }).get();
      if (!deleted) {
        const latest = getMessageDraft(db, account.id, draft.id);
        return latest ? deliveryStarted(c) : noDraft(c);
      }
      return c.body(null, 204);
    } finally { sqlite.close(); }
  });

  function scheduleDraftMirror(draftId: string, revision: number) {
    if (draftMirrorJobs.has(draftId)) return;
    draftMirrorJobs.add(draftId);
    queueMicrotask(async () => {
      const { db, sqlite } = dbFactory();
      let nextRevision: number | null = null;
      try {
        const draft = db.select().from(messageDrafts).where(and(
          eq(messageDrafts.id, draftId),
          eq(messageDrafts.revision, revision),
          eq(messageDrafts.deliveryStatus, "draft"),
        )).get();
        if (!draft) return;
        const content = createMessageDraftSchema.parse({
          to: parseDraftJson(draft.toRecipients, []),
          cc: parseDraftJson(draft.ccRecipients, []),
          bcc: parseDraftJson(draft.bccRecipients, []),
          subject: draft.subject,
          body: { text: draft.bodyText, html: draft.bodyHtml },
          context: parseDraftJson(draft.context, null),
          attachments: parseDraftJson(draft.attachments, []),
        });
        const account = getAccountById(db, draft.accountId);
        if (!account) return;
        try {
          const mirrored = account.provider === "gmail" && options.mirrorDraft
            ? await options.mirrorDraft(db, {
                accountId: draft.accountId,
                content,
                providerDraftId: draft.providerDraftId,
              })
            : await transportFor(account).saveDraft(db, account.id, toMessageDraft(draft));
          const updated = db.update(messageDrafts).set({
            providerDraftId: mirrored.providerDraftId,
            providerMessageId: mirrored.providerMessageId ?? null,
            providerThreadId: mirrored.providerThreadId ?? null,
            providerSyncStatus: "synced",
            providerSyncError: null,
            updatedAt: now(),
          }).where(and(eq(messageDrafts.id, draft.id), eq(messageDrafts.revision, revision)))
            .returning({ id: messageDrafts.id }).get();
          if (!updated) {
            // A newer local revision arrived while the provider was creating the
            // provider draft. Carry that provider ID forward so the next job
            // updates the same provider draft instead of creating an orphan.
            db.update(messageDrafts).set({
              providerDraftId: mirrored.providerDraftId,
              providerMessageId: mirrored.providerMessageId ?? null,
              providerThreadId: mirrored.providerThreadId ?? null,
            }).where(and(eq(messageDrafts.id, draft.id), isNull(messageDrafts.providerDraftId))).run();
          }
        } catch (error) {
          db.update(messageDrafts).set({
            providerSyncStatus: "failed",
            providerSyncError: error instanceof Error
              ? error.message
              : `${providerDisplayName(account.provider)} could not mirror this draft`,
            updatedAt: now(),
          }).where(and(eq(messageDrafts.id, draft.id), eq(messageDrafts.revision, revision))).run();
        }
        const latest = db.select({
          revision: messageDrafts.revision,
          providerSyncStatus: messageDrafts.providerSyncStatus,
        }).from(messageDrafts).where(eq(messageDrafts.id, draftId)).get();
        if (latest?.providerSyncStatus === "pending") nextRevision = latest.revision;
      } finally {
        sqlite.close();
        draftMirrorJobs.delete(draftId);
        if (nextRevision !== null) scheduleDraftMirror(draftId, nextRevision);
      }
    });
  }

  app.post("/v1/drafts/:id/send", validator("json", (value, c) => validateJson(c, sendMessageDraftSchema, value)), requireAuth({ dbFactory }), async (c) => {
    const { db, sqlite } = dbFactory();
    try {
      const account = getConnectedAccountByProvider(db, c.get("auth").userId, "gmail");
      if (!account) return noConnectedAccount(c);
      const draft = getMessageDraft(db, account.id, c.req.param("id"));
      if (!draft) return noDraft(c);
      const command = c.req.valid("json");
      if (draft.revision !== command.revision) return staleDraft(c, draft.revision);
      if (draft.sendIdempotencyKey) {
        if (draft.sendIdempotencyKey !== command.idempotencyKey) {
          return c.json({ error: { code: "ambiguous_delivery", message: "This draft already has a delivery command; inspect its status before retrying", retryable: false } }, 409);
        }
        return jsonWithSchema(c, deliveryResultSchema, toDeliveryResult(draft));
      }
      if (!capabilitiesFor(account).send) {
        return c.json({ error: { code: "missing_capability", message: `The connected ${providerDisplayName(account.provider)} account has read-only access and cannot deliver mail`, retryable: false } }, 501);
      }
      if (toMessageDraft(draft).attachments.some((attachment) => !attachment.contentBase64)) {
        return c.json({ error: { code: "provider_rejected", message: "Attachments must finish uploading before this message can be delivered", retryable: false } }, 409);
      }
      const reserved = db.update(messageDrafts).set({ deliveryStatus: "sending", sendIdempotencyKey: command.idempotencyKey, updatedAt: now() })
        .where(and(eq(messageDrafts.id, draft.id), eq(messageDrafts.accountId, account.id), eq(messageDrafts.revision, command.revision), isNull(messageDrafts.sendIdempotencyKey), eq(messageDrafts.deliveryStatus, "draft")))
        .returning({ id: messageDrafts.id }).get();
      if (!reserved) return jsonWithSchema(c, deliveryResultSchema, toDeliveryResult(getMessageDraft(db, account.id, draft.id)!));
      const sending = toMessageDraft(getMessageDraft(db, account.id, draft.id)!);
      try {
        const provider = await transportFor(account).send(db, account.id, sending);
        db.update(messageDrafts).set({ deliveryStatus: "sent", providerMessageId: provider.providerMessageId, providerThreadId: provider.providerThreadId, updatedAt: now() }).where(eq(messageDrafts.id, draft.id)).run();
      } catch (error) {
        const transport = asTransportError(error);
        db.update(messageDrafts).set({ deliveryStatus: transport.kind === "rejected" || transport.kind === "auth" ? "rejected" : "ambiguous", updatedAt: now() }).where(eq(messageDrafts.id, draft.id)).run();
      }
      return jsonWithSchema(c, deliveryResultSchema, toDeliveryResult(getMessageDraft(db, account.id, draft.id)!));
    } finally { sqlite.close(); }
  });

  app.get(
    "/v1/inbox",
    validator("query", (value, c) => {
      const result = inboxQuerySchema.safeParse(value);
      if (!result.success) {
        return c.json(
          {
            error: {
              code: "validation_error",
              message: "Invalid inbox query parameters",
              issues: result.error.issues.map((issue) => ({
                path: issue.path.join(".") || "query",
                message: issue.message,
              })),
            },
          } satisfies ValidationErrorResponse,
          400,
        );
      }

      return result.data;
    }),
    requireAuth({ dbFactory }),
    (c) => {
      const { cursor, limit = defaultInboxLimit, view, classification, query, sender, accountId, collectionId } = c.req.valid("query");
      const useClassificationResponse = classification !== undefined;
      const { sqlite } = dbFactory();
      try {
        try {
          const { response: result, metric } = createMailboxReader(sqlite, {
            capabilitiesFor: mailboxCapabilitiesFor,
            observe: options.mailboxReadObserver,
          }).read({
            authorization: { userId: c.get("auth").userId, ...(accountId ? { accountIds: [accountId] } : {}) },
            query: { cursor, limit, view, classification, query, sender, collectionId },
          });
          c.header("Server-Timing", `orca-mailbox;dur=${metric.durationMs.toFixed(2)}`);
          c.header("X-Orca-Mailbox-Revision", result.freshness.revision);
          return jsonWithSchema(c, inboxResponseSchema, {
            ...result,
            counts: useClassificationResponse ? result.counts : result.counts.attention,
          });
        } catch (error) {
          if (error instanceof MailboxCursorError) {
            return c.json({ error: { code: error.code, message: error.message } }, 400);
          }
          if (error instanceof MailboxScopeError) {
            return c.json({ error: { code: "not_found", message: error.message } }, 404);
          }
          throw error;
        }
      } finally {
        sqlite.close();
      }
    },
  );

  app.get(
    "/v1/threads/:threadId",
    validator("query", (value, c) => {
      const result = threadQuerySchema.safeParse(value);
      if (!result.success) return c.json({ error: { code: "validation_error", message: "An accountId is required to read a thread" } }, 400);
      return result.data;
    }),
    requireAuth({ dbFactory }),
    (c) => {
      const { db, sqlite } = dbFactory();
      try {
        const account = getConnectedAccountById(db, c.get("auth").userId, c.req.valid("query").accountId);
        if (!account) return c.json({ error: { code: "not_found", message: "Thread not found" } }, 404);
        try {
          const organized = createOrganization(createSqliteOrganizationRepository(db)).query({
            scope: {
              actor: { id: c.get("auth").userId, type: "human" },
              workspaceId: c.get("auth").userId,
              accountIds: [account.id],
            },
            query: { accountIds: [account.id], threadId: c.req.param("threadId"), attention: "all", classification: "all", limit: 1 },
          });
          if (organized.threads.length === 0) throw new McpReadError("not_found", "Thread not found");
          return jsonWithSchema(c, threadDetailSchema, readThreadDetail(
            db,
            account,
            serializeMailAccount(account),
            c.req.param("threadId"),
          ));
        } catch (error) {
          if (error instanceof McpReadError && error.code === "not_found") {
            return c.json({ error: { code: error.code, message: error.message } }, 404);
          }
          throw error;
        }
      } finally {
        sqlite.close();
      }
    },
  );

  app.post(
    "/v1/threads/:threadId/reply-brief",
    validator("query", (value, c) => {
      const result = threadQuerySchema.safeParse(value);
      if (!result.success) return c.json({ error: { code: "validation_error", message: "An accountId is required to request reply guidance" } }, 400);
      return result.data;
    }),
    validator("json", (value, c) => {
      const result = replyBriefInvocationRequestSchema.safeParse(value);
      if (!result.success) return c.json({ error: { code: "validation_error", message: "Reply guidance requires an explicit, scoped user request" } }, 400);
      return result.data;
    }),
    requireAuth({ dbFactory }),
    async (c) => {
      const request = c.req.valid("json");
      const accountId = c.req.valid("query").accountId;
      const threadId = c.req.param("threadId");
      const userId = c.get("auth").userId;
      const { db, sqlite } = dbFactory();
      let thread: ThreadDetail;
      let workingHours: CalendarWorkingHours | null = null;
      try {
        const account = getConnectedAccountById(db, userId, accountId);
        if (!account) return c.json({ error: { code: "not_found", message: "Conversation not found" } }, 404);
        if (request.accountId !== accountId || request.provider !== account.provider || request.threadId !== threadId) {
          return c.json({ error: { code: "validation_error", message: "Reply guidance scope must match the selected conversation" } }, 400);
        }
        try {
          thread = readThreadDetail(db, account, serializeMailAccount(account), threadId);
        } catch (error) {
          if (error instanceof McpReadError && error.code === "not_found") {
            return c.json({ error: { code: "not_found", message: "Conversation not found" } }, 404);
          }
          throw error;
        }
        const calendarPreference = db.select().from(calendarPreferences).where(eq(calendarPreferences.userId, userId)).get();
        if (calendarPreference?.workingHours) {
          try {
            const parsedWorkingHours = calendarWorkingHoursSchema.safeParse(JSON.parse(calendarPreference.workingHours));
            workingHours = parsedWorkingHours.success ? parsedWorkingHours.data : null;
          } catch {
            workingHours = null;
          }
        }
      } finally {
        sqlite.close();
      }
      try {
        let availability: CalendarAvailabilityResponse | null = null;
        if (options.replyBriefAvailability) {
          availability = await options.replyBriefAvailability({ userId, request, thread });
        } else if (request.calendarConnectionId && request.authorizedContext.includes("calendar_availability")) {
          availability = await replyBriefCalendarResolver.resolve({
            userId,
            request: {
              connectionId: request.calendarConnectionId,
              requestedWindows: interpretRequestedAvailabilityWindows({
                thread,
                selectedMessageIds: request.selectedMessageIds,
                requestedAt: request.requestedAt,
                userTimeZone: request.userTimeZone,
                webOrigin: serverConfig.webOrigin,
              }),
              userTimeZone: request.userTimeZone,
              workingHours,
            },
          });
        }
        return jsonWithSchema(c, replyBriefOutputSchema, createOnDemandReplyBrief({
          request,
          thread,
          availability,
          now: now(),
          webOrigin: serverConfig.webOrigin,
        }));
      } catch (error) {
        if (error instanceof Error && /selected|scope|belong|invocation/i.test(error.message)) {
          return c.json({ error: { code: "validation_error", message: error.message } }, 400);
        }
        throw error;
      }
    },
  );

  app.patch(
    "/v1/threads/:threadId/read",
    validator("query", (value, c) => {
      const result = threadQuerySchema.safeParse(value);
      if (!result.success) return c.json({ error: { code: "validation_error", message: "An accountId is required to mark a thread as read" } }, 400);
      return result.data;
    }),
    requireAuth({ dbFactory }),
    (c) => {
      const { db, sqlite } = dbFactory();
      try {
        const account = getConnectedAccountById(db, c.get("auth").userId, c.req.valid("query").accountId);
        if (!account) return noConnectedAccount(c);
        const thread = db.select().from(threads)
          .where(and(eq(threads.id, c.req.param("threadId")), eq(threads.accountId, account.id))).get();
        if (!thread) return c.json({ error: { code: "not_found", message: "Thread not found" } }, 404);
        db.update(emails)
          .set({ isRead: true, updatedAt: now() })
          .where(and(eq(emails.threadId, thread.id), eq(emails.accountId, account.id)))
          .run();
        db.update(threads)
          .set({ isRead: true, updatedAt: now() })
          .where(eq(threads.id, thread.id))
          .run();
        return c.json({ ok: true });
      } finally {
        sqlite.close();
      }
    },
  );

  for (const provider of providerRegistry.list()) {
    const routePrefix = providerAuthRoutePrefixes[provider.provider];
    if (!routePrefix) {
      throw new Error(`No OAuth route prefix is configured for mail provider ${provider.provider}`);
    }
    app.route(routePrefix, provider.createOAuthApp({ dbFactory }));
  }

  app.post(
    "/v1/gmail/watch",
    requireAuth({ dbFactory }),
    async (c) => {
      if (!gmailPushConfig.verificationToken || !gmailPushConfig.topicName) {
        return c.json({ error: { code: "push_not_configured", message: "Gmail push verification is not configured" } }, 503);
      }
      const { db, sqlite } = dbFactory();
      try {
        const accountId = c.req.query("accountId");
        const account = accountId
          ? getConnectedGmailAccount(db, c.get("auth").userId, accountId)
          : getPreferredConnectedAccount(db, c.get("auth").userId);
        if (!account) {
          return c.json({ error: { code: "not_found", message: "No Gmail account is connected for this user" } }, 404);
        }

        gmailSyncCoordinator.enqueue({ accountId: account.id, source: "fallback", freshnessAt: now() });
        const drained = await gmailSyncCoordinator.drainAccount(account.id);
        if (drained.error) throw drained.error;
        if (!drained.acquired) return c.json({ queued: true }, 202);
        return c.json({
          watch: drained.result?.watch ?? null,
          backfill: drained.result?.backfill ?? null,
        }, 200);
      } catch (error) {
        const publicError = toPublicPushError(error);
        return c.json({ error: { code: publicError.code, message: publicError.message } }, publicError.status);
      } finally {
        sqlite.close();
      }
    },
  );

  app.post(
    "/v1/sync/gmail",
    requireAuth({ dbFactory }),
    async (c) => {
      const auth = c.get("auth");
      const { db, sqlite } = dbFactory();
      let account: ConnectedAccount | undefined;

      try {
        const accountId = c.req.query("accountId");
        account = accountId
          ? getConnectedGmailAccount(db, auth.userId, accountId)
          : getPreferredConnectedAccount(db, auth.userId);

        if (!account) {
          return c.json(
            {
              error: {
                code: "not_found",
                message: "No Gmail account is connected for this user",
              },
            },
            404,
          );
        }

        const connectedAccount = account;
        if (connectedAccount.provider !== "gmail") {
          await providerFor(connectedAccount).syncPage(db, { accountId: connectedAccount.id, pageSize: 25 });
          throw new ProviderNotImplementedError(connectedAccount.provider, "sync");
        }
        gmailSyncCoordinator.enqueue({ accountId: connectedAccount.id, source: "manual", freshnessAt: now() });
        const drained = await withGmailSyncLock(connectedAccount.id, () => gmailSyncCoordinator.drainAccount(connectedAccount.id));
        if (drained.error) throw drained.error;
        if (!drained.acquired) return c.json({ queued: true }, 202);
        const result = drained.result ?? {};
        return c.json({
          accountId: String(result.accountId ?? connectedAccount.id),
          emailCount: Number(result.emailCount ?? 0),
          threadCount: Number(result.threadCount ?? 0),
          labelCount: Number(result.labelCount ?? 0),
          contactCount: Number(result.contactCount ?? 0),
          nextCursor: typeof result.nextCursor === "string" ? result.nextCursor : null,
          lastSyncedAt: typeof result.lastSyncedAt === "string" ? result.lastSyncedAt : now().toISOString(),
          pages: Number(result.pages ?? result.pageCount ?? 0),
        }, 200);
      } catch (error) {
        console.error(`${account?.provider ?? "mail"} sync failed`, {
          userId: auth.userId,
          error,
        });

        const publicError = toPublicSyncError(error);
        return c.json(
          {
            error: {
              code: publicError.code,
              message: publicError.message,
            },
          },
          publicError.status,
        );
      } finally {
        sqlite.close();
      }
    },
  );

  app.post(
    "/v1/sync/gmail/reset",
    requireAuth({ dbFactory }),
    async (c) => {
      const auth = c.get("auth");
      const { db, sqlite } = dbFactory();
      let account: ConnectedAccount | undefined;

      try {
        const accountId = c.req.query("accountId");
        account = getGmailRecoveryAccount(db, auth.userId, accountId);

        if (!account) {
          return c.json(
            {
              error: {
                code: "not_found",
                message: accountId
                  ? "The selected Gmail connection was not found. Refresh settings and try again."
                  : "No Gmail account is connected for this user",
              },
            },
            404,
          );
        }

        const connectedAccount = account;
        gmailSyncCoordinator.enqueue({
          accountId: connectedAccount.id,
          source: "reset",
          fullResync: true,
          freshnessAt: now(),
        });
        const drained = await gmailSyncCoordinator.drainAccount(connectedAccount.id);
        if (drained.error) throw drained.error;
        if (!drained.acquired) return c.json({ queued: true }, 202);
        return c.json(drained.result ?? { queued: false }, 200);
      } catch (error) {
        console.error("Gmail full resync failed", {
          userId: auth.userId,
          accountId: account?.id,
          error,
        });

        const publicError = toPublicSyncError(error);
        return c.json(
          {
            error: {
              code: publicError.code,
              message: publicError.message,
            },
          },
          publicError.status,
        );
      } finally {
        sqlite.close();
      }
    },
  );

  return app;
}

type ConnectedAccount = {
  id: string;
  provider: MailProvider;
  providerEmail: string;
  displayName: string | null;
  profileImageUrl: string | null;
  accessTokenEncrypted: string | null;
  refreshTokenEncrypted: string | null;
  syncCursor: string | null;
  syncHistoryId: string | null;
  lastSyncedAt: Date | null;
  updatedAt: Date;
  scope: string | null;
};

type Database = ReturnType<typeof createDatabaseClient>["db"];
type SenderRuleRecord = typeof senderAttentionRules.$inferSelect;
export type HumanClassificationOverrideRecord = typeof humanClassificationOverrides.$inferSelect;
export type ClassificationEmailRecord = Pick<typeof emails.$inferSelect,
  "id" | "accountId" | "fromAddress" | "humanSignal" | "humanClassification" | "humanClassificationReasons" | "humanClassifierVersion"
>;
type ViewSettingRecord = typeof attentionViewSettings.$inferSelect;
type CollectionRecord = typeof collections.$inferSelect;
type PinRecord = typeof pins.$inferSelect;
type ReminderRecord = typeof threadReminders.$inferSelect;
type MessageDraftRecord = typeof messageDrafts.$inferSelect;

class OrganizationTargetError extends Error {}

function validateJson<T>(c: Context, schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } } }, value: unknown) {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const attachmentLimit = result.error.issues.some((issue) => issue.message.includes("Attachments exceed the 25 MB delivery limit"));
  return c.json({
    error: {
      code: attachmentLimit ? "attachment_limit" : "validation_error",
      message: attachmentLimit ? "Attachments exceed the 25 MB delivery limit" : "Invalid request data",
      ...(attachmentLimit ? { retryable: false } : {}),
      issues: result.error.issues.map((issue) => ({ path: issue.path.join(".") || "body", message: issue.message })),
    },
  }, 400);
}

function noConnectedAccount(c: Context) {
  return c.json({ error: { code: "not_found", message: "No Gmail account is connected" } }, 404);
}

function noDraft(c: Context) {
  return c.json({ error: { code: "not_found", message: "Draft not found" } }, 404);
}

function staleDraft(c: Context, currentRevision: number) {
  return c.json({
    error: {
      code: "stale_draft",
      message: "This draft changed somewhere else. Reload it before saving again.",
      retryable: true,
      currentRevision,
    },
  }, 409);
}

function deliveryStarted(c: Context) {
  return c.json({
    error: {
      code: "ambiguous_delivery",
      message: "A draft with a reserved delivery command cannot be changed or discarded",
      retryable: false,
    },
  }, 409);
}

function asTransportError(error: unknown) {
  return error instanceof GmailTransportError
    ? error
    : error instanceof ProviderNotImplementedError
      ? new GmailTransportError(`${providerDisplayName(error.provider)} transport is not implemented`, "rejected", false)
    : new GmailTransportError("The delivery outcome could not be confirmed", "ambiguous", true);
}

function transportError(c: Context, error: unknown) {
  const transport = asTransportError(error);
  const code = transport.kind === "ambiguous" ? "ambiguous_delivery" : "provider_rejected";
  const status = transport.kind === "auth" ? 401 : transport.kind === "rate_limit" ? 429 : transport.kind === "ambiguous" ? 503 : 422;
  return c.json({ error: { code, message: transport.message, retryable: transport.retryable } }, status);
}

function getMessageDraft(db: Database, accountId: string, id: string) {
  return db.select().from(messageDrafts)
    .where(and(eq(messageDrafts.id, id), eq(messageDrafts.accountId, accountId))).get();
}

function draftStorage(input: ReturnType<typeof createMessageDraftSchema.parse>) {
  return {
    toRecipients: JSON.stringify(input.to),
    ccRecipients: JSON.stringify(input.cc),
    bccRecipients: JSON.stringify(input.bcc),
    subject: input.subject,
    bodyText: input.body.text,
    bodyHtml: sanitizeOutboundHtml(input.body.html),
    context: input.context ? JSON.stringify(input.context) : null,
    attachments: JSON.stringify(input.attachments),
  };
}

function hasMeaningfulDraftContent(input: ReturnType<typeof createMessageDraftSchema.parse>) {
  return input.to.length + input.cc.length + input.bcc.length > 0
    || Boolean(input.subject.trim())
    || Boolean(input.body.text.trim())
    || Boolean(input.body.html?.trim())
    || input.attachments.length > 0;
}

function toMessageDraft(draft: MessageDraftRecord): ReturnType<typeof messageDraftSchema.parse> {
  return messageDraftSchema.parse({
    id: draft.id,
    accountId: draft.accountId,
    to: parseDraftJson(draft.toRecipients, []),
    cc: parseDraftJson(draft.ccRecipients, []),
    bcc: parseDraftJson(draft.bccRecipients, []),
    subject: draft.subject,
    body: { text: draft.bodyText, html: draft.bodyHtml },
    context: parseDraftJson(draft.context, null),
    attachments: parseDraftJson(draft.attachments, []),
    revision: draft.revision,
    deliveryStatus: draft.deliveryStatus,
    providerSyncStatus: draft.providerSyncStatus,
    providerSyncError: draft.providerSyncError,
    providerDraftId: draft.providerDraftId,
    providerMessageId: draft.providerMessageId,
    providerThreadId: draft.providerThreadId,
    createdAt: draft.createdAt.toISOString(),
    updatedAt: draft.updatedAt.toISOString(),
  });
}

function parseDraftJson(value: string | null, fallback: unknown) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function toDeliveryResult(draft: MessageDraftRecord) {
  const error = draft.deliveryStatus === "rejected"
    ? { code: "provider_rejected" as const, message: "The provider rejected this delivery", retryable: false }
    : draft.deliveryStatus === "ambiguous"
      ? { code: "ambiguous_delivery" as const, message: "The provider outcome could not be confirmed", retryable: false }
      : null;
  return {
    draftId: draft.id,
    status: draft.deliveryStatus as "draft" | "queued" | "sending" | "sent" | "rejected" | "ambiguous",
    providerMessageId: draft.providerMessageId,
    providerThreadId: draft.providerThreadId,
    error,
  };
}

function getReminderViewSettings(db: Database, accountId: string) {
  const setting = db.select().from(reminderViewSettings).where(eq(reminderViewSettings.accountId, accountId)).get();
  return { displayName: setting?.displayName ?? "Later" };
}

function isValidTimeZone(timezone: string) {
  try { Intl.DateTimeFormat(undefined, { timeZone: timezone }); return true; } catch { return false; }
}

function validateReminderTime(_c: Context, isoTime: string, timezone: string, currentTime: Date) {
  const scheduledFor = new Date(isoTime);
  if (!isValidTimeZone(timezone) || Number.isNaN(scheduledFor.getTime()) || scheduledFor.getTime() <= currentTime.getTime()) return null;
  return scheduledFor;
}

function toReminder(reminder: ReminderRecord) {
  return {
    id: reminder.id, accountId: reminder.accountId, threadId: reminder.threadId,
    scheduledFor: reminder.scheduledFor.toISOString(), timezone: reminder.timezone, notify: reminder.notify,
    status: reminder.status as "scheduled" | "resurfaced" | "completed" | "cancelled",
    resurfacedAt: reminder.resurfacedAt?.toISOString() ?? null,
    completedAt: reminder.completedAt?.toISOString() ?? null,
    cancelledAt: reminder.cancelledAt?.toISOString() ?? null,
    createdAt: reminder.createdAt.toISOString(), updatedAt: reminder.updatedAt.toISOString(),
  };
}

function resurfaceDueReminders(db: Database, accountId: string, currentTime: Date) {
  db.update(threadReminders).set({ status: "resurfaced", resurfacedAt: currentTime, updatedAt: currentTime })
    .where(and(eq(threadReminders.accountId, accountId), eq(threadReminders.status, "scheduled"), sql`${threadReminders.scheduledFor} <= ${currentTime.getTime()}`)).run();
}

function updateReminderTerminal(
  c: Context<{ Variables: AuthVariables }>,
  dbFactory: typeof createDatabaseClient,
  now: () => Date,
  status: "completed" | "cancelled",
) {
  const { db, sqlite } = dbFactory();
  try {
    const account = getConnectedAccountByProvider(db, c.get("auth").userId, "gmail");
    if (!account) return noConnectedAccount(c);
    const reminderId = c.req.param("id");
    if (!reminderId) return c.json({ error: { code: "not_found", message: "Reminder not found" } }, 404);
    const record = db.select().from(threadReminders).where(and(eq(threadReminders.id, reminderId), eq(threadReminders.accountId, account.id))).get();
    if (!record) return c.json({ error: { code: "not_found", message: "Reminder not found" } }, 404);
    if (record.status !== status) {
      const timestamp = now();
      db.update(threadReminders).set({ status, completedAt: status === "completed" ? timestamp : record.completedAt, cancelledAt: status === "cancelled" ? timestamp : record.cancelledAt, updatedAt: timestamp }).where(eq(threadReminders.id, record.id)).run();
    }
    const updated = db.select().from(threadReminders).where(eq(threadReminders.id, record.id)).get()!;
    return status === "cancelled" ? c.body(null, 204) : jsonWithSchema(c, reminderSchema, toReminder(updated));
  } finally { sqlite.close(); }
}

function normalizeRuleInput(input: { scope: string; value: string; behavior: string; source: string }) {
  return createSenderAttentionRuleSchema.parse({
    scope: input.scope,
    value: input.value.trim().toLowerCase(),
    behavior: input.behavior,
    source: input.source,
  });
}

function classificationAccountNotFound(c: Context) {
  return c.json({ error: { code: "not_found", message: "Mail account was not found" } }, 404);
}

function classificationTargetNotFound(c: Context) {
  return c.json({ error: { code: "not_found", message: "Classification target was not found" } }, 404);
}

function classificationOverrideNotFound(c: Context) {
  return c.json({ error: { code: "not_found", message: "Classification override was not found" } }, 404);
}

function classificationOverrideConflict(c: Context, error: unknown) {
  if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) {
    return c.json({ error: { code: "conflict", message: "A classification override already exists for this target" } }, 409);
  }
  throw error;
}

function normalizeHumanClassificationOverrideTarget(
  target: ReturnType<typeof createHumanClassificationOverrideSchema.parse>["target"],
) {
  switch (target.scope) {
    case "message": return { scope: target.scope, value: target.messageId };
    case "sender_address": return { scope: target.scope, value: target.address };
    case "sender_domain": return { scope: target.scope, value: target.domain };
  }
}

function toHumanClassificationOverride(rule: HumanClassificationOverrideRecord) {
  const target = rule.targetType === "message"
    ? { scope: "message" as const, messageId: rule.targetValue }
    : rule.targetType === "sender_address"
      ? { scope: "sender_address" as const, address: rule.targetValue }
      : { scope: "sender_domain" as const, domain: rule.targetValue };
  return humanClassificationOverrideSchema.parse({
    id: rule.id,
    accountId: rule.accountId,
    target,
    classification: rule.classification,
    source: rule.source,
    createdAt: rule.createdAt.toISOString(),
    updatedAt: rule.updatedAt.toISOString(),
  });
}

function getHumanClassificationOverride(db: Database, accountId: string, id: string) {
  return db.select().from(humanClassificationOverrides).where(and(
    eq(humanClassificationOverrides.accountId, accountId),
    eq(humanClassificationOverrides.id, id),
  )).get();
}

function listHumanClassificationOverrides(db: Database, accountId: string) {
  return db.select().from(humanClassificationOverrides)
    .where(eq(humanClassificationOverrides.accountId, accountId))
    .orderBy(asc(humanClassificationOverrides.targetType), asc(humanClassificationOverrides.targetValue)).all();
}

function getEmailByAccountId(db: Database, accountId: string, id: string): ClassificationEmailRecord | undefined {
  return db.select({
    id: emails.id,
    accountId: emails.accountId,
    fromAddress: emails.fromAddress,
    humanSignal: emails.humanSignal,
    humanClassification: emails.humanClassification,
    humanClassificationReasons: emails.humanClassificationReasons,
    humanClassifierVersion: emails.humanClassifierVersion,
  }).from(emails).where(and(eq(emails.accountId, accountId), eq(emails.id, id))).get();
}

export function createHumanClassificationOverrideResolver(rules: HumanClassificationOverrideRecord[]) {
  const rulesByTarget = new Map(rules.map((rule) => [humanClassificationOverrideKey(rule.targetType, rule.targetValue), rule]));
  return (message: Pick<ClassificationEmailRecord, "id" | "fromAddress">) => {
    const normalizedAddress = message.fromAddress?.trim().toLowerCase() ?? "";
    const normalizedDomain = normalizedAddress.split("@")[1] ?? "";
    return rulesByTarget.get(humanClassificationOverrideKey("message", message.id))
      ?? (normalizedAddress ? rulesByTarget.get(humanClassificationOverrideKey("sender_address", normalizedAddress)) : undefined)
      ?? (normalizedDomain ? rulesByTarget.get(humanClassificationOverrideKey("sender_domain", normalizedDomain)) : undefined);
  };
}

function humanClassificationOverrideKey(targetType: string, targetValue: string) {
  return `${targetType}:${targetValue}`;
}

function resolveHumanClassification(
  message: ClassificationEmailRecord,
  resolveOverride: ReturnType<typeof createHumanClassificationOverrideResolver>,
): HumanClassificationResult {
  const rule = resolveOverride(message);
  const userOverride = rule ? toHumanClassificationOverride(rule) : null;
  const automatic = storedAutomaticClassification(message);

  if (rule) {
    const scopeReason: Record<"message" | "sender_address" | "sender_domain", HumanClassificationReasonCode> = {
      message: "user_message_override",
      sender_address: "user_sender_address_override",
      sender_domain: "user_sender_domain_override",
    };
    return {
      automatic,
      userOverride,
      effective: {
        classification: humanClassificationSchema.parse(rule.classification),
        score: null,
        reasonCodes: [scopeReason[rule.targetType as "message" | "sender_address" | "sender_domain"]],
        classifierVersion: null,
        source: "user_override" as const,
        userOverride,
      },
    };
  }

  const effective: HumanClassificationAssessment = automatic ?? {
    classification: "unclassified",
    score: null,
    reasonCodes: ["insufficient_evidence"],
    classifierVersion: null,
  };
  return {
    automatic,
    userOverride: null,
    effective: { ...effective, source: "automatic_heuristic" as const, userOverride: null },
  };
}

function storedAutomaticClassification(message: ClassificationEmailRecord): HumanClassificationAssessment | null {
  if (!message.humanClassification) return null;
  const parsed = humanClassificationAssessmentSchema.safeParse({
    classification: message.humanClassification,
    score: message.humanSignal,
    reasonCodes: parseHumanClassificationReasons(message.humanClassificationReasons),
    classifierVersion: message.humanClassifierVersion,
  });
  return parsed.success ? parsed.data : null;
}

function parseHumanClassificationReasons(value: string | null): HumanClassificationReasonCode[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(isHumanClassificationReasonCode) : [];
  } catch {
    return [];
  }
}

function isHumanClassificationReasonCode(value: unknown): value is HumanClassificationReasonCode {
  return typeof value === "string" && [
    "sender_no_reply_pattern", "list_id_header", "list_unsubscribe_header", "bulk_precedence_header",
    "auto_submitted_header", "provider_bulk_signal", "provider_promotions_signal", "provider_transactional_signal",
    "reply_context", "direct_recipient", "conflicting_evidence", "insufficient_evidence",
    "user_message_override", "user_sender_address_override", "user_sender_domain_override",
  ].includes(value);
}

function toSenderRule(rule: SenderRuleRecord) {
  return {
    id: rule.id,
    accountId: rule.accountId,
    scope: rule.scope,
    value: rule.value,
    behavior: rule.behavior,
    source: rule.source,
    createdAt: rule.createdAt.toISOString(),
    updatedAt: rule.updatedAt.toISOString(),
  };
}

function getSenderRule(db: Database, accountId: string, id: string) {
  return db.select().from(senderAttentionRules).where(and(
    eq(senderAttentionRules.accountId, accountId),
    eq(senderAttentionRules.id, id),
  )).get();
}

function listSenderRules(db: Database, accountId: string) {
  return db.select().from(senderAttentionRules)
    .where(eq(senderAttentionRules.accountId, accountId))
    .orderBy(asc(senderAttentionRules.scope), asc(senderAttentionRules.value)).all();
}

function resolveSenderAttention(db: Database, accountId: string, address: string): ResolvedSenderAttention {
  const domain = address.split("@")[1]!;
  const rule = db.select().from(senderAttentionRules).where(and(
    eq(senderAttentionRules.accountId, accountId),
    eq(senderAttentionRules.scope, "address"),
    eq(senderAttentionRules.value, address),
  )).get() ?? db.select().from(senderAttentionRules).where(and(
    eq(senderAttentionRules.accountId, accountId),
    eq(senderAttentionRules.scope, "domain"),
    eq(senderAttentionRules.value, domain),
  )).get();
  return resolvedSenderAttentionSchema.parse({
    behavior: rule?.behavior ?? "normal",
    rule: rule ? toSenderRule(rule) : null,
  });
}

function readThreadDetail(
  db: Database,
  account: ConnectedAccount,
  serializedAccount: MailAccount,
  threadId: string,
): ThreadDetail {
  const thread = db.select().from(threads)
    .where(and(eq(threads.id, threadId), eq(threads.accountId, account.id))).get();
  if (!thread) throw new McpReadError("not_found", "Thread not found");

  const messageRows = db.select({
    id: emails.id, accountId: emails.accountId, providerMessageId: emails.providerMessageId, fromAddress: emails.fromAddress, fromName: emails.fromName,
    toRecipients: emails.toRecipients, ccRecipients: emails.ccRecipients, bccRecipients: emails.bccRecipients,
    subject: emails.subject, snippet: emails.snippet, bodyText: emails.bodyText, bodyHtml: emails.bodyHtml,
    internetMessageId: emails.internetMessageId, references: emails.references,
    receivedAt: emails.receivedAt, isRead: emails.isRead, isStarred: emails.isStarred, isDraft: emails.isDraft,
    humanSignal: emails.humanSignal, humanClassification: emails.humanClassification,
    humanClassificationReasons: emails.humanClassificationReasons, humanClassifierVersion: emails.humanClassifierVersion,
    labelName: labels.name,
  }).from(emails).leftJoin(emailLabels, eq(emailLabels.emailId, emails.id)).leftJoin(labels, eq(labels.id, emailLabels.labelId))
    .where(and(eq(emails.threadId, thread.id), eq(emails.accountId, account.id)))
    .orderBy(asc(emails.receivedAt), asc(emails.createdAt), asc(emails.id)).all();
  const attachmentRows = db.select().from(emailAttachments).innerJoin(emails, eq(emails.id, emailAttachments.emailId))
    .where(and(eq(emails.threadId, thread.id), eq(emails.accountId, account.id))).all();
  const messagesById = new Map<string, typeof messageRows[number]>();
  const labelsByMessage = new Map<string, string[]>();
  for (const row of messageRows) {
    messagesById.set(row.id, row);
    const names = labelsByMessage.get(row.id) ?? [];
    if (row.labelName) names.push(row.labelName);
    labelsByMessage.set(row.id, names);
  }
  const attachmentsByMessage = new Map<string, Array<{ id: string; filename: string; mimeType: string; size: number }>>();
  for (const { email_attachments: attachment } of attachmentRows) {
    const attachments = attachmentsByMessage.get(attachment.emailId) ?? [];
    attachments.push({ id: attachment.id, filename: attachment.filename, mimeType: attachment.mimeType, size: attachment.size });
    attachmentsByMessage.set(attachment.emailId, attachments);
  }
  const resolveClassification = createHumanClassificationOverrideResolver(listHumanClassificationOverrides(db, account.id));
  const messages = [...messagesById.values()].map((message) => {
    const bodyHtml = sanitizeProviderHtml(message.bodyHtml);
    const humanClassification = resolveHumanClassification(message, resolveClassification);
    return {
      id: message.id, accountId: account.id, provider: account.provider, providerMessageId: message.providerMessageId,
      from: { name: message.fromName, email: message.fromAddress ?? "unknown@invalid" },
      to: parseContacts(message.toRecipients), cc: parseContacts(message.ccRecipients), bcc: parseContacts(message.bccRecipients),
      subject: message.subject ?? "", snippet: message.snippet ?? "", receivedAt: (message.receivedAt ?? new Date(0)).toISOString(),
      unread: !message.isRead, labels: labelsByMessage.get(message.id) ?? [], bodyText: message.bodyText ?? htmlToText(bodyHtml), bodyHtml,
      internetMessageId: message.internetMessageId, references: parseDraftJson(message.references, []),
      humanSignal: humanClassification.effective.score,
      humanClassification,
      attachments: attachmentsByMessage.get(message.id) ?? [],
    };
  });
  const sourceMessages = [...messagesById.values()];
  return threadDetailSchema.parse({
    account: serializedAccount,
    thread: {
      id: thread.id, provider: account.provider, providerThreadId: thread.providerThreadId, subject: thread.subject ?? "",
      latestReceivedAt: (thread.latestReceivedAt ?? new Date(0)).toISOString(), messageCount: thread.messageCount,
      labels: [...new Set(messages.flatMap((message) => message.labels))],
      participants: dedupeContacts(messages.flatMap((message) => [message.from, ...message.to, ...message.cc, ...message.bcc])),
      readState: thread.isRead ? "read" : "unread",
      attention: {
        hasUnread: messages.some((message) => message.unread), hasStarred: sourceMessages.some((message) => message.isStarred),
        hasDraft: sourceMessages.some((message) => message.isDraft),
        humanSignal: maxHumanSignal(sourceMessages.map((message) => message.humanSignal)),
      },
    },
    messages,
  });
}

function uniqueRuleError(c: Context, error: unknown) {
  if (error instanceof Error && error.name === "ZodError") {
    return c.json({ error: { code: "validation_error", message: "Invalid request data" } }, 400);
  }
  if (error instanceof Error && /UNIQUE constraint failed: sender_attention_rules/.test(error.message)) {
    return c.json({ error: { code: "conflict", message: "A rule already exists for this sender scope" } }, 409);
  }
  throw error;
}

function ensureViewSettings(db: Database, accountId: string) {
  const existing = db.select({ behavior: attentionViewSettings.behavior }).from(attentionViewSettings)
    .where(eq(attentionViewSettings.accountId, accountId)).all();
  const existingBehaviors = new Set(existing.map((setting) => setting.behavior));
  const missing = defaultViewSettings.filter((setting) => !existingBehaviors.has(setting.behavior));
  if (missing.length > 0) {
    db.insert(attentionViewSettings).values(missing.map((setting) => ({
      id: `attention-view:${accountId}:${setting.behavior}`,
      accountId,
      ...setting,
    }))).run();
  }
}

function listViewSettings(db: Database, accountId: string) {
  return db.select().from(attentionViewSettings)
    .where(eq(attentionViewSettings.accountId, accountId))
    .orderBy(asc(attentionViewSettings.position)).all();
}

function toViewSetting(setting: ViewSettingRecord) {
  return {
    behavior: setting.behavior,
    displayName: setting.displayName,
    icon: setting.icon,
    color: setting.color,
    position: setting.position,
  };
}

function updateViewSetting(
  db: Database,
  accountId: string,
  current: ViewSettingRecord,
  input: { displayName?: string; icon?: string; color?: string; position?: number },
) {
  const nextPosition = input.position ?? current.position;
  db.transaction((tx) => {
    if (nextPosition !== current.position) {
      tx.update(attentionViewSettings).set({ position: -1 })
        .where(eq(attentionViewSettings.id, current.id)).run();
      if (nextPosition < current.position) {
        for (let position = current.position - 1; position >= nextPosition; position -= 1) {
          tx.update(attentionViewSettings).set({ position: position + 1 })
            .where(and(eq(attentionViewSettings.accountId, accountId), eq(attentionViewSettings.position, position))).run();
        }
      } else {
        for (let position = current.position + 1; position <= nextPosition; position += 1) {
          tx.update(attentionViewSettings).set({ position: position - 1 })
            .where(and(eq(attentionViewSettings.accountId, accountId), eq(attentionViewSettings.position, position))).run();
        }
      }
    }
    tx.update(attentionViewSettings).set({
      displayName: input.displayName ?? current.displayName,
      icon: input.icon ?? current.icon,
      color: input.color ?? current.color,
      position: nextPosition,
      updatedAt: new Date(),
    }).where(eq(attentionViewSettings.id, current.id)).run();
  });
}

function listCollectionRecords(db: Database, accountId: string) {
  return db.select().from(collections).where(eq(collections.accountId, accountId)).orderBy(asc(collections.position)).all();
}

function getGmailLabelMigration(db: Database, account: ConnectedAccount) {
  const userLabels = db.select().from(labels)
    .where(and(eq(labels.accountId, account.id), eq(labels.type, "user")))
    .orderBy(asc(labels.name), asc(labels.id)).all();
  const importedLabelIds = new Set(db.select({ labelId: gmailLabelCollectionImports.labelId }).from(gmailLabelCollectionImports)
    .innerJoin(labels, eq(labels.id, gmailLabelCollectionImports.labelId))
    .where(eq(labels.accountId, account.id)).all().map((item) => item.labelId));
  const membershipRows = db.select({ labelId: emailLabels.labelId, threadId: emails.threadId }).from(emailLabels)
    .innerJoin(emails, eq(emails.id, emailLabels.emailId))
    .where(eq(emails.accountId, account.id)).all();
  const threadIdsByLabel = new Map<string, Set<string>>();
  for (const membership of membershipRows) {
    const threadIds = threadIdsByLabel.get(membership.labelId) ?? new Set<string>();
    threadIds.add(membership.threadId);
    threadIdsByLabel.set(membership.labelId, threadIds);
  }
  const migration = db.select().from(gmailLabelMigrations).where(eq(gmailLabelMigrations.accountId, account.id)).get();
  return {
    status: migration?.status ?? "pending",
    ready: account.lastSyncedAt !== null,
    labels: userLabels.map((label) => ({
      id: label.id,
      name: label.name,
      threadCount: threadIdsByLabel.get(label.id)?.size ?? 0,
      imported: importedLabelIds.has(label.id),
    })),
    completedAt: migration?.completedAt?.toISOString() ?? null,
  };
}

function uniqueImportedCollectionName(labelName: string, existingNames: Set<string>) {
  const base = labelName.trim().slice(0, 80) || "Imported label";
  if (!existingNames.has(base)) return base;
  const suffix = " (Gmail)";
  const gmailName = `${base.slice(0, 80 - suffix.length)}${suffix}`;
  if (!existingNames.has(gmailName)) return gmailName;
  let sequence = 2;
  while (sequence < 10_000) {
    const numberedSuffix = ` (Gmail ${sequence})`;
    const candidate = `${base.slice(0, 80 - numberedSuffix.length)}${numberedSuffix}`;
    if (!existingNames.has(candidate)) return candidate;
    sequence += 1;
  }
  throw new Error("Could not create a unique Collection name for the Gmail label");
}

function collectionImportIdempotencyKey(accountId: string, sourceId: string, threadId?: string) {
  const digest = createHash("sha256").update(JSON.stringify([accountId, sourceId, threadId ?? null])).digest("hex");
  return `collection-import:${digest}`;
}

function listCollections(db: Database, accountId: string) {
  const memberships = db.select({ collectionId: collectionThreads.collectionId, threadId: collectionThreads.threadId })
    .from(collectionThreads).innerJoin(collections, eq(collections.id, collectionThreads.collectionId))
    .where(eq(collections.accountId, accountId)).orderBy(asc(collectionThreads.createdAt), asc(collectionThreads.id)).all();
  const threadIdsByCollection = new Map<string, string[]>();
  for (const membership of memberships) {
    const threadIds = threadIdsByCollection.get(membership.collectionId) ?? [];
    threadIds.push(membership.threadId);
    threadIdsByCollection.set(membership.collectionId, threadIds);
  }
  return listCollectionRecords(db, accountId).map((collection) => ({
    id: collection.id,
    accountId: collection.accountId,
    name: collection.name,
    color: collection.color,
    position: collection.position,
    threadIds: threadIdsByCollection.get(collection.id) ?? [],
    createdAt: collection.createdAt.toISOString(),
    updatedAt: collection.updatedAt.toISOString(),
  }));
}

function getCollection(db: Database, accountId: string, id: string) {
  return db.select().from(collections).where(and(eq(collections.accountId, accountId), eq(collections.id, id))).get();
}

function updateCollectionRecord(db: Database, accountId: string, current: CollectionRecord, input: { name?: string; color?: string; position?: number }) {
  const records = listCollectionRecords(db, accountId);
  const nextPosition = Math.min(input.position ?? current.position, Math.max(records.length - 1, 0));
  db.transaction((tx) => {
    if (nextPosition !== current.position) {
      tx.update(collections).set({ position: -1 }).where(eq(collections.id, current.id)).run();
      const moving = records.filter((item) => item.id !== current.id && (
        nextPosition < current.position
          ? item.position >= nextPosition && item.position < current.position
          : item.position > current.position && item.position <= nextPosition
      ));
      for (const item of moving.sort((a, b) => nextPosition < current.position ? b.position - a.position : a.position - b.position)) {
        tx.update(collections).set({ position: item.position + (nextPosition < current.position ? 1 : -1) }).where(eq(collections.id, item.id)).run();
      }
    }
    tx.update(collections).set({ name: input.name?.trim() ?? current.name, color: input.color ?? current.color, position: nextPosition, updatedAt: new Date() }).where(eq(collections.id, current.id)).run();
  });
}

function listPins(db: Database, accountId: string) {
  return db.select().from(pins).where(eq(pins.accountId, accountId)).orderBy(asc(pins.position)).all();
}

function getPin(db: Database, accountId: string, id: string) {
  return db.select().from(pins).where(and(eq(pins.accountId, accountId), eq(pins.id, id))).get();
}

function toPin(db: Database, pin: PinRecord) {
  let targetId = pin.targetId;
  if ((pin.targetType === "query" || pin.savedQueryId) && pin.savedQueryId) {
    const savedQuery = db.select().from(organizationSavedQueries).where(and(
      eq(organizationSavedQueries.accountId, pin.accountId),
      eq(organizationSavedQueries.id, pin.savedQueryId),
    )).get();
    if (savedQuery) {
      const definition = normalizeOrganizationSavedQueryDefinition(JSON.parse(savedQuery.definitionJson));
      targetId = JSON.stringify(legacyPinFilterFromOrganizationSavedQueryDefinition(definition));
    }
  }
  return pinSchema.parse({
    id: pin.id, accountId: pin.accountId, kind: pin.kind, targetId, label: pin.label,
    icon: pin.icon, color: pin.color,
    position: pin.position, createdAt: pin.createdAt.toISOString(), updatedAt: pin.updatedAt.toISOString(),
  });
}

function updatePinRecord(db: Database, accountId: string, current: PinRecord, input: { label?: string; icon?: string; color?: string; position?: number }) {
  let updated = false;
  db.transaction((tx) => {
    // Re-read both the target row and the ordered list after the transaction
    // starts. The request may have waited behind another reorder, so using the
    // route-level snapshot here can shift rows into occupied unique positions.
    const freshCurrent = tx.select().from(pins).where(and(eq(pins.accountId, accountId), eq(pins.id, current.id))).get();
    if (!freshCurrent) return;
    const records = tx.select().from(pins).where(eq(pins.accountId, accountId)).orderBy(asc(pins.position)).all();
    const nextPosition = Math.min(input.position ?? freshCurrent.position, Math.max(records.length - 1, 0));
    if (nextPosition !== freshCurrent.position) {
      tx.update(pins).set({ position: -1 }).where(and(eq(pins.accountId, accountId), eq(pins.id, freshCurrent.id))).run();
      const moving = records.filter((item) => item.id !== freshCurrent.id && (
        nextPosition < freshCurrent.position
          ? item.position >= nextPosition && item.position < freshCurrent.position
          : item.position > freshCurrent.position && item.position <= nextPosition
      ));
      for (const item of moving.sort((a, b) => nextPosition < freshCurrent.position ? b.position - a.position : a.position - b.position)) {
        tx.update(pins).set({ position: item.position + (nextPosition < freshCurrent.position ? 1 : -1) }).where(and(eq(pins.accountId, accountId), eq(pins.id, item.id))).run();
      }
    }
    tx.update(pins).set({
      label: input.label?.trim() ?? freshCurrent.label,
      icon: input.icon ?? freshCurrent.icon,
      color: input.color ?? freshCurrent.color,
      position: nextPosition,
      updatedAt: new Date(),
    }).where(and(eq(pins.accountId, accountId), eq(pins.id, freshCurrent.id))).run();
    updated = true;
  });
  return updated;
}

function defaultPinIcon(kind: "sender" | "thread" | "view" | "filter") {
  if (kind === "sender") return "person" as const;
  if (kind === "thread") return "thread" as const;
  if (kind === "filter") return "search" as const;
  return "grid" as const;
}

function validatePinTarget(db: Database, accountId: string, kind: "sender" | "thread" | "view" | "filter", targetId: string) {
  const target = targetId.trim();
  if (kind === "thread" && !db.select({ id: threads.id }).from(threads).where(and(eq(threads.accountId, accountId), eq(threads.id, target))).get()) {
    throw new OrganizationTargetError("Thread pins must refer to a thread in this account");
  }
  if (kind === "sender" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(target)) {
    throw new OrganizationTargetError("Sender pins must contain an email address");
  }
  if (kind === "view" && !["inbox", "focus", "quiet", "hidden", "all"].includes(target)) {
    throw new OrganizationTargetError("View pins must refer to an Orca attention view");
  }
  if (kind === "filter") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(target);
    } catch {
      throw new OrganizationTargetError("Filter pins must contain a valid filter definition");
    }
    if (!pinFilterSchema.safeParse(parsed).success) {
      throw new OrganizationTargetError("Filter pins must contain a supported filter definition");
    }
  }
}

function organizationConflict(c: Context, error: unknown, message: string) {
  if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) {
    return c.json({ error: { code: "conflict", message } }, 409);
  }
  throw error;
}

function providerDisplayName(provider: MailProvider) {
  return provider === "gmail" ? "Gmail" : "Outlook";
}

function getConnectedAccountByProvider(
  db: ReturnType<typeof createDatabaseClient>["db"],
  userId: string,
  provider: ConnectedAccount["provider"],
): ConnectedAccount | undefined {
  return getConnectedAccounts(db, userId).find((account) => account.provider === provider);
}

function getPreferredConnectedAccount(
  db: ReturnType<typeof createDatabaseClient>["db"],
  userId: string,
): ConnectedAccount | undefined {
  return getConnectedAccountByProvider(db, userId, "gmail") ?? getUnifiedInboxAccounts(db, userId)[0];
}

function getConnectedAccountById(db: ReturnType<typeof createDatabaseClient>["db"], userId: string, accountId: string) {
  return getUnifiedInboxAccounts(db, userId).find((account) => account.id === accountId);
}

function getAccountById(db: ReturnType<typeof createDatabaseClient>["db"], accountId: string): ConnectedAccount | undefined {
  const record = db.select({
    id: oauthAccounts.id,
    provider: oauthAccounts.provider,
    providerEmail: oauthAccounts.providerEmail,
    displayName: users.displayName,
    profileImageUrl: oauthAccounts.profileImageUrl,
    accessTokenEncrypted: oauthAccounts.accessTokenEncrypted,
    refreshTokenEncrypted: oauthAccounts.refreshTokenEncrypted,
    syncCursor: oauthAccounts.syncCursor,
    syncHistoryId: oauthAccounts.syncHistoryId,
    lastSyncedAt: oauthAccounts.lastSyncedAt,
    updatedAt: oauthAccounts.updatedAt,
    scope: oauthAccounts.scope,
  })
    .from(oauthAccounts)
    .innerJoin(users, eq(users.id, oauthAccounts.userId))
    .where(eq(oauthAccounts.id, accountId))
    .get();
  return record ? { ...record, provider: record.provider as MailProvider } : undefined;
}

function getConnectedGmailAccount(
  db: ReturnType<typeof createDatabaseClient>["db"],
  userId: string,
  accountId?: string,
) {
  const account = accountId
    ? getConnectedAccountById(db, userId, accountId)
    : getConnectedAccounts(db, userId).find((candidate) => candidate.provider === "gmail");
  return account?.provider === "gmail" ? account : undefined;
}

function getGmailRecoveryAccount(
  db: ReturnType<typeof createDatabaseClient>["db"],
  userId: string,
  accountId?: string,
) {
  if (!accountId) return getConnectedAccounts(db, userId)[0];

  const requested = getConnectedGmailAccount(db, userId, accountId);
  if (requested) return requested;

  // A settings page can outlive a reconnect and retain the previous opaque
  // account ID. If this user has exactly one Gmail connection, it is safe to
  // recover against that connection; never guess when multiple Gmail accounts
  // are connected.
  const gmailAccounts = getConnectedAccounts(db, userId);
  return gmailAccounts.length === 1 ? gmailAccounts[0] : undefined;
}

function getConnectedAccounts(db: ReturnType<typeof createDatabaseClient>["db"], userId: string): ConnectedAccount[] {
  return selectConnectedAccounts(db, userId, "gmail");
}

function getUnifiedInboxAccounts(db: ReturnType<typeof createDatabaseClient>["db"], userId: string): ConnectedAccount[] {
  return selectConnectedAccounts(db, userId);
}

function selectConnectedAccounts(
  db: ReturnType<typeof createDatabaseClient>["db"],
  userId: string,
  provider?: ConnectedAccount["provider"],
): ConnectedAccount[] {
  const ownership = provider
    ? and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, provider))
    : eq(oauthAccounts.userId, userId);
  return db.select({
    id: oauthAccounts.id,
    provider: oauthAccounts.provider,
    providerEmail: oauthAccounts.providerEmail,
    displayName: users.displayName,
    profileImageUrl: oauthAccounts.profileImageUrl,
    accessTokenEncrypted: oauthAccounts.accessTokenEncrypted,
    refreshTokenEncrypted: oauthAccounts.refreshTokenEncrypted,
    syncHistoryId: oauthAccounts.syncHistoryId,
    lastSyncedAt: oauthAccounts.lastSyncedAt,
    updatedAt: oauthAccounts.updatedAt,
    scope: oauthAccounts.scope,
  })
    .from(oauthAccounts)
    .innerJoin(users, eq(users.id, oauthAccounts.userId))
    .where(ownership)
    .orderBy(asc(oauthAccounts.createdAt), asc(oauthAccounts.id))
    .all() as ConnectedAccount[];
}
const providerHtmlPolicy: sanitizeHtml.IOptions = {
  allowedTags: [
    "a", "abbr", "address", "article", "aside", "b", "blockquote", "br", "caption",
    "cite", "code", "col", "colgroup", "dd", "del", "details", "div", "dl", "dt",
    "em", "fieldset", "figcaption", "figure", "footer", "h1", "h2", "h3", "h4",
    "h5", "h6", "header", "hr", "i", "img", "ins", "legend", "li", "main", "mark",
    "nav", "ol", "p", "pre", "s", "section", "small", "span", "strong", "sub",
    "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "time", "tr",
    "u", "ul",
  ],
  allowedAttributes: {
    a: ["href", "title", "target", "rel", "name"],
    img: ["src", "alt", "width", "height", "title"],
    td: ["colspan", "rowspan", "align", "valign", "width", "height", "style"],
    th: ["colspan", "rowspan", "align", "valign", "width", "height", "style"],
    table: ["border", "cellpadding", "cellspacing", "width", "align", "style"],
    col: ["width", "style"],
    colgroup: ["width", "span", "style"],
    tr: ["align", "valign", "style"],
    div: ["align", "style", "data-email-preheader"],
    p: ["align", "style"],
    span: ["style"],
    "*": ["class", "style"],
  },
  allowedSchemes: ["http", "https", "mailto", "cid"],
  disallowedTagsMode: "discard",
  exclusiveFilter: (frame) => {
    if (frame.tag !== "div") return false;
    if (frame.attribs["data-email-preheader"] === "true") return true;
    const style = frame.attribs.style ?? "";
    const hasHiddenStyle = /(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0)/i.test(style);
    const hasZeroSize = /(?:height|max-height|width|max-width)\s*:\s*0(?:px)?/i.test(style);
    return hasHiddenStyle && hasZeroSize;
  },
  allowedStyles: {
    "*": {
      "margin": [/.*/],
      "margin-top": [/.*/],
      "margin-right": [/.*/],
      "margin-bottom": [/.*/],
      "margin-left": [/.*/],
      "padding": [/.*/],
      "padding-top": [/.*/],
      "padding-right": [/.*/],
      "padding-bottom": [/.*/],
      "padding-left": [/.*/],
      "width": [/.*/],
      "height": [/.*/],
      "max-width": [/.*/],
      "max-height": [/.*/],
      "min-width": [/.*/],
      "min-height": [/.*/],
      "text-align": [/.*/],
      "visibility": [/.*/],
      "opacity": [/.*/],
      "overflow": [/.*/],
      "overflow-x": [/.*/],
      "overflow-y": [/.*/],
      "vertical-align": [/.*/],
      "font-family": [/.*/],
      "font-size": [/.*/],
      "font-weight": [/.*/],
      "font-style": [/.*/],
      "line-height": [/.*/],
      "letter-spacing": [/.*/],
      "text-decoration": [/.*/],
      "text-transform": [/.*/],
      "border": [/.*/],
      "border-top": [/.*/],
      "border-right": [/.*/],
      "border-bottom": [/.*/],
      "border-left": [/.*/],
      "border-radius": [/.*/],
      "border-collapse": [/.*/],
      "border-spacing": [/.*/],
      "display": [/.*/],
      "float": [/.*/],
      "white-space": [/.*/],
      "word-break": [/.*/],
      "overflow-wrap": [/.*/],
      "table-layout": [/.*/],
    },
  },
  transformTags: {
    a: (_tagName, attributes) => ({
      tagName: "a",
      attribs: { ...attributes, target: "_blank", rel: "noopener noreferrer" },
    }),
  },
};

function sanitizeProviderHtml(value: string | null) {
  return value === null ? null : sanitizeHtml(value, providerHtmlPolicy) || null;
}

function sanitizeOutboundHtml(value: string | null) {
  return sanitizeProviderHtml(value);
}

function htmlToText(value: string | null) {
  if (value === null) return null;
  const visibleHtml = sanitizeProviderHtml(value);
  if (visibleHtml === null) return null;
  const text = sanitizeHtml(visibleHtml, { allowedTags: [], allowedAttributes: {} }).replace(/\s+/g, " ").trim();
  return text || null;
}

function parseContacts(value: string | null) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((contact): contact is { name: string | null; email: string } =>
      typeof contact === "object" && contact !== null && (typeof contact.name === "string" || contact.name === null) && typeof contact.email === "string",
    ) : [];
  } catch {
    return [];
  }
}

function dedupeContacts(contacts: Array<{ name: string | null; email: string }>) {
  const unique = new Map<string, { name: string | null; email: string }>();
  for (const contact of contacts) {
    if (!contact.email || contact.email === "unknown@invalid") continue;
    const prior = unique.get(contact.email.toLowerCase());
    if (!prior || (!prior.name && contact.name)) unique.set(contact.email.toLowerCase(), contact);
  }
  return [...unique.values()];
}

function maxHumanSignal(signals: Array<number | null>) {
  const values = signals.filter((value): value is number => value !== null);
  return values.length ? Math.max(...values) : null;
}

export const app = createApp();

type ValidationErrorResponse = {
  error: {
    code: "validation_error";
    message: string;
    issues: Array<{
      path: string;
      message: string;
    }>;
  };
};

type JsonSchema<T> = {
  parse(value: unknown): T;
};

function jsonWithSchema<T>(
  c: Context,
  schema: JsonSchema<T>,
  value: unknown,
) {
  return c.json(schema.parse(value));
}

function agentEventMutationErrorKind(error: unknown): "not_found" | "conflict" | "unknown" {
  if (error instanceof AgentEventNotFoundError) return "not_found";
  if (error instanceof AgentEventRevisionConflictError) return "conflict";
  if (!error || typeof error !== "object") return "unknown";
  const candidate = error as { code?: unknown; name?: unknown };
  const marker = `${typeof candidate.code === "string" ? candidate.code : ""} ${typeof candidate.name === "string" ? candidate.name : ""}`.toLowerCase();
  if (marker.includes("not_found") || marker.includes("notfound")) return "not_found";
  if (marker.includes("conflict") || marker.includes("revision")) return "conflict";
  return "unknown";
}

function publicAgentEventError(error: unknown) {
  const kind = agentEventMutationErrorKind(error);
  if (kind === "conflict") return "This signal changed in another Orca view. Refresh and try again.";
  if (kind === "not_found") return "This signal is no longer available.";
  return "Orca could not update the local signal projection. Provider mail was not changed.";
}

function toPublicSyncError(error: unknown) {
  if (error instanceof ProviderNotImplementedError) {
    return {
      code: "provider_not_implemented",
      message: `${providerDisplayName(error.provider)} ${error.operation} is not implemented`,
      status: 501,
    } as const;
  }
  if (error instanceof GmailSyncError) {
    switch (error.code) {
      case "provider_auth_error":
        return {
          code: "provider_auth_error",
          message: "Gmail needs to be reconnected before sync can continue",
          status: 401,
        } as const;
      case "sync_conflict":
        return {
          code: "sync_conflict",
          message: "Gmail sync cannot start until the connected account is fully configured",
          status: 409,
        } as const;
      case "provider_error":
      default:
        return {
          code: "provider_error",
          message: "Gmail sync is temporarily unavailable",
          status: 502,
        } as const;
    }
  }

  return {
    code: "internal_error",
    message: "Gmail sync failed unexpectedly",
    status: 500,
  } as const;
}

function toPublicPushError(error: unknown) {
  if (error instanceof GmailSyncError) {
    return toPublicPushError(new GmailPushError(error.message, error.code));
  }
  if (error instanceof GmailPushError) {
    switch (error.code) {
      case "push_not_configured":
        return {
          code: "push_not_configured",
          message: "Gmail push notifications are not configured",
          status: 503,
        } as const;
      case "provider_auth_error":
        return {
          code: "provider_auth_error",
          message: "Gmail needs to be reconnected before push sync can continue",
          status: 401,
        } as const;
      case "sync_conflict":
        return {
          code: "sync_conflict",
          message: "Gmail push sync cannot start until the connected account is fully configured",
          status: 409,
        } as const;
      case "provider_error":
      default:
        return {
          code: "provider_error",
          message: "Gmail push sync is temporarily unavailable",
          status: 502,
        } as const;
    }
  }

  return {
    code: "internal_error",
    message: "Gmail push sync failed unexpectedly",
    status: 500,
  } as const;
}

const { port } = serverConfig;

if (import.meta.main) {
  const server = serve({
    fetch: app.fetch,
    port,
  });

  console.log(`Orca API listening on http://localhost:${port}`);

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      console.log(`${signal} received, shutting down gracefully`);
      server.close(() => process.exit(0));
    });
  }
  startGmailSyncScheduler();
}
