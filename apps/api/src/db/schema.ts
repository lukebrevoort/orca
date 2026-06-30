import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const createdAtDefault = sql`(unixepoch() * 1000)`;

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    displayName: text("display_name"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(createdAtDefault),
  },
  (table) => ({
    emailUniqueIdx: uniqueIndex("users_email_unique_idx").on(table.email),
  }),
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
    subject: text("subject"),
    snippet: text("snippet"),
    bodyText: text("body_text"),
    bodyHtml: text("body_html"),
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
