import { z } from "zod";

import { facetFilterSchema } from "./organization-facets.ts";
import { organizationContextFilterSchema } from "./organization-contexts.ts";
import { humanClassificationReasonCodeSchema, humanClassificationSchema, humanSignalScoreSchema, mailProviderSchema } from "./schemas.ts";

const nonEmptyStringSchema = z.string().trim().min(1);
const identifierSchema = nonEmptyStringSchema.max(200);
const isoDateTimeSchema = z.string().datetime({ offset: false });
const uniqueIdentifiersSchema = z.array(identifierSchema).superRefine((values, context) => {
  if (new Set(values).size !== values.length) context.addIssue({ code: "custom", message: "Stable identifiers must be unique" });
});
const uniqueEmailsSchema = z.array(z.string().trim().email().max(320).transform((value) => value.toLocaleLowerCase())).superRefine((values, context) => {
  if (new Set(values).size !== values.length) context.addIssue({ code: "custom", message: "Sender addresses must be unique" });
});
const domainSchema = z.string().trim().toLowerCase().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i);
const uniqueDomainsSchema = z.array(domainSchema).superRefine((values, context) => {
  if (new Set(values).size !== values.length) context.addIssue({ code: "custom", message: "Sender domains must be unique" });
});

export const organizationViewBounds = Object.freeze({
  maximumResultsPerPage: 100,
  defaultResultsPerPage: 25,
  maximumPredicateItems: 50,
  maximumFacetFilters: 20,
  maximumContextFilters: 20,
});

export const organizationViewDefinitionSchema = z.object({
  revision: z.literal(1),
  accountIds: uniqueIdentifiersSchema.min(1).max(organizationViewBounds.maximumPredicateItems).optional(),
  laneIds: uniqueIdentifiersSchema.min(1).max(organizationViewBounds.maximumPredicateItems).optional(),
  facetFilters: z.array(facetFilterSchema).min(1).max(organizationViewBounds.maximumFacetFilters).optional(),
  contextFilters: z.array(organizationContextFilterSchema).min(1).max(organizationViewBounds.maximumContextFilters).optional(),
  workflowStateIds: uniqueIdentifiersSchema.min(1).max(organizationViewBounds.maximumPredicateItems).optional(),
  humanSignal: z.object({
    minimumScore: z.number().int().min(0).max(10).optional(),
    maximumScore: z.number().int().min(0).max(10).optional(),
    classifications: z.array(humanClassificationSchema).min(1).max(4).optional(),
    evidenceReasonCodes: z.array(humanClassificationReasonCodeSchema).min(1).max(12).optional(),
  }).strict().superRefine((value, context) => {
    if (value.minimumScore !== undefined && value.maximumScore !== undefined && value.minimumScore > value.maximumScore) {
      context.addIssue({ code: "custom", path: ["minimumScore"], message: "minimumScore must not exceed maximumScore" });
    }
  }).optional(),
  sender: z.object({
    addresses: uniqueEmailsSchema.min(1).max(organizationViewBounds.maximumPredicateItems).optional(),
    domains: uniqueDomainsSchema.min(1).max(organizationViewBounds.maximumPredicateItems).optional(),
  }).strict().refine((value) => value.addresses !== undefined || value.domains !== undefined, "Expected at least one sender predicate").optional(),
  date: z.object({
    receivedAfter: isoDateTimeSchema.optional(),
    receivedBefore: isoDateTimeSchema.optional(),
  }).strict().refine((value) => value.receivedAfter !== undefined || value.receivedBefore !== undefined, "Expected at least one date predicate").optional(),
  thread: z.object({
    ids: uniqueIdentifiersSchema.min(1).max(organizationViewBounds.maximumPredicateItems).optional(),
    subjectContains: nonEmptyStringSchema.max(200).optional(),
    readState: z.enum(["read", "unread"]).optional(),
  }).strict().refine((value) => value.ids !== undefined || value.subjectContains !== undefined || value.readState !== undefined, "Expected at least one Thread predicate").optional(),
}).strict().superRefine((value, context) => {
  if (value.date?.receivedAfter && value.date.receivedBefore && Date.parse(value.date.receivedAfter) > Date.parse(value.date.receivedBefore)) {
    context.addIssue({ code: "custom", path: ["date", "receivedAfter"], message: "receivedAfter must not be later than receivedBefore" });
  }
});
export type OrganizationViewDefinition = z.infer<typeof organizationViewDefinitionSchema>;

