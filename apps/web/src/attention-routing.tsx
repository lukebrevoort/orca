import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  attentionRoutingResultSchema,
  attentionRoutingStateSchema,
  type AttentionBehavior,
  type AttentionRoutingChange,
  type AttentionRoutingState,
  type AttentionRoutingTarget,
} from "@orca/shared";
import { useOnlineStatus } from "./navigation";

export class RoutingRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function attentionRequest(path: string, init?: RequestInit) {
  const response = await fetch(path, { ...init, credentials: "include" });
  if (!response.ok)
    throw new RoutingRequestError(
      response.status,
      (await response.json().catch(() => null))?.error?.message ??
        `Request failed (${response.status}).`,
    );
  return response.json();
}
export function routingUrl(
  accountId: string,
  target: AttentionRoutingTarget = { scope: "account" },
) {
  const params = new URLSearchParams({ accountId });
  if (target.scope === "sender")
    params.set("address", target.address.trim().toLowerCase());
  if (target.scope === "conversation") params.set("threadId", target.threadId);
  return `/v1/attention/routing?${params}`;
}
export const routingLabel = (behavior: AttentionBehavior) =>
  ({
    normal: "Inbox",
    quiet: "Quiet",
    notify: "Signals (advanced)",
    focus: "Focus (advanced)",
    hidden: "Hidden (advanced)",
  })[behavior];
export const inheritanceLabel = (state: AttentionRoutingState) =>
  `${routingLabel(state.selection.inherited.behavior)} · ${state.selection.inherited.source === "fallback" ? "Orca default" : `${state.selection.inherited.source} choice`}`;
type Receipt = {
  accountId: string;
  undo: AttentionRoutingChange;
  text: string;
};
const RoutingContext = createContext({
  provided: false,
  version: 0,
  changed: async (_receipt?: Receipt) => {},
  clear: () => {},
});

