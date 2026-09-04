import {
  redactState,
  type FeedbackAttachment,
  type FeedbackElementContext,
  type FeedbackKind,
  type FeedbackProject,
  type FeedbackReport,
  type FeedbackScope,
  type FeedbackScoper,
  type FeedbackScopingMessage,
  type FeedbackSeverity,
  type FeedbackSubmissionResult,
  type FeedbackSubmitter,
} from "@feedback-kit/core";
import {
  type ChangeEvent,
  type ClipboardEvent,
  type CSSProperties,
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  capturePageScreenshot,
  collectRuntimeContext,
  describeElement,
  fileToAttachment,
} from "./capture";
import {
  CameraIcon,
  CheckIcon,
  CloseIcon,
  MessageIcon,
  PaperclipIcon,
  TargetIcon,
} from "./icons";
import { ScopingConversation } from "./ScopingConversation";
import "./styles.css";

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_ATTACHMENTS = 4;

const KIND_COPY: Record<
  FeedbackKind,
  { title: string; description: string; action: string }
> = {
  bug: {
    title: "What broke?",
    description: "What did you expect, and what happened instead?",
    action: "Scope bug",
  },
  idea: {
    title: "What should we improve?",
    description: "What would this help you accomplish?",
    action: "Shape idea",
  },
  question: {
    title: "What do you need help with?",
    description: "Share where you got stuck and what you already tried.",
    action: "Clarify question",
  },
  other: {
    title: "What would you like us to know?",
    description: "Add the context that would help us understand.",
    action: "Review feedback",
  },
};

export interface FeedbackWidgetProps {
  project: FeedbackProject;
  endpoint?: string;
  submitFeedback?: FeedbackSubmitter;
  scopeFeedback?: FeedbackScoper;
  getState?: () => unknown | Promise<unknown>;
  metadata?: Record<string, unknown> | (() => Record<string, unknown>);
  reporter?: { id?: string; name?: string; email?: string };
  redactKeys?: string[];
  requestHeaders?: Record<string, string>;
  enabled?: boolean;
  defaultScreenshot?: boolean;
  position?: "bottom-right" | "bottom-left";
  accentColor?: string;
  captureTarget?: () => HTMLElement;
  maxSelectedElements?: number;
  onSubmitted?: (result: FeedbackSubmissionResult) => void;
}

type Status =
  | { type: "idle" }
  | { type: "capturing"; message: string }
  | { type: "scoping"; message: string }
  | { type: "submitting"; message: string }
  | { type: "error"; message: string }
  | { type: "success"; result: FeedbackSubmissionResult };

async function defaultSubmit(
  endpoint: string,
  report: FeedbackReport,
  headers: Record<string, string>,
): Promise<FeedbackSubmissionResult> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(report),
  });
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
    result?: FeedbackSubmissionResult;
  };
  if (!response.ok || !body.result) {
    throw new Error(body.error ?? `Feedback request failed (${response.status}).`);
  }
  return body.result;
}

