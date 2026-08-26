import { describe, expect, test } from "bun:test";
import { orcaCompiledRuleRevisionSchema } from "@orca/shared";

import { compileOrcaRule, type OrcaWorkspaceSnapshot } from "./compiler.ts";

const workspace: OrcaWorkspaceSnapshot = {
  workspaceId: "workspace-1",
  revision: 7,
  lanes: [{ id: "lane-focus", name: "Focus" }],
  workflowStates: [{ id: "state-review", name: "Needs review" }],
  facets: [{
    id: "facet-urgency",
    name: "Urgency",
    valueType: { kind: "enum", options: [{ id: "urgent", label: "Urgent" }] },
    cardinality: "single",
    optional: true,
  }],
  collections: [{ id: "collection-launch", name: "Launch" }],
  contextTypes: [{ id: "context-type-project", name: "Project" }],
  contexts: [{ id: "context-orca", contextTypeId: "context-type-project", name: "Orca" }],
};

describe("compileOrcaRule", () => {
  test("compiles one Event, reusable predicates, and ordered actions to stable IDs", () => {
    const source = `orca 1
rule "Production failures"
event message.received
predicate from_vercel = sender.domain equals "vercel.com"
predicate failed = subject contains "failed"
predicate actionable = all(from_vercel, failed)
when actionable
action route lane "Focus"
action set workflow "Needs review"
action set facet "Urgency" = "Urgent"
action add collection "Launch"
action link context "Project" "Orca"
action notify immediate
because "A failed deploy blocks work"`;

    const result = compileOrcaRule({ source, workspace });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    expect(result.revision.workspaceSchemaRevision).toBe(7);
    expect(result.revision.event).toEqual({ kind: "message.received" });
    expect(result.revision.predicates).toHaveLength(4);
    expect(result.revision.actions.map((action) => action.kind)).toEqual([
      "route_lane", "set_workflow_state", "set_facet", "add_collection", "link_context", "notify",
    ]);
    expect(result.revision.actions[0]).toMatchObject({ laneId: "lane-focus" });
    expect(result.revision.actions[2]).toMatchObject({ facetId: "facet-urgency", value: "urgent" });
    expect(result.revision.actions[4]).toMatchObject({ contextTypeId: "context-type-project", contextId: "context-orca" });
    expect(result.revision.requiredCapabilities).toEqual(["organization_attention", "organization_thread"]);
    expect(result.revision.risk).toBe("medium");
    expect(orcaCompiledRuleRevisionSchema.parse(result.revision)).toEqual(result.revision);
  });

  test("returns actionable located diagnostics for malformed and multiply-triggered source", () => {
    const result = compileOrcaRule({
      workspace,
      source: `orca 1
rule "Too many triggers"
event message.received
event schedule.reached
when sender.domain equals 42
action run javascript "danger()"
because "This must never execute"`,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected diagnostics");
    expect(result.diagnostics.map((item) => item.code)).toContain("event_count");
    expect(result.diagnostics.map((item) => item.code)).toContain("literal_type_mismatch");
    expect(result.diagnostics.map((item) => item.code)).toContain("invalid_action");
    expect(result.diagnostics.every((item) => item.span.start.line >= 1 && item.span.start.column >= 1)).toBe(true);
    expect(result.diagnostics.find((item) => item.code === "event_count")?.span.start.line).toBe(4);
  });

  test("makes Optional values false-on-missing unless explicitly tested", () => {
    const result = compileOrcaRule({
      workspace,
      source: `orca 1
rule "Known sender"
event message.received
when missing sender.domain
when sender.domain equals "example.com"
action route lane "Focus"
because "Known senders have an explicit fallback"`,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    expect(result.revision.predicates[0]?.expression).toMatchObject({ kind: "missing", optional: true });
    expect(result.revision.predicates[1]?.expression).toMatchObject({ kind: "compare", optional: true, missingBehavior: "false" });
  });

  test("rejects recursive named predicates and bounded-depth abuse", () => {
    const cycle = compileOrcaRule({
      workspace,
      source: `orca 1
rule "Cycle"
event message.received
predicate one = two
predicate two = one
when one
action route lane "Focus"
because "No recursive definitions"`,
    });
    expect(cycle.ok).toBe(false);
    if (!cycle.ok) expect(cycle.diagnostics.map((item) => item.code)).toContain("predicate_cycle");

    const names = Array.from({ length: 18 }, (_, index) => `p${index + 1}`);
    const depth = compileOrcaRule({
      workspace,
      source: [
        "orca 1", 'rule "Depth"', "event message.received",
        ...names.map((name, index) => `predicate ${name} = ${names[index + 1] ?? 'subject contains "x"'}`),
        "when p1", 'action route lane "Focus"', 'because "Bounded depth"',
      ].join("\n"),
    });
    expect(depth.ok).toBe(false);
    if (!depth.ok) expect(depth.diagnostics.map((item) => item.code)).toContain("expression_too_deep");
  });

  test("enforces source-size bounds before parsing", () => {
    const result = compileOrcaRule({ source: `orca 1\n# ${"x".repeat(70_000)}`, workspace });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.map((item) => item.code)).toContain("source_too_large");
  });

  test("bounds aggregate expression AST nodes independently of lines and tokens", () => {
    const references = Array.from({ length: 100 }, () => "base").join(", ");
    const result = compileOrcaRule({
      workspace,
      source: [
        "orca 1", 'rule "Wide AST"', "event message.received", 'predicate base = subject contains "x"',
        ...Array.from({ length: 11 }, (_, index) => `predicate group${index} = all(${references})`),
        "when group0", 'action route lane "Focus"', 'because "A bounded compiler rejects wide trees"',
      ].join("\n"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.map((item) => item.code)).toContain("too_many_ast_nodes");
  });

  test("classifies destructive proposals without executing them", () => {
    const result = compileOrcaRule({
      workspace,
      source: `orca 1
rule "Deletion candidate"
event message.received
when subject contains "expired"
action propose provider deletion
because "A human must approve provider deletion separately"`,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    expect(result.revision.actions).toEqual([{ kind: "propose_provider_deletion" }]);
    expect(result.revision.requiredCapabilities).toEqual(["provider_delete"]);
    expect(result.revision.risk).toBe("destructive");
  });

  test("resource renames do not alter an already compiled revision", () => {
    const source = `orca 1
rule "Focus launch"
event message.received
when subject contains "launch"
action route lane "Focus"
because "Launch mail belongs together"`;
    const first = compileOrcaRule({ source, workspace });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(JSON.stringify(first.diagnostics));
    const original = structuredClone(first.revision);

    const renamed = structuredClone(workspace);
    renamed.revision = 8;
    renamed.lanes[0]!.name = "Deep Focus";
    expect(first.revision).toEqual(original);
    const staleName = compileOrcaRule({ source, workspace: renamed });
    expect(staleName.ok).toBe(false);
    const rebound = compileOrcaRule({ source: source.replace('"Focus"', '"Deep Focus"'), workspace: renamed });
    expect(rebound.ok).toBe(true);
    if (rebound.ok) expect(rebound.revision.actions[0]).toMatchObject({ laneId: "lane-focus" });
  });
});
