import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type {
  HumanClassification,
  HumanClassificationOverrideScope,
  InboxMessage,
} from "@orca/shared";

export type ClassificationView = "human" | "tideline" | "uncertain" | "all";

export type ClassificationCounts = {
  likely_human: number;
  automated_or_bulk: number;
  uncertain: number;
  unclassified: number;
  all: number;
};

export type ClassificationCorrectionTarget = {
  scope: HumanClassificationOverrideScope;
  messageId?: string;
  address?: string;
  domain?: string;
};

export const classificationViewItems: Array<{
  id: ClassificationView;
  label: string;
  shortLabel: string;
  description: string;
  countKey: keyof ClassificationCounts;
}> = [
  { id: "human", label: "Human Inbox", shortLabel: "Human", description: "Likely written by a person", countKey: "likely_human" },
  { id: "tideline", label: "Tideline", shortLabel: "Tideline", description: "Automated or bulk mail", countKey: "automated_or_bulk" },
  { id: "uncertain", label: "Review", shortLabel: "Review", description: "Uncertain or needs a look", countKey: "uncertain" },
  { id: "all", label: "All mail", shortLabel: "All", description: "Every effective classification", countKey: "all" },
];

export function classificationViewLabel(view: ClassificationView) {
  return classificationViewItems.find((item) => item.id === view)?.label ?? "Human Inbox";
}

export function classificationLabel(classification: HumanClassification) {
  if (classification === "likely_human") return "Likely human";
  if (classification === "automated_or_bulk") return "Automated or bulk";
  if (classification === "uncertain") return "Uncertain";
  return "Unclassified";
}

export function classificationReasonLabel(reasonCode: string) {
  const labels: Record<string, string> = {
    direct_recipient: "direct recipient",
    reply_context: "reply context",
    sender_no_reply_pattern: "sender pattern",
    list_id_header: "mailing-list header",
    list_unsubscribe_header: "unsubscribe header",
    bulk_precedence_header: "bulk header",
    auto_submitted_header: "automatic header",
    provider_bulk_signal: "provider bulk signal",
    provider_promotions_signal: "promotions signal",
    provider_transactional_signal: "transactional signal",
    conflicting_evidence: "conflicting evidence",
    insufficient_evidence: "not enough evidence",
    user_message_override: "your message correction",
    user_sender_address_override: "your sender correction",
    user_sender_domain_override: "your domain correction",
  };
  return labels[reasonCode] ?? reasonCode.replaceAll("_", " ");
}

export function classificationExplanation(message: Pick<InboxMessage, "humanClassification" | "humanSignal">) {
  const result = message.humanClassification;
  if (!result) return "No classification yet";
  const effective = result.effective;
  const reasons = effective.reasonCodes.slice(0, 2).map(classificationReasonLabel).join(" · ");
  const source = effective.source === "user_override" ? "Your correction" : "Orca estimate";
  const score = effective.score === null ? "no score" : `signal ${effective.score}/10`;
  return `${source} · ${reasons || score}`;
}

export function ClassificationBadge({ message, compact = false }: {
  message: Pick<InboxMessage, "humanClassification" | "humanSignal">;
  compact?: boolean;
}) {
  const classification = message.humanClassification?.effective.classification ?? "unclassified";
  const source = message.humanClassification?.effective.source;
  return (
    <span
      className={`classification-badge classification-badge-${classification}${compact ? " classification-badge-compact" : ""}`}
      title={classificationExplanation(message)}
    >
      <span aria-hidden="true" className="classification-badge-dot" />
      {classificationLabel(classification)}
      {source === "user_override" ? <span className="classification-badge-source">You</span> : null}
    </span>
  );
}

export function ClassificationTabs({
  counts,
  active,
  onChange,
  loading = false,
}: {
  counts: ClassificationCounts;
  active: ClassificationView;
  onChange: (view: ClassificationView) => void;
  loading?: boolean;
}) {
  return (
    <nav aria-label="Inbox classification views" className="classification-tabs">
      <span className="classification-tabs-label">Sort by signal · message counts</span>
      <div className="classification-tab-list" role="tablist">
        {classificationViewItems.map((item) => (
          <button
            aria-label={`${item.label}, ${counts[item.countKey]} messages`}
            aria-controls="classification-panel"
            aria-selected={active === item.id}
            className={active === item.id ? "classification-tab classification-tab-selected" : "classification-tab"}
            disabled={loading}
            id={`classification-tab-${item.id}`}
            key={item.id}
            onClick={() => onChange(item.id)}
            role="tab"
            title={`${item.description} · ${counts[item.countKey]} messages`}
            type="button"
          >
            <span>{item.label}</span>
            <strong>{counts[item.countKey]}</strong>
          </button>
        ))}
      </div>
      <span aria-live="polite" className="classification-tabs-status">{loading ? "Loading view…" : ""}</span>
    </nav>
  );
}

function targetLabel(target: ClassificationCorrectionTarget) {
  if (target.scope === "sender_domain") return "sender domain";
  if (target.scope === "sender_address") return "sender address";
  return "this message";
}

