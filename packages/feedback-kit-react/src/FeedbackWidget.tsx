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
  const [scopeReply, setScopeReply] = useState("");
  const titleRef = useRef<HTMLInputElement>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const style = { "--feedback-accent": accentColor } as CSSProperties;

  const captureScreenshot = useCallback(async () => {
    setStatus({ type: "capturing", message: "Capturing this screen…" });
    try {
      const attachment = await capturePageScreenshot(
        captureTarget?.() ?? document.body,
      );
      setAttachments((current) => [
        attachment,
        ...current.filter((item) => item.source !== "automatic-screenshot"),
      ]);
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
    setOpen(true);
    setStatus({ type: "idle" });
    if (defaultScreenshot) {
      window.setTimeout(() => void captureScreenshot(), 80);
    }
  }, [captureScreenshot, defaultScreenshot]);

  useEffect(() => {
    if (!open) return;
    titleRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

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

  const addFiles = useCallback(async (files: File[], source: "upload" | "clipboard") => {
    const accepted = files
      .filter((file) => file.type.startsWith("image/"))
      .filter((file) => file.size <= MAX_ATTACHMENT_BYTES)
      .slice(0, MAX_ATTACHMENTS);
    const converted = await Promise.all(
      accepted.map((file) => fileToAttachment(file, source)),
    );
    setAttachments((current) =>
      [...current, ...converted].slice(0, MAX_ATTACHMENTS),
    );
  }, []);

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    void addFiles(Array.from(event.target.files ?? []), "upload");
    event.target.value = "";
  };

  const onPaste = (event: ClipboardEvent<HTMLFormElement>) => {
    const imageFiles = Array.from(event.clipboardData.files).filter((file) =>
      file.type.startsWith("image/"),
    );
    if (imageFiles.length > 0) void addFiles(imageFiles, "clipboard");
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
        <div className="feedback-kit-backdrop" onMouseDown={() => setOpen(false)}>
          <section
            aria-labelledby="feedback-kit-title"
            aria-modal="true"
            className="feedback-kit-panel"
            onMouseDown={(event) => event.stopPropagation()}
            role="dialog"
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
                    ? `${status.result.identifier} is ready in Linear.`
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
                      setOpen(false);
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
                error={status.type === "error" ? status.message : undefined}
                messages={scopingMessages}
                onBack={() => {
                  setStage("report");
                  setStatus({ type: "idle" });
                }}
                onClose={() => setOpen(false)}
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
                    onClick={() => setOpen(false)}
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
                    <span>What happened?</span>
                    <input
                      maxLength={120}
                      onChange={(event) => setTitle(event.target.value)}
                      placeholder="A short, specific summary"
                      ref={titleRef}
                      required
                      value={title}
                    />
                  </label>

                  <label className="feedback-kit-field">
                    <span>Tell us more</span>
                    <textarea
                      maxLength={4_000}
                      onChange={(event) => setDescription(event.target.value)}
                      placeholder="What did you expect? What did you see instead?"
                      required
                      rows={5}
                      value={description}
                    />
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
                      <small>Screen, app state, and selected UI</small>
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
                          ? "Scope with agent"
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
          type="button"
        >
          <MessageIcon />
          <span>Feedback</span>
        </button>
      ) : null}
    </div>
  );
}