export function FeedbackWidget({
  project,
  endpoint = "/api/feedback",
  submitFeedback,
  scopeFeedback,
  getState,
  metadata,
  reporter,
  redactKeys,
  requestHeaders = {},
  enabled = true,
  defaultScreenshot = true,
  position = "bottom-right",
  accentColor = "#7c5cff",
  captureTarget,
  maxSelectedElements = 8,
  onSubmitted,
}: FeedbackWidgetProps) {
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [kind, setKind] = useState<FeedbackKind>("bug");
  const [severity, setSeverity] = useState<FeedbackSeverity>("normal");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [attachments, setAttachments] = useState<FeedbackAttachment[]>([]);
  const [elements, setElements] = useState<FeedbackElementContext[]>([]);
  const [status, setStatus] = useState<Status>({ type: "idle" });
  const [stage, setStage] = useState<"report" | "scope">("report");
  const [draftReport, setDraftReport] = useState<FeedbackReport>();
  const [scopingMessages, setScopingMessages] = useState<
    FeedbackScopingMessage[]
  >([]);
  const [agentScope, setAgentScope] = useState<FeedbackScope>();
  const [scopeComplete, setScopeComplete] = useState(false);
  const [scopeReply, setScopeReply] = useState("");
  const titleRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const style = { "--feedback-accent": accentColor } as CSSProperties;
  const kindCopy = KIND_COPY[kind];
  const isBusy =
    status.type === "capturing" ||
    status.type === "scoping" ||
    status.type === "submitting";

  const captureScreenshot = useCallback(async () => {
    setStatus({ type: "capturing", message: "Capturing this screen…" });
    try {
      const attachment = await capturePageScreenshot(
        captureTarget?.() ?? document.body,
      );
      setAttachments((current) =>
        [
          attachment,
          ...current.filter((item) => item.source !== "automatic-screenshot"),
        ].slice(0, MAX_ATTACHMENTS),
      );
      setStatus({ type: "idle" });
    } catch (error) {
      setStatus({
        type: "error",
        message:
          error instanceof Error ? error.message : "Could not capture the screen.",
      });
    }
  }, [captureTarget]);

  const openWidget = useCallback(() => {
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : triggerRef.current;
    setOpen(true);
    setStatus({ type: "idle" });
    if (
      defaultScreenshot &&
      !attachments.some((item) => item.source === "automatic-screenshot")
    ) {
      window.setTimeout(() => void captureScreenshot(), 80);
    }
  }, [attachments, captureScreenshot, defaultScreenshot]);

  const closeWidget = useCallback(() => {
    setOpen(false);
    window.setTimeout(() => returnFocusRef.current?.focus(), 0);
  }, []);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusTarget =
      stage === "report" ? titleRef.current : dialogRef.current;
    focusTarget?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeWidget();
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [closeWidget, open, stage]);

  useEffect(() => {
    if (!picking) return;
    const overlay = document.createElement("div");
    overlay.className = "feedback-kit-element-overlay";
    overlay.setAttribute("data-feedback-kit-root", "");
    document.body.append(overlay);
    overlayRef.current = overlay;

    const move = (event: PointerEvent) => {
      const target = document.elementFromPoint(event.clientX, event.clientY);
      if (!target || target.closest("[data-feedback-kit-root]")) return;
      const rect = target.getBoundingClientRect();
      Object.assign(overlay.style, {
        display: "block",
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      });
    };
    const choose = (event: MouseEvent) => {
      const target = document.elementFromPoint(event.clientX, event.clientY);
      if (!target || target.closest("[data-feedback-kit-root]")) return;
      event.preventDefault();
      event.stopPropagation();
      const selected = describeElement(target);
      setElements((current) => {
        if (
          current.some((item) => item.selector === selected.selector) ||
          current.length >= maxSelectedElements
        ) {
          return current;
        }
        return [...current, selected];
      });
    };
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPicking(false);
        setOpen(true);
      }
    };

    document.addEventListener("pointermove", move, true);
    document.addEventListener("click", choose, true);
    document.addEventListener("keydown", cancel, true);
    return () => {
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("click", choose, true);
      document.removeEventListener("keydown", cancel, true);
      overlay.remove();
      overlayRef.current = null;
    };
  }, [maxSelectedElements, picking]);

  const addFiles = useCallback(
    async (files: File[], source: "upload" | "clipboard") => {
      const images = files.filter((file) => file.type.startsWith("image/"));
      const accepted = images.filter((file) => file.size <= MAX_ATTACHMENT_BYTES);
      const availableSlots = Math.max(0, MAX_ATTACHMENTS - attachments.length);

      if (images.length !== files.length) {
        setStatus({ type: "error", message: "Only image attachments are supported." });
      } else if (accepted.length !== images.length) {
        setStatus({
          type: "error",
          message: "Each image must be smaller than 8 MB.",
        });
      } else if (accepted.length > availableSlots || availableSlots === 0) {
        setStatus({
          type: "error",
          message: `You can attach up to ${MAX_ATTACHMENTS} images.`,
        });
      } else {
        setStatus({ type: "idle" });
      }

      const converted = await Promise.all(
        accepted
          .slice(0, availableSlots)
          .map((file) => fileToAttachment(file, source)),
      );
      setAttachments((current) =>
        [...current, ...converted].slice(0, MAX_ATTACHMENTS),
      );
    },
    [attachments.length],
  );

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    void addFiles(Array.from(event.target.files ?? []), "upload");
    event.target.value = "";
  };

  const onPaste = (event: ClipboardEvent<HTMLFormElement>) => {
    const imageFiles = Array.from(event.clipboardData.files).filter((file) =>
      file.type.startsWith("image/"),
    );
    if (imageFiles.length > 0) {
      event.preventDefault();
      void addFiles(imageFiles, "clipboard");
    }
  };

  const reset = () => {
    setTitle("");
    setDescription("");
    setKind("bug");
    setSeverity("normal");
    setAttachments([]);
    setElements([]);
    setStage("report");
    setDraftReport(undefined);
    setScopingMessages([]);
    setAgentScope(undefined);
    setScopeComplete(false);
    setScopeReply("");
    setStatus({ type: "idle" });
  };

  const submitReport = async (report: FeedbackReport) => {
    setStatus({ type: "submitting", message: "Creating the report…" });
    try {
      const result = submitFeedback
        ? await submitFeedback(report)
        : await defaultSubmit(endpoint, report, requestHeaders);
      setStatus({ type: "success", result });
      onSubmitted?.(result);
    } catch (error) {
      setStatus({
        type: "error",
        message:
          error instanceof Error ? error.message : "Could not submit feedback.",
      });
    }
  };

  const beginScoping = async (report: FeedbackReport) => {
    if (!scopeFeedback) {
      await submitReport(report);
      return;
    }
    setDraftReport(report);
    setStage("scope");
    setStatus({ type: "scoping", message: "Reviewing the report…" });
    try {
      const result = await scopeFeedback(report, []);
      const assistantMessage: FeedbackScopingMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: result.message,
      };
      setScopingMessages([assistantMessage]);
      setAgentScope(result.scope);
      setScopeComplete(result.complete);
      setStatus({ type: "idle" });
    } catch (error) {
      setStatus({
        type: "error",
        message:
          error instanceof Error ? error.message : "Could not scope the report.",
      });
    }
  };

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() || !description.trim()) return;
    setStatus({ type: "submitting", message: "Preparing the report…" });
    try {
      const rawState = getState ? await getState() : undefined;
      const report: FeedbackReport = {
        schemaVersion: 1,
        id: crypto.randomUUID(),
        project,
        kind,
        severity,
        title: title.trim(),
        description: description.trim(),
        ...(reporter ? { reporter } : {}),
        context: collectRuntimeContext(),
        elements,
        ...(rawState === undefined
          ? {}
          : { state: redactState(rawState, { keys: redactKeys }) }),
        metadata: typeof metadata === "function" ? metadata() : metadata,
        attachments,
      };
      await beginScoping(report);
    } catch (error) {
      setStatus({
        type: "error",
        message:
          error instanceof Error ? error.message : "Could not prepare feedback.",
      });
    }
  };

  const replyToScoper = async () => {
    if (!draftReport || !scopeFeedback || !scopeReply.trim()) return;
    const userMessage: FeedbackScopingMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: scopeReply.trim(),
    };
    const nextMessages = [...scopingMessages, userMessage];
    setScopingMessages(nextMessages);
    setScopeReply("");
    setStatus({ type: "scoping", message: "Updating the issue brief…" });
    try {
      const result = await scopeFeedback(draftReport, nextMessages);
      setScopingMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: result.message,
        },
      ]);
      setAgentScope(result.scope);
      setScopeComplete(result.complete);
      setStatus({ type: "idle" });
    } catch (error) {
      setStatus({
        type: "error",
        message:
          error instanceof Error ? error.message : "Could not continue scoping.",
      });
    }
  };

  const createScopedTicket = () => {
    if (!draftReport) return;
    void submitReport({
      ...draftReport,
      ...(agentScope ? { scope: agentScope } : {}),
      scopingConversation: scopingMessages,
    });
  };

  if (!enabled) return null;

  return (
    <div
      className={`feedback-kit-root feedback-kit-${position}`}
      data-feedback-kit-root
      style={style}
    >
      {picking ? (
        <>
          {elements.map((selected, index) => (
            <div
              className="feedback-kit-selected-overlay"
              key={selected.selector}
              style={{
                height: selected.bounds.height,
                left: selected.bounds.x,
                top: selected.bounds.y,
                width: selected.bounds.width,
              }}
            >
              <span>{index + 1}</span>
            </div>
          ))}
          <div className="feedback-kit-picker-hint" role="status">
            <TargetIcon />
            <span>
              Select elements · {elements.length}/{maxSelectedElements}
            </span>
            <button
              onClick={() => {
                setPicking(false);
                setOpen(true);
              }}
              type="button"
            >
              Done
            </button>
            <kbd>esc</kbd>
          </div>
        </>
      ) : null}

      {open ? (
        <div className="feedback-kit-backdrop" onMouseDown={closeWidget}>
          <section
            aria-labelledby="feedback-kit-title"
            aria-modal="true"
            aria-busy={isBusy}
            className="feedback-kit-panel"
            onMouseDown={(event) => event.stopPropagation()}
            ref={dialogRef}
            role="dialog"
            tabIndex={-1}
          >
            {status.type === "success" ? (
              <div className="feedback-kit-success">
                <div className="feedback-kit-success-icon">
                  <CheckIcon />
                </div>
                <p className="feedback-kit-eyebrow">REPORT SENT</p>
                <h2>Thanks for making this better.</h2>
                <p>
                  {status.result.identifier
                    ? `${status.result.identifier} is ready to review.`
                    : "Your feedback has been captured."}
                </p>
                <div className="feedback-kit-success-actions">
                  {status.result.url ? (
                    <a href={status.result.url} rel="noreferrer" target="_blank">
                      Open ticket
                    </a>
                  ) : null}
                  <button
                    onClick={() => {
                      reset();
                      closeWidget();
                    }}
                    type="button"
                  >
                    Done
                  </button>
                </div>
              </div>
            ) : stage === "scope" ? (
              <ScopingConversation
                busy={status.type === "scoping" || status.type === "submitting"}
                complete={scopeComplete}
                error={status.type === "error" ? status.message : undefined}
                messages={scopingMessages}
                onBack={() => {
                  setStage("report");
                  setStatus({ type: "idle" });
                }}
                onClose={closeWidget}
                onCreate={createScopedTicket}
                onReply={() => void replyToScoper()}
                onReplyChange={setScopeReply}
                projectName={project.name}
                reply={scopeReply}
                scope={agentScope}
              />
            ) : (
              <>
                <header className="feedback-kit-header">
                  <div>
                    <p className="feedback-kit-eyebrow">{project.name}</p>
                    <h2 id="feedback-kit-title">Share feedback</h2>
                  </div>
                  <button
                    aria-label="Close feedback"
                    className="feedback-kit-icon-button"
                    onClick={closeWidget}
                    type="button"
                  >
                    <CloseIcon />
                  </button>
                </header>

                <form onPaste={onPaste} onSubmit={onSubmit}>
                  <div className="feedback-kit-kind-row" role="group" aria-label="Feedback type">
                    {(["bug", "idea", "question", "other"] as const).map((value) => (
                      <button
                        aria-pressed={kind === value}
                        className={kind === value ? "is-active" : ""}
                        key={value}
                        onClick={() => setKind(value)}
                        type="button"
                      >
                        {value}
                      </button>
                    ))}
                  </div>

                  <label className="feedback-kit-field">
                    <span>{kindCopy.title}</span>
                    <input
                      aria-describedby="feedback-kit-title-count"
                      maxLength={120}
                      onChange={(event) => setTitle(event.target.value)}
                      placeholder="A short, specific summary"
                      ref={titleRef}
                      required
                      value={title}
                    />
                    <small className="feedback-kit-character-count" id="feedback-kit-title-count">
                      {title.length}/120
                    </small>
                  </label>

                  <label className="feedback-kit-field">
                    <span>Details</span>
                    <textarea
                      aria-describedby="feedback-kit-description-count"
                      maxLength={4_000}
                      onChange={(event) => setDescription(event.target.value)}
                      placeholder={kindCopy.description}
                      required
                      rows={5}
                      value={description}
                    />
                    <small
                      className="feedback-kit-character-count"
                      id="feedback-kit-description-count"
                    >
                      {description.length}/4000
                    </small>
                  </label>

                  <div className="feedback-kit-severity">
                    <span>Impact</span>
                    <select
                      aria-label="Impact"
                      onChange={(event) =>
                        setSeverity(event.target.value as FeedbackSeverity)
                      }
                      value={severity}
                    >
                      <option value="low">Low — small annoyance</option>
                      <option value="normal">Normal — workflow affected</option>
                      <option value="high">High — task blocked</option>
                      <option value="urgent">Urgent — app unusable</option>
                    </select>
                  </div>

                  <div className="feedback-kit-context">
                    <div className="feedback-kit-context-copy">
                      <span>Helpful context</span>
                      <small>
                        {attachments.length} image{attachments.length === 1 ? "" : "s"} ·{" "}
                        {elements.length} element{elements.length === 1 ? "" : "s"} · app state
                      </small>
                    </div>
                    <div className="feedback-kit-context-actions">
                      <button
                        className={attachments.some(
                          (item) => item.source === "automatic-screenshot",
                        ) ? "has-value" : ""}
                        disabled={status.type === "capturing"}
                        onClick={() => void captureScreenshot()}
                        type="button"
                      >
                        <CameraIcon />
                        Screen
                      </button>
                      <button
                        className={elements.length > 0 ? "has-value" : ""}
                        onClick={() => {
                          setOpen(false);
                          setPicking(true);
                        }}
                        type="button"
                      >
                        <TargetIcon />
                        Element
                      </button>
                      <label className="feedback-kit-attach-button">
                        <PaperclipIcon />
                        Image
                        <input
                          accept="image/*"
                          multiple
                          onChange={onFileChange}
                          type="file"
                        />
                      </label>
                    </div>
                  </div>

                  {attachments.length > 0 || elements.length > 0 ? (
                    <div className="feedback-kit-chips">
                      {elements.map((selected, index) => (
                        <button
                          key={selected.selector}
                          onClick={() =>
                            setElements((current) =>
                              current.filter(
                                (item) => item.selector !== selected.selector,
                              ),
                            )
                          }
                          type="button"
                        >
                          <TargetIcon />
                          {index + 1}. {selected.selector}
                          <CloseIcon />
                        </button>
                      ))}
                      {attachments.map((attachment) => (
                        <button
                          key={attachment.id}
                          onClick={() =>
                            setAttachments((current) =>
                              current.filter((item) => item.id !== attachment.id),
                            )
                          }
                          type="button"
                        >
                          <CameraIcon />
                          {attachment.name}
                          <CloseIcon />
                        </button>
                      ))}
                    </div>
                  ) : null}

                  {status.type === "error" ? (
                    <p className="feedback-kit-error" role="alert">
                      {status.message}
                    </p>
                  ) : null}

                  <footer className="feedback-kit-footer">
                    <span>
                      {status.type === "capturing"
                        ? status.message
                        : "Paste an image anywhere in this form"}
                    </span>
                    <button
                      className="feedback-kit-submit"
                      disabled={
                        status.type === "submitting" ||
                        !title.trim() ||
                        !description.trim()
                      }
                      type="submit"
                    >
                      {status.type === "submitting"
                        ? status.message
                        : scopeFeedback
                          ? kindCopy.action
                          : "Send report"}
                    </button>
                  </footer>
                </form>
              </>
            )}
          </section>
        </div>
      ) : null}

      {!open && !picking ? (
        <button
          aria-label="Send feedback"
          className="feedback-kit-trigger"
          onClick={openWidget}
          ref={triggerRef}
          type="button"
        >
          <MessageIcon />
          <span>Feedback</span>
        </button>
      ) : null}
    </div>
  );
}