/** The receipt lives outside a row/reader so moving a conversation cannot remove Undo. */
export function AttentionRoutingProvider({
  children,
  onRefresh,
}: {
  children: ReactNode;
  onRefresh: () => Promise<void>;
}) {
  const [version, setVersion] = useState(0);
  const [receipt, setReceipt] = useState<Receipt>();
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const receiptGeneration = useRef(0);
  const online = useOnlineStatus();
  async function changed(next?: Receipt) {
    const generation = ++receiptGeneration.current;
    setReceipt(next);
    setNotice(next?.text ?? "");
    setVersion((v) => v + 1);
    try {
      await onRefresh();
      if (generation === receiptGeneration.current) setError("");
    } catch {
      if (generation === receiptGeneration.current) setError("Mail could not reload. Last loaded mail may be out of date.");
    }
  }
  async function undo() {
    if (!receipt || lock.current || !online) return;
    lock.current = true;
    setBusy(true);
    const generation = receiptGeneration.current;
    try {
      const result = attentionRoutingResultSchema.parse(
        await attentionRequest(routingUrl(receipt.accountId), {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(receipt.undo),
        }),
      );
      if (result.state.accountId !== receipt.accountId)
        throw new Error("Account mismatch");
      if (generation !== receiptGeneration.current) {
        await onRefresh();
        return;
      }
      const completionGeneration = receiptGeneration.current + 1;
      await changed();
      if (completionGeneration !== receiptGeneration.current) return;
      setNotice("Last routing change undone.");
      requestAnimationFrame(() => {
        if (completionGeneration !== receiptGeneration.current) return;
        (document.querySelector<HTMLElement>("#sender-heading")
          ?? document.querySelector<HTMLElement>(".content-pane")
          ?? document.querySelector<HTMLElement>('button[aria-current="page"]'))?.focus();
      });
    } catch {
      if (generation !== receiptGeneration.current) return;
      const failureGeneration = ++receiptGeneration.current;
      setReceipt(undefined);
      setNotice(
        "Undo could not be confirmed. Reloading current routing; your old change will not be retried.",
      );
      setVersion((v) => v + 1);
      try {
        await onRefresh();
      } catch {
        if (failureGeneration === receiptGeneration.current) setError("Mail could not reload. Retry mail reload.");
      }
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <RoutingContext.Provider
      value={{
        provided: true,
        version,
        changed,
        clear: () => {
          receiptGeneration.current += 1;
          setReceipt(undefined);
          setNotice("");
        },
      }}
    >
      {children}
      {(notice || error) && (
        <aside className="routing-feedback" aria-label="Routing update">
          <span role="status">{notice}</span>
          {receipt && (
            <button disabled={busy || !online} onClick={() => void undo()}>
              {busy ? "Undoing…" : "Undo"}
            </button>
          )}
          {error && (
            <span role="alert">
              {error}{" "}
              <button onClick={() => void changed(receipt)}>
                Retry mail reload
              </button>
            </span>
          )}
          <button
            aria-label="Dismiss routing update"
            disabled={busy}
            onClick={() => {
              receiptGeneration.current += 1;
              setReceipt(undefined);
              setNotice("");
              setError("");
            }}
          >
            ×
          </button>
        </aside>
      )}
    </RoutingContext.Provider>
  );
}

export function useAttentionRouting(
  accountId: string,
  target: AttentionRoutingTarget,
  enabled = true,
) {
  const context = useContext(RoutingContext);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const online = useOnlineStatus();
  const [state, setState] = useState<AttentionRoutingState | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [stale, setStale] = useState(true);
  const [readOnly, setReadOnly] = useState(false);
  const deniedKey = useRef("");
  const [reload, setReload] = useState(0);
  const generation = useRef(0);
  const lock = useRef(false);
  const key = routingUrl(accountId, target);
  const activeKey = useRef(key);
  activeKey.current = key;
  const stateKey = useRef("");
  useEffect(() => {
    const current = ++generation.current;
    const controller = new AbortController();
    if (stateKey.current !== key) {
      setState(null);
      setSaveError("");
      setLoadError("");
    }
    setStale(true);
    setLoading(enabled && Boolean(accountId));
    setReadOnly(deniedKey.current === key);
    if (enabled && accountId)
      void attentionRequest(key, { signal: controller.signal })
        .then((raw) => {
          if (current !== generation.current || controller.signal.aborted)
            return;
          const next = attentionRoutingStateSchema.parse(raw);
          if (
            next.accountId !== accountId ||
            routingUrl(accountId, next.selection.target) !== key
          )
            throw new Error("Routing selection did not match. Reload choices.");
          stateKey.current = key;
          setState(next);
          setStale(false);
          setLoadError("");
        })
        .catch((cause) => {
          if (current !== generation.current || controller.signal.aborted)
            return;
          setReadOnly(
            deniedKey.current === key ||
              (cause instanceof RoutingRequestError &&
                [401, 403].includes(cause.status)),
          );
          setLoadError(`Could not reload choices. ${cause.message}`);
        })
        .finally(() => {
          if (current === generation.current) setLoading(false);
        });
    return () => {
      ++generation.current;
      controller.abort();
    };
  }, [key, enabled, reload, context.version]);
  const locked =
    !online ||
    !state ||
    stateKey.current !== key ||
    stale ||
    readOnly ||
    loading ||
    saving;
  async function save(behavior: AttentionBehavior | null, saveTarget = target) {
    if (locked || lock.current || !state) return false;
    lock.current = true;
    setSaving(true);
    setSaveError("");
    const savedKey = key;
    try {
      const result = attentionRoutingResultSchema.parse(
        await attentionRequest(routingUrl(accountId), {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            expectedRevision: state.revision,
            target: saveTarget,
            behavior,
          }),
        }),
      );
      if (
        result.state.accountId !== accountId ||
        routingUrl(accountId, result.state.selection.target) !==
          routingUrl(accountId, saveTarget) ||
        result.undo.expectedRevision !== result.state.revision
      )
        throw new Error("Routing response mismatch");
      if (!mounted.current || activeKey.current !== savedKey) { await context.changed(); return false; }
      setStale(true);
      await context.changed({
        accountId,
        undo: result.undo,
        text: `${saveTarget.scope === "account" ? "Everyone else" : saveTarget.scope === "sender" ? `Mail from ${saveTarget.address}` : "This conversation"} · ${behavior === null ? "Inherited choice restored" : routingLabel(behavior)}.`,
      });
      if (!context.provided) setReload((v) => v + 1);
      return true;
    } catch (cause) {
      if (!mounted.current || activeKey.current !== savedKey) { await context.changed(); return false; }
      setStale(true);
      if (
        cause instanceof RoutingRequestError &&
        [401, 403].includes(cause.status)
      ) {
        deniedKey.current = key;
        setReadOnly(true);
      }
      setSaveError(
        cause instanceof RoutingRequestError && cause.status === 409
          ? "Choices changed elsewhere."
          : "Save could not be confirmed.",
      );
      await context.changed();
      if (!context.provided) setReload((v) => v + 1);
      return false;
    } finally {
      lock.current = false;
      setSaving(false);
    }
  }
  return {
    state: stateKey.current === key ? state : null,
    reliable: stateKey.current === key && !stale && !loading && !loadError,
    loading,
    saving,
    locked,
    readOnly,
    loadError,
    saveError,
    online,
    save,
    reload: () => {
      deniedKey.current = "";
      setReload((v) => v + 1);
    },
    clearReceipt: context.clear,
  };
}
export function RoutingErrors({
  routing,
}: {
  routing: ReturnType<typeof useAttentionRouting>;
}) {
  return (
    <>
      {!routing.online && (
        <p role="status">You’re offline. Last loaded choices are locked.</p>
      )}
      {routing.readOnly && (
        <p>Read-only. Sign in with access to this account, then reload.</p>
      )}
      {routing.saveError && (
        <p role="alert">
          {routing.saveError}{" "}
          {routing.loading
            ? "Reloading current choices…"
            : routing.loadError
              ? "Reload to check the current choices."
              : "Current choices are now shown. Review them before choosing again."}{" "}
          Your change will not be retried automatically.
        </p>
      )}
      {routing.loadError && (
        <p role="alert">
          {routing.loadError} Showing last reliable values, locked.
        </p>
      )}
      {(routing.loadError || routing.saveError) && (
        <button
          type="button"
          disabled={routing.loading || routing.saving || !routing.online}
          onClick={routing.reload}
        >
          Reload choices
        </button>
      )}
    </>
  );
}
