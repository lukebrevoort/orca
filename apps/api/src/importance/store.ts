import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import type { Database, SQLQueryBindings } from "bun:sqlite";
import {
  importanceOperationSchema, importancePreviewSchema, importanceResolutionSchema, importantPageSchema,
  type ImportanceMutation, type ImportanceOperation, type ImportancePreviewRequest, type ImportanceResolution, type ImportanceTarget,
} from "@orca/shared";
import { getAuthConfig } from "../auth/config.ts";

const windowMs = 5 * 60_000;
export class ImportanceError extends Error {
  constructor(readonly code: "not_found" | "stale_revision" | "operation_conflict" | "confirmation_required" | "invalid_cursor", message: string, readonly current?: unknown) { super(message); }
}
type Scope = { userId: string; accountId: string };
type Stored = { choice: "important" | "not_important" | null; revision: number };
type State = { account_id: string; thread_id: string; effective: ImportanceResolution["effective"]; important_count: number; not_important_count: number; unreviewed_count: number; participant_count: number; received_at: number };
type Op = { account_id: string; user_id: string; operation_id: string; kind: ImportanceTarget["kind"]; target: string; choice: Stored["choice"]; previous_choice: Stored["choice"]; revision: number; fingerprint: string; created_at: number };
const targetValue = (target: ImportanceTarget) => target.kind === "sender" ? target.address : target.threadId;
function opaqueKey() { return createHmac("sha256", getAuthConfig().sessionSecret).update("orca-importance-v1").digest(); }
function seal(value: unknown, scope: unknown) {
  const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", opaqueKey(), nonce);
  cipher.setAAD(Buffer.from(JSON.stringify(scope)));
  const bytes = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return [nonce, bytes, cipher.getAuthTag()].map(x => x.toString("base64url")).join(".");
}
function open(value: string, scope: unknown): unknown {
  if (value.length > 8192 || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(value)) throw Error("Invalid token");
  const parts = value.split("."), decoded = parts.map(x => Buffer.from(x, "base64url"));
  if (decoded.some((x, i) => x.toString("base64url") !== parts[i]) || decoded[0]!.length !== 12 || decoded[2]!.length !== 16) throw Error("Invalid token");
  const cipher = createDecipheriv("aes-256-gcm", opaqueKey(), decoded[0]!); cipher.setAAD(Buffer.from(JSON.stringify(scope))); cipher.setAuthTag(decoded[2]!);
  return JSON.parse(Buffer.concat([cipher.update(decoded[1]!), cipher.final()]).toString());
}
export function authorizeImportance(sqlite: Database, scope: Scope) {
  if (!sqlite.query("SELECT 1 FROM oauth_accounts WHERE id=? AND user_id=?").get(scope.accountId, scope.userId)) throw new ImportanceError("not_found", "Account not found");
}
export function importanceRevision(sqlite: Database, accountId: string) {
  return (sqlite.query("SELECT revision FROM mailbox_revisions WHERE account_id=?").get(accountId) as { revision: number }).revision;
}
function stored(sqlite: Database, accountId: string, kind: string, target: string): Stored {
  return sqlite.query("SELECT choice,revision FROM importance_choices WHERE account_id=? AND kind=? AND target=?").get(accountId, kind, target) as Stored | null ?? { choice: null, revision: 0 };
}
function requireTarget(sqlite: Database, accountId: string, target: ImportanceTarget) {
  const exists = target.kind === "conversation"
    ? sqlite.query("SELECT 1 FROM threads WHERE account_id=? AND id=?").get(accountId, target.threadId)
    : sqlite.query("SELECT 1 FROM importance_participants WHERE account_id=? AND address=? LIMIT 1").get(accountId, target.address);
  // Existing tombstones remain editable even if the last matching email disappears.
  if (!exists && (target.kind === "conversation" || stored(sqlite, accountId, "sender", target.address).revision === 0)) throw new ImportanceError("not_found", "Importance target not found");
}