export const organizationViewSchema = z.object({
  id: identifierSchema,
  workspaceId: identifierSchema,
  name: nonEmptyStringSchema.max(120),
  description: z.string().trim().max(500),
  color: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/),
  position: z.number().int().nonnegative(),
  definition: organizationViewDefinitionSchema,
  revision: z.number().int().positive(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
}).strict();
export type OrganizationView = z.infer<typeof organizationViewSchema>;

export const organizationViewCreateRequestSchema = z.object({
  name: nonEmptyStringSchema.max(120),
  description: z.string().trim().max(500).default(""),
  color: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/).default("#0b9b84"),
  position: z.number().int().nonnegative().default(0),
  definition: organizationViewDefinitionSchema,
}).strict();
export type OrganizationViewCreateRequest = z.infer<typeof organizationViewCreateRequestSchema>;

export const organizationViewUpdateRequestSchema = z.object({
  expectedRevision: z.number().int().positive(),
  patch: z.object({
    name: nonEmptyStringSchema.max(120).optional(),
    description: z.string().trim().max(500).optional(),
    color: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    position: z.number().int().nonnegative().optional(),
    definition: organizationViewDefinitionSchema.optional(),
  }).strict().refine((value) => Object.keys(value).length > 0, "Expected at least one View field"),
}).strict();
export type OrganizationViewUpdateRequest = z.infer<typeof organizationViewUpdateRequestSchema>;

export const organizationViewListResponseSchema = z.object({
  workspaceId: identifierSchema,
  items: z.array(organizationViewSchema),
}).strict();
export type OrganizationViewListResponse = z.infer<typeof organizationViewListResponseSchema>;

export const organizationViewResultQuerySchema = z.object({
  limit: z.number().int().min(1).max(organizationViewBounds.maximumResultsPerPage).default(organizationViewBounds.defaultResultsPerPage),
  cursor: z.string().trim().min(1).max(2_048).optional(),
}).strict();
export type OrganizationViewResultQuery = z.infer<typeof organizationViewResultQuerySchema>;

export const organizationViewResultItemSchema = z.object({
  accountId: identifierSchema,
  accountEmail: nonEmptyStringSchema.max(320),
  provider: mailProviderSchema,
  threadId: identifierSchema,
  subject: z.string(),
  latestReceivedAt: isoDateTimeSchema,
  messageCount: z.number().int().nonnegative(),
  readState: z.enum(["read", "unread", "mixed"]),
  primaryLaneId: identifierSchema,
  sender: z.object({ name: z.string().nullable(), email: z.string() }).strict(),
  humanSignal: humanSignalScoreSchema,
  humanClassification: humanClassificationSchema.nullable(),
}).strict();
export type OrganizationViewResultItem = z.infer<typeof organizationViewResultItemSchema>;

export const organizationViewResultPageSchema = z.object({
  viewId: identifierSchema,
  viewRevision: z.number().int().positive(),
  accountIds: uniqueIdentifiersSchema,
  items: z.array(organizationViewResultItemSchema).max(organizationViewBounds.maximumResultsPerPage),
  nextCursor: z.string().max(2_048).nullable(),
  limit: z.number().int().min(1).max(organizationViewBounds.maximumResultsPerPage),
}).strict();
export type OrganizationViewResultPage = z.infer<typeof organizationViewResultPageSchema>;