export function ClassificationCorrection({
  message,
  onCorrect,
  compact = false,
}: {
  message: Pick<InboxMessage, "id" | "accountId" | "from" | "humanClassification" | "humanSignal">;
  onCorrect: (target: ClassificationCorrectionTarget, classification: HumanClassification | "reset") => Promise<void>;
  compact?: boolean;
}) {
  const effective = message.humanClassification?.effective.classification ?? "unclassified";
  const override = message.humanClassification?.userOverride ?? message.humanClassification?.effective.userOverride ?? null;
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<ClassificationCorrectionTarget>(() => override?.target ?? { scope: "message", messageId: message.id });
  const [pending, setPending] = useState<HumanClassification | "reset" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLButtonElement | null>(null);
  const menuId = `classification-correction-menu-${useId()}`;
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number; maxHeight: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setMenuPosition(null);
      const trigger = restoreFocusRef.current;
      restoreFocusRef.current = null;
      if (trigger?.isConnected) window.requestAnimationFrame(() => trigger.isConnected && trigger.focus());
      return;
    }

    const menu = menuRef.current;
    const trigger = triggerRef.current;
    if (!menu || !trigger) return;

    const positionMenu = () => {
      const triggerRect = trigger.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const viewportMargin = 12;
      const gap = 8;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const menuWidth = Math.min(menuRect.width || 360, viewportWidth - viewportMargin * 2);
      const belowSpace = Math.max(0, viewportHeight - triggerRect.bottom - gap - viewportMargin);
      const aboveSpace = Math.max(0, triggerRect.top - gap - viewportMargin);
      const flipAbove = belowSpace < Math.min(menuRect.height || 0, 360) && aboveSpace > belowSpace;
      const availableSpace = flipAbove ? aboveSpace : belowSpace;
      const maxHeight = Math.max(120, Math.min(520, availableSpace || viewportHeight - viewportMargin * 2));
      const visibleHeight = Math.min(menuRect.height || maxHeight, maxHeight);
      const requestedTop = flipAbove ? triggerRect.top - gap - visibleHeight : triggerRect.bottom + gap;
      const top = Math.max(viewportMargin, Math.min(requestedTop, viewportHeight - viewportMargin - visibleHeight));
      const requestedLeft = triggerRect.right - menuWidth;
      const left = Math.max(viewportMargin, Math.min(requestedLeft, viewportWidth - viewportMargin - menuWidth));
      setMenuPosition({ top, left, maxHeight });
    };

    positionMenu();
    const onViewportChange = () => positionMenu();
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
    return () => {
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function chooseTarget(scope: HumanClassificationOverrideScope) {
    if (scope === "message") {
      setTarget({ scope, messageId: message.id });
    } else if (scope === "sender_address") {
      setTarget({ scope, address: message.from.email });
    } else {
      setTarget({ scope, domain: message.from.email.split("@").at(-1) ?? "" });
    }
  }

  async function apply(classification: HumanClassification | "reset") {
    setPending(classification);
    setError(null);
    try {
      await onCorrect(target, classification);
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save that correction.");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className={`classification-correction${compact ? " classification-correction-compact" : ""}${open ? " classification-correction-open" : ""}`} ref={wrapperRef}>
      <button
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Correct classification: ${classificationLabel(effective)}`}
        className="classification-correction-trigger"
        ref={triggerRef}
        onClick={(event) => {
          event.stopPropagation();
          if (open) {
            setOpen(false);
            return;
          }
          restoreFocusRef.current = event.currentTarget;
          setMenuPosition(null);
          setOpen(true);
        }}
        type="button"
      >
        <ClassificationBadge compact message={message} />
        <span aria-hidden="true">⌄</span>
      </button>
      {open ? (
        <div
          aria-label="Correct message classification"
          aria-modal="false"
          className="classification-correction-menu"
          id={menuId}
          onClick={(event) => event.stopPropagation()}
          ref={menuRef}
          role="dialog"
          style={{
            left: menuPosition?.left,
            maxHeight: menuPosition?.maxHeight,
            top: menuPosition?.top,
            visibility: menuPosition ? "visible" : "hidden",
          }}
        >
          <header>
            <div>
              <span>Classification</span>
              <strong>{classificationLabel(effective)}</strong>
            </div>
            <button aria-label="Close classification corrections" onClick={() => setOpen(false)} type="button">×</button>
          </header>
          <p className="classification-correction-explanation">{classificationExplanation(message)}</p>
          <fieldset>
            <legend>Apply correction to</legend>
            <div className="classification-target-options">
              {(["message", "sender_address", "sender_domain"] as const).map((scope) => (
                <button
                  aria-pressed={target.scope === scope}
                  className={target.scope === scope ? "classification-target-selected" : ""}
                  key={scope}
                  onClick={() => chooseTarget(scope)}
                  type="button"
                >
                  {scope === "message" ? "This message" : scope === "sender_address" ? "This sender" : "This domain"}
                </button>
              ))}
            </div>
            <small>Applies to {targetLabel(target)} only. It never changes mail at the provider.</small>
          </fieldset>
          <div className="classification-choice-grid">
            <button aria-pressed={effective === "likely_human"} disabled={pending !== null} onClick={() => void apply("likely_human")} type="button"><span>Likely human</span><small>Person signal</small></button>
            <button aria-pressed={effective === "automated_or_bulk"} disabled={pending !== null} onClick={() => void apply("automated_or_bulk")} type="button"><span>Automated or bulk</span><small>Tideline</small></button>
            <button aria-pressed={effective === "uncertain"} disabled={pending !== null} onClick={() => void apply("uncertain")} type="button"><span>Leave uncertain</span><small>Review later</small></button>
          </div>
          <button aria-busy={pending === "reset" || undefined} className="classification-reset" disabled={pending === "reset" || !override} onClick={() => void apply("reset")} type="button">
            {pending === "reset" ? "Resetting…" : "Reset to Orca estimate"}
          </button>
          {error ? <p className="classification-correction-error" role="alert">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