/** One batched metadata-only projection; no per-row SQL or message bodies. Caller owns an authorized read snapshot. */
export function readImportance(sqlite: Database, targets: readonly { accountId: string; threadId: string }[]): Map<string, ImportanceResolution> {
  if (!targets.length) return new Map();
  const unique = [...new Map(targets.map(t => [JSON.stringify([t.accountId, t.threadId]), t])).values()];
  const values = unique.map(() => "(?,?)").join(","), params = unique.flatMap(t => [t.accountId, t.threadId]);
  const rows = sqlite.query(`WITH wanted(account_id,thread_id) AS (VALUES ${values})
    SELECT s.*,c.choice,c.revision choice_revision,r.revision account_revision
    FROM wanted w JOIN importance_thread_state s ON s.account_id=w.account_id AND s.thread_id=w.thread_id
    LEFT JOIN importance_choices c ON c.account_id=s.account_id AND c.kind='conversation' AND c.target=s.thread_id
    JOIN mailbox_revisions r ON r.account_id=s.account_id`).all(...params) as (State & { choice: Stored["choice"]; choice_revision: number | null; account_revision: number })[];
  // Windowed per-conversation preference projection visits explicit contributing preferences only.
  const prefs = sqlite.query(`WITH wanted(account_id,thread_id) AS (VALUES ${values}), ranked AS (
    SELECT p.account_id,p.thread_id,p.address,c.choice,c.revision,
      row_number() OVER(PARTITION BY p.account_id,p.thread_id ORDER BY CASE c.choice WHEN 'important' THEN 0 ELSE 1 END,p.address) ordinal
    FROM wanted w JOIN importance_participants p ON p.account_id=w.account_id AND p.thread_id=w.thread_id
    JOIN importance_choices c ON c.account_id=p.account_id AND c.kind='sender' AND c.target=p.address AND c.choice IS NOT NULL)
    SELECT * FROM ranked WHERE ordinal<=20`).all(...params) as { account_id: string; thread_id: string; address: string; choice: "important" | "not_important"; revision: number }[];
  const byThread = new Map<string, typeof prefs>();
  for (const p of prefs) { const key = JSON.stringify([p.account_id, p.thread_id]); const list = byThread.get(key) ?? []; list.push(p); byThread.set(key, list); }
  return new Map(rows.map(row => {
    const key = JSON.stringify([row.account_id, row.thread_id]);
    const preferences = (byThread.get(key) ?? []).map(({ address, choice, revision }) => ({ address, choice, revision }));
    const inherited = aggregate(row.important_count, row.unreviewed_count, row.not_important_count);
    return [key, importanceResolutionSchema.parse({ effective: row.effective, source: row.choice ? "conversation" : row.participant_count ? "participants" : "unreviewed",
      conversation: { choice: row.choice ?? null, revision: row.choice_revision ?? 0 }, inherited,
      participantCounts: { important: row.important_count, notImportant: row.not_important_count, unreviewed: row.unreviewed_count, total: row.participant_count },
      preferences, preferencesTruncated: row.important_count + row.not_important_count > preferences.length, accountRevision: row.account_revision })];
  }));
}
export const importanceKey = (accountId: string, threadId: string) => JSON.stringify([accountId, threadId]);
export function readConversationImportance(sqlite: Database, accountId: string, threadId: string) {
  const result = readImportance(sqlite, [{ accountId, threadId }]).get(importanceKey(accountId, threadId));
  if (!result) throw new ImportanceError("not_found", "Conversation not found");
  return result;
}
// Shared notification eligibility input: use this result rather than authorship/read/placement heuristics.
export function aggregate(important: number, unreviewed: number, notImportant: number): ImportanceResolution["effective"] {
  return important > 0 ? "important" : unreviewed > 0 || notImportant === 0 ? "unreviewed" : "not_important";
}

