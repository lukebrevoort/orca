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
  }).strict().refine((value) => Object.values(value).some((predicate) => predicate !== undefined), "Expected at least one Human Signal predicate").superRefine((value, context) => {
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

export const organizationViewDefinitionKindSchema = z.enum(["match_all", "filtered"]);
export type OrganizationViewDefinitionKind = z.infer<typeof organizationViewDefinitionKindSchema>;

export function organizationViewDefinitionKind(definition: OrganizationViewDefinition): OrganizationViewDefinitionKind {
  return Object.keys(definition).some((key) => key !== "revision") ? "filtered" : "match_all";
}

export const organizationViewUnsupportedClauseSchema = z.object({
  id: identifierSchema,
  label: nonEmptyStringSchema.max(120),
  reason: nonEmptyStringSchema.max(500),
}).strict();
export type OrganizationViewUnsupportedClause = z.infer<typeof organizationViewUnsupportedClauseSchema>;

export const organizationViewDraftSourceSchema = z.object({
  kind: z.enum(["manual", "search", "sender_selection", "saved_view"]),
  label: nonEmptyStringSchema.max(120),
  returnTarget: z.string().trim().min(1).max(2_048).optional(),
}).strict();
export type OrganizationViewDraftSource = z.infer<typeof organizationViewDraftSourceSchema>;

const organizationViewDraftIdentitySchema = z.object({
  name: nonEmptyStringSchema.max(120),
  description: z.string().trim().max(500).default(""),
  color: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/).default("#0b9b84"),
  position: z.number().int().nonnegative().default(0),
}).strict();

export const organizationViewSelectedMessageReferenceSchema = z.object({
  accountId: identifierSchema,
  threadId: identifierSchema,
  messageId: identifierSchema,
}).strict();
export type OrganizationViewSelectedMessageReference = z.infer<typeof organizationViewSelectedMessageReferenceSchema>;

const uniqueSelectedMessageReferencesSchema = z.array(organizationViewSelectedMessageReferenceSchema)
  .min(1)
  .max(organizationViewBounds.maximumPredicateItems)
  .superRefine((references, context) => {
    const identities = references.map((reference) => JSON.stringify([reference.accountId, reference.threadId, reference.messageId]));
    if (new Set(identities).size !== identities.length) context.addIssue({ code: "custom", message: "Selected message references must be unique" });
  });

export const organizationViewPreparationInputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("typed_definition"),
    source: organizationViewDraftSourceSchema.omit({ kind: true }).extend({
      kind: z.enum(["manual", "search", "sender_selection"]),
    }).strict(),
    identity: organizationViewDraftIdentitySchema,
    definition: organizationViewDefinitionSchema,
    unsupportedClauses: z.array(organizationViewUnsupportedClauseSchema).max(20).default([]),
  }).strict(),
  z.object({
    kind: z.literal("saved_view"),
    viewId: identifierSchema,
  }).strict(),
  z.object({
    kind: z.literal("selected_senders"),
    source: organizationViewDraftSourceSchema.omit({ kind: true }).extend({
      kind: z.literal("sender_selection"),
    }).strict(),
    identity: organizationViewDraftIdentitySchema,
    references: uniqueSelectedMessageReferencesSchema,
  }).strict(),
]);
export type OrganizationViewPreparationInput = z.infer<typeof organizationViewPreparationInputSchema>;

export const organizationViewDraftInputSchema = z.object({
  mode: z.enum(["create", "update"]),
  viewId: identifierSchema.nullable(),
  source: organizationViewDraftSourceSchema,
  identity: organizationViewDraftIdentitySchema,
  definition: organizationViewDefinitionSchema,
  unsupportedClauses: z.array(organizationViewUnsupportedClauseSchema).max(20),
}).strict().superRefine((value, context) => {
  if ((value.mode === "create") !== (value.viewId === null)) {
    context.addIssue({ code: "custom", path: ["viewId"], message: "Create drafts omit a View ID; update drafts require one" });
  }
});
export type OrganizationViewDraftInput = z.infer<typeof organizationViewDraftInputSchema>;

export const organizationViewDefinitionSummarySchema = z.object({
  text: nonEmptyStringSchema.max(2_000),
  clauses: z.array(nonEmptyStringSchema.max(500)).max(20),
}).strict();
export type OrganizationViewDefinitionSummary = z.infer<typeof organizationViewDefinitionSummarySchema>;

export const organizationViewSaveEligibilitySchema = z.object({
  allowed: z.boolean(),
  code: z.enum(["blank_definition", "unsupported_clauses"]).nullable(),
  detail: nonEmptyStringSchema.max(500),
}).strict();
export type OrganizationViewSaveEligibility = z.infer<typeof organizationViewSaveEligibilitySchema>;

