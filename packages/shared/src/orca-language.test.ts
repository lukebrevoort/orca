import assert from "node:assert/strict";
import { describe, expect, test } from "bun:test";

import {
  orcaCompiledRuleRevisionSchema,
  orcaEvaluationEventKindSchema,
  orcaEvaluationEventSchema,
  orcaEventKindSchema,
  orcaRuleRevisionListQuerySchema,
  orcaRuleRevisionPageDefaultLimit,
  orcaRuleRevisionPageMaximumLimit,
  orcaRuleReorderRequestSchema,
  orcaRuleOrderResponseSchema,
  orcaWorkspaceSnapshotSchema,
  validateOrcaCompiledRevisionSemantics,
  type OrcaCompiledRuleRevision,
  type OrcaWorkspaceSnapshot,
} from "./orca-language.ts";

describe("Orca Rule revision history contract", () => {
  test("defaults and caps the public page size while bounding cursors", () => {
    assert.deepEqual(orcaRuleRevisionListQuerySchema.parse({}), {
      limit: orcaRuleRevisionPageDefaultLimit,
    });
    assert.equal(orcaRuleRevisionListQuerySchema.parse({ limit: String(orcaRuleRevisionPageMaximumLimit) }).limit, 100);
    assert.equal(orcaRuleRevisionListQuerySchema.safeParse({ limit: 0 }).success, false);
    assert.equal(orcaRuleRevisionListQuerySchema.safeParse({ limit: 101 }).success, false);
    assert.equal(orcaRuleRevisionListQuerySchema.safeParse({ cursor: "x".repeat(2_049) }).success, false);
  });
});

describe("Orca Rule Set order contract", () => {
  test("accepts bounded partial reorder semantics and rejects ambiguous duplicate IDs or positions", () => {
    const request = { idempotencyKey: "reorder-1", expectedWorkspaceRevision: 7, expectedRuleSetRevision: 3, items: [
      { id: "rule-b", position: 0, expectedRevision: 2 },
      { id: "rule-a", position: 1, expectedRevision: 4 },
    ] };
    assert.deepEqual(orcaRuleReorderRequestSchema.parse(request), request);
    assert.equal(orcaRuleReorderRequestSchema.safeParse({ ...request, items: [request.items[0], { ...request.items[1], id: "rule-b" }] }).success, false);
    assert.equal(orcaRuleReorderRequestSchema.safeParse({ ...request, items: [request.items[0], { ...request.items[1], position: 0 }] }).success, false);
    assert.equal(orcaRuleReorderRequestSchema.safeParse({ ...request, items: [] }).success, false);
  });

  test("exposes the persisted aggregate revision, digest, count, and canonical positions", () => {
    const response = { workspaceId: "owner", workspaceRevision: 8, ruleSetRevision: 4, orderDigest: `order-v1:${"a".repeat(64)}`, ruleCount: 2, items: [
      { id: "rule-b", position: 0, revision: 2 }, { id: "rule-a", position: 1, revision: 4 },
    ] };
    assert.deepEqual(orcaRuleOrderResponseSchema.parse(response), response);
    assert.equal(orcaRuleOrderResponseSchema.safeParse({ ...response, orderDigest: "not-a-digest" }).success, false);
  });
});

const eventFamilies = ["message.received", "thread.updated", "schedule.reached", "user.corrected"] as const;