export function previewImportance(sqlite: Database, scope: Scope, input: ImportancePreviewRequest, now = Date.now()) {
  requireTarget(sqlite, scope.accountId, { kind: "sender", address: input.address });
  const current = stored(sqlite, scope.accountId, "sender", input.address), revision = importanceRevision(sqlite, scope.accountId);
  const rows = sqlite.query(`SELECT s.*,c.choice override_choice FROM importance_participants p
    JOIN importance_thread_state s ON s.account_id=p.account_id AND s.thread_id=p.thread_id
    LEFT JOIN importance_choices c ON c.account_id=p.account_id AND c.kind='conversation' AND c.target=p.thread_id
    WHERE p.account_id=? AND p.address=?`).all(scope.accountId, input.address) as (State & { override_choice: Stored["choice"] })[];
  const existing = { matching: rows.length, overridden: 0, changed: 0, keptImportantByOtherParticipants: 0,
    before: { important: 0, not_important: 0, unreviewed: 0 }, after: { important: 0, not_important: 0, unreviewed: 0 } };
  for (const row of rows) {
    const i = row.important_count - (current.choice === "important" ? 1 : 0) + (input.choice === "important" ? 1 : 0);
    const n = row.not_important_count - (current.choice === "not_important" ? 1 : 0) + (input.choice === "not_important" ? 1 : 0);
    const u = row.unreviewed_count - (current.choice === null ? 1 : 0) + (input.choice === null ? 1 : 0);
    const after = row.override_choice ?? aggregate(i, u, n);
    existing.before[row.effective]++; existing.after[after]++;
    if (row.override_choice) existing.overridden++;
    if (after !== row.effective) existing.changed++;
    if (!row.override_choice && input.choice !== "important" && after === "important") existing.keptImportantByOtherParticipants++;
  }
  return importancePreviewSchema.parse({ accountId: scope.accountId, address: input.address, choice: input.choice, current, accountRevision: revision, existing,
    confirmation: seal({ version: 1, revision, address: input.address, choice: input.choice, expires: now + windowMs }, { ...scope, purpose: "sender-confirmation" }),
    expiresAt: new Date(now + windowMs).toISOString(), future: { accountId: scope.accountId, address: input.address, preservesConversationOverrides: true, otherImportantParticipantsMayKeepImportant: true, exactAddressOnly: true } });
}
function opRecord(sqlite: Database, scope: Scope, operationId: string) {
  const op = sqlite.query("SELECT * FROM importance_operations WHERE account_id=? AND operation_id=? AND user_id=?").get(scope.accountId, operationId, scope.userId) as Op | null;
  if (!op) throw new ImportanceError("not_found", "Importance operation not found");
  return op;
}
function describe(sqlite: Database, op: Op): ImportanceOperation {
  const current = stored(sqlite, op.account_id, op.kind, op.target);
  const importance = op.kind === "conversation" && sqlite.query("SELECT 1 FROM threads WHERE account_id=? AND id=?").get(op.account_id, op.target)
    ? readConversationImportance(sqlite, op.account_id, op.target) : undefined;
  return importanceOperationSchema.parse({ status: current.revision === op.revision ? "current" : "superseded", current, importance,
    receipt: { operationId: op.operation_id, accountId: op.account_id, target: op.kind === "conversation" ? { kind: op.kind, threadId: op.target } : { kind: op.kind, address: op.target },
      choice: op.choice, previousChoice: op.previous_choice, revision: op.revision, undoUntil: new Date(op.created_at + windowMs).toISOString() } });
}
export function reconcileImportance(sqlite: Database, scope: Scope, operationId: string) { return describe(sqlite, opRecord(sqlite, scope, operationId)); }
function apply(sqlite: Database, scope: Scope, input: ImportanceMutation, fingerprint: string, now: number) {
  const value = targetValue(input.target);
  const replay = sqlite.query("SELECT * FROM importance_operations WHERE account_id=? AND operation_id=?").get(scope.accountId, input.operationId) as Op | null;
  if (replay) {
    if (replay.user_id !== scope.userId || replay.fingerprint !== fingerprint) throw new ImportanceError("operation_conflict", "Operation ID was already used for another command");
    return describe(sqlite, replay);
  }
  requireTarget(sqlite, scope.accountId, input.target);
  const current = stored(sqlite, scope.accountId, input.target.kind, value);
  if (current.revision !== input.expectedRevision) throw new ImportanceError("stale_revision", "Choice changed. Read the current choice before trying again.", current);
  if (current.revision >= Number.MAX_SAFE_INTEGER) throw new ImportanceError("stale_revision", "Revision exhausted", current);
  const next = current.revision + 1;
  sqlite.query(`INSERT INTO importance_choices(account_id,kind,target,choice,revision,updated_at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(account_id,kind,target) DO UPDATE SET choice=excluded.choice,revision=excluded.revision,updated_at=excluded.updated_at`).run(scope.accountId, input.target.kind, value, input.choice, next, now);
  sqlite.query("INSERT INTO importance_operations VALUES(?,?,?,?,?,?,?,?,?,?)").run(scope.accountId, input.operationId, scope.userId, input.target.kind, value, input.choice, current.choice, next, fingerprint, now);
  return reconcileImportance(sqlite, scope, input.operationId);
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function mutateImportance(sqlite: Database, scope: Scope, input: ImportanceMutation, now = Date.now()) {
  return sqlite.transaction(() => {
    authorizeImportance(sqlite, scope);
    const fingerprint = digest({ target: input.target, choice: input.choice, expectedRevision: input.expectedRevision });
    const replay = sqlite.query("SELECT 1 FROM importance_operations WHERE account_id=? AND operation_id=?").get(scope.accountId, input.operationId);
    if (!replay) requireTarget(sqlite, scope.accountId, input.target);
    if (!replay && input.target.kind === "sender") {
      try {
        const token = open(input.confirmation ?? "", { ...scope, purpose: "sender-confirmation" }) as { version: number; revision: number; address: string; choice: Stored["choice"]; expires: number };
        if (token.version !== 1 || token.revision !== importanceRevision(sqlite, scope.accountId) || token.address !== input.target.address || token.choice !== input.choice || token.expires < now) throw Error();
      } catch { throw new ImportanceError("confirmation_required", "Review a current exact-sender preview before confirming"); }
    }
    return apply(sqlite, scope, input, fingerprint, now);
  }).immediate();
}
export function undoImportance(sqlite: Database, scope: Scope, sourceId: string, input: { operationId: string; expectedRevision: number }, now = Date.now()) {
  return sqlite.transaction(() => {
    authorizeImportance(sqlite, scope);
    const source = opRecord(sqlite, scope, sourceId);
    const command: ImportanceMutation = { accountId: scope.accountId, target: source.kind === "sender" ? { kind: "sender", address: source.target } : { kind: "conversation", threadId: source.target },
      choice: source.previous_choice, expectedRevision: input.expectedRevision, operationId: input.operationId };
    const fingerprint = digest({ undo: sourceId, expectedRevision: input.expectedRevision });
    // An acknowledged undo can be reconciled/retried after its window, but never reapplied.
    const replay = sqlite.query("SELECT 1 FROM importance_operations WHERE account_id=? AND operation_id=?").get(scope.accountId, input.operationId);
    if (!replay && (source.revision !== input.expectedRevision || now > source.created_at + windowMs)) throw new ImportanceError("stale_revision", "Undo is no longer available; read and directly correct the current choice");
    return apply(sqlite, scope, command, fingerprint, now);
  }).immediate();
}

export const importantPageSql = `SELECT s.thread_id,s.received_at,t.subject,
 (SELECT snippet FROM emails e WHERE e.account_id=s.account_id AND e.thread_id=s.thread_id ORDER BY received_at DESC,created_at DESC,id LIMIT 1) snippet,
 (SELECT from_address FROM emails e WHERE e.account_id=s.account_id AND e.thread_id=s.thread_id ORDER BY received_at DESC,created_at DESC,id LIMIT 1) sender,
 EXISTS(SELECT 1 FROM emails e WHERE e.account_id=s.account_id AND e.thread_id=s.thread_id AND e.is_read=0) unread
 FROM importance_thread_state s JOIN threads t ON t.id=s.thread_id AND t.account_id=s.account_id
 WHERE s.account_id=? AND s.effective='important' AND s.retained_count>0`;
export function readImportantPage(sqlite: Database, scope: Scope, limit: number, cursor?: string) {
  return sqlite.transaction(() => {
    authorizeImportance(sqlite, scope);
    const revision = importanceRevision(sqlite, scope.accountId);
    let anchor: { received: number; thread: string } | undefined;
    if (cursor) {
      try {
        const data = open(cursor, { ...scope, purpose: "important-page", limit }) as { version: number; revision: number; received: number; thread: string };
        if (data.version !== 1 || data.revision !== revision || !Number.isSafeInteger(data.received) || typeof data.thread !== "string") throw Error();
        anchor = data;
      } catch { throw new ImportanceError("invalid_cursor", "Important mail changed or cursor scope is invalid. Restart pages."); }
    }
    // Disjoint range seeks avoid rescanning previous pages on tied timestamps.
    type Row = { thread_id: string; received_at: number; subject: string | null; snippet: string | null; sender: string | null; unread: number };
    const rows: Row[] = [];
    const query = (condition: string, bindings: SQLQueryBindings[]) => rows.push(...sqlite.query(`${importantPageSql} ${condition} ORDER BY s.received_at DESC,s.thread_id LIMIT ?`).all(scope.accountId, ...bindings, limit + 1 - rows.length) as Row[]);
    if (!anchor) query("", []);
    else {
      query("AND s.received_at=? AND s.thread_id>?", [anchor.received, anchor.thread]);
      if (rows.length < limit + 1) query("AND s.received_at<?", [anchor.received]);
    }
    const hasNext = rows.length > limit; rows.length = Math.min(rows.length, limit);
    const importance = readImportance(sqlite, rows.map(row => ({ accountId: scope.accountId, threadId: row.thread_id })));
    const last = rows.at(-1);
    return importantPageSchema.parse({ accountId: scope.accountId, revision,
      items: rows.map(row => ({ accountId: scope.accountId, threadId: row.thread_id, subject: row.subject ?? "", snippet: row.snippet ?? "", from: row.sender,
        receivedAt: new Date(row.received_at).toISOString(), unread: Boolean(row.unread), importance: importance.get(importanceKey(scope.accountId, row.thread_id)) })),
      nextCursor: hasNext && last ? seal({ version: 1, revision, received: last.received_at, thread: last.thread_id }, { ...scope, purpose: "important-page", limit }) : null });
  }).deferred();
}
