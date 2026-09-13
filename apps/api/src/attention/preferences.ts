import { and, eq } from "drizzle-orm";
import { attentionPreferencesSchema, updateAttentionPreferencesSchema } from "@orca/shared";
import type { createDatabaseClient } from "../db/client.ts";
import { accountAttentionPreferences, oauthAccounts } from "../db/schema.ts";

type Db = Pick<ReturnType<typeof createDatabaseClient>["db"], "select" | "insert" | "update" | "transaction">;
export class AttentionPreferencesError extends Error {
  constructor(readonly status: 403 | 409, message: string) { super(message); }
}
export function createAttentionPreferences(db: Db, userId: string) {
  function owned(accountId: string) {
    if (!db.select({ id: oauthAccounts.id }).from(oauthAccounts).where(and(eq(oauthAccounts.id, accountId), eq(oauthAccounts.userId, userId))).get())
      throw new AttentionPreferencesError(403, "This account is not available to you.");
  }
  function read(accountId: string) {
    owned(accountId);
    const row = db.select().from(accountAttentionPreferences).where(eq(accountAttentionPreferences.accountId, accountId)).get();
    return attentionPreferencesSchema.parse({ accountId, revision: row?.revision ?? 0, defaultChoice: row?.defaultChoice ?? "quiet", senders: row ? JSON.parse(row.sendersJson) : [], delivery: "proposal_only" });
  }
  return { read, save(accountId: string, input: unknown) {
    const value = updateAttentionPreferencesSchema.parse(input);
    return db.transaction(tx => {
      const current = createAttentionPreferences(tx, userId).read(accountId);
      if (current.revision !== value.expectedRevision) throw new AttentionPreferencesError(409, "These choices changed elsewhere. Reload before trying again.");
      const next = { revision: current.revision + 1, defaultChoice: value.defaultChoice, sendersJson: JSON.stringify(value.senders) };
      if (current.revision === 0) tx.insert(accountAttentionPreferences).values({ accountId, ...next }).run();
      else {
        const changed = tx.update(accountAttentionPreferences).set(next).where(and(eq(accountAttentionPreferences.accountId, accountId), eq(accountAttentionPreferences.revision, current.revision))).returning({ accountId: accountAttentionPreferences.accountId }).all();
        if (changed.length !== 1) throw new AttentionPreferencesError(409, "These choices changed elsewhere. Reload before trying again.");
      }
      return createAttentionPreferences(tx, userId).read(accountId);
    }, { behavior: "immediate" });
  } };
}
