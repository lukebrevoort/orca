import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const createdAtDefault = sql`(unixepoch() * 1000)`;

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    displayName: text("display_name"),
    authenticatedAt: integer("authenticated_at", { mode: "timestamp_ms" }),
    onboardingCompletedAt: integer("onboarding_completed_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(createdAtDefault),
  },
  (table) => ({
    emailUniqueIdx: uniqueIndex("users_email_unique_idx").on(table.email),
  }),
);

export const userPreferences = sqliteTable(
  "user_preferences",
  {
    userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
    signature: text("signature").notNull().default(""),
    composeFormat: text("compose_format").notNull().default("plain"),
    replyBehavior: text("reply_behavior").notNull().default("reply"),
    notifyByDefault: integer("notify_by_default", { mode: "boolean" }).notNull().default(false),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
  },
);

export const oauthAccounts = sqliteTable(
  "oauth_accounts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerEmail: text("provider_email").notNull(),
    providerId: text("provider_id").notNull(),
    profileImageUrl: text("profile_image_url"),
    accessTokenEncrypted: text("access_token_encrypted"),
    refreshTokenEncrypted: text("refresh_token_encrypted"),
    tokenExpiry: integer("token_expiry", { mode: "timestamp_ms" }),
    scope: text("scope"),
    syncCursor: text("sync_cursor"),
    syncHistoryId: text("sync_history_id"),
    watchExpirationAt: integer("watch_expiration_at", { mode: "timestamp_ms" }),
    watchTopic: text("watch_topic"),
    lastSyncedAt: integer("last_synced_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(createdAtDefault),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(createdAtDefault),
  },
  (table) => ({
    userIdx: index("oauth_accounts_user_idx").on(table.userId),
    providerIdentityUniqueIdx: uniqueIndex(
      "oauth_accounts_provider_identity_unique_idx",
    ).on(table.userId, table.provider, table.providerId),
    userIdIdUniqueIdx: uniqueIndex("oauth_accounts_user_id_id_unique_idx").on(table.userId, table.id),
  }),
);

/**
 * Calendar authorization is deliberately separate from mail authorization.
 * A Gmail token can never satisfy this connection, even when both providers
 * happen to be Google accounts.
 */
export const calendarConnections = sqliteTable(
  "calendar_connections",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    accountLabel: text("account_label").notNull(),
    accessTokenEncrypted: text("access_token_encrypted"),
    refreshTokenEncrypted: text("refresh_token_encrypted"),
    tokenExpiry: integer("token_expiry", { mode: "timestamp_ms" }),
    scope: text("scope").notNull(),
    state: text("state").notNull().default("connected"),
    error: text("error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
  },
  (table) => ({
    userIdx: index("calendar_connections_user_idx").on(table.userId),
    providerIdentityUniqueIdx: uniqueIndex("calendar_connections_provider_identity_unique_idx").on(table.userId, table.provider, table.providerAccountId),
  }),
);

export const availabilityCalendars = sqliteTable(
  "availability_calendars",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id").notNull().references(() => calendarConnections.id, { onDelete: "cascade" }),
    providerCalendarId: text("provider_calendar_id").notNull(),
    displayName: text("display_name").notNull(),
    timeZone: text("time_zone"),
    selected: integer("selected", { mode: "boolean" }).notNull().default(false),
    isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false),
    accessRole: text("access_role").notNull(),
    lastDiscoveredAt: integer("last_discovered_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
  },
  (table) => ({
    connectionProviderCalendarUniqueIdx: uniqueIndex("availability_calendars_connection_provider_unique_idx").on(table.connectionId, table.providerCalendarId),
    connectionSelectedIdx: index("availability_calendars_connection_selected_idx").on(table.connectionId, table.selected),
  }),
);

export const calendarPreferences = sqliteTable(
  "calendar_preferences",
  {
    userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
    timeZone: text("time_zone").notNull(),
    workingHours: text("working_hours"),
    staleAfterMinutes: integer("stale_after_minutes").notNull().default(15),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
  },
);

export const threads = sqliteTable(
  "threads",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => oauthAccounts.id, { onDelete: "cascade" }),
    providerThreadId: text("provider_thread_id").notNull(),
    subject: text("subject"),
    latestReceivedAt: integer("latest_received_at", { mode: "timestamp_ms" }),
    messageCount: integer("message_count").notNull().default(0),
    isRead: integer("is_read", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(createdAtDefault),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(createdAtDefault),
  },
  (table) => ({
    providerThreadUniqueIdx: uniqueIndex("threads_provider_thread_unique_idx").on(
      table.accountId,
      table.providerThreadId,
    ),
    accountLatestReceivedAtIdx: index("threads_account_latest_received_at_idx").on(
      table.accountId,
      table.latestReceivedAt,
    ),
    accountIdIdUniqueIdx: uniqueIndex("threads_account_id_id_unique_idx").on(table.accountId, table.id),
  }),
);

