import { useDestinations } from "./mail-destinations";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AttentionRoutingTarget } from "@orca/shared";
import {
  RoutingErrors,
  routingLabel,
  routingUrl,
  useAttentionRouting,
} from "./attention-routing";
import "./attention-page.css";

type Target = {
  id: string;
  accountId: string;
  threadId: string;
  from: { email: string; name: string | null };
};
export function RoutingChooser({
  message,
  reader = false,
}: {
  message: Target;
  reader?: boolean;
}) {
  const catalog = useDestinations();
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<"conversation" | "sender">("conversation");
  const [userChoice, setChoice] = useState<{ key: string; value: string } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const address = message.from.email.trim().toLowerCase();
  const target: AttentionRoutingTarget =
    scope === "conversation"
      ? { scope, threadId: message.threadId }
      : { scope, address };
  const routing = useAttentionRouting(message.accountId, target, open);
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);
  // Only a click is an explicit choice. A loaded default must follow the fresh
  // read for this opening/target, rather than becoming sticky cached intent.
  const currentBehavior = routing.reliable
    ? routing.state?.selection.effective.destinationId
    : undefined;
  const choiceKey = routingUrl(message.accountId, target);
  const choice = userChoice?.key === choiceKey ? userChoice.value :
    (currentBehavior ?? "");
  function close() {
    dialog.current?.close();
    setOpen(false);
    requestAnimationFrame(() => trigger.current?.focus());
  }
  async function save(value: string | null) {
    const row = trigger.current?.closest(".message-row-wrap");
    const rows = Array.from(document.querySelectorAll(".message-row-wrap"));
    const index = row ? rows.indexOf(row) : -1;
    const next = (
      rows[index + 1] ?? rows[index - 1]
    )?.querySelector<HTMLButtonElement>(".message-row");
    if (await routing.save(value)) {
      close();
      requestAnimationFrame(() => {
        if (!trigger.current?.isConnected)
          (next?.isConnected
            ? next
            : document.querySelector<HTMLElement>(
                '.message-row, .content-pane, [aria-current="page"]',
              )
          )?.focus();
      });
    }
  }
  return (
    <>
      <button
        ref={trigger}
        title={`Tune mail from ${message.from.name ?? address}`}
        className="sender-attention-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Manage mail from ${message.from.name ?? address}`}
        onClick={(event) => {
          event.stopPropagation();
          setScope("conversation");
          setChoice(null);
          setOpen(true);
        }}
        type="button"
      >
        {reader ? (
          "Attention"
        ) : (
          <svg
            aria-hidden="true"
            className="message-action-icon"
            fill="none"
            viewBox="0 0 24 24"
          >
            <path d="M4 7h16M4 12h16M4 17h16" />
            <circle cx="9" cy="7" r="1.8" />
            <circle cx="15" cy="12" r="1.8" />
            <circle cx="10" cy="17" r="1.8" />
          </svg>
        )}
      </button>
      {open &&
        createPortal(
          <dialog
            ref={dialog}
            className="simple-attention-dialog routing-chooser"
            aria-labelledby={`routing-title-${message.id}`}
            onCancel={(event) => {
              event.preventDefault();
              event.stopPropagation();
              close();
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                close();
              }
            }}
            onClick={(event) => {
              event.stopPropagation();
              if (event.target === dialog.current) {
                const box = dialog.current.getBoundingClientRect();
                if (
                  event.clientX < box.left ||
                  event.clientX > box.right ||
                  event.clientY < box.top ||
                  event.clientY > box.bottom
                )
                  close();
              }
            }}
          >
            <h2 id={`routing-title-${message.id}`}>Where this mail belongs</h2>
            <p>Choose a destination for this mail.</p>
            <label>
              Apply to
              <select
                value={scope}
                disabled={routing.saving}
                onChange={(e) => {
                  setScope(e.target.value as "conversation" | "sender");
                  setChoice(null);
                }}
              >
                <option value="conversation">This conversation</option>
                <option value="sender">
                  Existing & future mail from {address}
                </option>
              </select>
            </label>
            {scope === "sender" && (
              <p>
                Only {address} in this account. Explicit conversation choices
                take precedence.
              </p>
            )}
            {routing.loading && <p role="status">Loading current routing…</p>}
            {routing.state && (
              <p className="routing-current">
                Currently{" "}
                {routingLabel(routing.state.selection.effective.destinationId)} ·{" "}
                {routing.state.selection.explicitDestinationId === null
                  ? `Uses your ${routing.state.selection.effective.source === "sender" ? "sender choice" : routing.state.selection.effective.source === "advanced" ? "domain choice" : "default"}`
                  : `Chosen for this ${scope}`}
              </p>
            )}
            <div className="routing-destinations" aria-label="Destination">
              {catalog.active.map(({id: value}) => (
                <button
                  type="button"
                  key={value}
                  disabled={(routing.locked || catalog.locked)}
                  aria-pressed={choice === value}
                  onClick={() => setChoice({ key: choiceKey, value })}
                >
                  {routingLabel(value)}
                </button>
              ))}
            </div>
            {routing.state?.selection.effective.locked && <p role="status">{routing.state.selection.effective.reason}</p>}
            {catalog.error && <p role="alert">{catalog.error}</p>}
            <RoutingErrors routing={routing} />
            <p>
              <a href="/?destination=attention">
                Attention & advanced organization
              </a>
            </p>
            <footer>
              <button type="button" onClick={close}>
                Cancel
              </button>
              <button
                type="button"
                disabled={
                  (routing.locked || catalog.locked) ||
                  routing.state?.selection.explicitDestinationId === null
                }
                onClick={() => void save(null)}
              >
                {routing.state?.selection.inherited.source === "sender"
                  ? "Use sender choice"
                  : routing.state?.selection.inherited.source === "advanced"
                    ? "Use inherited choice"
                    : "Use default"}
              </button>
              <button
                type="button"
                disabled={(routing.locked || catalog.locked) || !choice}
                onClick={() => choice && void save(choice)}
              >
                {routing.saving ? "Saving…" : "Save choice"}
              </button>
            </footer>
          </dialog>,
          document.body,
        )}
    </>
  );
}
