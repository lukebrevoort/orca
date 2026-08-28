import { describe, expect, test } from "bun:test";
import {
  orcaCompiledRuleRevisionSchema,
  orcaCompileResultSchema,
  type OrcaCompiler,
} from "@orca/shared";

import { compileOrcaRule, type OrcaWorkspaceSnapshot } from "./compiler.ts";

const sharedCompiler: OrcaCompiler = compileOrcaRule;

const workspace: OrcaWorkspaceSnapshot = {
  workspaceId: "workspace-1",
  revision: 7,
  lanes: [{ id: "lane-focus", name: "Focus" }],
  workflowStates: [{ id: "state-review", name: "Needs review" }],
  facets: [{
    id: "facet-urgency",
    name: "Urgency",
    valueType: { kind: "enum", options: [{ id: "urgent", label: "Urgent", position: 0, retiredAt: null }] },
    cardinality: "single",
    optional: true,
  }],
  collections: [{ id: "collection-launch", accountId: "account-1", name: "Launch" }],
  contextTypes: [{ id: "context-type-project", name: "Project" }],
  contexts: [{ id: "context-orca", contextTypeId: "context-type-project", name: "Orca" }],
};

describe("compileOrcaRule", () => {
  test("reports exact deterministic compiler budget counters through the public result", () => {
    const result = compileOrcaRule({
      workspace,
      source: `orca 1
rule "Budget"
event message.received
when subject contains "x"
action route lane "Focus"
because "Measured"`,
    });

    expect(result.ok).toBe(true);
    expect(result.budget).toEqual({
      status: "complete",
      exhausted: [],
      limits: {
        maximumSourceBytes: 65_536,
        maximumLines: 1_000,
        maximumLineBytes: 2_000,
        maximumTokens: 8_000,
        maximumAstNodes: 1_000,
        maximumExpressionDepth: 16,
        maximumPredicates: 100,
        maximumActions: 100,
      },
      usage: {
        sourceBytes: 114,
        lines: 6,
        maximumLineBytes: 25,
        tokens: 16,
        astNodes: 2,
        expressionDepth: 1,
        predicates: 1,
        actions: 1,
      },
    });
  });

  test("rejects control and bidirectional source characters before semantic compilation", () => {
    const valid = `orca 1
rule "Unicode safety"
event message.received
when subject contains "status"
action route lane "Focus"
because "Human-reviewed source"`;
    const probes = [
      valid.replace("Human-reviewed", "Human\u0000reviewed"),
      valid.replace("Human-reviewed", "Human\u202Ereviewed"),
    ];

    for (const source of probes) {
      const result = compileOrcaRule({ workspace, source });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.diagnostics.map((item) => item.code)).toContain("invalid_source_character");
    }
  });

  test("rejects ambiguous non-ASCII grammar whitespace while preserving quoted Unicode text", () => {
    const hiddenGrammar = ["\u2028", "\u2029", "\u00a0", "\u2007", "\u202f"];
    for (const whitespace of hiddenGrammar) {
      const source = `orca${whitespace}1\nrule "Hidden whitespace"\nevent message.received\nwhen subject contains "status"\naction route lane "Focus"\nbecause "Must not create hidden grammar"`;
      const result = compileOrcaRule({ workspace, source });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.diagnostics).toEqual(expect.arrayContaining([
          expect.objectContaining({
            phase: "parse",
            code: "invalid_source_character",
            span: expect.objectContaining({ start: expect.objectContaining({ line: 1 }) }),
          }),
        ]));
        expect(result.budget.usage.sourceBytes).toBe(new TextEncoder().encode(source).length);
        expect(result.budget.usage.lines).toBe(6);
        expect(result.budget.usage.tokens).toBe(16);
      }
    }

    const visibleUnicode = compileOrcaRule({
      workspace,
      source: `orca 1\nrule "Résumé ✨"\nevent message.received\nwhen subject contains "Café du monde"\naction route lane "Focus"\nbecause "Quoted Unicode remains ordinary user text"`,
    });
    expect(visibleUnicode.ok).toBe(true);
  });

  test("satisfies the shared compiler interface on success and failure", () => {
    const success = sharedCompiler({
      workspace,
      source: `orca 1\nrule "Shared interface"\nevent thread.updated\nwhen subject contains "status"\naction add collection "Launch"\nbecause "Compiler drift must fail at the shared seam"`,
    });
    const failure = sharedCompiler({ source: "not orca", workspace });

    expect(orcaCompileResultSchema.parse(success)).toEqual(success);
    expect(orcaCompileResultSchema.parse(failure)).toEqual(failure);
  });

  test("authors the same four canonical Event families accepted by evaluation Trace", () => {
    for (const event of ["message.received", "thread.updated", "schedule.reached", "user.corrected"] as const) {
      const result = compileOrcaRule({
        workspace,
        source: `orca 1
rule "${event} rule"
event ${event}
when subject contains "status"
action route lane "Focus"
because "The canonical Event family is authorable"`,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(`${event}: ${JSON.stringify(result.diagnostics)}`);
      expect(result.revision.event.kind).toBe(event);
      expect(orcaCompiledRuleRevisionSchema.parse(result.revision)).toEqual(result.revision);
    }
  });

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
    expect(result.revision.actions[3]).toEqual({ kind: "add_collection", accountId: "account-1", collectionId: "collection-launch" });
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

  test("binds Facet comparisons and values to authoritative types and constraints", () => {
    const constrainedWorkspace = {
      ...workspace,
      facets: [
        { id: "facet-enum", name: "Status", valueType: { kind: "enum", options: [{ id: "status-open", label: "Open", position: 0, retiredAt: null }] }, cardinality: "single", optional: true },
        { id: "facet-text", name: "Code", valueType: { kind: "text", maxLength: 5 }, cardinality: "single", optional: true },
        { id: "facet-boolean", name: "Approved", valueType: { kind: "boolean" }, cardinality: "single", optional: false },
        { id: "facet-number", name: "Score", valueType: { kind: "number", minimum: 0, maximum: 10, integer: true }, cardinality: "single", optional: true },
        { id: "facet-date", name: "Due", valueType: { kind: "datetime" }, cardinality: "single", optional: true },
      ],
    } as unknown as OrcaWorkspaceSnapshot;
    const compile = (predicate: string, action = 'action route lane "Focus"') => compileOrcaRule({
      workspace: constrainedWorkspace,
      source: `orca 1\nrule "Typed Facet"\nevent message.received\nwhen ${predicate}\n${action}\nbecause "Facet schema is authoritative"`,
    });

    const valid = [
      compile('facet "Status" equals "Open"'),
      compile('facet "Code" contains "abc"'),
      compile('facet "Approved" equals true'),
      compile('facet "Score" greater_than 4'),
      compile('facet "Due" less_than "2026-08-26T12:00:00Z"'),
      compile('missing facet "Score"'),
    ];
    expect(valid.every((result) => result.ok)).toBe(true);
    if (!valid[0]?.ok) throw new Error(JSON.stringify(valid[0]?.diagnostics));
    expect(valid[0].revision.predicates[0]?.expression).toMatchObject({ facetId: "facet-enum", value: "status-open", optional: true });

    const invalid = [
      compile('facet "Status" equals "status-open"'),
      compile('facet "Status" contains "Open"'),
      compile('facet "Code" equals "too-long"'),
      compile('facet "Approved" contains true'),
      compile('facet "Score" equals 4.5'),
      compile('facet "Score" greater_than 11'),
      compile('facet "Due" equals "not-a-date"'),
      compile('missing facet "Approved"'),
      compile('facet "Code" equals "ok"', 'action set facet "Code" = "too-long"'),
    ];
    expect(invalid.every((result) => !result.ok)).toBe(true);
    expect(invalid.flatMap((result) => result.ok ? [] : result.diagnostics.map((item) => item.code))).toEqual(expect.arrayContaining([
      "literal_type_mismatch", "operator_type_mismatch", "required_field_never_missing",
    ]));
  });

  test("accepts and rejects the full authoritative Facet scalar matrix", () => {
    const typedWorkspace = {
      ...workspace,
      facets: [
        { id: "facet-text", name: "Text", valueType: { kind: "text", maxLength: 4 }, cardinality: "single", optional: true },
        { id: "facet-number", name: "Number", valueType: { kind: "number", minimum: 1, maximum: 5, integer: false }, cardinality: "single", optional: true },
        { id: "facet-integer", name: "Integer", valueType: { kind: "number", minimum: 1, maximum: 5, integer: true }, cardinality: "single", optional: true },
        { id: "facet-boolean", name: "Boolean", valueType: { kind: "boolean" }, cardinality: "single", optional: false },
        { id: "facet-datetime", name: "DateTime", valueType: { kind: "datetime" }, cardinality: "single", optional: true },
        { id: "facet-duration", name: "Duration", valueType: { kind: "duration" }, cardinality: "single", optional: true },
        { id: "facet-email-strict", name: "Strict email", valueType: { kind: "email", allowDisplayName: false }, cardinality: "single", optional: true },
        { id: "facet-email-display", name: "Display email", valueType: { kind: "email", allowDisplayName: true }, cardinality: "single", optional: true },
        { id: "facet-domain", name: "Domain", valueType: { kind: "domain" }, cardinality: "single", optional: true },
        { id: "facet-enum", name: "Status", valueType: { kind: "enum", options: [{ id: "status-open", label: "Open", position: 0, retiredAt: null }] }, cardinality: "single", optional: true },
      ],
    } as OrcaWorkspaceSnapshot;
    const compile = (predicate: string, action = 'action route lane "Focus"') => compileOrcaRule({
      workspace: typedWorkspace,
      source: `orca 1\nrule "Facet matrix"\nevent message.received\nwhen ${predicate}\n${action}\nbecause "Compiled IR must use the Facet contract"`,
    });

    const valid: Array<[name: string, literal: string, compiled: string | number | boolean]> = [
      ["Text", '"orca"', "orca"],
      ["Number", "3.5", 3.5],
      ["Integer", "3", 3],
      ["Boolean", "true", true],
      ["DateTime", '"2026-08-26T12:00:00Z"', "2026-08-26T12:00:00Z"],
      ["DateTime", '"2026-08-26T12:00:00+05:30"', "2026-08-26T12:00:00+05:30"],
      ["Duration", '"P1Y"', "P1Y"],
      ["Duration", '"P2M3W4DT5H6M7.5S"', "P2M3W4DT5H6M7.5S"],
      ["Strict email", '"ada@example.com"', "ada@example.com"],
      ["Display email", '"Ada Lovelace <ada@example.com>"', "Ada Lovelace <ada@example.com>"],
      ["Domain", '"sub.example.com"', "sub.example.com"],
      ["Status", '"Open"', "status-open"],
    ];
    const failures = {
      rejectedPredicates: [] as string[],
      rejectedActions: [] as string[],
      acceptedInvalidPredicates: [] as string[],
      acceptedInvalidActions: [] as string[],
      operatorMismatches: [] as string[],
    };
    for (const [name, literal, compiled] of valid) {
      const predicate = compile(`facet "${name}" equals ${literal}`);
      if (!predicate.ok) failures.rejectedPredicates.push(`${name} ${literal}`);
      if (predicate.ok) expect(predicate.revision.predicates[0]?.expression).toMatchObject({ value: compiled });
      const action = compile(`facet "${name}" equals ${literal}`, `action set facet "${name}" = ${literal}`);
      if (!action.ok) failures.rejectedActions.push(`${name} ${literal}`);
      if (action.ok) expect(action.revision.actions[0]).toMatchObject({ facetId: typedWorkspace.facets.find((facet) => facet.name === name)!.id, value: compiled });
    }

    const invalid: Array<[name: string, literal: string]> = [
      ["Text", '"orcas"'],
      ["Number", "6"],
      ["Integer", "3.5"],
      ["Boolean", '"true"'],
      ["DateTime", '"2026-08-26T12:00:00"'],
      ["DateTime", '"tomorrow"'],
      ["Duration", '"1 year"'],
      ["Strict email", '"Ada Lovelace <ada@example.com>"'],
      ["Display email", '"Ada Lovelace"'],
      ["Domain", '"Example.COM"'],
      ["Domain", '"https://example.com/path"'],
      ["Status", '"status-open"'],
    ];
    for (const [name, literal] of invalid) {
      if (compile(`facet "${name}" equals ${literal}`).ok) failures.acceptedInvalidPredicates.push(`${name} ${literal}`);
      if (compile('facet "Text" equals "orca"', `action set facet "${name}" = ${literal}`).ok) failures.acceptedInvalidActions.push(`${name} ${literal}`);
    }

    for (const [probe, expected] of [
      ['facet "Text" contains "orc"', true],
      ['facet "Strict email" contains "ada@example.com"', true],
      ['facet "Domain" contains "example.com"', true],
      ['facet "Boolean" contains true', false],
      ['missing facet "Boolean"', false],
      ['missing facet "Text"', true],
    ] as const) {
      if (compile(probe).ok !== expected) failures.operatorMismatches.push(probe);
    }
    expect(failures).toEqual({
      rejectedPredicates: [],
      rejectedActions: [],
      acceptedInvalidPredicates: [],
      acceptedInvalidActions: [],
      operatorMismatches: [],
    });
  });

  test("stores stable Facet and enum IDs across schema renames", () => {
    const first = compileOrcaRule({
      workspace,
      source: `orca 1\nrule "Urgent"\nevent message.received\nwhen facet "Urgency" equals "Urgent"\naction set facet "Urgency" = "Urgent"\nbecause "Stable IDs survive display renames"`,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const original = structuredClone(first.revision);
    const renamed = structuredClone(workspace);
    renamed.revision = 8;
    renamed.facets[0]!.name = "Priority";
    if (renamed.facets[0]!.valueType.kind === "enum") renamed.facets[0]!.valueType.options[0]!.label = "Critical";

    expect(first.revision).toEqual(original);
    expect(compileOrcaRule({ source: first.revision.predicates.length ? `orca 1\nrule "Urgent"\nevent message.received\nwhen facet "Urgency" equals "Urgent"\naction set facet "Urgency" = "Urgent"\nbecause "Old aliases no longer bind"` : "", workspace: renamed }).ok).toBe(false);
    const rebound = compileOrcaRule({
      workspace: renamed,
      source: `orca 1\nrule "Urgent"\nevent message.received\nwhen facet "Priority" equals "Critical"\naction set facet "Priority" = "Critical"\nbecause "Renamed labels bind to stable IDs"`,
    });
    expect(rebound.ok).toBe(true);
    if (rebound.ok) {
      expect(rebound.revision.predicates[0]?.expression).toMatchObject({ facetId: "facet-urgency", value: "urgent" });
      expect(rebound.revision.actions[0]).toMatchObject({ facetId: "facet-urgency", value: "urgent" });
    }
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

  test("bounds repeated named-predicate fan-out by the dependency graph", () => {
    const levels = Array.from({ length: 7 }, (_, index) => `level_${index + 1}`);
    const source = [
      "orca 1", 'rule "Bounded fan-out"', "event message.received",
      'predicate base = subject contains "x"',
      ...levels.map((name, index) => `predicate ${name} = all(${Array.from({ length: 10 }, () => levels[index - 1] ?? "base").join(", ")})`),
      `when ${levels.at(-1)}`, 'action route lane "Focus"', 'because "Shared predicate paths are analyzed once"',
    ].join("\n");

    const startedAt = performance.now();
    const result = compileOrcaRule({ source, workspace });

    expect(performance.now() - startedAt).toBeLessThan(250);
    expect(result.ok).toBe(true);
  }, 1_000);

  test("enforces source-size bounds before parsing", () => {
    const result = compileOrcaRule({ source: `orca 1\n# ${"x".repeat(70_000)}`, workspace });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.map((item) => item.code)).toContain("source_too_large");
      expect(result.budget).toMatchObject({ status: "exhausted", exhausted: expect.arrayContaining(["source_bytes"]) });
    }
  });

  test("stops oversized source at the byte preflight without scanning later compiler units", () => {
    const result = compileOrcaRule({ source: "x".repeat(2_000_000), workspace });

    expect(result.ok).toBe(false);
    expect(result.budget).toMatchObject({
      status: "exhausted",
      exhausted: ["source_bytes"],
      usage: {
        sourceBytes: 65_537,
        lines: 0,
        maximumLineBytes: 0,
        tokens: 0,
        astNodes: 0,
        expressionDepth: 0,
        predicates: 0,
        actions: 0,
      },
    });
  });

  test("reports each compiler resource limit independently through bounded adversarial source", () => {
    const tokenLines = Array.from({ length: 81 }, (_, line) => Array.from({ length: line === 80 ? 1 : 100 }, () => "x").join(" ")).join("\n");
    const cases: Array<[string, string, string]> = [
      ["source bytes", Array.from({ length: 650 }, () => `# ${"x".repeat(100)}`).join("\n"), "source_bytes"],
      ["lines", Array.from({ length: 1_001 }, () => "#").join("\n"), "lines"],
      ["line bytes", `#${"é".repeat(1_000)}`, "line_bytes"],
      ["tokens", tokenLines, "tokens"],
      ["predicates", ["orca 1", 'rule "Predicates"', "event message.received", ...Array.from({ length: 101 }, (_, index) => `predicate p${index} = subject contains "x"`), "when p0", 'action route lane "Focus"', 'because "Bounded"'].join("\n"), "predicates"],
      ["actions", ["orca 1", 'rule "Actions"', "event message.received", 'when subject contains "x"', ...Array.from({ length: 101 }, () => 'action route lane "Focus"'), 'because "Bounded"'].join("\n"), "actions"],
    ];

    for (const [name, source, exhausted] of cases) {
      const result = compileOrcaRule({ workspace, source });
      expect({ name, ok: result.ok, status: result.budget.status, exhausted: result.budget.exhausted }).toEqual({
        name,
        ok: false,
        status: "exhausted",
        exhausted: expect.arrayContaining([exhausted]),
      });
    }
  });

  test("keeps ambient capabilities, general loops, dynamic evaluation, and undeclared Workspace data unrepresentable", () => {
    const directives = [
      "action fetch network \"https://example.com\"",
      "action read filesystem \"/etc/passwd\"",
      "action read process env \"TOKEN\"",
      "action read ambient time",
      "action eval javascript \"danger()\"",
      "action run shell \"echo danger\"",
      "action while subject contains \"x\"",
      "action emit event thread.updated",
      "action send mail \"recipient@example.com\"",
      "action reply mail \"message\"",
      "action forward mail \"recipient@example.com\"",
      "action delete provider message",
    ];
    for (const directive of directives) {
      const result = compileOrcaRule({
        workspace,
        source: `orca 1\nrule "Isolation"\nevent message.received\nwhen subject contains "x"\n${directive}\nbecause "Ambient authority is unavailable"`,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.diagnostics.map((item) => item.code)).toContain("invalid_action");
    }

    for (const predicate of ["process.env equals \"x\"", "workspace.secret equals \"x\"", "ambient.now greater_than \"2026-01-01T00:00:00Z\""]) {
      const result = compileOrcaRule({
        workspace,
        source: `orca 1\nrule "Isolation"\nevent message.received\nwhen ${predicate}\naction route lane "Focus"\nbecause "Only declared fields exist"`,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.diagnostics.map((item) => item.code)).toContain("unknown_field");
    }
  });

  test("fails closed on case aliases, missing resources, and crafted labels while preserving stable IDs", () => {
    const ambiguous = structuredClone(workspace);
    ambiguous.lanes.push({ id: "lane-focus-alias", name: "focus" });
    const alias = compileOrcaRule({
      workspace: ambiguous,
      source: `orca 1\nrule "Alias"\nevent message.received\nwhen subject contains "x"\naction route lane "Focus"\nbecause "Aliases cannot select authority"`,
    });
    expect(alias.ok).toBe(false);
    if (!alias.ok) expect(alias.diagnostics.map((item) => item.code)).toContain("ambiguous_resource");

    const unicodeAliases = structuredClone(workspace);
    unicodeAliases.lanes = [{ id: "lane-cafe-1", name: "Café" }, { id: "lane-cafe-2", name: "Cafe\u0301" }];
    const unicodeAlias = compileOrcaRule({
      workspace: unicodeAliases,
      source: `orca 1\nrule "Unicode alias"\nevent message.received\nwhen subject contains "x"\naction route lane "Café"\nbecause "Canonical Unicode aliases cannot choose authority"`,
    });
    expect(unicodeAlias.ok).toBe(false);
    if (!unicodeAlias.ok) expect(unicodeAlias.diagnostics.map((item) => item.code)).toContain("ambiguous_resource");

    const missing = compileOrcaRule({
      workspace,
      source: `orca 1\nrule "Missing"\nevent message.received\nwhen subject contains "x"\naction route lane "provider_delete"\nbecause "A crafted label grants nothing"`,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.diagnostics.map((item) => item.code)).toContain("unknown_resource");
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
