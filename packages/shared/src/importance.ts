import { z } from "zod";

const id = z.string().trim().min(1).max(1024);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const importanceChoiceSchema = z.enum(["important", "not_important"]);
export const importanceEffectiveSchema = z.enum(["important", "not_important", "unreviewed"]);
// Deliberately excludes display names, wildcards, domains and alias expansion.
export const importanceAddressSchema = z.string().trim().max(320).email().refine(value => !/[<>*\s]/.test(value)).transform(value => value.toLowerCase());
export const importanceTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("conversation"), threadId: id }).strict(),
  z.object({ kind: z.literal("sender"), address: importanceAddressSchema }).strict(),
]);
export const importanceStoredChoiceSchema = z.object({ choice: importanceChoiceSchema.nullable(), revision }).strict();
export const importanceResolutionSchema = z.object({
  effective: importanceEffectiveSchema,
  source: z.enum(["conversation", "participants", "unreviewed"]),
  conversation: importanceStoredChoiceSchema,
  inherited: importanceEffectiveSchema,
  participantCounts: z.object({ important: revision, notImportant: revision, unreviewed: revision, total: revision }).strict(),
  // Actual explicit preferences, deterministically ordered, with a truthful bound.
  preferences: z.array(z.object({ address: importanceAddressSchema, choice: importanceChoiceSchema, revision }).strict()).max(20),
  preferencesTruncated: z.boolean(),
  accountRevision: revision,
}).strict();
export const importanceMutationSchema = z.object({
  accountId: id, target: importanceTargetSchema, choice: importanceChoiceSchema.nullable(),
  expectedRevision: revision, operationId: z.string().uuid(), confirmation: z.string().min(1).max(8192).optional(),
}).strict();
export const importancePreviewRequestSchema = z.object({ accountId: id, address: importanceAddressSchema, choice: importanceChoiceSchema.nullable() }).strict();
export const importancePreviewSchema = z.object({
  accountId: id, address: importanceAddressSchema, choice: importanceChoiceSchema.nullable(), current: importanceStoredChoiceSchema,
  accountRevision: revision, confirmation: z.string(), expiresAt: z.string().datetime(),
  existing: z.object({ matching: revision, overridden: revision, changed: revision, keptImportantByOtherParticipants: revision,
    before: z.object({ important: revision, not_important: revision, unreviewed: revision }).strict(),
    after: z.object({ important: revision, not_important: revision, unreviewed: revision }).strict(),
  }).strict(),
  future: z.object({ accountId: id, address: importanceAddressSchema, preservesConversationOverrides: z.literal(true), otherImportantParticipantsMayKeepImportant: z.literal(true), exactAddressOnly: z.literal(true) }).strict(),
}).strict();
export const importanceReceiptSchema = z.object({
  operationId: z.string().uuid(), accountId: id, target: importanceTargetSchema,
  choice: importanceChoiceSchema.nullable(), previousChoice: importanceChoiceSchema.nullable(), revision,
  undoUntil: z.string().datetime(),
}).strict();
export const importanceOperationSchema = z.object({
  status: z.enum(["current", "superseded"]), receipt: importanceReceiptSchema,
  current: importanceStoredChoiceSchema, importance: importanceResolutionSchema.optional(),
}).strict();
export const importanceUndoSchema = z.object({ accountId: id, operationId: z.string().uuid(), expectedRevision: revision }).strict();
export const importantQuerySchema = z.object({ accountId: id, limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().min(1).max(8192).optional() }).strict();
export const importantPageSchema = z.object({
  accountId: id, revision, items: z.array(z.object({ accountId: id, threadId: id, subject: z.string(), snippet: z.string(),
    from: z.string().nullable(), receivedAt: z.string().datetime(), unread: z.boolean(), importance: importanceResolutionSchema }).strict()).max(100),
  nextCursor: z.string().nullable(),
}).strict();
export type ImportanceChoice = z.infer<typeof importanceChoiceSchema>;
export type ImportanceResolution = z.infer<typeof importanceResolutionSchema>;
export type ImportanceTarget = z.infer<typeof importanceTargetSchema>;
export type ImportanceMutation = z.infer<typeof importanceMutationSchema>;
export type ImportanceOperation = z.infer<typeof importanceOperationSchema>;
export type ImportancePreviewRequest = z.infer<typeof importancePreviewRequestSchema>;
