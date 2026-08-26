import { z } from "zod";

import { orcaRuleRiskSchema } from "./orca-language.ts";

const identifierSchema = z.string().trim().min(1).max(200);
const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const accountIdsSchema = z.array(identifierSchema).min(1).max(20).superRefine((values, context) => {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", message: "Account IDs must be unique" });
  }
});

export const orcaHistoricalSimulationRequestSchema = z.object({
  ruleId: identifierSchema,
  revisionId: identifierSchema,
  workspaceSchemaRevision: z.number().int().positive(),
  accountIds: accountIdsSchema,
  maximumThreads: z.number().int().min(1).max(5_000),
}).strict();
export type OrcaHistoricalSimulationRequest = z.infer<typeof orcaHistoricalSimulationRequestSchema>;

const nullableScalarSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);

export const orcaHistoricalSimulationResponseSchema = z.object({
  simulationId: digestSchema,
  state: z.enum(["simulated", "conflicted"]),
  binding: z.object({
    ruleId: identifierSchema,
    revisionId: identifierSchema,
    ruleRevision: z.number().int().positive(),
    sourceDigest: digestSchema,
    workspaceSchemaRevision: z.number().int().positive(),
    workspaceRevision: z.number().int().positive(),
    ruleSetRevision: z.number().int().positive(),
  }).strict(),
  scope: z.object({
    accountIds: accountIdsSchema,
    maximumThreads: z.number().int().min(1).max(5_000),
  }).strict(),
  counts: z.object({
    evaluatedThreads: z.number().int().nonnegative(),
    affectedThreads: z.number().int().nonnegative(),
    candidateActions: z.number().int().nonnegative(),
    conflicts: z.number().int().nonnegative(),
  }).strict(),
  laneChanges: z.array(z.object({
    fromLaneId: identifierSchema,
    toLaneId: identifierSchema,
    count: z.number().int().positive(),
  }).strict()).max(5_000),
  facetChanges: z.array(z.object({
    facetId: identifierSchema,
    operation: z.enum(["set", "unset"]),
    count: z.number().int().positive(),
  }).strict()).max(5_000),
  representativeThreads: z.array(z.object({
    accountId: identifierSchema,
    threadId: identifierSchema,
    subject: z.string().max(10_000),
    lane: z.object({ before: identifierSchema, after: identifierSchema }).strict().nullable(),
    facets: z.array(z.object({
      facetId: identifierSchema,
      before: nullableScalarSchema,
      after: nullableScalarSchema,
    }).strict()).max(100),
    conflictCount: z.number().int().nonnegative(),
    traceId: identifierSchema,
  }).strict()).max(20),
  conflicts: z.array(z.object({
    accountId: identifierSchema,
    threadId: identifierSchema,
    slot: identifierSchema,
    winningCandidateId: identifierSchema,
    losingCandidateIds: z.array(identifierSchema).min(1).max(100),
  }).strict()).max(5_000),
  losingRules: z.array(z.object({
    ruleId: identifierSchema,
    revisionId: identifierSchema,
    losses: z.number().int().positive(),
  }).strict()).max(5_000),
  risk: orcaRuleRiskSchema,
  attentionImpact: z.object({
    notifications: z.number().int().nonnegative(),
    interruptionsSuppressed: z.number().int().nonnegative(),
    estimatedMinutesSaved: z.number().int().nonnegative(),
  }).strict(),
}).strict();
export type OrcaHistoricalSimulationResponse = z.infer<typeof orcaHistoricalSimulationResponseSchema>;

export const orcaRuleActivationRequestSchema = z.object({
  ruleId: identifierSchema,
  revisionId: identifierSchema,
  simulationId: digestSchema,
  accountIds: accountIdsSchema,
  maximumThreads: z.number().int().min(1).max(5_000),
  expectedWorkspaceRevision: z.number().int().positive(),
  expectedRuleRevision: z.number().int().positive(),
  expectedRuleSetRevision: z.number().int().positive(),
  idempotencyKey: identifierSchema,
}).strict();
export type OrcaRuleActivationRequest = z.infer<typeof orcaRuleActivationRequestSchema>;

export const orcaRuleRevertRequestSchema = z.object({
  changeSetId: identifierSchema,
  accountIds: accountIdsSchema,
  expectedWorkspaceRevision: z.number().int().positive(),
  idempotencyKey: identifierSchema,
}).strict();
export type OrcaRuleRevertRequest = z.infer<typeof orcaRuleRevertRequestSchema>;
