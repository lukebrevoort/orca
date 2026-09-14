import { and, asc, desc, eq } from "drizzle-orm";
import {
  attentionRoutingChangeSchema, attentionRoutingStateSchema, attentionRoutingTargetSchema, senderAttentionRuleSchema,
  type AttentionBehavior, type AttentionRoutingResolution, type AttentionRoutingTarget,
} from "@orca/shared";
import type { createDatabaseClient } from "../db/client.ts";
import { accountAttentionRouting, emails, oauthAccounts, senderAttentionRules, threadAttentionOverrides, threads } from "../db/schema.ts";

type Db = Pick<ReturnType<typeof createDatabaseClient>["db"], "select" | "insert" | "update" | "delete" | "transaction">;
export class AttentionRoutingError extends Error {
  constructor(readonly status: 404 | 409, message: string) { super(message); }
}
const conflict = () => new AttentionRoutingError(409, "Routing changed elsewhere. Reload before trying again.");

/** Snapshot resolver shared by the reader and Organization. Never changes lanes or provider mail. */
export function loadAttentionRouting(db: Db, accountId: string) {
  const account = db.select().from(accountAttentionRouting).where(eq(accountAttentionRouting.accountId, accountId)).get();
  const rules = db.select().from(senderAttentionRules).where(eq(senderAttentionRules.accountId, accountId))
    .orderBy(asc(senderAttentionRules.scope), asc(senderAttentionRules.value)).all().map(row => senderAttentionRuleSchema.parse({
      ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    }));
  const overrides = db.select().from(threadAttentionOverrides).where(eq(threadAttentionOverrides.accountId, accountId)).all();
  function resolution(behavior: AttentionBehavior, source: AttentionRoutingResolution["source"], rule: AttentionRoutingResolution["rule"] = null): AttentionRoutingResolution {
    return { behavior, source, rule, destination: behavior === "normal" ? "inbox" : behavior === "quiet" ? "quiet" : null };
  }
  function resolve(address = "", threadId?: string, skip?: AttentionRoutingTarget["scope"]): AttentionRoutingResolution {
    address = address.trim().toLowerCase();
    const thread = skip !== "conversation" && threadId ? overrides.find(row => row.threadId === threadId) : undefined;
    if (thread) return resolution(thread.behavior as AttentionBehavior, "conversation");
    const exact = skip !== "sender" ? rules.find(row => row.scope === "address" && row.value === address) : undefined;
    if (exact) return resolution(exact.behavior, "sender", exact);
    const domain = rules.find(row => row.scope === "domain" && row.value === address.split("@")[1]);
    if (domain) return resolution(domain.behavior, "domain", domain);
    if (skip !== "account" && account?.defaultBehavior) return resolution(account.defaultBehavior as AttentionBehavior, "account");
    return resolution("normal", "fallback");
  }
  return { account, rules, overrides, resolve };
}

export function createAttentionRouting(db: Db, userId: string) {
  function owned(accountId: string) {
    if (!db.select({ id: oauthAccounts.id }).from(oauthAccounts).where(and(eq(oauthAccounts.id, accountId), eq(oauthAccounts.userId, userId))).get())
      throw new AttentionRoutingError(404, "Mail account was not found.");
  }
  function readSnapshot(accountId: string, target: AttentionRoutingTarget) {
    owned(accountId);
    let address = target.scope === "sender" ? target.address : "";
    if (target.scope === "conversation") {
      if (!db.select({ id: threads.id }).from(threads).where(and(eq(threads.id, target.threadId), eq(threads.accountId, accountId))).get())
        throw new AttentionRoutingError(404, "Conversation was not found in this account.");
      address = db.select({ address: emails.fromAddress }).from(emails)
        .where(and(eq(emails.accountId, accountId), eq(emails.threadId, target.threadId)))
        .orderBy(desc(emails.receivedAt), desc(emails.createdAt), asc(emails.id)).get()?.address ?? "";
    }
    const snapshot = loadAttentionRouting(db, accountId);
    const threadId = target.scope === "conversation" ? target.threadId : undefined;
    const explicitBehavior = target.scope === "account" ? snapshot.account?.defaultBehavior
      : target.scope === "sender" ? snapshot.rules.find(rule => rule.scope === "address" && rule.value === address)?.behavior
      : snapshot.overrides.find(row => row.threadId === target.threadId)?.behavior;
    return attentionRoutingStateSchema.parse({
      accountId, revision: snapshot.account?.revision ?? 0,
      defaultBehavior: snapshot.account?.defaultBehavior ?? null,
      senders: snapshot.rules,
      selection: { target, explicitBehavior: explicitBehavior ?? null,
        effective: snapshot.resolve(address, threadId), inherited: snapshot.resolve(address, threadId, target.scope) },
    });
  }
  return {
    read(accountId: string, target: AttentionRoutingTarget = { scope: "account" }) {
      return db.transaction(() => readSnapshot(accountId, attentionRoutingTargetSchema.parse(target)), { behavior: "deferred" });
    },
    save(accountId: string, input: unknown) {
      const change = attentionRoutingChangeSchema.parse(input);
      return db.transaction(tx => {
        const service = createAttentionRouting(tx, userId);
        const current = service.read(accountId, change.target);
        if (current.revision !== change.expectedRevision) throw conflict();
        const { target, behavior } = change;
        // Do not write no-ops: retries can safely re-read canonical state. Reusing
        // an old revision after an actual write still conflicts (including Undo).
        if (current.selection.explicitBehavior !== behavior) {
          if (target.scope === "account") {
            tx.insert(accountAttentionRouting).values({ accountId, defaultBehavior: behavior, revision: current.revision + 1 })
              .onConflictDoUpdate({ target: accountAttentionRouting.accountId, set: { defaultBehavior: behavior, revision: current.revision + 1 } }).run();
          } else if (target.scope === "sender") {
            const where = and(eq(senderAttentionRules.accountId, accountId), eq(senderAttentionRules.scope, "address"), eq(senderAttentionRules.value, target.address));
            if (behavior === null) tx.delete(senderAttentionRules).where(where).run();
            else tx.insert(senderAttentionRules).values({ id: `sender-rule:${crypto.randomUUID()}`, accountId, scope: "address", value: target.address, behavior, source: "user_choice" })
              .onConflictDoUpdate({ target: [senderAttentionRules.accountId, senderAttentionRules.scope, senderAttentionRules.value], set: { behavior, source: "user_choice", updatedAt: new Date() } }).run();
          } else {
            if (behavior === null) tx.delete(threadAttentionOverrides).where(and(eq(threadAttentionOverrides.accountId, accountId), eq(threadAttentionOverrides.threadId, target.threadId))).run();
            else tx.insert(threadAttentionOverrides).values({ accountId, threadId: target.threadId, behavior })
              .onConflictDoUpdate({ target: [threadAttentionOverrides.accountId, threadAttentionOverrides.threadId], set: { behavior } }).run();
          }
        }
        const state = service.read(accountId, target);
        return { state, undo: { expectedRevision: state.revision, target, behavior: current.selection.explicitBehavior } };
      }, { behavior: "immediate" });
    },
  };
}
