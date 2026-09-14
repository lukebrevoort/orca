import { DestinationManager, useDestinations } from "./mail-destinations";
import { useEffect, useRef, useState } from "react";
import {
  attentionRoutingTargetSchema,
  attentionSenderLookupResultSchema,
  mailAccountPageSchema,
  type MailAccount,
} from "@orca/shared";
import {
  attentionRequest,
  RoutingErrors,
  routingLabel,
  useAttentionRouting,
} from "./attention-routing";
import "./attention-page.css";

export function AttentionPage({
  demoMode = false,
  onAdvanced,
}: {
  demoMode?: boolean;
  onAdvanced: () => void;
}) {
  const catalog = useDestinations();
  const [managing, setManaging] = useState(false);
  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  const [accountId, setAccountId] = useState("");
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [accountsError, setAccountsError] = useState("");
  const [retryAccounts, setRetryAccounts] = useState(0);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<string>("all");
  const [adding, setAdding] = useState(false);
  const [address, setAddress] = useState("");
  const [choice, setChoice] = useState<string>("");
  const [addError, setAddError] = useState("");
  const [candidates, setCandidates] = useState<
    Array<{ address: string; name: string | null }>
  >([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [lookupError, setLookupError] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [lookupRetry, setLookupRetry] = useState(0);
  const routing = useAttentionRouting(
    accountId,
    { scope: "account" },
    !demoMode,
  );
  const dialog = useRef<HTMLDialogElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const pendingSenderFocus = useRef<{
    accountId: string;
    row: Element;
    initialState: typeof routing.state;
  } | null>(null);
  useEffect(() => {
    // Moving to another control cancels the pending focus restoration.
    const onFocus = (event: FocusEvent) => {
      const intent = pendingSenderFocus.current;
      if (intent && event.target instanceof Node && event.target !== document.body
        && !intent.row.contains(event.target)) pendingSenderFocus.current = null;
    };
    document.addEventListener("focusin", onFocus);
    return () => document.removeEventListener("focusin", onFocus);
  }, []);
  useEffect(() => {
    const intent = pendingSenderFocus.current;
    if (!intent) return;
    if (intent.accountId !== accountId) { pendingSenderFocus.current = null; return; }
    // A rejected/ambiguous write is reconciled only against a new reliable GET.
    if (routing.loading || routing.saving || !routing.reliable || !routing.state
      || routing.state === intent.initialState) return;
    pendingSenderFocus.current = null;
    if (!intent.row.isConnected) heading.current?.focus();
  }, [accountId, routing.loading, routing.saving, routing.reliable, routing.state]);
  useEffect(() => {
    const controller = new AbortController();
    setAccountsLoading(true);
    void attentionRequest("/v1/accounts", { signal: controller.signal })
      .then((raw) => {
        if (controller.signal.aborted) return;
        const items = mailAccountPageSchema.parse(raw).items;
        setAccounts(items);
        setAccountsError("");
        setAccountId((current) =>
          items.some((item) => item.id === current)
            ? current
            : (items[0]?.id ?? ""),
        );
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setAccountsError(`Could not load accounts. ${cause.message}`);
      })
      .finally(() => {
        if (!controller.signal.aborted) setAccountsLoading(false);
      });
    return () => controller.abort();
  }, [retryAccounts]);
  useEffect(() => {
    setNames({});
    setCandidates([]);
    pendingSenderFocus.current = null;
    setAdding(false);
    setAddress("");
    setQuery("");
    setFilter("all");
    routing.clearReceipt();
  }, [accountId]);
  useEffect(() => {
    const controller = new AbortController();
    setCandidates([]);
    if (!accountId) return;
    const timer = setTimeout(() => {
      void attentionRequest(
        `/v1/attention/senders?${new URLSearchParams({ accountId, query: adding ? address : query })}`,
        { signal: controller.signal },
      )
        .then((raw) => {
          if (controller.signal.aborted) return;
          const result = attentionSenderLookupResultSchema.parse(raw);
          if (result.accountId !== accountId)
            throw new Error("Account mismatch");
          setCandidates(result.candidates);
          setTruncated(result.truncated);
          setLookupError("");
          setNames((current) => ({
            ...current,
            ...Object.fromEntries(
              result.candidates
                .filter((c) => c.name)
                .map((c) => [c.address, c.name!]),
            ),
          }));
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setLookupError(
              "Sender suggestions are unavailable. You can still enter an email address.",
            );
        });
    }, 180);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [accountId, query, address, adding, lookupRetry]);
  useEffect(() => {
    if (adding) dialog.current?.showModal();
    else dialog.current?.close();
  }, [adding]);
  function closeAdd() {
    dialog.current?.close();
    setAdding(false);
    requestAnimationFrame(() => addButton.current?.focus());
  }
  const locked =
    routing.locked || catalog.locked || accountsLoading || Boolean(accountsError) || demoMode;
  const senders =
    routing.state?.senders.filter((s) => s.scope === "address") ?? [];
  const domains =
    routing.state?.senders.filter((s) => s.scope === "domain") ?? [];
  const visible = senders.filter(
    (s) =>
      (filter === "all" || s.destinationId === filter) &&
      `${names[s.value] ?? ""} ${s.value}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  async function changeSender(
    value: string,
    destinationId: string | null,
  ) {
    const row = document.activeElement?.closest(".simple-attention-row");
    pendingSenderFocus.current = row ? { accountId, row, initialState: routing.state } : null;
    await routing.save(destinationId, { scope: "sender", address: value });
  }

  return (
    <section
      className="simple-attention"
      aria-labelledby="simple-attention-title"
      aria-busy={routing.loading || routing.saving || accountsLoading}
    >
      <header className="simple-attention-intro">
        <span>Your attention, your choice</span>
        <h1 id="simple-attention-title">
          A little less noise.
          <br />
          Room for what matters.
        </h1>
        <p>
          Choose where each sender’s mail belongs.
          <br />
          Your destinations, ready when you are.
        </p>
      </header>
      <div className="simple-attention-account">
        <label>
          For account{" "}
          <select
            aria-label="Attention account"
            value={accountId}
            disabled={accountsLoading || routing.saving || !accounts.length}
            onChange={(event) => setAccountId(event.target.value)}
          >
            {!accounts.length && <option value="">No connected account</option>}
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.email}
              </option>
            ))}
          </select>
        </label>
        <button onClick={() => setManaging(true)}>New / manage destinations</button>
        <button onClick={onAdvanced}>Advanced organization ↗</button>
      </div>
      {accountsError && (
        <p role="alert">
          {accountsError}{" "}
          <button onClick={() => setRetryAccounts((v) => v + 1)}>
            Reload accounts
          </button>
        </p>
      )}
      {accountsLoading && <p role="status">Loading accounts…</p>}
      {!accountsLoading && !accountsError && !accounts.length && (
        <p>
          Connect an account in <a href="/settings#connected">Settings</a> to
          choose where mail goes.
        </p>
      )}
      {demoMode && (
        <p>
          This preview is read-only. Connect an account to save routing choices.
        </p>
      )}
      {managing && <DestinationManager onClose={() => setManaging(false)} onCreated={() => {}} />}
      {catalog.error && <p role="alert">{catalog.error} <button onClick={() => void catalog.refresh().catch(() => {})}>Reload destinations</button></p>}
      <RoutingErrors routing={routing} />
      <div
        className="simple-attention-choices"
        aria-label="Filter sender choices"
      >
        {catalog.active.map(({id: value}) => (
          <button
            key={value}
            aria-pressed={filter === value}
            onClick={() => setFilter(filter === value ? "all" : value)}
          >
            <span aria-hidden="true">{"⌑"}</span>
            <small>
              {routing.state
                ? `${senders.filter((s) => s.destinationId === value).length} ${senders.filter((s) => s.destinationId === value).length === 1 ? "sender" : "senders"}`
                : "Not loaded"}
            </small>
            <strong>{routingLabel(value)}</strong>
            <p>
              Read this mail in {routingLabel(value)}.
            </p>
          </button>
        ))}
      </div>
      <section aria-labelledby="sender-heading">
        <div className="simple-attention-list-heading">
          <h2 id="sender-heading" tabIndex={-1} ref={heading}>
            Your senders
          </h2>
          <button
            ref={addButton}
            disabled={locked}
            onClick={() => {
              setAddError("");
              setChoice("");
              setAdding(true);
            }}
          >
            + Add sender
          </button>
        </div>
        <div className="simple-attention-search">
          <input
            type="search"
            aria-label="Search senders"
            placeholder="Find a person or email address"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button
            aria-pressed={filter === "all"}
            onClick={() => setFilter("all")}
          >
            All senders
          </button>
        </div>
        {routing.loading && <p role="status">Loading choices…</p>}
        {visible.map((sender) => (
          <div className="simple-attention-row" key={sender.value}>
            <span aria-hidden="true" className="simple-attention-avatar">
              {(names[sender.value] ?? sender.value).slice(0, 1).toUpperCase()}
            </span>
            <div className="attention-person">
              <strong>{names[sender.value] ?? sender.value}</strong>
              {names[sender.value] && <small>{sender.value}</small>}
            </div>
            <select
              aria-label={`Destination for ${sender.value}`}
              disabled={locked || !sender.editable}
              value={sender.destinationId}
              onChange={(e) =>
                void changeSender(
                  sender.value,
                  e.target.value,
                )
              }
            >
              {catalog.active.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
              {!catalog.active.some(item => item.id === sender.destinationId) && <option value={sender.destinationId}>Unavailable destination</option>}
            </select>
            <button
              disabled={locked || !sender.editable}
              aria-label={`Reset ${sender.value} to inherited choice`}
              onClick={() => void changeSender(sender.value, null)}
            >
              Reset
            </button>
          </div>
        ))}
        {routing.state && !visible.length && (
          <div className="simple-attention-empty">
            <p>
              {senders.length
                ? "No senders match these filters."
                : "No sender choices yet. Everyone follows the default below unless an advanced rule or conversation choice applies."}
            </p>
            {(query || filter !== "all") && (
              <button
                onClick={() => {
                  setQuery("");
                  setFilter("all");
                }}
              >
                Clear filters
              </button>
            )}
          </div>
        )}
      </section>
      <section className="simple-attention-default">
        <div>
          <h2>Everyone else</h2>
          <p>For mail without a sender, domain, or conversation choice.</p>
        </div>
        <select
          aria-label="Default destination for everyone else"
          value={routing.state?.defaultDestinationId ?? "inherit"}
          disabled={locked}
          onChange={(e) =>
            void routing.save(
              e.target.value === "inherit"
                ? null
                : (e.target.value),
            )
          }
        >
          <option value="inherit">Workspace default · {routingLabel(catalog.data?.fallbackDestinationId)}</option>
          {catalog.active.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </section>
      {domains.length > 0 && (
        <details className="attention-domain-rules">
          <summary>{domains.length} domain rules · Advanced</summary>
          {domains.map((rule) => (
            <p key={rule.value}>
              {rule.value} · {routingLabel(rule.destinationId)}
            </p>
          ))}
          <button onClick={onAdvanced}>Manage advanced organization</button>
        </details>
      )}
      <p className="simple-attention-footnote">
        Counts describe your sender list, not messages. Conversation choices
        take precedence. These choices never delete mail.
      </p>
      <p className="simple-attention-footnote">
        Alerts are separate. Notification delivery is not available yet.
      </p>
      <dialog
        ref={dialog}
        className="simple-attention-dialog"
        aria-labelledby="add-sender-title"
        onCancel={(e) => {
          e.preventDefault();
          e.stopPropagation();
          closeAdd();
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") e.stopPropagation();
        }}
        onClick={(e) => {
          if (e.target === dialog.current) {
            const box = dialog.current.getBoundingClientRect();
            if (
              e.clientX < box.left ||
              e.clientX > box.right ||
              e.clientY < box.top ||
              e.clientY > box.bottom
            )
              closeAdd();
          }
        }}
      >
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const result = attentionRoutingTargetSchema.safeParse({
              scope: "sender",
              address,
            });
            if (!result.success || result.data.scope !== "sender") {
              setAddError("Enter a valid email address.");
              return;
            }
            const senderTarget = result.data;
            if (senders.some((s) => s.value === senderTarget.address)) {
              setAddError(
                "This sender is already on your list. Change their choice there.",
              );
              return;
            }
            if (!choice) { setAddError("Choose a destination."); return; }
            if (await routing.save(choice, result.data)) {
              closeAdd();
              setAddress("");
            }
          }}
        >
          <h2 id="add-sender-title">Add a sender</h2>
          <p>
            Existing and future mail from this exact address in{" "}
            {accounts.find((a) => a.id === accountId)?.email}. Conversation
            choices still take precedence.
          </p>
          <label>
            Email address
            <input
              type="email"
              required
              maxLength={320}
              value={address}
              onChange={(e) => {
                setAddress(e.target.value);
                setAddError("");
              }}
              placeholder="alex@example.com"
            />
          </label>
          {candidates
            .filter((c) => !senders.some((s) => s.value === c.address))
            .slice(0, 6)
            .map((c) => (
              <button
                className="attention-suggestion"
                type="button"
                key={c.address}
                onClick={() => setAddress(c.address)}
              >
                {c.name && <strong>{c.name}</strong>} {c.address}
              </button>
            ))}
          {truncated && <p>More senders available. Narrow your search.</p>}
          {lookupError && (
            <p>
              {lookupError}{" "}
              <button
                type="button"
                onClick={() => setLookupRetry((v) => v + 1)}
              >
                Retry suggestions
              </button>
            </p>
          )}
          <label>
            Destination
            <select
              value={choice}
              onChange={(e) => setChoice(e.target.value)}
            >
              <option value="">Choose destination</option>
              {catalog.active.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          {addError && <p role="alert">{addError}</p>}
          <RoutingErrors routing={routing} />
          <footer>
            <button type="button" onClick={closeAdd}>
              Cancel
            </button>
            <button disabled={locked || !choice} type="submit">
              {routing.saving ? "Saving…" : "Add sender"}
            </button>
          </footer>
        </form>
      </dialog>
    </section>
  );
}
