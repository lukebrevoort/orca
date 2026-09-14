import { destinationChangeEvent, destinationLabel, refreshDestinations } from "./mail-destinations";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  destinationBatchResultSchema,
  type DestinationBatchChange,
  destinationRoutingResultSchema,
  destinationRoutingStateSchema,
  type DestinationRoutingChange,
  type DestinationRoutingState,
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
  return `/v1/destinations/routing?${params}`;
}
export const routingLabel = destinationLabel;
export const inheritanceLabel = (state: DestinationRoutingState) =>
  `${routingLabel(state.selection.inherited.destinationId)} · ${state.selection.inherited.source} choice`;
type Receipt = ({ accountId: string; undo: DestinationRoutingChange; batch?: false } | { batch: true; undo: DestinationBatchChange }) & { text: string };
type ReceiptOwner = { generation: number; key: string };
const RoutingContext = createContext({
  provided: false,
  version: 0,
  recoveryRequired: false,
  recovering: false,
  requireRecovery: (_owner: ReceiptOwner) => {},
  recover: async () => false,
  begin: (): ReceiptOwner => ({ generation: 0, key: "" }),
  changed: async (_receipt?: Receipt, _owner?: ReceiptOwner) => true,
  clear: () => {},
});

/** The receipt lives outside a row/reader so moving a conversation cannot remove Undo. */
export function AttentionRoutingProvider({
  children,
  onRefresh,
  ownerKey = "",
}: {
  children: ReactNode;
  onRefresh: () => Promise<void | boolean>;
  ownerKey?: string;
}) {
  const [version, setVersion] = useState(0);
  const [receipt, setReceipt] = useState<Receipt>();
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [recoveryRequired, setRecoveryRequired] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const recoveryAttempt = useRef<{ promise: Promise<boolean> } | null>(null);
  const lock = useRef(false);
  const receiptGeneration = useRef(0);
  const online = useOnlineStatus();
  const currentOwner = useRef(ownerKey);
  if (currentOwner.current !== ownerKey) { currentOwner.current = ownerKey; receiptGeneration.current++; recoveryAttempt.current = null; }
  useEffect(() => { setReceipt(undefined); setNotice(""); setError(""); setRecoveryRequired(false); setRecovering(false); }, [ownerKey]);
  useEffect(() => () => { receiptGeneration.current++; currentOwner.current = "unmounted"; }, []);
  function begin() {
    const generation = ++receiptGeneration.current;
    setReceipt(undefined); setNotice(""); setError("");
    return { generation, key: currentOwner.current };
  }
  async function changed(next?: Receipt, owner?: ReceiptOwner) {
    if (owner && (owner.generation !== receiptGeneration.current || owner.key !== currentOwner.current)) {
      await Promise.all([onRefresh(), refreshDestinations()]).catch(() => {});
      return false;
    }
    const generation = ++receiptGeneration.current;
    setReceipt(next);
    setNotice(next?.text ?? "");
    setVersion((v) => v + 1);
    try {
      await Promise.all([onRefresh(), refreshDestinations()]);
      if (generation === receiptGeneration.current) setError("");
      return true;
    } catch {
      if (generation === receiptGeneration.current) setError("Mail could not reload. Last loaded mail may be out of date.");
      return false;
    }
  }
  useEffect(() => {
    const refresh = () => { void changed(); };
    window.addEventListener(destinationChangeEvent, refresh);
    return () => window.removeEventListener(destinationChangeEvent, refresh);
  }, [onRefresh]);
  function recover(): Promise<boolean> {
    // Every recovery trigger shares this owner-scoped attempt. A duplicate click
    // must not supersede the canonical snapshot another recovery is awaiting.
    if (recoveryAttempt.current) return recoveryAttempt.current.promise;
    const key = currentOwner.current, generation = receiptGeneration.current;
    const attempt = { promise: Promise.resolve(false) };
    recoveryAttempt.current = attempt;
    setRecovering(true);
    attempt.promise = (async () => {
      try {
        const [applied] = await Promise.all([onRefresh(), refreshDestinations()]);
        if (key !== currentOwner.current || generation !== receiptGeneration.current) return false;
        if (applied === false) throw new Error("Mail refresh was superseded");
        setRecoveryRequired(false); setError("");
        return true;
      } catch {
        if (key === currentOwner.current && generation === receiptGeneration.current) setError("Mail could not reload. Retry mail reload.");
        return false;
      } finally {
        if (recoveryAttempt.current === attempt) { recoveryAttempt.current = null; setRecovering(false); }
      }
    })();
    return attempt.promise;
  }
  async function undo() {
    if (!receipt || lock.current || !online) return;
    lock.current = true;
    setBusy(true);
    const generation = receiptGeneration.current;
    try {
      const raw = await attentionRequest(receipt.batch ? "/v1/destinations/routing/batch" : routingUrl(receipt.accountId), {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(receipt.undo),
      });
      if (receipt.batch) destinationBatchResultSchema.parse(raw);
      else if (destinationRoutingResultSchema.parse(raw).state.accountId !== receipt.accountId) throw new Error("Account mismatch");
      if (generation !== receiptGeneration.current) {
        await Promise.all([onRefresh(), refreshDestinations()]);
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
        await Promise.all([onRefresh(), refreshDestinations()]);
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
        begin,
        recoveryRequired,
        recovering,
        requireRecovery: (owner) => {
          if (owner.key === currentOwner.current && owner.generation === receiptGeneration.current) setRecoveryRequired(true);
        },
        recover,
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
              <button disabled={recovering || !online} onClick={() => void recover()}>
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

export function useRoutingUpdates() { return useContext(RoutingContext); }

export function useAttentionRouting(
  accountId: string,
  target: AttentionRoutingTarget,
  enabled = true,
) {
  const context = useContext(RoutingContext);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const online = useOnlineStatus();
  const [state, setState] = useState<DestinationRoutingState | null>(null);
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
          const next = destinationRoutingStateSchema.parse(raw);
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
    !enabled ||
    !online ||
    !state ||
    stateKey.current !== key ||
    stale ||
    readOnly ||
    loading ||
    saving;
  async function save(destinationId: string | null, saveTarget = target) {
    if (locked || lock.current || !state) return false;
    lock.current = true;
    setSaving(true);
    setSaveError("");
    const savedKey = key;
    const receiptOwner = context.begin();
    try {
      const result = destinationRoutingResultSchema.parse(
        await attentionRequest(routingUrl(accountId), {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            expectedRevision: state.revision,
            target: saveTarget,
            destinationId,
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
      if (!mounted.current || activeKey.current !== savedKey) { await context.changed(undefined, receiptOwner); return false; }
      setStale(true);
      await context.changed({
        accountId,
        undo: result.undo,
        text: `${saveTarget.scope === "account" ? "Everyone else" : saveTarget.scope === "sender" ? `Mail from ${saveTarget.address}` : "This conversation"} · ${destinationId === null ? "Inherited choice restored" : routingLabel(destinationId)}.`,
      }, receiptOwner);
      if (!context.provided) setReload((v) => v + 1);
      return true;
    } catch (cause) {
      if (!mounted.current || activeKey.current !== savedKey) { await context.changed(undefined, receiptOwner); return false; }
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
      await context.changed(undefined, receiptOwner);
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
