import { z } from "zod";

import { organizationActorSchema } from "./organization-contract.ts";

const identifierSchema = z.string().trim().min(1).max(200);
const nonEmptyStringSchema = z.string().trim().min(1).max(500);
const positionSchema = z.number().int().nonnegative();
const revisionSchema = z.number().int().positive();
const retiredAtSchema = z.string().datetime({ offset: true }).nullable();

export const laneVisibilitySchema = z.enum(["prominent", "standard", "muted"]);
export const laneInterruptionSchema = z.enum(["notify", "badge", "quiet"]);
export const laneReviewSchema = z.enum(["continuous", "daily", "weekly", "manual"]);
export const laneRetentionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("keep"), days: z.null() }).strict(),
  z.object({ mode: z.literal("review_after"), days: z.number().int().min(1).max(3_650) }).strict(),
]);

/** Defaults only. Provider deletion is deliberately impossible in this contract. */
export const lanePolicySchema = z.object({
  id: identifierSchema,
  visibility: laneVisibilitySchema,
  interruption: laneInterruptionSchema,
  review: laneReviewSchema,
  retention: laneRetentionSchema,
  providerDeletion: z.literal(false),
  revision: revisionSchema,
}).strict();
export type LanePolicy = z.infer<typeof lanePolicySchema>;

/** Stable Lane identity. Name, order, lifecycle, and default Policy may change independently. */
export const laneSchema = z.object({
  id: identifierSchema,
  name: nonEmptyStringSchema.max(120),
  position: positionSchema,
  defaultPolicyId: identifierSchema,
  retiredAt: retiredAtSchema,
  revision: revisionSchema,
}).strict();
export type Lane = z.infer<typeof laneSchema>;

export const organizationLaneConfigurationSchema = z.object({
  workspaceRevision: revisionSchema,
  fallbackLaneId: identifierSchema,
  lanes: z.array(laneSchema),
  policies: z.array(lanePolicySchema),
}).strict().superRefine((configuration, context) => {
  const policies = new Set(configuration.policies.map((policy) => policy.id));
  const lanes = new Map(configuration.lanes.map((lane) => [lane.id, lane]));
  if (!lanes.has(configuration.fallbackLaneId)) {
    context.addIssue({ code: "custom", path: ["fallbackLaneId"], message: "Fallback Lane must resolve to a Lane" });
  } else if (lanes.get(configuration.fallbackLaneId)?.retiredAt !== null) {
    context.addIssue({ code: "custom", path: ["fallbackLaneId"], message: "Fallback Lane cannot be retired" });
  }
  for (const [index, lane] of configuration.lanes.entries()) {
    if (!policies.has(lane.defaultPolicyId)) {
      context.addIssue({ code: "custom", path: ["lanes", index, "defaultPolicyId"], message: "Lane default Policy must resolve" });
    }
  }
});
export type OrganizationLaneConfiguration = z.infer<typeof organizationLaneConfigurationSchema>;

export const lanePlacementSourceSchema = z.enum([
  "safety_lock",
  "manual_override",
  "rule_revision",
  "lane_policy",
  "workspace_fallback",
]);
export const lanePrecedenceLevelSchema = z.enum([
  "1_safety_lock",
  "2_manual_override",
  "3_rule_revision",
  "4_lane_policy",
  "5_workspace_fallback",
]);

export const threadLanePlacementEvidenceSchema = z.object({
  winningSource: lanePlacementSourceSchema,
  sourceId: identifierSchema,
  precedenceLevel: lanePrecedenceLevelSchema,
  actor: organizationActorSchema,
  reason: nonEmptyStringSchema,
}).strict();
export type ThreadLanePlacementEvidence = z.infer<typeof threadLanePlacementEvidenceSchema>;

const placementDecisionSchema = z.object({
  laneId: identifierSchema,
  actor: organizationActorSchema,
  reason: nonEmptyStringSchema,
  updatedAt: z.string().datetime({ offset: true }),
}).strict();

