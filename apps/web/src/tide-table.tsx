import { useRef, useState, type KeyboardEvent } from "react";
import { orcaRuleCompileResponseSchema, type OrcaDiagnostic } from "@orca/shared";

export const acceptedOrcaV1Example = `orca 1
rule "Production failures"
event message.received
predicate production = sender.domain equals "vercel.com"
predicate failure = subject contains "failed"
when all(production, failure)
action route lane "Everything else"
action notify immediate
because "A failed deploy blocks work and needs a human response"`;

type TideRequest = (path: string, init?: RequestInit) => Promise<Response>;

type RuleIdentity = { id: string; revision: number };
type CompileIntent = {
  body: string;
  generation: number;
  source: string;
};

export type TideCompileSuccess = {
  ruleId: string;
  ruleRevision: number;
  workspaceRevision: number;
};

async function defaultRequest(path: string, init?: RequestInit) {
  return fetch(path, { credentials: "include", ...init });
}

export function createTidePreviewRequest(): TideRequest {
  return async (path, init) => {
    if (path === "/v1/organization/describe") return Response.json({ workspaceRevision: 17 });
    if (path !== "/v1/organization/rules/compile") return Response.json({ error: { message: "Local preview endpoint unavailable" } }, { status: 404 });
    const payload = JSON.parse(String(init?.body)) as { ruleId?: string; expectedRuleRevision: number | null; workspaceSchemaRevision: number; source: string };
    await new Promise((resolve) => setTimeout(resolve, 900));
    if (payload.source.includes('lane "Missing"')) {
      const offset = payload.source.indexOf('"Missing"');
      const prefix = payload.source.slice(0, offset);
      const line = prefix.split("\n").length;
      const column = (prefix.split("\n").at(-1)?.length ?? 0) + 1;
      return Response.json({ ok: false, diagnostics: [{ severity: "error", phase: "resolve", code: "preview_unknown_lane", message: "Lane 'Missing' does not exist in this local preview.", span: { start: { offset, line, column }, end: { offset: offset + 9, line, column: column + 9 } }, hint: "Use Everything else for the deterministic preview." }] }, { status: 422 });
    }
    const revision = (payload.expectedRuleRevision ?? 0) + 1;
    const ruleId = payload.ruleId ?? "preview-rule-production-failures";
    const createdAt = "2026-08-26T12:00:00.000Z";
    return Response.json({
      ok: true,
      rule: { id: ruleId, workspaceId: "preview-workspace", name: "Production failures", latestRevision: revision, activeRevisionId: null, position: 0, createdAt, updatedAt: createdAt },
      revision: {
        id: `preview-rule-revision-${revision}`, ruleId, workspaceId: "preview-workspace", revision, source: payload.source,
        sourceDigest: `sha256:${"0".repeat(64)}`,
        compiled: {
          languageVersion: 1, workspaceId: "preview-workspace", workspaceSchemaRevision: payload.workspaceSchemaRevision, name: "Production failures",
          event: { kind: "message.received" },
          predicates: [{ name: null, expression: { kind: "compare", field: "subject", operator: "contains", value: "failed", valueType: "text", optional: false, missingBehavior: "false" } }],
          actions: [{ kind: "route_lane", laneId: "preview-lane-everything-else" }], because: "A failed deploy blocks work and needs a human response",
          requiredCapabilities: ["organization_attention"], risk: "low",
        },
        actor: { id: "preview-human", type: "human" }, createdAt,
      },
      diagnostics: [],
    }, { status: revision === 1 ? 201 : 200 });
  };
}

