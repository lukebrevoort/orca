import { z } from "zod";
import { pinFilterSchema, type PinFilter } from "./schemas.ts";

const nonEmptyStringSchema = z.string().trim().min(1);
const isoDateTimeSchema = z.string().datetime({ offset: false });
const uniqueStringsSchema = z.array(nonEmptyStringSchema).superRefine((values, context) => {
  if (new Set(values).size !== values.length) context.addIssue({ code: "custom", message: "Values must be unique" });
});

export const organizationCollectionPinScopeSchema = z.object({
  actor: z.object({ id: nonEmptyStringSchema, type: z.enum(["human", "agent", "system"]) }).strict(),
  workspaceId: nonEmptyStringSchema,
  accountIds: uniqueStringsSchema,
}).strict();
export type OrganizationCollectionPinScope = z.infer<typeof organizationCollectionPinScopeSchema>;

export const organizationPinResourceFamilySchema = z.enum(["thread", "view", "collection", "sender"]);
const organizationPinResourceIdentitySchema = z.discriminatedUnion("family", [
  z.object({ family: z.literal("thread"), id: nonEmptyStringSchema }).strict(),
  z.object({ family: z.literal("view"), id: z.enum(["inbox", "focus", "quiet", "hidden", "all"]) }).strict(),
  z.object({ family: z.literal("collection"), id: nonEmptyStringSchema }).strict(),
  z.object({ family: z.literal("sender"), id: z.string().trim().email().max(320) }).strict(),
]);
export const organizationPinTargetSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("resource"),
    resource: organizationPinResourceIdentitySchema,
  }).strict(),
  z.object({ type: z.literal("query"), queryId: nonEmptyStringSchema }).strict(),
]);
export type OrganizationPinTarget = z.infer<typeof organizationPinTargetSchema>;

export const organizationSavedQueryDefinitionSchema = z.object({
  revision: z.literal(1),
  filters: z.object({
    mailbox: z.enum(["inbox", "focus", "quiet", "hidden", "all"]).optional(),
    attention: z.enum(["all", "notify", "focus", "normal"]).optional(),
    classification: z.enum(["human", "tideline", "uncertain", "all"]).optional(),
    text: z.string().trim().min(1).max(200).optional(),
    sender: z.string().trim().min(1).max(320).optional(),
  }).strict().superRefine((filters, context) => {
    if ((filters.mailbox === undefined) !== (filters.attention === undefined)) {
      context.addIssue({ code: "custom", message: "Mailbox and attention must be provided together" });
    }
  }).transform((filters) => {
    if (filters.mailbox !== "inbox" || filters.attention !== "all") return filters;
    const canonical = { ...filters };
    delete canonical.mailbox;
    delete canonical.attention;
    return canonical;
  }),
}).strict();
export type OrganizationSavedQueryDefinition = z.infer<typeof organizationSavedQueryDefinitionSchema>;

export function organizationSavedQueryDefinitionFromLegacyPinFilter(input: unknown): OrganizationSavedQueryDefinition {
  const legacy = pinFilterSchema.parse(input);
  const isDefaultSelection = legacy.mailbox === "inbox" && legacy.attention === "all";
  return organizationSavedQueryDefinitionSchema.parse({
    revision: 1,
    filters: {
      ...(!isDefaultSelection ? { mailbox: legacy.mailbox, attention: legacy.attention } : {}),
      ...(legacy.classification ? { classification: legacy.classification } : {}),
      ...(legacy.person ? { sender: legacy.person } : {}),
      ...(legacy.query ? { text: legacy.query } : {}),
    },
  });
}

export function legacyPinFilterFromOrganizationSavedQueryDefinition(
  definition: OrganizationSavedQueryDefinition,
): PinFilter {
  const parsed = organizationSavedQueryDefinitionSchema.parse(definition);
  const mailbox = parsed.filters.mailbox;
  const attention = parsed.filters.attention;
  return pinFilterSchema.parse({
    mailbox: mailbox ?? "inbox",
    attention: attention ?? "all",
    ...(parsed.filters.classification ? { classification: parsed.filters.classification } : {}),
    person: parsed.filters.sender ?? null,
    query: parsed.filters.text ?? "",
  });
}

