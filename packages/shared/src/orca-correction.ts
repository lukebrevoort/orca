import { z } from "zod";

import { orcaEvaluationTraceSchema } from "./orca-language.ts";

const identifierSchema = z.string().trim().min(1).max(200);

/** A deliberate human/authorized-agent correction that emits user.corrected. */
export const orcaThreadCorrectionRequestSchema = z.object({
  accountId: identifierSchema,
  threadId: identifierSchema,
  expectedWorkspaceRevision: z.number().int().positive(),
  expectedThreadRevision: z.number().int().positive().nullable(),
  idempotencyKey: identifierSchema,
  reason: z.string().trim().min(1).max(500),
}).strict();
export type OrcaThreadCorrectionRequest = z.infer<typeof orcaThreadCorrectionRequestSchema>;

export const orcaThreadCorrectionResponseSchema = z.object({
  eventId: identifierSchema,
  eventKind: z.literal("user.corrected"),
  workspaceId: identifierSchema,
  accountId: identifierSchema,
  threadId: identifierSchema,
  actor: z.object({ id: identifierSchema, type: z.enum(["human", "agent"]) }).strict(),
  reason: z.string().trim().min(1).max(500),
  trace: orcaEvaluationTraceSchema,
  changeSetId: identifierSchema.nullable(),
}).strict();
export type OrcaThreadCorrectionResponse = z.infer<typeof orcaThreadCorrectionResponseSchema>;