export const organizationViewReviewedDraftSchema = organizationViewDraftInputSchema.extend({
  definitionDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  definitionKind: organizationViewDefinitionKindSchema,
  effectiveAccountIds: uniqueIdentifiersSchema.min(1),
  summary: organizationViewDefinitionSummarySchema,
  saveEligibility: organizationViewSaveEligibilitySchema,
}).strict();
export type OrganizationViewReviewedDraft = z.infer<typeof organizationViewReviewedDraftSchema>;

export const organizationViewPrepareResponseSchema = z.object({
  workspaceId: identifierSchema,
  workspaceRevision: z.number().int().positive(),
  draft: organizationViewReviewedDraftSchema,
}).strict();
export type OrganizationViewPrepareResponse = z.infer<typeof organizationViewPrepareResponseSchema>;

export const organizationViewPreviewRequestSchema = z.object({
  draft: organizationViewDraftInputSchema,
  page: z.object({
    limit: z.number().int().min(1).max(organizationViewBounds.maximumResultsPerPage).default(organizationViewBounds.defaultResultsPerPage),
    cursor: z.string().min(1).max(2_048).optional(),
  }).strict().default({ limit: organizationViewBounds.defaultResultsPerPage }),
}).strict();
export type OrganizationViewPreviewRequest = z.infer<typeof organizationViewPreviewRequestSchema>;

export const organizationViewResultCountSchema = z.object({
  kind: z.enum(["shown", "exact"]),
  value: z.number().int().nonnegative(),
}).strict();
export type OrganizationViewResultCount = z.infer<typeof organizationViewResultCountSchema>;

export const organizationViewResultProvenanceSchema = z.object({
  source: z.literal("stored_mail"),
  definitionDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  authorizedScopeDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  evaluatedAt: isoDateTimeSchema,
}).strict();
export type OrganizationViewResultProvenance = z.infer<typeof organizationViewResultProvenanceSchema>;

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
  idempotencyKey: identifierSchema,
  expectedWorkspaceRevision: z.number().int().positive(),
  name: nonEmptyStringSchema.max(120),
  description: z.string().trim().max(500).default(""),
  color: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/).default("#0b9b84"),
  position: z.number().int().nonnegative().default(0),
  definition: organizationViewDefinitionSchema,
}).strict();
export type OrganizationViewCreateRequest = z.infer<typeof organizationViewCreateRequestSchema>;

