import { and, eq, isNull, like } from "drizzle-orm";
import type { createDatabaseClient } from "../db/client.ts";
import { users } from "../db/schema.ts";
import { PENDING_EMAIL_LIKE } from "./mail-oauth-transactions.ts";

export const pendingUserEmailPattern = PENDING_EMAIL_LIKE;

export function isPendingUser(
  db: ReturnType<typeof createDatabaseClient>["db"],
  userId: string,
): boolean {
  return db.select({ id: users.id }).from(users).where(and(
    eq(users.id, userId),
    like(users.email, pendingUserEmailPattern),
    isNull(users.authenticatedAt),
  )).get() !== undefined;
}
