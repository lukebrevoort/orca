import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
    accessTokenEncrypted: text("access_token_encrypted"),
    refreshTokenEncrypted: text("refresh_token_encrypted"),
    tokenExpiry: integer("token_expiry", { mode: "timestamp_ms" }),
    scope: text("scope"),
    syncCursor: text("sync_cursor"),
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
  }),
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
    threadIdx: index("emails_thread_idx").on(table.threadId),
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
    label: text("label").notNull(),
    position: integer("position").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(createdAtDefault),
  },
  (table) => ({
    accountTargetUniqueIdx: uniqueIndex("pins_account_target_unique_idx").on(table.accountId, table.kind, table.targetId),
    accountPositionUniqueIdx: uniqueIndex("pins_account_position_unique_idx").on(table.accountId, table.position),
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