export function TideTableEditor({ onCompiled, previewMode = false, request = defaultRequest }: { onCompiled?: (success: TideCompileSuccess) => void; previewMode?: boolean; request?: TideRequest }) {
  const [source, setSource] = useState(acceptedOrcaV1Example);
  const [diagnostics, setDiagnostics] = useState<OrcaDiagnostic[]>([]);
  const [state, setState] = useState<"editing" | "compiling" | "queued" | "retry" | "compiled" | "error">("editing");
  const [ruleIdentity, setRuleIdentity] = useState<RuleIdentity | null>(null);
  const [message, setMessage] = useState(previewMode ? "Local demo adapter ready. No authenticated endpoint or persistence will be used." : "Ready to compile against the current Workspace Schema.");
  const textarea = useRef<HTMLTextAreaElement>(null);
  const sourceRef = useRef(source);
  const generationRef = useRef(0);
  const busyGeneration = useRef<number | null>(null);
  const queuedGeneration = useRef<number | null>(null);
  const pendingIntent = useRef<CompileIntent | null>(null);
  const ruleIdentityRef = useRef<RuleIdentity | null>(null);

  function rememberIdentity(identity: RuleIdentity) {
    ruleIdentityRef.current = identity;
    setRuleIdentity(identity);
  }

  async function beginCompile(generation: number, sourceSnapshot: string, identity: RuleIdentity | null) {
    busyGeneration.current = generation;
    setState("compiling");
    setMessage(previewMode ? "Compiling with the deterministic local demo adapter…" : "Resolving the current Workspace Schema and compiling…");
    setDiagnostics([]);
    try {
      const describeResponse = await request("/v1/organization/describe");
      if (!describeResponse.ok) throw new Error("The current Workspace Schema is unavailable.");
      const description = await describeResponse.json() as { workspaceRevision?: number; laneConfiguration?: { workspaceRevision?: number } };
      const workspaceSchemaRevision = description.workspaceRevision ?? description.laneConfiguration?.workspaceRevision;
      if (!workspaceSchemaRevision) throw new Error("The Workspace Schema revision was not returned.");
      const intent: CompileIntent = {
        generation,
        source: sourceSnapshot,
        body: JSON.stringify({
          ...(identity ? { ruleId: identity.id } : {}),
          idempotencyKey: `rule-compile:${crypto.randomUUID()}`,
          expectedRuleRevision: identity?.revision ?? null,
          workspaceSchemaRevision,
          source: sourceSnapshot,
        }),
      };
      pendingIntent.current = intent;
      await submitIntent(intent);
    } catch (error) {
      busyGeneration.current = null;
      setState("error");
      setMessage(error instanceof Error ? error.message : "Compilation could not be completed.");
    }
  }

  async function continueQueued(identity: RuleIdentity | null) {
    const queued = queuedGeneration.current;
    if (queued === null || queued !== generationRef.current) return false;
    queuedGeneration.current = null;
    await beginCompile(queued, sourceRef.current, identity);
    return true;
  }

  async function submitIntent(intent: CompileIntent) {
    busyGeneration.current = intent.generation;
    setState(queuedGeneration.current === generationRef.current ? "queued" : "compiling");
    try {
      const response = await request("/v1/organization/rules/compile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: intent.body,
      });
      const body = await response.json().catch(() => null) as unknown;
      const parsed = orcaRuleCompileResponseSchema.safeParse(body);
      if (response.status >= 500) {
        busyGeneration.current = null;
        setState("retry");
        setMessage("The compile outcome is unknown. Retry exact request to preserve its idempotency key, serialized source, and Workspace revision.");
        return;
      }
      if (parsed.success && !parsed.data.ok) {
        pendingIntent.current = null;
        busyGeneration.current = null;
        if (intent.generation !== generationRef.current && await continueQueued(ruleIdentityRef.current)) return;
        if (intent.generation !== generationRef.current) {
          setState("editing");
          setMessage("The earlier source was rejected without a write. This edited source remains uncompiled and ready for a fresh attempt.");
          return;
        }
        setDiagnostics(parsed.data.diagnostics);
        setState("error");
        setMessage(`${parsed.data.diagnostics.length} compiler ${parsed.data.diagnostics.length === 1 ? "diagnostic" : "diagnostics"}. Source is preserved.`);
        return;
      }
      if (!response.ok || !parsed.success || !parsed.data.ok) {
        pendingIntent.current = null;
        busyGeneration.current = null;
        if (intent.generation !== generationRef.current && await continueQueued(ruleIdentityRef.current)) return;
        setState("error");
        setMessage("Compilation was definitively rejected before a write. The next attempt will resolve a fresh Workspace revision.");
        return;
      }
      pendingIntent.current = null;
      busyGeneration.current = null;
      const identity = { id: parsed.data.rule.id, revision: parsed.data.rule.latestRevision };
      rememberIdentity(identity);
      onCompiled?.({ ruleId: identity.id, ruleRevision: identity.revision, workspaceRevision: parsed.data.revision.compiled.workspaceSchemaRevision + 1 });
      if (intent.generation !== generationRef.current && await continueQueued(identity)) return;
      if (intent.generation !== generationRef.current) {
        setState("editing");
        setMessage(`Earlier immutable revision ${identity.revision} resolved successfully. The current edited source remains uncompiled.`);
        return;
      }
      setState("compiled");
      setMessage(`${previewMode ? "Local demo" : "Immutable"} revision ${parsed.data.rule.latestRevision} compiled · ${parsed.data.revision.compiled.risk} risk · ${parsed.data.revision.compiled.requiredCapabilities.join(", ") || "no capabilities"}. ${previewMode ? "Not persisted or activated." : "Not activated."}`);
    } catch (error) {
      busyGeneration.current = null;
      setState("retry");
      setMessage("The compile outcome is unknown. Retry exact request to preserve its idempotency key, serialized source, and Workspace revision.");
    }
  }

  async function compile() {
    const generation = generationRef.current;
    if (busyGeneration.current !== null) {
      if (generation !== busyGeneration.current) {
        queuedGeneration.current = generation;
        setState("queued");
        setMessage("The earlier immutable request must finish first. This edited source is queued to append to the Rule identity it returns.");
      }
      return;
    }
    if (pendingIntent.current) {
      setState("compiling");
      setMessage("Retrying the exact serialized request with its original idempotency key and Workspace revision…");
      await submitIntent(pendingIntent.current);
      return;
    }
    await beginCompile(generation, sourceRef.current, ruleIdentityRef.current);
  }

  function focusDiagnostic(item: OrcaDiagnostic) {
    const field = textarea.current;
    if (!field) return;
    field.focus();
    field.setSelectionRange(item.span.start.offset, Math.max(item.span.start.offset + 1, item.span.end.offset));
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void compile();
    }
  }

  return <section className={`tide-table tide-table-${state}`} aria-label="Tide Table Orca source authoring">
    <header>
      <div><span>Accepted Orca language · version 1</span><p>Bounded, declarative authoring. Compile creates an immutable revision. It does not activate or execute the rule.</p></div>
      {ruleIdentity ? <strong>{previewMode ? "Local demo" : "Rule"} revision {ruleIdentity.revision}</strong> : <strong>{previewMode ? "Local demo Rule" : "New Rule"}</strong>}
    </header>
    <textarea
      aria-describedby="tide-table-help tide-table-status"
      aria-invalid={diagnostics.length > 0 || undefined}
      aria-label="Tide Table rule source"
      onInput={(event) => {
        const nextSource = event.currentTarget.value;
        sourceRef.current = nextSource;
        generationRef.current += 1;
        setSource(nextSource);
        setDiagnostics([]);
        if (busyGeneration.current !== null) {
          if (queuedGeneration.current !== null) queuedGeneration.current = generationRef.current;
          setState(queuedGeneration.current === null ? "editing" : "queued");
          setMessage(queuedGeneration.current === null
            ? "Source changed while an immutable request is in flight. It must finish first; queue this edit to append safely to the returned Rule identity."
            : "Queued source updated. The earlier immutable request must finish first.");
        } else if (pendingIntent.current) {
          setState("retry");
          setMessage("Source changed, but the earlier compile outcome is unknown. Retry its exact request before compiling this edit.");
        } else {
          setState("editing");
          setMessage(previewMode ? "Local preview source changed. Compile locally; nothing will persist." : "Source changed. Compile to create a new immutable revision.");
        }
      }}
      onKeyDown={onKeyDown}
      ref={textarea}
      spellCheck={false}
      value={source}
    />
    <footer>
      <p id="tide-table-help"><kbd>⌘/Ctrl + Enter</kbd> compile · comparisons against missing optional values are false unless <code>exists</code> or <code>missing</code> is explicit.</p>
      <button disabled={(busyGeneration.current !== null && generationRef.current === busyGeneration.current) || (state === "queued" && queuedGeneration.current === generationRef.current)} onClick={() => void compile()} type="button">{
        state === "retry" ? "Retry exact request"
          : busyGeneration.current !== null && generationRef.current !== busyGeneration.current && queuedGeneration.current !== generationRef.current ? "Queue next revision"
            : state === "queued" ? "Next revision queued"
              : state === "compiling" ? "Compiling…"
                : previewMode ? (ruleIdentity ? "Compile next local revision" : "Compile local demo")
                  : ruleIdentity ? "Compile next revision" : "Compile immutable revision"
      }</button>
    </footer>
    <p aria-live="polite" className="tide-table-status" id="tide-table-status">{message}</p>
    {diagnostics.length ? <ol className="tide-diagnostics" role="alert">
      {diagnostics.map((item, index) => <li key={`${item.code}:${item.span.start.offset}:${index}`}>
        <button onClick={() => focusDiagnostic(item)} type="button"><strong>Line {item.span.start.line}, column {item.span.start.column}</strong><span>{item.message}</span>{item.hint ? <small>{item.hint}</small> : null}</button>
      </li>)}
    </ol> : null}
  </section>;
}