export const organizationSavedQuerySchema = z.object({
  id: nonEmptyStringSchema,
  accountId: nonEmptyStringSchema,
  name: z.string().trim().min(1).max(120),
  definition: organizationSavedQueryDefinitionSchema,
  revision: z.number().int().positive(),
}).strict();
export type OrganizationSavedQuery = z.infer<typeof organizationSavedQuerySchema>;

export const organizationCollectionSchema = z.object({
  id: nonEmptyStringSchema,
  accountId: nonEmptyStringSchema,
  name: z.string().trim().min(1).max(80),
  color: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/),
  position: z.number().int().nonnegative(),
  threadIds: uniqueStringsSchema,
  revision: z.number().int().positive(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
}).strict();
export type OrganizationCollection = z.infer<typeof organizationCollectionSchema>;

export const organizationPinSchema = z.object({
  id: nonEmptyStringSchema,
  accountId: nonEmptyStringSchema,
  label: z.string().trim().min(1).max(120),
  icon: z.enum(["person", "thread", "search", "grid", "star", "bolt", "heart", "bookmark"]),
  color: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/),
  position: z.number().int().nonnegative(),
  target: organizationPinTargetSchema,
  revision: z.number().int().positive(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
}).strict();
export type OrganizationPin = z.infer<typeof organizationPinSchema>;

export const organizationCollectionPinQuerySchema = z.object({
  accountIds: uniqueStringsSchema.min(1).optional(),
  collectionId: nonEmptyStringSchema.optional(),
  threadId: nonEmptyStringSchema.optional(),
}).strict();
export type OrganizationCollectionPinQuery = z.infer<typeof organizationCollectionPinQuerySchema>;

export const organizationCollectionPinQueryResponseSchema = z.object({
  workspaceId: nonEmptyStringSchema,
  accountIds: uniqueStringsSchema,
  collections: z.array(organizationCollectionSchema),
  pins: z.array(organizationPinSchema),
  queries: z.array(organizationSavedQuerySchema),
}).strict();
export type OrganizationCollectionPinQueryResponse = z.infer<typeof organizationCollectionPinQueryResponseSchema>;

const collectionMembershipChangeSchema = z.object({
  kind: z.literal("collection_membership"),
  action: z.enum(["add", "remove"]),
  accountId: nonEmptyStringSchema,
  collectionId: nonEmptyStringSchema,
  threadId: nonEmptyStringSchema,
}).strict();
const collectionChangeSchema = z.discriminatedUnion("action", [
  z.object({
    kind: z.literal("collection"), action: z.literal("create"), accountId: nonEmptyStringSchema,
    collection: z.object({ name: z.string().trim().min(1).max(80), color: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/) }).strict(),
  }).strict(),
  z.object({
    kind: z.literal("collection"), action: z.literal("update"), accountId: nonEmptyStringSchema, collectionId: nonEmptyStringSchema,
    patch: z.object({
      name: z.string().trim().min(1).max(80).optional(),
      color: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      position: z.number().int().nonnegative().optional(),
    }).strict().refine((value) => Object.keys(value).length > 0, "Expected at least one Collection field"),
  }).strict(),
  z.object({ kind: z.literal("collection"), action: z.literal("remove"), accountId: nonEmptyStringSchema, collectionId: nonEmptyStringSchema }).strict(),
]);
const organizationPinCreateTargetSchema = z.union([
  organizationPinTargetSchema,
  z.object({
    type: z.literal("new_query"),
    name: z.string().trim().min(1).max(120),
    definition: organizationSavedQueryDefinitionSchema,
  }).strict(),
]);
const pinChangeSchema = z.discriminatedUnion("action", [
  z.object({
    kind: z.literal("pin"), action: z.literal("create"), accountId: nonEmptyStringSchema,
    pin: z.object({
      label: z.string().trim().min(1).max(120),
      icon: z.enum(["person", "thread", "search", "grid", "star", "bolt", "heart", "bookmark"]),
      color: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/),
      target: organizationPinCreateTargetSchema,
    }).strict(),
  }).strict(),
  z.object({
    kind: z.literal("pin"), action: z.literal("update"), accountId: nonEmptyStringSchema, pinId: nonEmptyStringSchema,
    patch: z.object({
      label: z.string().trim().min(1).max(120).optional(),
      icon: z.enum(["person", "thread", "search", "grid", "star", "bolt", "heart", "bookmark"]).optional(),
      color: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      position: z.number().int().nonnegative().optional(),
    }).strict().refine((value) => Object.keys(value).length > 0, "Expected at least one Pin field"),
  }).strict(),
  z.object({ kind: z.literal("pin"), action: z.literal("remove"), accountId: nonEmptyStringSchema, pinId: nonEmptyStringSchema }).strict(),
]);
const savedQueryChangeSchema = z.discriminatedUnion("action", [
  z.object({
    kind: z.literal("saved_query"), action: z.literal("create"), accountId: nonEmptyStringSchema,
    query: z.object({ name: z.string().trim().min(1).max(120), definition: organizationSavedQueryDefinitionSchema }).strict(),
  }).strict(),
  z.object({ kind: z.literal("saved_query"), action: z.literal("remove"), accountId: nonEmptyStringSchema, queryId: nonEmptyStringSchema }).strict(),
]);

