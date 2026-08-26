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

async function defaultRequest(path: string, init?: RequestInit) {
  return fetch(path, { credentials: "include", ...init });
}

export function TideTableEditor({ request = defaultRequest }: { request?: TideRequest }) {
  const [source, setSource] = useState(acceptedOrcaV1Example);
  const [diagnostics, setDiagnostics] = useState<OrcaDiagnostic[]>([]);
  const [state, setState] = useState<"editing" | "compiling" | "compiled" | "error">("editing");
  const [ruleIdentity, setRuleIdentity] = useState<{ id: string; revision: number } | null>(null);
  const [message, setMessage] = useState("Ready to compile against the current Workspace Schema.");
  const textarea = useRef<HTMLTextAreaElement>(null);

  async function compile() {
    if (state === "compiling") return;
    setState("compiling");
    setMessage("Resolving the current Workspace Schema and compiling…");
    setDiagnostics([]);
    try {
      const describeResponse = await request("/v1/organization/describe");
      if (!describeResponse.ok) throw new Error("The current Workspace Schema is unavailable.");
      const description = await describeResponse.json() as { workspaceRevision?: number; laneConfiguration?: { workspaceRevision?: number } };
      const workspaceSchemaRevision = description.workspaceRevision ?? description.laneConfiguration?.workspaceRevision;
      if (!workspaceSchemaRevision) throw new Error("The Workspace Schema revision was not returned.");
      const response = await request("/v1/organization/rules/compile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(ruleIdentity ? { ruleId: ruleIdentity.id } : {}),
          expectedRuleRevision: ruleIdentity?.revision ?? null,
          workspaceSchemaRevision,
          source,
        }),
      });
      const body = await response.json() as unknown;
      const parsed = orcaRuleCompileResponseSchema.safeParse(body);
      if (parsed.success && !parsed.data.ok) {
        setDiagnostics(parsed.data.diagnostics);
        setState("error");
        setMessage(`${parsed.data.diagnostics.length} compiler ${parsed.data.diagnostics.length === 1 ? "diagnostic" : "diagnostics"}. Source is preserved.`);
        return;
      }
      if (!response.ok || !parsed.success || !parsed.data.ok) throw new Error("Compilation could not be completed.");
      setRuleIdentity({ id: parsed.data.rule.id, revision: parsed.data.rule.latestRevision });
      setState("compiled");
      setMessage(`Immutable revision ${parsed.data.rule.latestRevision} compiled · ${parsed.data.revision.compiled.risk} risk · ${parsed.data.revision.compiled.requiredCapabilities.join(", ") || "no capabilities"}. Not activated.`);
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "Compilation could not be completed.");
    }
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
      {ruleIdentity ? <strong>Rule revision {ruleIdentity.revision}</strong> : <strong>New Rule</strong>}
    </header>
    <textarea
      aria-describedby="tide-table-help tide-table-status"
      aria-invalid={diagnostics.length > 0 || undefined}
      aria-label="Tide Table rule source"
      onChange={(event) => { setSource(event.target.value); setState("editing"); setDiagnostics([]); setMessage("Source changed. Compile to create a new immutable revision."); }}
      onKeyDown={onKeyDown}
      ref={textarea}
      spellCheck={false}
      value={source}
    />
    <footer>
      <p id="tide-table-help"><kbd>⌘/Ctrl + Enter</kbd> compile · comparisons against missing optional values are false unless <code>exists</code> or <code>missing</code> is explicit.</p>
      <button disabled={state === "compiling"} onClick={() => void compile()} type="button">{state === "compiling" ? "Compiling…" : ruleIdentity ? "Compile next revision" : "Compile immutable revision"}</button>
    </footer>
    <p aria-live="polite" className="tide-table-status" id="tide-table-status">{message}</p>
    {diagnostics.length ? <ol className="tide-diagnostics" role="alert">
      {diagnostics.map((item, index) => <li key={`${item.code}:${item.span.start.offset}:${index}`}>
        <button onClick={() => focusDiagnostic(item)} type="button"><strong>Line {item.span.start.line}, column {item.span.start.column}</strong><span>{item.message}</span>{item.hint ? <small>{item.hint}</small> : null}</button>
      </li>)}
    </ol> : null}
  </section>;
}
