import { z } from "zod";
import { attentionBehaviorSchema, senderAttentionRuleSchema } from "./schemas.ts";

const id = z.string().trim().min(1).max(256);
const address = z.string().trim().email().max(320).transform(value => value.toLowerCase());
export const attentionRoutingTargetSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("account") }).strict(),
  z.object({ scope: z.literal("sender"), address }).strict(),
  z.object({ scope: z.literal("conversation"), threadId: id }).strict(),
]);
export const attentionRoutingQuerySchema = z.object({ accountId: id, address: address.optional(), threadId: id.optional() }).strict();
export const attentionRoutingChangeSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  target: attentionRoutingTargetSchema,
  // Advanced values are accepted for exact sender undo/legacy interoperability;
  // account and conversation choices remain Inbox/Quiet only.
  behavior: attentionBehaviorSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.target.scope !== "sender" && value.behavior !== null && !["normal", "quiet"].includes(value.behavior))
    context.addIssue({ code: "custom", path: ["behavior"], message: "Choose normal (Inbox), quiet, or null (inherit)." });
});
export const attentionRoutingResolutionSchema = z.object({
  behavior: attentionBehaviorSchema,
  destination: z.enum(["inbox", "quiet"]).nullable(),
  source: z.enum(["conversation", "sender", "domain", "account", "fallback"]),
  rule: senderAttentionRuleSchema.nullable(),
}).strict();
export const attentionRoutingStateSchema = z.object({
  accountId: id,
  revision: z.number().int().nonnegative(),
  defaultBehavior: z.enum(["normal", "quiet"]).nullable(),
  senders: z.array(senderAttentionRuleSchema),
  selection: z.object({
    target: attentionRoutingTargetSchema,
    explicitBehavior: attentionBehaviorSchema.nullable(),
    effective: attentionRoutingResolutionSchema,
    inherited: attentionRoutingResolutionSchema,
  }).strict(),
}).strict();
export const attentionRoutingResultSchema = z.object({
  state: attentionRoutingStateSchema,
  undo: attentionRoutingChangeSchema,
}).strict();
export type AttentionRoutingTarget = z.infer<typeof attentionRoutingTargetSchema>;
export type AttentionRoutingChange = z.infer<typeof attentionRoutingChangeSchema>;
export type AttentionRoutingResolution = z.infer<typeof attentionRoutingResolutionSchema>;
export type AttentionRoutingState = z.infer<typeof attentionRoutingStateSchema>;

export const attentionSenderLookupQuerySchema = z.object({
  accountId: id,
  query: z.string().trim().max(200).default(""),
}).strict();
export const attentionSenderLookupResultSchema = z.object({
  accountId: id,
  candidates: z.array(z.object({ address, name: z.string().nullable() }).strict()).max(30),
  truncated: z.boolean(),
}).strict();