/** Revision root for atomic Workspace-wide Organization structure changes. */
export const organizationWorkspaceStates = sqliteTable(
  "organization_workspace_states",
  {
    workspaceId: text("workspace_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull().default(1),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
  },
  (table) => ({
    revisionCheck: check("organization_workspace_states_revision_check", sql`${table.revision} >= 1`),
  }),
);

/** BRE-313 persists only a live View definition; Thread membership is always evaluated from current Organization state. */
export const organizationViews = sqliteTable(
  "organization_views",
  {
    workspaceId: text("workspace_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    color: text("color").notNull(),
    position: integer("position").notNull(),
    definition: text("definition").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
  },
  (table) => ({
    primaryKey: primaryKey({ columns: [table.workspaceId, table.id] }),
    workspacePositionIdx: index("organization_views_workspace_position_idx").on(table.workspaceId, table.position, table.id),
    revisionCheck: check("organization_views_revision_check", sql`${table.revision} >= 1`),
    positionCheck: check("organization_views_position_check", sql`${table.position} >= 0`),
  }),
);

export const organizationLanePolicies = sqliteTable(
  "organization_lane_policies",
  {
    workspaceId: text("workspace_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    visibility: text("visibility").notNull(),
    interruption: text("interruption").notNull(),
    review: text("review").notNull(),
    retentionMode: text("retention_mode").notNull(),
    retentionDays: integer("retention_days"),
    providerDeletion: integer("provider_deletion", { mode: "boolean" }).notNull().default(false),
    revision: integer("revision").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
  },
  (table) => ({
    primaryKey: primaryKey({ columns: [table.workspaceId, table.id] }),
    revisionCheck: check("organization_lane_policies_revision_check", sql`${table.revision} >= 1`),
    providerDeletionCheck: check("organization_lane_policies_provider_delete_check", sql`${table.providerDeletion} = 0`),
  }),
);

export const organizationLanes = sqliteTable(
  "organization_lanes",
  {
    workspaceId: text("workspace_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    name: text("name").notNull(),
    position: integer("position").notNull(),
    defaultPolicyId: text("default_policy_id").notNull(),
    retiredAt: integer("retired_at", { mode: "timestamp_ms" }),
    revision: integer("revision").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
  },
  (table) => ({
    primaryKey: primaryKey({ columns: [table.workspaceId, table.id] }),
    workspacePolicyForeignKey: foreignKey({
      columns: [table.workspaceId, table.defaultPolicyId],
      foreignColumns: [organizationLanePolicies.workspaceId, organizationLanePolicies.id],
      name: "organization_lanes_workspace_policy_fk",
    }),
    workspacePositionUniqueIdx: uniqueIndex("organization_lanes_workspace_position_unique_idx").on(table.workspaceId, table.position),
    revisionCheck: check("organization_lanes_revision_check", sql`${table.revision} >= 1`),
  }),
);

export const organizationWorkspaceLaneSettings = sqliteTable(
  "organization_workspace_lane_settings",
  {
    workspaceId: text("workspace_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
    fallbackLaneId: text("fallback_lane_id").notNull(),
    revision: integer("revision").notNull().default(1),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
  },
  (table) => ({
    fallbackForeignKey: foreignKey({
      columns: [table.workspaceId, table.fallbackLaneId],
      foreignColumns: [organizationLanes.workspaceId, organizationLanes.id],
      name: "organization_workspace_lane_settings_fallback_fk",
    }),
    revisionCheck: check("organization_workspace_lane_settings_revision_check", sql`${table.revision} >= 1`),
  }),
);

export const organizationThreadLaneStates = sqliteTable(
  "organization_thread_lane_states",
  {
    workspaceId: text("workspace_id").notNull(),
    accountId: text("account_id").notNull(),
    threadId: text("thread_id").notNull(),
    primaryLaneId: text("primary_lane_id").notNull(),
    placementSource: text("placement_source").notNull().default("workspace_fallback"),
    sourceId: text("source_id").notNull(),
    actorId: text("actor_id").notNull().default("system:workspace-fallback"),
    actorType: text("actor_type").notNull().default("system"),
    reason: text("reason").notNull(),
    manualOverrideLaneId: text("manual_override_lane_id"),
    manualOverrideActorId: text("manual_override_actor_id"),
    manualOverrideActorType: text("manual_override_actor_type"),
    manualOverrideReason: text("manual_override_reason"),
    manualOverrideAt: integer("manual_override_at", { mode: "timestamp_ms" }),
    safetyLocked: integer("safety_locked", { mode: "boolean" }).notNull().default(false),
    safetyLockActorId: text("safety_lock_actor_id"),
    safetyLockActorType: text("safety_lock_actor_type"),
    safetyLockReason: text("safety_lock_reason"),
    safetyLockUpdatedAt: integer("safety_lock_updated_at", { mode: "timestamp_ms" }),
    revision: integer("revision").notNull().default(1),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
  },
  (table) => ({
    primaryKey: primaryKey({ columns: [table.workspaceId, table.accountId, table.threadId] }),
    workspaceAccountForeignKey: foreignKey({
      columns: [table.workspaceId, table.accountId],
      foreignColumns: [oauthAccounts.userId, oauthAccounts.id],
      name: "organization_thread_lane_states_workspace_account_fk",
    }).onDelete("cascade"),
    accountThreadForeignKey: foreignKey({
      columns: [table.accountId, table.threadId],
      foreignColumns: [threads.accountId, threads.id],
      name: "organization_thread_lane_states_account_thread_fk",
    }).onDelete("cascade"),
    primaryLaneForeignKey: foreignKey({
      columns: [table.workspaceId, table.primaryLaneId],
      foreignColumns: [organizationLanes.workspaceId, organizationLanes.id],
      name: "organization_thread_lane_states_primary_lane_fk",
    }),
    manualOverrideLaneForeignKey: foreignKey({
      columns: [table.workspaceId, table.manualOverrideLaneId],
      foreignColumns: [organizationLanes.workspaceId, organizationLanes.id],
      name: "organization_thread_lane_states_manual_override_lane_fk",
    }),
    laneIdx: index("organization_thread_lane_states_lane_idx").on(table.workspaceId, table.primaryLaneId, table.accountId),
    revisionCheck: check("organization_thread_lane_states_revision_check", sql`${table.revision} >= 1`),
  }),
);

export const organizationFacets = sqliteTable(
  "organization_facets",
  {
    id: text("id").notNull(),
    workspaceId: text("workspace_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").notNull(),
    valueType: text("value_type").notNull(),
    cardinality: text("cardinality").notNull(),
    isOptional: integer("is_optional", { mode: "boolean" }).notNull(),
    defaultValue: text("default_value"),
    retiredAt: integer("retired_at", { mode: "timestamp_ms" }),
    revision: integer("revision").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
  },
  (table) => ({
    primaryKey: primaryKey({ columns: [table.workspaceId, table.id] }),
    workspacePositionIdx: index("organization_facets_workspace_position_idx").on(table.workspaceId, table.position),
    workspaceNameIdx: index("organization_facets_workspace_name_idx").on(table.workspaceId, table.name),
    revisionCheck: check("organization_facets_revision_check", sql`${table.revision} >= 1`),
  }),
);

export const organizationWorkflowStates = sqliteTable(
  "organization_workflow_states",
  {
    id: text("id").notNull(),
    workspaceId: text("workspace_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").notNull(),
    retiredAt: integer("retired_at", { mode: "timestamp_ms" }),
    revision: integer("revision").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
  },
  (table) => ({
    primaryKey: primaryKey({ columns: [table.workspaceId, table.id] }),
    workspacePositionIdx: index("organization_workflow_states_workspace_position_idx").on(table.workspaceId, table.position),
    workspaceNameIdx: index("organization_workflow_states_workspace_name_idx").on(table.workspaceId, table.name),
    revisionCheck: check("organization_workflow_states_revision_check", sql`${table.revision} >= 1`),
  }),
);

export const organizationThreadFacetValues = sqliteTable(
  "organization_thread_facet_values",
  {
    workspaceId: text("workspace_id").notNull(),
    facetId: text("facet_id").notNull(),
    accountId: text("account_id").notNull(),
    threadId: text("thread_id").notNull(),
    value: text("value").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
  },
  (table) => ({
    primaryKey: primaryKey({ columns: [table.workspaceId, table.facetId, table.accountId, table.threadId] }),
    workspaceFacetForeignKey: foreignKey({
      columns: [table.workspaceId, table.facetId],
      foreignColumns: [organizationFacets.workspaceId, organizationFacets.id],
      name: "organization_thread_facet_values_workspace_facet_fk",
    }).onDelete("cascade"),
    workspaceAccountForeignKey: foreignKey({
      columns: [table.workspaceId, table.accountId],
      foreignColumns: [oauthAccounts.userId, oauthAccounts.id],
      name: "organization_thread_facet_values_workspace_account_fk",
    }).onDelete("cascade"),
    accountThreadForeignKey: foreignKey({
      columns: [table.accountId, table.threadId],
      foreignColumns: [threads.accountId, threads.id],
      name: "organization_thread_facet_values_account_thread_fk",
    }).onDelete("cascade"),
    accountThreadIdx: index("organization_thread_facet_values_account_thread_idx").on(table.workspaceId, table.accountId, table.threadId),
  }),
);

export const organizationThreadWorkflowStates = sqliteTable(
  "organization_thread_workflow_states",
  {
    workspaceId: text("workspace_id").notNull(),
    threadId: text("thread_id").notNull(),
    accountId: text("account_id").notNull(),
    stateId: text("state_id").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
  },
  (table) => ({
    primaryKey: primaryKey({ columns: [table.workspaceId, table.accountId, table.threadId] }),
    workspaceStateForeignKey: foreignKey({
      columns: [table.workspaceId, table.stateId],
      foreignColumns: [organizationWorkflowStates.workspaceId, organizationWorkflowStates.id],
      name: "organization_thread_workflow_states_workspace_state_fk",
    }).onDelete("cascade"),
    workspaceAccountForeignKey: foreignKey({
      columns: [table.workspaceId, table.accountId],
      foreignColumns: [oauthAccounts.userId, oauthAccounts.id],
      name: "organization_thread_workflow_states_workspace_account_fk",
    }).onDelete("cascade"),
    accountThreadForeignKey: foreignKey({
      columns: [table.accountId, table.threadId],
      foreignColumns: [threads.accountId, threads.id],
      name: "organization_thread_workflow_states_account_thread_fk",
    }).onDelete("cascade"),
    accountStateIdx: index("organization_thread_workflow_states_account_state_idx").on(table.workspaceId, table.accountId, table.stateId),
  }),
);

export const organizationThreadStates = sqliteTable(
  "organization_thread_states",
  {
    workspaceId: text("workspace_id").notNull(),
    accountId: text("account_id").notNull(),
    threadId: text("thread_id").notNull(),
    revision: integer("revision").notNull().default(1),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
  },
  (table) => ({
    primaryKey: primaryKey({ columns: [table.workspaceId, table.accountId, table.threadId] }),
    workspaceAccountForeignKey: foreignKey({
      columns: [table.workspaceId, table.accountId],
      foreignColumns: [oauthAccounts.userId, oauthAccounts.id],
      name: "organization_thread_states_workspace_account_fk",
    }).onDelete("cascade"),
    accountThreadForeignKey: foreignKey({
      columns: [table.accountId, table.threadId],
      foreignColumns: [threads.accountId, threads.id],
      name: "organization_thread_states_account_thread_fk",
    }).onDelete("cascade"),
    revisionCheck: check("organization_thread_states_revision_check", sql`${table.revision} >= 1`),
  }),
);

export const organizationChangeSets = sqliteTable(
  "organization_change_sets",
  {
    id: text("id").notNull(),
    workspaceId: text("workspace_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    commandDigest: text("command_digest").notNull(),
    authorityTrace: text("authority_trace").notNull(),
    resourceFamily: text("resource_family").notNull().default("facet_workflow"),
    operation: text("operation").notNull().default("apply"),
    commandJson: text("command_json").notNull().default("{}"),
    revertsChangeId: text("reverts_change_id"),
    workspaceRevisionBefore: integer("workspace_revision_before").notNull().default(1),
    workspaceRevisionAfter: integer("workspace_revision_after").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
  },
  (table) => ({
    primaryKey: primaryKey({ columns: [table.workspaceId, table.id] }),
    workspaceIdempotencyUniqueIdx: uniqueIndex("organization_change_sets_workspace_idempotency_unique_idx").on(table.workspaceId, table.idempotencyKey),
  }),
);

/** Ordered inverse evidence for resource-specific changes in the shared Organization audit. */
export const organizationChangeActions = sqliteTable(
  "organization_change_actions",
  {
    workspaceId: text("workspace_id").notNull(),
    changeId: text("change_id").notNull(),
    position: integer("position").notNull(),
    actionKind: text("action_kind").notNull(),
    resourceFamily: text("resource_family").notNull(),
    resourceId: text("resource_id").notNull(),
    beforeJson: text("before_json"),
    afterJson: text("after_json"),
  },
  (table) => ({
    primaryKey: primaryKey({ columns: [table.workspaceId, table.changeId, table.position] }),
    changeForeignKey: foreignKey({
      columns: [table.workspaceId, table.changeId],
      foreignColumns: [organizationChangeSets.workspaceId, organizationChangeSets.id],
      name: "organization_change_actions_change_fk",
    }).onDelete("cascade"),
    resourceIdx: index("organization_change_actions_resource_idx").on(table.workspaceId, table.resourceFamily, table.resourceId),
  }),
);

export const organizationContextTypes = sqliteTable(
  "organization_context_types",
  {
    workspaceId: text("workspace_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    name: text("name").notNull(),
    position: integer("position").notNull(),
    retiredAt: integer("retired_at", { mode: "timestamp_ms" }),
    revision: integer("revision").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
  },
  (table) => ({
    primaryKey: primaryKey({ columns: [table.workspaceId, table.id] }),
    workspacePositionUniqueIdx: uniqueIndex("organization_context_types_workspace_position_unique_idx").on(table.workspaceId, table.position),
    workspaceNameUniqueIdx: uniqueIndex("organization_context_types_workspace_name_unique_idx").on(table.workspaceId, table.name),
    positionCheck: check("organization_context_types_position_check", sql`${table.position} >= 0`),
    revisionCheck: check("organization_context_types_revision_check", sql`${table.revision} >= 1`),
  }),
);

export const organizationContextRelationshipTypes = sqliteTable(
  "organization_context_relationship_types",
  {
    workspaceId: text("workspace_id").notNull(),
    id: text("id").notNull(),
    contextTypeId: text("context_type_id").notNull(),
    name: text("name").notNull(),
    inverseName: text("inverse_name").notNull(),
    direction: text("direction").notNull(),
    position: integer("position").notNull(),
    maximumPerThread: integer("maximum_per_thread").notNull(),
    retiredAt: integer("retired_at", { mode: "timestamp_ms" }),
    revision: integer("revision").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
  },
  (table) => ({
    primaryKey: primaryKey({ columns: [table.workspaceId, table.id] }),
    contextTypeForeignKey: foreignKey({
      columns: [table.workspaceId, table.contextTypeId],
      foreignColumns: [organizationContextTypes.workspaceId, organizationContextTypes.id],
      name: "organization_context_relationship_types_context_type_fk",
    }).onDelete("cascade"),
    workspaceTypeNameUniqueIdx: uniqueIndex("organization_context_relationship_types_workspace_type_name_unique_idx").on(table.workspaceId, table.contextTypeId, table.name),
    workspaceTypePositionUniqueIdx: uniqueIndex("organization_context_relationship_types_workspace_type_position_unique_idx").on(table.workspaceId, table.contextTypeId, table.position),
    workspaceIdTypeDirectionUniqueIdx: uniqueIndex("organization_context_relationship_types_workspace_id_type_direction_unique_idx").on(table.workspaceId, table.id, table.contextTypeId, table.direction),
    directionCheck: check("organization_context_relationship_types_direction_check", sql`${table.direction} IN ('thread_to_context', 'context_to_thread')`),
    positionCheck: check("organization_context_relationship_types_position_check", sql`${table.position} >= 0`),
    revisionCheck: check("organization_context_relationship_types_revision_check", sql`${table.revision} >= 1`),
    maximumCheck: check("organization_context_relationship_types_maximum_check", sql`${table.maximumPerThread} >= 1 AND ${table.maximumPerThread} <= 20`),
  }),
);

export const organizationContexts = sqliteTable(
  "organization_contexts",
  {
    workspaceId: text("workspace_id").notNull(),
    id: text("id").notNull(),
    contextTypeId: text("context_type_id").notNull(),
    name: text("name").notNull(),
    retiredAt: integer("retired_at", { mode: "timestamp_ms" }),
    revision: integer("revision").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
  },
  (table) => ({
    primaryKey: primaryKey({ columns: [table.workspaceId, table.id] }),
    contextTypeForeignKey: foreignKey({
      columns: [table.workspaceId, table.contextTypeId],
      foreignColumns: [organizationContextTypes.workspaceId, organizationContextTypes.id],
      name: "organization_contexts_context_type_fk",
    }).onDelete("cascade"),
    workspaceTypeNameUniqueIdx: uniqueIndex("organization_contexts_workspace_type_name_unique_idx").on(table.workspaceId, table.contextTypeId, table.name),
    workspaceIdTypeUniqueIdx: uniqueIndex("organization_contexts_workspace_id_type_unique_idx").on(table.workspaceId, table.id, table.contextTypeId),
    revisionCheck: check("organization_contexts_revision_check", sql`${table.revision} >= 1`),
  }),
);

export const organizationThreadContextRelationships = sqliteTable(
  "organization_thread_context_relationships",
  {
    workspaceId: text("workspace_id").notNull(),
    id: text("id").notNull(),
    accountId: text("account_id").notNull(),
    threadId: text("thread_id").notNull(),
    contextTypeId: text("context_type_id").notNull(),
    contextId: text("context_id").notNull(),
    relationshipTypeId: text("relationship_type_id").notNull(),
    direction: text("direction").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
  },
  (table) => ({
    primaryKey: primaryKey({ columns: [table.workspaceId, table.id] }),
    workspaceAccountForeignKey: foreignKey({
      columns: [table.workspaceId, table.accountId],
      foreignColumns: [oauthAccounts.userId, oauthAccounts.id],
      name: "organization_thread_context_relationships_workspace_account_fk",
    }).onDelete("cascade"),
    accountThreadForeignKey: foreignKey({
      columns: [table.accountId, table.threadId],
      foreignColumns: [threads.accountId, threads.id],
      name: "organization_thread_context_relationships_account_thread_fk",
    }).onDelete("cascade"),
    contextForeignKey: foreignKey({
      columns: [table.workspaceId, table.contextId, table.contextTypeId],
      foreignColumns: [organizationContexts.workspaceId, organizationContexts.id, organizationContexts.contextTypeId],
      name: "organization_thread_context_relationships_context_fk",
    }).onDelete("cascade"),
    relationshipTypeForeignKey: foreignKey({
      columns: [table.workspaceId, table.relationshipTypeId, table.contextTypeId, table.direction],
      foreignColumns: [organizationContextRelationshipTypes.workspaceId, organizationContextRelationshipTypes.id, organizationContextRelationshipTypes.contextTypeId, organizationContextRelationshipTypes.direction],
      name: "organization_thread_context_relationships_relationship_type_fk",
    }).onDelete("cascade"),
    stableEdgeUniqueIdx: uniqueIndex("organization_thread_context_relationships_stable_edge_unique_idx").on(table.workspaceId, table.accountId, table.threadId, table.contextId, table.relationshipTypeId),
    threadIdx: index("organization_thread_context_relationships_thread_idx").on(table.workspaceId, table.accountId, table.threadId),
    contextIdx: index("organization_thread_context_relationships_context_idx").on(table.workspaceId, table.contextId),
    directionCheck: check("organization_thread_context_relationships_direction_check", sql`${table.direction} IN ('thread_to_context', 'context_to_thread')`),
    revisionCheck: check("organization_thread_context_relationships_revision_check", sql`${table.revision} >= 1`),
  }),
);

export const labels = sqliteTable(
  "labels",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => oauthAccounts.id, { onDelete: "cascade" }),
    providerLabelId: text("provider_label_id").notNull(),
    name: text("name").notNull(),
    type: text("type").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(createdAtDefault),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(createdAtDefault),
  },
  (table) => ({
    providerLabelUniqueIdx: uniqueIndex("labels_provider_label_unique_idx").on(
      table.accountId,
      table.providerLabelId,
    ),
    accountIdx: index("labels_account_idx").on(table.accountId),
  }),
);

export const emails = sqliteTable(
  "emails",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => oauthAccounts.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    providerMessageId: text("provider_message_id").notNull(),
    fromAddress: text("from_address"),
    fromName: text("from_name"),
    toRecipients: text("to_recipients"),
    ccRecipients: text("cc_recipients"),
    bccRecipients: text("bcc_recipients"),
    subject: text("subject"),
    snippet: text("snippet"),
    bodyText: text("body_text"),
    bodyHtml: text("body_html"),
    internetMessageId: text("internet_message_id"),
    references: text("references"),
    receivedAt: integer("received_at", { mode: "timestamp_ms" }),
    internalDate: integer("internal_date", { mode: "timestamp_ms" }),
    isRead: integer("is_read", { mode: "boolean" }).notNull().default(false),
    isStarred: integer("is_starred", { mode: "boolean" }).notNull().default(false),
    isDraft: integer("is_draft", { mode: "boolean" }).notNull().default(false),
    humanSignal: integer("human_signal"),
    humanClassification: text("human_classification"),
    humanClassificationReasons: text("human_classification_reasons"),
    humanClassifierVersion: text("human_classifier_version"),
    humanClassificationEvidence: text("human_classification_evidence"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(createdAtDefault),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(createdAtDefault),
  },
  (table) => ({
    providerMessageUniqueIdx: uniqueIndex("emails_provider_message_unique_idx").on(
      table.accountId,
      table.providerMessageId,
    ),
    accountReceivedAtIdx: index("emails_account_received_at_idx").on(
      table.accountId,
      table.receivedAt,
    ),
    accountHumanClassificationIdx: index("emails_account_human_classification_idx").on(
      table.accountId,
      table.humanClassification,
    ),
    accountThreadIdUniqueIdx: uniqueIndex("emails_account_thread_id_unique_idx").on(
      table.accountId,
      table.threadId,
      table.id,
    ),
    threadIdx: index("emails_thread_idx").on(table.threadId),
  }),
);

/**
 * A concise, local projection of an important automated message. This table
 * intentionally has no body/header/attachment columns and never mutates mail.
 */
export const agentEvents = sqliteTable(
  "agent_events",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id").notNull(),
    accountId: text("account_id").notNull(),
    messageId: text("message_id").notNull(),
    providerMessageId: text("provider_message_id").notNull(),
    threadId: text("thread_id").notNull(),
    provider: text("provider").notNull(),
    senderName: text("sender_name"),
    senderAddress: text("sender_address").notNull(),
    sourceSubject: text("source_subject").notNull(),
    sourceReceivedAt: integer("source_received_at", { mode: "timestamp_ms" }).notNull(),
    sourceUrl: text("source_url").notNull(),
    trigger: text("trigger").notNull(),
    policyVersion: text("policy_version").notNull(),
    agentId: text("agent_id").notNull(),
    agentVersion: text("agent_version").notNull(),
    executionMode: text("execution_mode").notNull(),
    eventKind: text("event_kind").notNull(),
    importance: text("importance").notNull(),
    relevance: text("relevance").notNull(),
    destination: text("destination").notNull(),
    reasonCodes: text("reason_codes").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    whyThisMatters: text("why_this_matters").notNull(),
    suggestedNextStep: text("suggested_next_step"),
    humanClassification: text("human_classification"),
    humanSignal: integer("human_signal"),
    humanClassificationReasons: text("human_classification_reasons"),
    humanClassifierVersion: text("human_classifier_version"),
    humanClassificationSource: text("human_classification_source"),
    deduplicationKey: text("deduplication_key").notNull(),
    assessmentFingerprint: text("assessment_fingerprint").notNull(),
    evaluatedAt: integer("evaluated_at", { mode: "timestamp_ms" }).notNull(),
    lifecycleState: text("lifecycle_state").notNull().default("new"),
    lastTransition: text("last_transition").notNull().default("created"),
    revision: integer("revision").notNull().default(1),
    seenAt: integer("seen_at", { mode: "timestamp_ms" }),
    snoozedUntil: integer("snoozed_until", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
  },
  (table) => ({
    ownerAccountForeignKey: foreignKey({
      columns: [table.ownerUserId, table.accountId],
      foreignColumns: [oauthAccounts.userId, oauthAccounts.id],
      name: "agent_events_owner_account_fk",
    }).onDelete("cascade"),
    accountThreadForeignKey: foreignKey({
      columns: [table.accountId, table.threadId],
      foreignColumns: [threads.accountId, threads.id],
      name: "agent_events_account_thread_fk",
    }).onDelete("cascade"),
    sourceMessageForeignKey: foreignKey({
      columns: [table.accountId, table.threadId, table.messageId],
      foreignColumns: [emails.accountId, emails.threadId, emails.id],
      name: "agent_events_source_message_fk",
    }).onDelete("cascade"),
    deduplicationUniqueIdx: uniqueIndex("agent_events_owner_account_dedupe_unique_idx").on(
      table.ownerUserId,
      table.accountId,
      table.deduplicationKey,
    ),
    accountUpdatedAtIdx: index("agent_events_account_updated_at_idx").on(table.accountId, table.updatedAt),
    accountStateIdx: index("agent_events_account_state_idx").on(table.accountId, table.lifecycleState),
    revisionCheck: check("agent_events_revision_check", sql`${table.revision} >= 1`),
    destinationCheck: check("agent_events_destination_check", sql`${table.destination} <> 'none'`),
  }),
);

/** Sparse account-scoped departures from the versioned conservative defaults. */
export const agentPropagationPolicyOverrides = sqliteTable(
  "agent_propagation_policy_overrides",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull().references(() => oauthAccounts.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
  },
  (table) => ({
    accountCategoryUniqueIdx: uniqueIndex("agent_propagation_policy_overrides_account_category_unique_idx").on(
      table.accountId,
      table.category,
    ),
  }),
);

/** Active mute rows are deleted to reverse a mute; no provider state changes. */
export const agentPropagationMutes = sqliteTable(
  "agent_propagation_mutes",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull().references(() => oauthAccounts.id, { onDelete: "cascade" }),
    targetScope: text("target_scope").notNull(),
    targetValue: text("target_value").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
  },
  (table) => ({
    accountTargetUniqueIdx: uniqueIndex("agent_propagation_mutes_account_target_unique_idx").on(
      table.accountId,
      table.targetScope,
      table.targetValue,
    ),
  }),
);

export const emailLabels = sqliteTable(
  "email_labels",
  {
    id: text("id").primaryKey(),
    emailId: text("email_id")
      .notNull()
      .references(() => emails.id, { onDelete: "cascade" }),
    labelId: text("label_id")
      .notNull()
      .references(() => labels.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(createdAtDefault),
  },
  (table) => ({
    emailLabelUniqueIdx: uniqueIndex("email_labels_email_label_unique_idx").on(
      table.emailId,
      table.labelId,
    ),
    labelIdx: index("email_labels_label_idx").on(table.labelId),
  }),
);

export const emailAttachments = sqliteTable(
  "email_attachments",
  {
    id: text("id").primaryKey(),
    emailId: text("email_id")
      .notNull()
      .references(() => emails.id, { onDelete: "cascade" }),
    providerAttachmentId: text("provider_attachment_id").notNull(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    size: integer("size").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(createdAtDefault),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(createdAtDefault),
  },
  (table) => ({
    emailIdx: index("email_attachments_email_idx").on(table.emailId),
    providerAttachmentUniqueIdx: uniqueIndex("email_attachments_provider_attachment_unique_idx").on(
      table.emailId,
      table.providerAttachmentId,
    ),
  }),
);

export const contacts = sqliteTable(
  "contacts",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => oauthAccounts.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    name: text("name"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(createdAtDefault),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(createdAtDefault),
  },
  (table) => ({
    accountEmailUniqueIdx: uniqueIndex("contacts_account_email_unique_idx").on(
      table.accountId,
      table.email,
    ),
    accountIdx: index("contacts_account_idx").on(table.accountId),
  }),
);

export const senderAttentionRules = sqliteTable(
  "sender_attention_rules",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => oauthAccounts.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    value: text("value").notNull(),
    behavior: text("behavior").notNull(),
    source: text("source").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(createdAtDefault),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(createdAtDefault),
  },
  (table) => ({
    accountScopeValueUniqueIdx: uniqueIndex("sender_attention_rules_account_scope_value_unique_idx").on(
      table.accountId,
      table.scope,
      table.value,
    ),
    accountIdx: index("sender_attention_rules_account_idx").on(table.accountId),
  }),
);

export const humanClassificationOverrides = sqliteTable(
  "human_classification_overrides",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => oauthAccounts.id, { onDelete: "cascade" }),
    targetType: text("target_type").notNull(),
    targetValue: text("target_value").notNull(),
    classification: text("classification").notNull(),
    source: text("source").notNull().default("user_choice"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(createdAtDefault),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(createdAtDefault),
  },
  (table) => ({
    accountTargetUniqueIdx: uniqueIndex("human_classification_overrides_account_target_unique_idx").on(
      table.accountId,
      table.targetType,
      table.targetValue,
    ),
    accountIdx: index("human_classification_overrides_account_idx").on(table.accountId),
  }),
);

export const attentionViewSettings = sqliteTable(
  "attention_view_settings",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => oauthAccounts.id, { onDelete: "cascade" }),
    behavior: text("behavior").notNull(),
    displayName: text("display_name").notNull(),
    icon: text("icon").notNull(),
    color: text("color").notNull(),
    position: integer("position").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(createdAtDefault),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(createdAtDefault),
  },
  (table) => ({
    accountBehaviorUniqueIdx: uniqueIndex("attention_view_settings_account_behavior_unique_idx").on(
      table.accountId,
      table.behavior,
    ),
    accountPositionUniqueIdx: uniqueIndex("attention_view_settings_account_position_unique_idx").on(
      table.accountId,
      table.position,
    ),
  }),
);

export const collections = sqliteTable(
  "collections",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull().references(() => oauthAccounts.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color").notNull().default("#70867d"),
    position: integer("position").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
  },
  (table) => ({
    accountNameUniqueIdx: uniqueIndex("collections_account_name_unique_idx").on(table.accountId, table.name),
    accountPositionUniqueIdx: uniqueIndex("collections_account_position_unique_idx").on(table.accountId, table.position),
  }),
);

export const collectionThreads = sqliteTable(
  "collection_threads",
  {
    id: text("id").primaryKey(),
    collectionId: text("collection_id").notNull().references(() => collections.id, { onDelete: "cascade" }),
    threadId: text("thread_id").notNull().references(() => threads.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
  },
  (table) => ({
    membershipUniqueIdx: uniqueIndex("collection_threads_membership_unique_idx").on(table.collectionId, table.threadId),
    threadIdx: index("collection_threads_thread_idx").on(table.threadId),
  }),
);

export const gmailLabelMigrations = sqliteTable(
  "gmail_label_migrations",
  {
    accountId: text("account_id").primaryKey().references(() => oauthAccounts.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
  },
);

export const gmailLabelCollectionImports = sqliteTable(
  "gmail_label_collection_imports",
  {
    labelId: text("label_id").primaryKey().references(() => labels.id, { onDelete: "cascade" }),
    collectionId: text("collection_id").notNull().references(() => collections.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
  },
  (table) => ({
    collectionUniqueIdx: uniqueIndex("gmail_label_collection_imports_collection_unique_idx").on(table.collectionId),
  }),
);

export const pins = sqliteTable(
  "pins",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull().references(() => oauthAccounts.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    targetId: text("target_id").notNull(),
    targetType: text("target_type").notNull().default("resource"),
    resourceFamily: text("resource_family"),
    savedQueryId: text("saved_query_id"),
    label: text("label").notNull(),
    icon: text("icon").notNull().default("person"),
    color: text("color").notNull().default("#70867d"),
    position: integer("position").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
  },
  (table) => ({
    accountTargetUniqueIdx: uniqueIndex("pins_account_target_unique_idx").on(table.accountId, table.kind, table.targetId),
    accountPositionUniqueIdx: uniqueIndex("pins_account_position_unique_idx").on(table.accountId, table.position),
  }),
);

export const organizationSavedQueries = sqliteTable(
  "organization_saved_queries",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull().references(() => oauthAccounts.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    definitionJson: text("definition_json").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
  },
);

export const organizationCollectionPinAudits = sqliteTable(
  "organization_collection_pin_audits",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull().references(() => oauthAccounts.id, { onDelete: "cascade" }),
    actorId: text("actor_id").notNull(),
    actorType: text("actor_type").notNull(),
    operation: text("operation").notNull(),
    changeKind: text("change_kind").notNull(),
    resourceId: text("resource_id").notNull(),
    beforeJson: text("before_json"),
    afterJson: text("after_json"),
    commandJson: text("command_json").notNull(),
    reason: text("reason").notNull(),
    revertsChangeId: text("reverts_change_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
  },
  (table) => ({
    workspaceIdempotencyUniqueIdx: uniqueIndex("organization_collection_pin_audits_workspace_idempotency_unique_idx").on(table.workspaceId, table.idempotencyKey),
    workspaceCreatedIdx: index("organization_collection_pin_audits_workspace_created_idx").on(table.workspaceId, table.createdAt),
  }),
);

export const threadReminders = sqliteTable(
  "thread_reminders",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull().references(() => oauthAccounts.id, { onDelete: "cascade" }),
    threadId: text("thread_id").notNull().references(() => threads.id, { onDelete: "cascade" }),
    scheduledFor: integer("scheduled_for", { mode: "timestamp_ms" }).notNull(),
    timezone: text("timezone").notNull(),
    notify: integer("notify", { mode: "boolean" }).notNull().default(false),
    status: text("status").notNull().default("scheduled"),
    resurfacedAt: integer("resurfaced_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    cancelledAt: integer("cancelled_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
  },
  (table) => ({
    accountThreadIdx: index("thread_reminders_account_thread_idx").on(table.accountId, table.threadId),
    accountScheduledForIdx: index("thread_reminders_account_scheduled_for_idx").on(table.accountId, table.scheduledFor),
  }),
);

export const reminderViewSettings = sqliteTable(
  "reminder_view_settings",
  {
    accountId: text("account_id").primaryKey().references(() => oauthAccounts.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull().default("Later"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
  },
);

export const messageDrafts = sqliteTable(
  "message_drafts",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull().references(() => oauthAccounts.id, { onDelete: "cascade" }),
    toRecipients: text("to_recipients").notNull().default("[]"),
    ccRecipients: text("cc_recipients").notNull().default("[]"),
    bccRecipients: text("bcc_recipients").notNull().default("[]"),
    subject: text("subject").notNull().default(""),
    bodyText: text("body_text").notNull().default(""),
    bodyHtml: text("body_html"),
    context: text("context"),
    attachments: text("attachments").notNull().default("[]"),
    providerDraftId: text("provider_draft_id"),
    providerSyncStatus: text("provider_sync_status").notNull().default("not_applicable"),
    providerSyncError: text("provider_sync_error"),
    providerMessageId: text("provider_message_id"),
    providerThreadId: text("provider_thread_id"),
    revision: integer("revision").notNull().default(0),
    deliveryStatus: text("delivery_status").notNull().default("draft"),
    sendIdempotencyKey: text("send_idempotency_key"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
  },
  (table) => ({
    accountUpdatedAtIdx: index("message_drafts_account_updated_at_idx").on(table.accountId, table.updatedAt),
    accountIdempotencyUniqueIdx: uniqueIndex("message_drafts_account_idempotency_unique_idx").on(table.accountId, table.sendIdempotencyKey),
  }),
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(createdAtDefault),
    invalidatedAt: integer("invalidated_at", { mode: "timestamp_ms" }),
  },
  (table) => ({
    userIdx: index("sessions_user_idx").on(table.userId),
    expiresAtIdx: index("sessions_expires_at_idx").on(table.expiresAt),
  }),
);

export const mcpOAuthClients = sqliteTable(
  "mcp_oauth_clients",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    redirectUris: text("redirect_uris").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(createdAtDefault),
  },
  (table) => ({
    createdAtIdx: index("mcp_oauth_clients_created_at_idx").on(table.createdAt),
  }),
);

export const mcpAuthorizationCodes = sqliteTable(
  "mcp_authorization_codes",
  {
    id: text("id").primaryKey(),
    codeHash: text("code_hash").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clientId: text("client_id")
      .notNull()
      .references(() => mcpOAuthClients.id, { onDelete: "cascade" }),
    redirectUri: text("redirect_uri").notNull(),
    resource: text("resource").notNull(),
    scopes: text("scopes").notNull(),
    accountIds: text("account_ids").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    consumedAt: integer("consumed_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(createdAtDefault),
  },
  (table) => ({
    codeHashUniqueIdx: uniqueIndex("mcp_authorization_codes_code_hash_unique_idx").on(table.codeHash),
    expiresAtIdx: index("mcp_authorization_codes_expires_at_idx").on(table.expiresAt),
  }),
);

export const mcpConnections = sqliteTable(
  "mcp_connections",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clientId: text("client_id")
      .notNull()
      .references(() => mcpOAuthClients.id, { onDelete: "cascade" }),
    resource: text("resource").notNull(),
    scopes: text("scopes").notNull(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(createdAtDefault),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(createdAtDefault),
  },
  (table) => ({
    userIdx: index("mcp_connections_user_idx").on(table.userId),
    revokedAtIdx: index("mcp_connections_revoked_at_idx").on(table.revokedAt),
  }),
);

export const mcpConnectionAccounts = sqliteTable(
  "mcp_connection_accounts",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => mcpConnections.id, { onDelete: "cascade" }),
    accountId: text("account_id")
      .notNull()
      .references(() => oauthAccounts.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(createdAtDefault),
  },
  (table) => ({
    connectionAccountUniqueIdx: uniqueIndex("mcp_connection_accounts_connection_account_unique_idx").on(table.connectionId, table.accountId),
    accountIdx: index("mcp_connection_accounts_account_idx").on(table.accountId),
  }),
);

export const mcpAccessTokens = sqliteTable(
  "mcp_access_tokens",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => mcpConnections.id, { onDelete: "cascade" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(createdAtDefault),
  },
  (table) => ({
    tokenHashUniqueIdx: uniqueIndex("mcp_access_tokens_token_hash_unique_idx").on(table.tokenHash),
    connectionIdx: index("mcp_access_tokens_connection_idx").on(table.connectionId),
    expiresAtIdx: index("mcp_access_tokens_expires_at_idx").on(table.expiresAt),
    revokedAtIdx: index("mcp_access_tokens_revoked_at_idx").on(table.revokedAt),
  }),
);

export const mcpRefreshTokens = sqliteTable(
  "mcp_refresh_tokens",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => mcpConnections.id, { onDelete: "cascade" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    consumedAt: integer("consumed_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(createdAtDefault),
  },
  (table) => ({
    tokenHashUniqueIdx: uniqueIndex("mcp_refresh_tokens_token_hash_unique_idx").on(table.tokenHash),
    connectionIdx: index("mcp_refresh_tokens_connection_idx").on(table.connectionId),
    expiresAtIdx: index("mcp_refresh_tokens_expires_at_idx").on(table.expiresAt),
    consumedAtIdx: index("mcp_refresh_tokens_consumed_at_idx").on(table.consumedAt),
    revokedAtIdx: index("mcp_refresh_tokens_revoked_at_idx").on(table.revokedAt),
  }),
);
