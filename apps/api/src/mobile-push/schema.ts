import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { emails, oauthAccounts, users } from "../db/schema.ts";

const nowMs = sql`(unixepoch() * 1000)`;

/** Standalone schema exports; the parent integration can re-export these from db/schema.ts. */
export const mobilePushDevices = sqliteTable("mobile_push_devices", {
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  installationId: text("installation_id").notNull(),
  sessionId: text("session_id").notNull(),
  tokenEncrypted: text("token_encrypted").notNull(),
  tokenHash: text("token_hash").notNull(),
  environment: text("environment").notNull(),
  // Retained only so pre-0049 registrations can be migrated without losing an
  // explicit opt-out. Runtime preference evaluation uses notifyInbox + spaces.
  legacyNotificationMode: text("notification_mode").notNull().default("human"),
  notifyInbox: integer("notify_inbox", { mode: "boolean" }).notNull().default(true),
  generation: integer("generation").notNull().default(1),
  eligibleAfterAt: integer("eligible_after_at", { mode: "timestamp_ms" }).notNull(),
  watermarkSequence: integer("watermark_sequence").notNull().default(0),
  watermarkCreatedAt: integer("watermark_created_at", { mode: "timestamp_ms" }).notNull(),
  watermarkEmailId: text("watermark_email_id").notNull().default(""),
  registeredAt: integer("registered_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  disabledAt: integer("disabled_at", { mode: "timestamp_ms" }),
  disabledReason: text("disabled_reason"),
}, (table) => ({
  primaryKey: primaryKey({ columns: [table.userId, table.installationId] }),
  scanIdx: index("mobile_push_devices_selection_scan_idx").on(table.notifyInbox, table.disabledAt, table.watermarkSequence),
  staleIdx: index("mobile_push_devices_stale_idx").on(table.lastSeenAt),
  tokenOwnerIdx: uniqueIndex("mobile_push_devices_token_owner_idx").on(table.tokenHash, table.environment),
  environmentCheck: check("mobile_push_devices_environment_check", sql`${table.environment} IN ('sandbox','production')`),
  modeCheck: check("mobile_push_devices_mode_check", sql`${table.legacyNotificationMode} IN ('human','all','off')`),
  generationCheck: check("mobile_push_devices_generation_check", sql`${table.generation} >= 1`),
}));

export const mobilePushDeviceSpaces = sqliteTable("mobile_push_device_spaces", {
  userId: text("user_id").notNull(),
  installationId: text("installation_id").notNull(),
  spaceId: text("space_id").notNull(),
  kind: text("kind").notNull(),
  resourceId: text("resource_id").notNull(),
}, (table) => ({
  primaryKey: primaryKey({ columns: [table.userId, table.installationId, table.spaceId] }),
  deviceForeignKey: foreignKey({
    columns: [table.userId, table.installationId],
    foreignColumns: [mobilePushDevices.userId, mobilePushDevices.installationId],
    name: "mobile_push_device_spaces_device_fk",
  }).onDelete("cascade"),
  resourceIdx: index("mobile_push_device_spaces_resource_idx").on(table.kind, table.resourceId),
  kindCheck: check("mobile_push_device_spaces_kind_check", sql`${table.kind} IN ('destination','collection','view')`),
}));

export const mobilePushOutbox = sqliteTable("mobile_push_outbox", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  installationId: text("installation_id").notNull(),
  deviceGeneration: integer("device_generation").notNull(),
  messageId: text("message_id").notNull(),
  accountId: text("account_id").notNull(),
  threadId: text("thread_id").notNull(),
  environment: text("environment").notNull(),
  payloadJson: text("payload_json").notNull(),
  apnsId: text("apns_id").notNull(),
  state: text("state").notNull().default("pending"),
  attemptCount: integer("attempt_count").notNull().default(0),
  availableAt: integer("available_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }),
  lastStatus: integer("last_status"),
  lastError: text("last_error"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(nowMs),
  sentAt: integer("sent_at", { mode: "timestamp_ms" }),
}, (table) => ({
  deviceForeignKey: foreignKey({
    columns: [table.userId, table.installationId],
    foreignColumns: [mobilePushDevices.userId, mobilePushDevices.installationId],
    name: "mobile_push_outbox_device_fk",
  }).onDelete("cascade"),
  ownerAccountForeignKey: foreignKey({
    columns: [table.userId, table.accountId],
    foreignColumns: [oauthAccounts.userId, oauthAccounts.id],
    name: "mobile_push_outbox_owner_account_fk",
  }).onDelete("cascade"),
  accountMessageForeignKey: foreignKey({
    columns: [table.accountId, table.threadId, table.messageId],
    foreignColumns: [emails.accountId, emails.threadId, emails.id],
    name: "mobile_push_outbox_account_message_fk",
  }).onDelete("cascade"),
  dedupeIdx: uniqueIndex("mobile_push_outbox_dedupe_idx").on(table.userId, table.installationId, table.deviceGeneration, table.messageId),
  readyIdx: index("mobile_push_outbox_ready_idx").on(table.state, table.availableAt, table.createdAt),
  environmentCheck: check("mobile_push_outbox_environment_check", sql`${table.environment} IN ('sandbox','production')`),
  stateCheck: check("mobile_push_outbox_state_check", sql`${table.state} IN ('pending','delivering','sent','dead')`),
  attemptCheck: check("mobile_push_outbox_attempt_check", sql`${table.attemptCount} >= 0`),
}));

// Populated transactionally by the AFTER INSERT trigger in migration 0048.
export const mobilePushSequenceCounter = sqliteTable("mobile_push_sequence_counter", {
  id: integer("id").primaryKey(),
  value: integer("value").notNull(),
}, (table) => ({
  singletonCheck: check("mobile_push_sequence_counter_singleton_check", sql`${table.id} = 1`),
  valueCheck: check("mobile_push_sequence_counter_value_check", sql`${table.value} >= 0`),
}));

export const mobilePushEmailSequence = sqliteTable("mobile_push_email_sequence", {
  emailId: text("email_id").primaryKey().references(() => emails.id, { onDelete: "cascade" }),
  sequence: integer("sequence").notNull(),
}, (table) => ({
  sequenceIdx: uniqueIndex("mobile_push_email_sequence_sequence_unique_idx").on(table.sequence),
}));