export const threadLanePlacementSchema = z.object({
  accountId: identifierSchema,
  threadId: identifierSchema,
  primaryLaneId: identifierSchema,
  manualOverride: placementDecisionSchema.nullable(),
  safetyLock: z.object({
    locked: z.boolean(),
    actor: organizationActorSchema.nullable(),
    reason: nonEmptyStringSchema.nullable(),
    updatedAt: z.string().datetime({ offset: true }).nullable(),
  }).strict(),
  evidence: threadLanePlacementEvidenceSchema,
  revision: revisionSchema.nullable(),
}).strict();
export type ThreadLanePlacement = z.infer<typeof threadLanePlacementSchema>;

const defineLanePolicyActionSchema = z.object({
  kind: z.literal("define_lane_policy"),
  id: identifierSchema,
  visibility: laneVisibilitySchema,
  interruption: laneInterruptionSchema,
  review: laneReviewSchema,
  retention: laneRetentionSchema,
}).strict();

const updateLanePolicyActionSchema = z.object({
  kind: z.literal("update_lane_policy"),
  policyId: identifierSchema,
  visibility: laneVisibilitySchema.optional(),
  interruption: laneInterruptionSchema.optional(),
  review: laneReviewSchema.optional(),
  retention: laneRetentionSchema.optional(),
  expectedRevision: revisionSchema,
}).strict().superRefine((action, context) => {
  if (action.visibility === undefined && action.interruption === undefined && action.review === undefined && action.retention === undefined) {
    context.addIssue({ code: "custom", message: "A Lane Policy update must change at least one default" });
  }
});

const defineLaneActionSchema = z.object({
  kind: z.literal("define_lane"),
  id: identifierSchema,
  name: nonEmptyStringSchema.max(120),
  position: positionSchema,
  defaultPolicyId: identifierSchema,
}).strict();

const updateLaneActionSchema = z.object({
  kind: z.literal("update_lane"),
  laneId: identifierSchema,
  name: nonEmptyStringSchema.max(120).optional(),
  position: positionSchema.optional(),
  defaultPolicyId: identifierSchema.optional(),
  retired: z.boolean().optional(),
  expectedRevision: revisionSchema,
}).strict().superRefine((action, context) => {
  if (action.name === undefined && action.position === undefined && action.defaultPolicyId === undefined && action.retired === undefined) {
    context.addIssue({ code: "custom", message: "A Lane update must rename, reorder, change Policy, or change retirement" });
  }
});

const setFallbackLaneActionSchema = z.object({
  kind: z.literal("set_fallback_lane"),
  laneId: identifierSchema,
}).strict();

const setThreadManualOverrideActionSchema = z.object({
  kind: z.literal("set_thread_manual_override"),
  accountId: identifierSchema,
  threadId: identifierSchema,
  laneId: identifierSchema.nullable(),
  reason: nonEmptyStringSchema,
  expectedThreadRevision: revisionSchema.nullable(),
}).strict();

const setThreadSafetyLockActionSchema = z.object({
  kind: z.literal("set_thread_safety_lock"),
  accountId: identifierSchema,
  threadId: identifierSchema,
  locked: z.boolean(),
  reason: nonEmptyStringSchema,
  expectedThreadRevision: revisionSchema.nullable(),
}).strict();

export const organizationLaneActionSchema = z.discriminatedUnion("kind", [
  defineLanePolicyActionSchema,
  updateLanePolicyActionSchema,
  defineLaneActionSchema,
  updateLaneActionSchema,
  setFallbackLaneActionSchema,
  setThreadManualOverrideActionSchema,
  setThreadSafetyLockActionSchema,
]);
export type OrganizationLaneAction = z.infer<typeof organizationLaneActionSchema>;

export const organizationLaneApplySchema = z.object({
  id: identifierSchema,
  idempotencyKey: nonEmptyStringSchema.max(200),
  expectedWorkspaceRevision: revisionSchema,
  actions: z.array(organizationLaneActionSchema).min(1).max(100),
}).strict();
export type OrganizationLaneApply = z.infer<typeof organizationLaneApplySchema>;

export const organizationLaneApplyResponseSchema = z.object({
  changeSetId: identifierSchema,
  workspaceId: identifierSchema,
  workspaceRevision: revisionSchema,
  appliedActions: z.number().int().positive(),
  laneConfiguration: organizationLaneConfigurationSchema,
  placements: z.array(threadLanePlacementSchema),
}).strict();
export type OrganizationLaneApplyResponse = z.infer<typeof organizationLaneApplyResponseSchema>;
