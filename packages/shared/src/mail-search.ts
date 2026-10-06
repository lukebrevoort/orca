import { z } from "zod";
import { inboxMessageSchema, mailAccountSchema } from "./schemas.ts";

export const mailSearchSemantics = "literal-index-v3" as const;
/** A control-plane declaration, not a promise that indexing is caught up. */
export const mailSearchCapabilitiesSchema = z.discriminatedUnion("mode", [
  z.object({
    version: z.literal(1), mode: z.literal("legacy-metadata"), epoch: z.string().min(1).max(256), ownerId: z.string().min(1),
    coverage: z.literal("stored-metadata"), semantics: z.literal("legacy-substring-v1"),
  }).strict(),
  z.object({
    version: z.literal(1), mode: z.literal("indexed"), epoch: z.string().min(1).max(256), ownerId: z.string().min(1),
    coverage: z.literal("stored-plaintext"), semantics: z.literal(mailSearchSemantics),
  }).strict(),
]);
export type MailSearchCapabilities = z.infer<typeof mailSearchCapabilitiesSchema>;
export const mailSearchOrder = "field-relevance-v1" as const;
export const mailSearchLimits = Object.freeze({ inputCharacters: 200, clauses: 16, pageSize: 10, maxPageSize: 50 });
export const normalizeMailSearchText = (value: string) => value.replace(/[A-Z]/g, letter => letter.toLowerCase());

export class MailSearchQueryError extends Error {
  constructor(readonly code: "search_invalid_query" | "search_anchor_required", message: string) {
    super(message); this.name = "MailSearchQueryError";
  }
}

/** Literal clauses only. The compiler, never user text, supplies FTS syntax. */
export function parseMailSearch(value: string): { clauses: string[]; anchors: string[]; shortClauses: string[] } {
  if (value.length > mailSearchLimits.inputCharacters || value.includes("\0")) {
    throw new MailSearchQueryError("search_invalid_query", "Use at most 200 characters and no NUL character.");
  }
  const clauses: string[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    while (cursor < value.length && /\s/u.test(value[cursor]!)) cursor++;
    if (cursor >= value.length) break;
    let clause = "";
    if (value[cursor] === '"') {
      cursor++;
      let closed = false;
      while (cursor < value.length) {
        const character = value[cursor++]!;
        if (character === '"') { closed = true; break; }
        if (character === "\\" && (value[cursor] === '"' || value[cursor] === "\\")) clause += value[cursor++]!;
        else clause += character;
      }
      if (!closed || cursor < value.length && !/\s/u.test(value[cursor]!)) {
        throw new MailSearchQueryError("search_invalid_query", "Close each quoted phrase and separate clauses with spaces.");
      }
    } else {
      while (cursor < value.length && !/\s/u.test(value[cursor]!)) {
        if (value[cursor] === '"') throw new MailSearchQueryError("search_invalid_query", "Start a quoted phrase at the beginning of a clause.");
        clause += value[cursor++]!;
      }
    }
    if (!clause.length) throw new MailSearchQueryError("search_invalid_query", "A quoted phrase cannot be empty.");
    clause = normalizeMailSearchText(clause);
    if (!clauses.includes(clause)) clauses.push(clause);
    if (clauses.length > mailSearchLimits.clauses) throw new MailSearchQueryError("search_invalid_query", "Use at most 16 distinct words or phrases.");
  }
  if (!clauses.length) throw new MailSearchQueryError("search_invalid_query", "Enter a word or phrase to search stored mail.");
  const anchors = clauses.filter(clause => [...clause].length >= 3);
  if (!anchors.length) throw new MailSearchQueryError("search_anchor_required", "Add a word or phrase with at least 3 characters. Short terms can accompany it, such as AI update.");
  return { clauses, anchors, shortClauses: clauses.filter(clause => [...clause].length < 3) };
}

const searchText = z.string().trim().min(1).max(mailSearchLimits.inputCharacters).superRefine((value, context) => {
  try { parseMailSearch(value); }
  catch (error) { context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid search" }); }
});
export const mailSearchQuerySchema = z.object({
  query: searchText,
  cursor: z.string().min(1).max(2_048).optional(),
  limit: z.coerce.number().int().min(1).max(mailSearchLimits.maxPageSize).default(mailSearchLimits.pageSize),
  accountId: z.string().min(1).max(1_024).optional(),
  view: z.enum(["inbox", "focus", "normal", "quiet", "hidden", "all"]).default("all"),
  classification: z.enum(["human", "tideline", "uncertain", "all"]).default("all"),
  sender: z.string().trim().min(1).max(320).optional(),
  senderAddress: z.string().trim().min(1).max(320).optional(),
  attentionBehavior: z.enum(["notify", "focus", "normal", "quiet", "hidden"]).optional(),
  collectionId: z.string().min(1).max(1_024).optional(),
  destinationId: z.string().min(1).max(1_024).optional(),
}).strict();
export type MailSearchQuery = z.infer<typeof mailSearchQuerySchema>;

export const mailSearchPageSchema = z.object({
  accounts: z.array(mailAccountSchema),
  messages: z.array(inboxMessageSchema).max(mailSearchLimits.maxPageSize),
  nextCursor: z.string().min(1).max(2_048).nullable(),
  // scan means more index positions remain, not that another match is known.
  continuation: z.enum(["matches", "scan", "none"]),
  snapshot: z.string().min(1),
  order: z.literal(mailSearchOrder),
  semantics: z.literal(mailSearchSemantics),
  coverage: z.enum(["stored-metadata", "stored-plaintext"]),
}).strict().superRefine((value, context) => {
  if ((value.continuation === "none") !== (value.nextCursor === null)) context.addIssue({ code: "custom", path: ["nextCursor"], message: "Continuation and cursor must agree" });
});
export type MailSearchPage = z.infer<typeof mailSearchPageSchema>;
