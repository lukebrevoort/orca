import { z } from "zod";
import { inboxMessageSchema, mailAccountSchema } from "./schemas.ts";

export const organizationSavedQueryResultQuerySchema = z.object({
  accountId: z.string().trim().min(1),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().min(1).max(16_384).optional(),
}).strict();
export type OrganizationSavedQueryResultQuery = z.infer<typeof organizationSavedQueryResultQuerySchema>;

export const organizationSavedQueryEvaluationProfileSchema = z.enum(["stored-mail-v1", "legacy-pin-v1"]);
export type OrganizationSavedQueryEvaluationProfile = z.infer<typeof organizationSavedQueryEvaluationProfileSchema>;

/** Additive wire shape. The old strict Inbox/catalog responses remain unchanged. */
export const organizationSavedQueryResultResponseSchema = z.object({
  query: z.object({
    id: z.string().min(1),
    accountId: z.string().min(1),
    revision: z.number().int().positive(),
    definitionDigest: z.string().regex(/^[0-9a-f]{64}$/),
    evaluationProfile: organizationSavedQueryEvaluationProfileSchema,
  }).strict(),
  accounts: z.array(mailAccountSchema).length(1),
  messages: z.array(inboxMessageSchema).max(100),
  nextCursor: z.string().min(1).nullable(),
  freshness: z.object({
    revision: z.string().regex(/^mailbox-v[12]:[0-9a-f]{64}$/),
    lastSyncedAt: z.string().datetime().nullable(),
  }).strict(),
}).strict();
export type OrganizationSavedQueryResultResponse = z.infer<typeof organizationSavedQueryResultResponseSchema>;