export const organizationViewUpdateRequestSchema = z.object({
  idempotencyKey: identifierSchema,
  expectedWorkspaceRevision: z.number().int().positive(),
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

export const organizationViewReorderRequestSchema = z.object({
  idempotencyKey: identifierSchema,
  expectedWorkspaceRevision: z.number().int().positive(),
  items: z.array(z.object({
    id: identifierSchema,
    expectedRevision: z.number().int().positive(),
    position: z.number().int().nonnegative(),
  }).strict()).min(2),
}).strict().superRefine((value, context) => {
  const ids = value.items.map((item) => item.id);
  const positions = value.items.map((item) => item.position);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", path: ["items"], message: "View identifiers must be unique" });
  if (new Set(positions).size !== positions.length) context.addIssue({ code: "custom", path: ["items"], message: "View positions must be unique" });
});
export type OrganizationViewReorderRequest = z.infer<typeof organizationViewReorderRequestSchema>;

export const organizationViewRemoveRequestSchema = z.object({
  idempotencyKey: identifierSchema,
  expectedWorkspaceRevision: z.number().int().positive(),
  expectedRevision: z.number().int().positive(),
}).strict();
export type OrganizationViewRemoveRequest = z.infer<typeof organizationViewRemoveRequestSchema>;

export const organizationViewListResponseSchema = z.object({
  workspaceId: identifierSchema,
  workspaceRevision: z.number().int().positive(),
  items: z.array(organizationViewSchema),
}).strict();
export type OrganizationViewListResponse = z.infer<typeof organizationViewListResponseSchema>;

export const organizationViewResultQuerySchema = z.object({
  limit: z.number().int().min(1).max(organizationViewBounds.maximumResultsPerPage).default(organizationViewBounds.defaultResultsPerPage),
  cursor: z.string().min(1).max(2_048).optional(),
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

export const organizationViewPreviewResponseSchema = z.object({
  workspaceId: identifierSchema,
  workspaceRevision: z.number().int().positive(),
  draft: organizationViewReviewedDraftSchema,
  results: z.object({
    accountIds: uniqueIdentifiersSchema.min(1),
    items: z.array(organizationViewResultItemSchema).max(organizationViewBounds.maximumResultsPerPage),
    nextCursor: z.string().max(2_048).nullable(),
    limit: z.number().int().min(1).max(organizationViewBounds.maximumResultsPerPage),
    count: organizationViewResultCountSchema,
    state: z.enum(["matches", "zero"]),
    provenance: organizationViewResultProvenanceSchema,
  }).strict(),
}).strict();
export type OrganizationViewPreviewResponse = z.infer<typeof organizationViewPreviewResponseSchema>;

export const organizationViewCommitRequestSchema = z.object({
  draft: organizationViewReviewedDraftSchema,
  expectedRevisions: z.object({
    workspace: z.number().int().positive(),
    view: z.number().int().positive().nullable(),
  }).strict(),
  retryKey: identifierSchema,
  confirmedZeroMatchDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/).nullable().default(null),
}).strict().superRefine((value, context) => {
  if ((value.draft.mode === "update") !== (value.expectedRevisions.view !== null)) {
    context.addIssue({ code: "custom", path: ["expectedRevisions", "view"], message: "Only update commits carry a View revision" });
  }
});
export type OrganizationViewCommitRequest = z.infer<typeof organizationViewCommitRequestSchema>;

export const organizationViewCommitResponseSchema = z.object({
  workspaceId: identifierSchema,
  workspaceRevision: z.number().int().positive(),
  view: organizationViewSchema,
  navigation: z.object({
    destination: z.string().trim().min(6).max(256).regex(/^view:/),
    href: z.string().regex(/^\/\?destination=view%3A/),
  }).strict(),
}).strict();
export type OrganizationViewCommitResponse = z.infer<typeof organizationViewCommitResponseSchema>;

export function summarizeOrganizationViewDefinition(definition: OrganizationViewDefinition): OrganizationViewDefinitionSummary {
  const clauses: string[] = [];
  if (definition.accountIds) clauses.push(`${definition.accountIds.length} explicit ${definition.accountIds.length === 1 ? "account" : "accounts"}`);
  else clauses.push("all authorized accounts, including accounts authorized later");
  if (definition.laneIds) clauses.push(`${definition.laneIds.length} primary ${definition.laneIds.length === 1 ? "Lane" : "Lanes"}`);
  if (definition.workflowStateIds) clauses.push(`${definition.workflowStateIds.length} workflow ${definition.workflowStateIds.length === 1 ? "state" : "states"}`);
  if (definition.facetFilters) clauses.push(`${definition.facetFilters.length} Facet ${definition.facetFilters.length === 1 ? "filter" : "filters"}`);
  if (definition.contextFilters) clauses.push(`${definition.contextFilters.length} Context ${definition.contextFilters.length === 1 ? "relationship" : "relationships"}`);
  if (definition.thread?.ids) clauses.push(`${definition.thread.ids.length} exact ${definition.thread.ids.length === 1 ? "Thread" : "Threads"}`);
  if (definition.thread?.subjectContains) clauses.push(`subject contains “${definition.thread.subjectContains}”`);
  if (definition.thread?.readState) clauses.push(definition.thread.readState === "unread" ? "at least one unread message" : "no unread messages");
  if (definition.humanSignal?.minimumScore !== undefined) clauses.push(`Human Signal at least ${definition.humanSignal.minimumScore}`);
  if (definition.humanSignal?.maximumScore !== undefined) clauses.push(`Human Signal at most ${definition.humanSignal.maximumScore}`);
  if (definition.humanSignal?.classifications) clauses.push(`effective evidence: ${definition.humanSignal.classifications.join(" or ")}`);
  if (definition.humanSignal?.evidenceReasonCodes) clauses.push(`${definition.humanSignal.evidenceReasonCodes.length} evidence ${definition.humanSignal.evidenceReasonCodes.length === 1 ? "reason" : "reasons"}`);
  if (definition.sender?.addresses) clauses.push(definition.sender.addresses.length === 1
    ? `from ${definition.sender.addresses[0]}`
    : `from ${definition.sender.addresses.length} sender addresses`);
  if (definition.sender?.domains) clauses.push(definition.sender.domains.length === 1
    ? `from domain ${definition.sender.domains[0]}`
    : `from ${definition.sender.domains.length} sender domains`);
  if (definition.date?.receivedAfter) clauses.push(`received at or after ${definition.date.receivedAfter}`);
  if (definition.date?.receivedBefore) clauses.push(`received at or before ${definition.date.receivedBefore}`);
  return organizationViewDefinitionSummarySchema.parse({
    text: organizationViewDefinitionKind(definition) === "match_all"
      ? "All Threads in every currently authorized account."
      : `Threads matching ${clauses.join("; ")}.`,
    clauses,
  });
}
