import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { users } from "../../db/schema.ts";

export const mobileAuthRequests = sqliteTable(
  "mobile_auth_requests",
  {
    id: text("id").primaryKey(),
    requestTokenHash: text("request_token_hash").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    state: text("state").notNull(),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    browserSessionId: text("browser_session_id"),
    csrfTokenHash: text("csrf_token_hash"),
    authorizationCodeHash: text("authorization_code_hash"),
    requestExpiresAt: integer("request_expires_at", { mode: "timestamp_ms" }).notNull(),
    codeExpiresAt: integer("code_expires_at", { mode: "timestamp_ms" }),
    authorizedAt: integer("authorized_at", { mode: "timestamp_ms" }),
    consumedAt: integer("consumed_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => ({
    requestTokenHashUniqueIdx: uniqueIndex("mobile_auth_requests_request_token_hash_unique_idx").on(table.requestTokenHash),
    authorizationCodeHashUniqueIdx: uniqueIndex("mobile_auth_requests_code_hash_unique_idx").on(table.authorizationCodeHash),
    requestExpiryIdx: index("mobile_auth_requests_request_expiry_idx").on(table.requestExpiresAt),
    codeExpiryIdx: index("mobile_auth_requests_code_expiry_idx").on(table.codeExpiresAt),
  }),
);

export const mobileSessions = sqliteTable(
  "mobile_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  },
  (table) => ({
    tokenHashUniqueIdx: uniqueIndex("mobile_sessions_token_hash_unique_idx").on(table.tokenHash),
    userIdx: index("mobile_sessions_user_idx").on(table.userId),
    expiresAtIdx: index("mobile_sessions_expires_at_idx").on(table.expiresAt),
  }),
);
