import type {
  FeedbackScope,
  FeedbackScopingMessage,
} from "@feedback-kit/core";
import type { FormEvent } from "react";
import { CheckIcon, CloseIcon, MessageIcon } from "./icons";

interface ScopingConversationProps {
  projectName: string;
  messages: FeedbackScopingMessage[];
  scope?: FeedbackScope;
  complete: boolean;
  reply: string;
  busy: boolean;
  error?: string;
  onReplyChange: (value: string) => void;
  onReply: () => void;
  onCreate: () => void;
  onBack: () => void;
  onClose: () => void;
}

export function ScopingConversation({
  projectName,
  messages,
  scope,
  complete,
  reply,
  busy,
  error,
  onReplyChange,
  onReply,
  onCreate,
  onBack,
  onClose,
}: ScopingConversationProps) {
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (reply.trim() && !busy) onReply();
  };

  return (
    <>
      <header className="feedback-kit-header">
        <div>
          <p className="feedback-kit-eyebrow">{projectName} · issue scoper</p>
          <h2 id="feedback-kit-title">Sharpen the report</h2>
        </div>
        <button
          aria-label="Close feedback"
          className="feedback-kit-icon-button"
          onClick={onClose}
          type="button"
        >
          <CloseIcon />
        </button>
      </header>

      <div className="feedback-kit-agent-intro">
        <MessageIcon />
        <p>
          A short conversation turns your capture into reproduction steps and
          acceptance criteria.
        </p>
      </div>

      <div aria-live="polite" className="feedback-kit-conversation">
        {messages.map((message) => (
          <div
            className={`feedback-kit-message feedback-kit-message-${message.role}`}
            key={message.id}
          >
            <span>{message.role === "assistant" ? "SCOPER" : "YOU"}</span>
            <p>{message.content}</p>
          </div>
        ))}
        {busy ? (
          <div className="feedback-kit-message feedback-kit-message-assistant is-thinking">
            <span>SCOPER</span>
            <p>Reviewing the evidence…</p>
          </div>
        ) : null}
      </div>

      {scope ? (
        <div className={`feedback-kit-scope-preview${complete ? " is-ready" : ""}`}>
          <div>
            <CheckIcon />
            <span>{complete ? "Issue brief ready" : "Issue brief in progress"}</span>
          </div>
          <strong>{scope.title}</strong>
          <small>
            {scope.reproductionSteps.length} reproduction steps ·{" "}
            {scope.acceptanceCriteria.length} acceptance criteria ·{" "}
            {scope.confidence} confidence
          </small>
        </div>
      ) : null}

      <form className="feedback-kit-reply-form" onSubmit={onSubmit}>
        <label className="feedback-kit-field">
          <span>{complete ? "Scoping complete" : "Your reply"}</span>
          <textarea
            disabled={complete}
            maxLength={4_000}
            onChange={(event) => onReplyChange(event.target.value)}
            placeholder={
              complete
                ? "The issue brief has enough detail to create."
                : "Add the missing detail…"
            }
            rows={3}
            value={reply}
          />
        </label>
        {error ? (
          <p className="feedback-kit-error" role="alert">
            {error}
          </p>
        ) : null}
        <button
          className="feedback-kit-agent-reply"
          disabled={complete || !reply.trim() || busy}
          type="submit"
        >
          {complete ? "Ready" : "Send reply"}
        </button>
      </form>

      <footer className="feedback-kit-scope-footer">
        <button onClick={onBack} type="button">
          Back to report
        </button>
        <button
          className="feedback-kit-submit"
          disabled={busy}
          onClick={onCreate}
          type="button"
        >
          {scope ? "Create scoped ticket" : "Skip & create ticket"}
        </button>
      </footer>
    </>
  );
}