export const organizationCollectionPinChangeSchema = z.union([
  collectionMembershipChangeSchema,
  collectionChangeSchema,
  pinChangeSchema,
  savedQueryChangeSchema,
]);
export type OrganizationCollectionPinChange = z.infer<typeof organizationCollectionPinChangeSchema>;

export const organizationCollectionPinApplyRequestSchema = z.object({
  idempotencyKey: nonEmptyStringSchema.max(200),
  change: organizationCollectionPinChangeSchema,
}).strict();
export type OrganizationCollectionPinApplyRequest = z.infer<typeof organizationCollectionPinApplyRequestSchema>;

export const organizationCollectionPinRevertRequestSchema = z.object({
  idempotencyKey: nonEmptyStringSchema.max(200),
  changeId: nonEmptyStringSchema,
}).strict();
export type OrganizationCollectionPinRevertRequest = z.infer<typeof organizationCollectionPinRevertRequestSchema>;

export const organizationCollectionPinAuditEntrySchema = z.object({
  id: nonEmptyStringSchema,
  workspaceId: nonEmptyStringSchema,
  accountId: nonEmptyStringSchema,
  actor: z.object({ id: nonEmptyStringSchema, type: z.enum(["human", "agent", "system"]) }).strict(),
  operation: z.enum(["apply", "revert"]),
  changeKind: z.enum(["collection", "collection_membership", "pin", "saved_query"]),
  resourceId: nonEmptyStringSchema,
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  reason: nonEmptyStringSchema,
  revertsChangeId: nonEmptyStringSchema.nullable(),
  revertedByChangeId: nonEmptyStringSchema.nullable(),
  createdAt: isoDateTimeSchema,
}).strict();
export type OrganizationCollectionPinAuditEntry = z.infer<typeof organizationCollectionPinAuditEntrySchema>;

export const organizationCollectionPinMutationResponseSchema = z.object({
  change: organizationCollectionPinAuditEntrySchema,
  state: organizationCollectionPinQueryResponseSchema,
}).strict();
export type OrganizationCollectionPinMutationResponse = z.infer<typeof organizationCollectionPinMutationResponseSchema>;

export const organizationCollectionPinDescribeResponseSchema = z.object({
  workspaceId: nonEmptyStringSchema,
  accountIds: uniqueStringsSchema,
  semantics: z.object({ collections: z.literal("explicit_thread_membership"), pins: z.literal("stable_shortcut_identity") }).strict(),
  operations: z.object({ describe: z.literal(true), query: z.literal(true), apply: z.literal(true), revert: z.literal(true), simulate: z.literal(false) }).strict(),
  authority: z.object({ sendMail: z.literal(false), deleteProviderMail: z.literal(false) }).strict(),
}).strict();
export type OrganizationCollectionPinDescribeResponse = z.infer<typeof organizationCollectionPinDescribeResponseSchema>;