describe("Orca Event contracts", () => {
  test("shares one stable four-family vocabulary across compiled Rules and evaluation Trace", () => {
    for (const event of eventFamilies) {
      expect(orcaEventKindSchema.parse(event)).toBe(event);
      expect(orcaEvaluationEventKindSchema.parse(event)).toBe(event);
      expect(orcaCompiledRuleRevisionSchema.parse({
        languageVersion: 1,
        workspaceId: "workspace-1",
        workspaceSchemaRevision: 1,
        name: `${event} rule`,
        event: { kind: event },
        predicates: [{
          name: null,
          expression: { kind: "exists", field: "subject", valueType: "text", optional: true },
        }],
        actions: [{ kind: "route_lane", laneId: "lane-focus" }],
        because: "Canonical Event family",
        requiredCapabilities: ["organization_thread"],
        risk: "low",
      }).event.kind).toBe(event);
    }
  });

  test("binds every Event family to authoritative cause and subject provenance", () => {
    const base = { id: "event-1", occurredAt: "2026-08-26T12:00:00.000Z", workspaceId: "workspace-1", accountId: "account-1", threadId: "thread-1" };
    const valid = [
      { ...base, kind: "message.received", cause: "provider", messageId: "message-1" },
      { ...base, kind: "thread.updated", cause: "provider" },
      { ...base, kind: "thread.updated", cause: "internal" },
      { ...base, kind: "schedule.reached", cause: "scheduler" },
      { ...base, kind: "user.corrected", cause: "user" },
    ];
    for (const event of valid) expect(orcaEvaluationEventSchema.safeParse(event).success).toBe(true);

    const invalid = [
      { ...base, kind: "message.received", cause: "user", messageId: "message-1" },
      { ...base, kind: "message.received", cause: "provider" },
      { ...base, kind: "schedule.reached", cause: "provider" },
      { ...base, kind: "schedule.reached", cause: "scheduler", messageId: "forged" },
      { ...base, kind: "user.corrected", cause: "provider" },
      { ...base, kind: "user.corrected", cause: "user", messageId: "forged" },
      { ...base, kind: "thread.updated", cause: "scheduler" },
      { ...base, kind: "thread.updated", cause: "internal", messageId: "forged" },
      { ...base, accountId: undefined, kind: "message.received", cause: "provider", messageId: "message-1" },
      { ...base, kind: "message.received", cause: "provider", messageId: "message-1", source: "caller:forged" },
      { ...base, kind: "thread.updated", cause: "evaluator" },
    ];
    for (const event of invalid) expect(orcaEvaluationEventSchema.safeParse(event).success).toBe(false);
  });

  test("rejects crafted Action capability and risk downgrades at the shared revision seam", () => {
    const destructive = {
      languageVersion: 1,
      workspaceId: "workspace-1",
      workspaceSchemaRevision: 1,
      name: "Crafted downgrade",
      event: { kind: "message.received" },
      predicates: [{
        name: null,
        expression: { kind: "exists", field: "subject", valueType: "text", optional: true },
      }],
      actions: [{ kind: "propose_provider_deletion" }],
      because: "A label must never downgrade a resolved Action",
      requiredCapabilities: ["organization_thread"],
      risk: "low",
    };

    expect(orcaCompiledRuleRevisionSchema.safeParse(destructive).success).toBe(false);
    expect(orcaCompiledRuleRevisionSchema.safeParse({
      ...destructive,
      requiredCapabilities: ["provider_delete"],
      risk: "destructive",
    }).success).toBe(true);

    const attentionOnly = {
      ...destructive,
      actions: [{ kind: "notify", urgency: "immediate" }],
      requiredCapabilities: ["organization_attention"],
      risk: "medium",
    };
    expect(orcaCompiledRuleRevisionSchema.safeParse(attentionOnly).success).toBe(false);
    expect(orcaCompiledRuleRevisionSchema.safeParse({
      ...attentionOnly,
      requiredCapabilities: ["organization_attention", "organization_thread"],
    }).success).toBe(true);
  });
});

describe("Orca Predicate semantic binding", () => {
  const workspace = orcaWorkspaceSnapshotSchema.parse({
    workspaceId: "workspace-1",
    revision: 7,
    lanes: [{ id: "lane-focus", name: "Focus" }],
    workflowStates: [],
    facets: [{
      id: "facet-ticket",
      name: "Ticket",
      valueType: { kind: "enum", options: [{ id: "ticket-open", label: "Open", position: 0, retiredAt: null }] },
      cardinality: "single",
      optional: true,
    }],
    collections: [],
    contextTypes: [],
    contexts: [],
  });
  const revision = orcaCompiledRuleRevisionSchema.parse({
    languageVersion: 1,
    workspaceId: "workspace-1",
    workspaceSchemaRevision: 7,
    name: "Bound Predicate graph",
    event: { kind: "message.received" },
    predicates: [
      { name: "subject_contains", expression: { kind: "compare", field: "subject", operator: "contains", value: "failed", valueType: "text", optional: true, missingBehavior: "false" } },
      { name: "count_greater", expression: { kind: "compare", field: "thread.message_count", operator: "greater_than", value: 1, valueType: "number", optional: false, missingBehavior: "false" } },
      { name: "date_less", expression: { kind: "compare", field: "thread.latest_received_at", operator: "less_than", value: "2026-08-27T00:00:00.000Z", valueType: "datetime", optional: true, missingBehavior: "false" } },
      { name: "unread_equals", expression: { kind: "compare", field: "thread.unread", operator: "equals", value: true, valueType: "boolean", optional: false, missingBehavior: "false" } },
      { name: "ticket_equals", expression: { kind: "compare", field: "facet:facet-ticket", facetId: "facet-ticket", operator: "equals", value: "ticket-open", valueType: "enum", optional: true, missingBehavior: "false" } },
      { name: "ticket_exists", expression: { kind: "exists", field: "facet:facet-ticket", facetId: "facet-ticket", valueType: "enum", optional: true } },
      { name: "sender_missing", expression: { kind: "missing", field: "sender.email", valueType: "email", optional: true } },
      { name: "nested_any", expression: { kind: "any", predicates: ["subject_contains", "ticket_equals"] } },
      { name: "nested_not", expression: { kind: "not", predicate: "sender_missing" } },
      { name: null, expression: { kind: "all", predicates: ["nested_any", "nested_not", "count_greater", "date_less", "unread_equals", "ticket_exists"] } },
    ],
    actions: [{ kind: "route_lane", laneId: "lane-focus" }],
    because: "Every Predicate node is rebound",
    requiredCapabilities: ["organization_thread"],
    risk: "low",
  });

  test("recursively re-binds every graph form and supported leaf/operator to authoritative field and Facet semantics", () => {
    assert.deepEqual(validateOrcaCompiledRevisionSemantics(revision, workspace), []);
    const cases: Array<[string, (candidate: OrcaCompiledRuleRevision, schema: OrcaWorkspaceSnapshot) => void]> = [
      ["forged field/Facet pairing", (candidate) => { candidate.predicates[0]!.expression = { kind: "exists", field: "subject", facetId: "facet-ticket", valueType: "enum", optional: true }; }],
      ["missing Facet ID", (candidate) => { candidate.predicates[0]!.expression = { kind: "exists", field: "facet:facet-ticket", valueType: "enum", optional: true }; }],
      ["mismatched Facet ID", (candidate) => { candidate.predicates[0]!.expression = { kind: "exists", field: "facet:facet-ticket", facetId: "facet-other", valueType: "enum", optional: true }; }],
      ["unknown built-in field", (candidate) => { candidate.predicates[0]!.expression = { kind: "exists", field: "thread.secret", valueType: "text", optional: true }; }],
      ["forged built-in type", (candidate) => { candidate.predicates[0]!.expression = { kind: "exists", field: "subject", valueType: "enum", optional: true }; }],
      ["forged built-in optionality", (candidate) => { candidate.predicates[0]!.expression = { kind: "exists", field: "subject", valueType: "text", optional: false }; }],
      ["forged Facet type", (candidate) => { candidate.predicates[4]!.expression = { kind: "compare", field: "facet:facet-ticket", facetId: "facet-ticket", operator: "equals", value: "ticket-open", valueType: "text", optional: true, missingBehavior: "false" }; }],
      ["forged Facet optionality", (candidate) => { candidate.predicates[5]!.expression = { kind: "exists", field: "facet:facet-ticket", facetId: "facet-ticket", valueType: "enum", optional: false }; }],
      ["unsupported multi-value Facet", (_candidate, schema) => { schema.facets[0]!.cardinality = "multi"; }],
      ["contains on Boolean", (candidate) => { candidate.predicates[3]!.expression = { kind: "compare", field: "thread.unread", operator: "contains", value: true, valueType: "boolean", optional: false, missingBehavior: "false" }; }],
      ["ordering on Text", (candidate) => { candidate.predicates[0]!.expression = { kind: "compare", field: "subject", operator: "greater_than", value: "failed", valueType: "text", optional: true, missingBehavior: "false" }; }],
      ["invalid enum literal", (candidate) => { candidate.predicates[4]!.expression = { kind: "compare", field: "facet:facet-ticket", facetId: "facet-ticket", operator: "equals", value: "ticket-forged", valueType: "enum", optional: true, missingBehavior: "false" }; }],
      ["missing nested reference", (candidate) => { candidate.predicates[7]!.expression = { kind: "any", predicates: ["subject_contains", "missing_name"] }; }],
      ["duplicate Predicate name", (candidate) => { candidate.predicates[1]!.name = "subject_contains"; }],
      ["recursive all/any/not graph", (candidate) => { candidate.predicates[7]!.expression = { kind: "any", predicates: ["nested_not"] }; candidate.predicates[8]!.expression = { kind: "not", predicate: "nested_any" }; }],
    ];

    for (const [name, mutate] of cases) {
      const candidate = structuredClone(revision);
      const schema = structuredClone(workspace);
      mutate(candidate, schema);
      assert.notEqual(validateOrcaCompiledRevisionSemantics(candidate, schema).length, 0, name);
    }
  });
});
