import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { InboxMessage, MailContact } from "@orca/shared";

export type RecipientKind = "to" | "cc" | "bcc";
export type ComposeSaveStatus = "saved" | "saving" | "failed";

export type ComposeDraft = {
  id: string;
  accountId: string;
  to: MailContact[];
  cc: MailContact[];
  bcc: MailContact[];
  subject: string;
  body: string;
  updatedAt: string;
};

type ComposeDraftController = {
  draft: ComposeDraft;
  saveStatus: ComposeSaveStatus;
  hasContent: boolean;
  updateDraft: (update: Partial<Pick<ComposeDraft, "to" | "cc" | "bcc" | "subject" | "body">>) => void;
  discardDraft: () => void;
};

const EMAIL_PATTERN = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const SAVE_DELAY_MS = 420;

function draftStorageKey(accountId: string) {
  return `orca-compose-draft:${accountId}`;
}

export function createEmptyComposeDraft(accountId: string): ComposeDraft {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `draft-${Date.now()}`,
    accountId,
    to: [],
    cc: [],
    bcc: [],
    subject: "",
    body: "",
    updatedAt: new Date().toISOString(),
  };
}

export function hasComposeContent(draft: ComposeDraft) {
  return draft.to.length + draft.cc.length + draft.bcc.length > 0
    || Boolean(draft.subject.trim())
    || Boolean(draft.body.trim());
}

export function isValidEmail(value: string) {
  return EMAIL_PATTERN.test(value.trim());
}

export function parseRecipientText(value: string): MailContact[] {
  const seen = new Set<string>();
  return value
    .split(/[\n,;]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = part.match(/^(.*?)\s*<([^<>]+)>$/);
      return match
        ? { name: match[1]!.trim().replace(/^['"]|['"]$/g, "") || null, email: match[2]!.trim().toLowerCase() }
        : { name: null, email: part.toLowerCase() };
    })
    .filter((contact) => {
      if (!isValidEmail(contact.email) || seen.has(contact.email)) return false;
      seen.add(contact.email);
      return true;
    });
}

export function collectComposeContacts(messages: InboxMessage[], accountEmail: string) {
  const contacts = new Map<string, MailContact>();
  for (const message of messages) {
    const email = message.from.email.trim().toLowerCase();
    if (!email || email === accountEmail.trim().toLowerCase()) continue;
    const existing = contacts.get(email);
    if (!existing || (!existing.name && message.from.name)) contacts.set(email, { ...message.from, email });
  }
  return [...contacts.values()].sort((a, b) => (a.name ?? a.email).localeCompare(b.name ?? b.email));
}

export function readComposeDraft(accountId: string, storage?: Pick<Storage, "getItem">): ComposeDraft {
  const fallback = createEmptyComposeDraft(accountId);
  if (!storage) return fallback;
  try {
    const parsed = JSON.parse(storage.getItem(draftStorageKey(accountId)) ?? "null") as Partial<ComposeDraft> | null;
    if (!parsed || parsed.accountId !== accountId || typeof parsed.id !== "string") return fallback;
    return {
      ...fallback,
      ...parsed,
      to: Array.isArray(parsed.to) ? parsed.to.filter((contact) => isValidEmail(contact.email)) : [],
      cc: Array.isArray(parsed.cc) ? parsed.cc.filter((contact) => isValidEmail(contact.email)) : [],
      bcc: Array.isArray(parsed.bcc) ? parsed.bcc.filter((contact) => isValidEmail(contact.email)) : [],
      subject: typeof parsed.subject === "string" ? parsed.subject : "",
      body: typeof parsed.body === "string" ? parsed.body : "",
    };
  } catch {
    return fallback;
  }
}

export function useComposeDraft(accountId: string): ComposeDraftController {
  const [draft, setDraft] = useState(() => readComposeDraft(accountId, typeof window === "undefined" ? undefined : window.localStorage));
  const [saveStatus, setSaveStatus] = useState<ComposeSaveStatus>("saved");
  const persistedDraftRef = useRef(JSON.stringify(draft));
  const accountIdRef = useRef(accountId);

  useEffect(() => {
    if (accountIdRef.current === accountId) return;
    accountIdRef.current = accountId;
    const restored = readComposeDraft(accountId, typeof window === "undefined" ? undefined : window.localStorage);
    persistedDraftRef.current = JSON.stringify(restored);
    setDraft(restored);
    setSaveStatus("saved");
  }, [accountId]);

  useEffect(() => {
    const serialized = JSON.stringify(draft);
    if (serialized === persistedDraftRef.current) return;
    setSaveStatus("saving");
    const timer = window.setTimeout(() => {
      try {
        window.localStorage.setItem(draftStorageKey(accountId), serialized);
        persistedDraftRef.current = serialized;
        setSaveStatus("saved");
      } catch {
        setSaveStatus("failed");
      }
    }, SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [accountId, draft]);

  const hasContent = hasComposeContent(draft);
  useEffect(() => {
    if (!hasContent || saveStatus === "saved") return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [hasContent, saveStatus]);

  function updateDraft(update: Partial<Pick<ComposeDraft, "to" | "cc" | "bcc" | "subject" | "body">>) {
    setDraft((current) => ({ ...current, ...update, updatedAt: new Date().toISOString() }));
  }

  function discardDraft() {
    const empty = createEmptyComposeDraft(accountId);
    window.localStorage.removeItem(draftStorageKey(accountId));
    persistedDraftRef.current = JSON.stringify(empty);
    setDraft(empty);
    setSaveStatus("saved");
  }

  return { draft, saveStatus, hasContent, updateDraft, discardDraft };
}

const slashCommands = [
  { id: "heading", label: "Heading", hint: "A clear section break", prefix: "## " },
  { id: "bullets", label: "Bulleted list", hint: "Turn thoughts into points", prefix: "- " },
  { id: "numbered", label: "Numbered list", hint: "Give ideas an order", prefix: "1. " },
  { id: "quote", label: "Quote", hint: "Set a passage apart", prefix: "> " },
  { id: "divider", label: "Divider", hint: "Create a quiet pause", prefix: "---\n" },
] as const;

export function ComposeWorkspace({
  controller,
  contacts,
  autoFocusTo = false,
  variant = "panel",
  onExitZen,
  onClose,
}: {
  controller: ComposeDraftController;
  contacts: MailContact[];
  autoFocusTo?: boolean;
  variant?: "panel" | "zen";
  onExitZen?: () => void;
  onClose?: () => void;
}) {
  const { draft, saveStatus, hasContent, updateDraft, discardDraft } = controller;
  const [showCarbonCopy, setShowCarbonCopy] = useState(draft.cc.length + draft.bcc.length > 0);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const slashQuery = getSlashQuery(draft.body, bodyRef.current?.selectionStart ?? draft.body.length);
  const filteredCommands = slashQuery === null ? [] : slashCommands.filter((command) => command.label.toLowerCase().includes(slashQuery));
  const contactsLabel = contacts.length === 1 ? "1 contact" : `${contacts.length} contacts`;
  const deliveryReason = draft.to.length === 0
    ? "Add at least one valid recipient to prepare this message."
    : "Sending needs Gmail send access. This account is connected read-only, so your draft stays safely saved in Orca.";

  useEffect(() => {
    if (variant === "zen") bodyRef.current?.focus();
  }, [variant]);

  function closeOrDiscard() {
    if (!hasContent) {
      onClose?.();
      return;
    }
    if (window.confirm("Discard this saved draft? This cannot be undone.")) {
      discardDraft();
      onClose?.();
    }
  }

  function formatSelection(prefix: string, suffix = "") {
    const textarea = bodyRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = draft.body.slice(start, end);
    updateDraft({ body: `${draft.body.slice(0, start)}${prefix}${selected}${suffix}${draft.body.slice(end)}` });
    window.requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(start + prefix.length, end + prefix.length);
    });
  }

  function applySlashCommand(prefix: string) {
    const textarea = bodyRef.current;
    if (!textarea) return;
    const cursor = textarea.selectionStart;
    const lineStart = draft.body.lastIndexOf("\n", cursor - 1) + 1;
    updateDraft({ body: `${draft.body.slice(0, lineStart)}${prefix}${draft.body.slice(cursor)}` });
    window.requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(lineStart + prefix.length, lineStart + prefix.length);
    });
  }

  function handleBodyKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") {
      event.preventDefault();
      formatSelection("**", "**");
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "i") {
      event.preventDefault();
      formatSelection("_", "_");
    }
    if (event.key === "Escape" && variant === "zen") onExitZen?.();
  }

  const editor = (
    <>
      <div className="compose-addressing">
        <RecipientField autoFocus={autoFocusTo && variant === "panel"} contacts={contacts} kind="to" label="To" onChange={(to) => updateDraft({ to })} recipients={draft.to} />
        {showCarbonCopy ? (
          <>
            <RecipientField contacts={contacts} kind="cc" label="Cc" onChange={(cc) => updateDraft({ cc })} recipients={draft.cc} />
            <RecipientField contacts={contacts} kind="bcc" label="Bcc" onChange={(bcc) => updateDraft({ bcc })} recipients={draft.bcc} />
          </>
        ) : null}
        <button aria-expanded={showCarbonCopy} className="compose-carbon-toggle" onClick={() => setShowCarbonCopy((shown) => !shown)} type="button">
          {showCarbonCopy ? "Hide Cc and Bcc" : "Add Cc or Bcc"}
        </button>
      </div>

      <label className="compose-subject-field">
        <span className="sr-only">Subject</span>
        <input autoComplete="off" name="subject" onChange={(event) => updateDraft({ subject: event.target.value })} placeholder="Give this note a subject…" type="text" value={draft.subject} />
      </label>

      <div className="compose-writing-field">
        <div aria-label="Formatting" className="compose-formatting" role="toolbar">
          <button aria-label="Bold, Command B" onClick={() => formatSelection("**", "**")} type="button"><strong>B</strong></button>
          <button aria-label="Italic, Command I" onClick={() => formatSelection("_", "_")} type="button"><em>I</em></button>
          <button aria-label="Bulleted list" onClick={() => formatSelection("- ")} type="button">List</button>
          <button aria-label="Quote" onClick={() => formatSelection("> ")} type="button">Quote</button>
          <span>Plain text · type / for structure</span>
        </div>
        <textarea
          aria-describedby="compose-writing-help"
          aria-label="Message body"
          autoComplete="off"
          className="compose-writing-area"
          name="body"
          onChange={(event) => updateDraft({ body: normalizePastedText(event.target.value) })}
          onKeyDown={handleBodyKeyDown}
          placeholder={variant === "zen" ? "Say what you mean." : "Start with the human part…"}
          ref={bodyRef}
          value={draft.body}
        />
        {filteredCommands.length > 0 ? (
          <div aria-label="Writing commands" className="compose-command-menu" role="listbox">
            <p>Shape this line</p>
            {filteredCommands.map((command) => (
              <button aria-selected="false" key={command.id} onClick={() => applySlashCommand(command.prefix)} role="option" type="button">
                <span>/{command.id}</span><strong>{command.label}</strong><small>{command.hint}</small>
              </button>
            ))}
          </div>
        ) : null}
        <span className="sr-only" id="compose-writing-help">Use Command B for bold, Command I for italic, and Command Z or Command Shift Z to undo or redo.</span>
      </div>
    </>
  );

  if (variant === "zen") {
    return (
      <section aria-label="Zen writing mode" aria-modal="true" className="zen-canvas" onKeyDown={(event) => { if (event.key === "Escape") onExitZen?.(); }} role="dialog">
        <header className="zen-header compose-zen-header">
          <button className="zen-back" onClick={onExitZen} type="button"><span aria-hidden="true">←</span><span>Return to compose</span></button>
          <DraftStatus status={saveStatus} />
        </header>
        <div className="zen-stage"><div className="zen-column compose-workspace compose-workspace-zen">{editor}</div></div>
      </section>
    );
  }

  return (
    <section aria-label="Compose message" className="compose-workspace compose-workspace-panel">
      <div className="compose-workspace-intro">
        <div><span className="compose-kicker">A note from you</span><h3>Write first. Send when it’s ready.</h3></div>
        <span className="compose-contact-count">{contactsLabel}</span>
      </div>
      {editor}
      <footer className="compose-delivery-bar">
        <div><DraftStatus status={saveStatus} /><span>{draft.body.trim() ? `${draft.body.trim().split(/\s+/).length} words` : "A blank page"}</span></div>
        <div className="compose-delivery-actions">
          {hasContent ? <button className="compose-discard" onClick={closeOrDiscard} type="button">Discard</button> : null}
          <button aria-describedby="compose-send-reason" className="compose-send" disabled type="button">Send</button>
        </div>
        <p id="compose-send-reason">{deliveryReason}</p>
      </footer>
    </section>
  );
}

function RecipientField({ autoFocus, contacts, kind, label, onChange, recipients }: {
  autoFocus?: boolean;
  contacts: MailContact[];
  kind: RecipientKind;
  label: string;
  onChange: (recipients: MailContact[]) => void;
  recipients: MailContact[];
}) {
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const recipientEmails = useMemo(() => new Set(recipients.map((recipient) => recipient.email.toLowerCase())), [recipients]);
  const suggestions = query.trim().length === 0 ? [] : contacts.filter((contact) => {
    const needle = query.toLowerCase();
    return !recipientEmails.has(contact.email.toLowerCase()) && `${contact.name ?? ""} ${contact.email}`.toLowerCase().includes(needle);
  }).slice(0, 5);

  useEffect(() => { if (autoFocus) inputRef.current?.focus(); }, [autoFocus]);

  function addContacts(next: MailContact[]) {
    const merged = [...recipients];
    const seen = new Set(recipientEmails);
    for (const contact of next) {
      if (!seen.has(contact.email.toLowerCase())) {
        merged.push(contact);
        seen.add(contact.email.toLowerCase());
      }
    }
    onChange(merged);
    setQuery("");
    setError(null);
  }

  function commitQuery() {
    if (!query.trim()) return;
    const parsed = parseRecipientText(query);
    if (parsed.length === 0) {
      setError("Enter a complete email address, like maya@example.com.");
      return;
    }
    addContacts(parsed);
  }

  function onPaste(event: ClipboardEvent<HTMLInputElement>) {
    const pasted = event.clipboardData.getData("text");
    if (!/[\n,;]/.test(pasted)) return;
    const parsed = parseRecipientText(pasted);
    window.setTimeout(() => {
      if (parsed.length === 0) setError("No valid email addresses were found in that paste.");
      else addContacts(parsed);
    }, 0);
  }

  return (
    <div className="compose-recipient-row">
      <span className="compose-recipient-label" id={`${kind}-label`}>{label}</span>
      <div aria-labelledby={`${kind}-label`} className={`compose-recipient-box${error ? " compose-recipient-box-error" : ""}`}>
        {recipients.map((recipient) => (
          <span className="compose-recipient-chip" key={recipient.email}>
            <span>{recipient.name ?? recipient.email}</span>
            <button aria-label={`Remove ${recipient.name ?? recipient.email} from ${label}`} onClick={() => onChange(recipients.filter((item) => item.email !== recipient.email))} type="button">×</button>
          </span>
        ))}
        <input
          aria-label={`Add ${label} recipient`}
          aria-autocomplete="list"
          aria-expanded={suggestions.length > 0}
          aria-invalid={Boolean(error)}
          autoComplete="off"
          name={`${kind}-recipient`}
          onBlur={() => { if (query.trim() && suggestions.length === 0) commitQuery(); }}
          onChange={(event) => { setQuery(event.target.value); setError(null); }}
          onKeyDown={(event) => {
            if ((event.key === "Enter" || event.key === "," || event.key === ";") && query.trim()) { event.preventDefault(); suggestions[0] ? addContacts([suggestions[0]]) : commitQuery(); }
            if (event.key === "Backspace" && !query && recipients.length) onChange(recipients.slice(0, -1));
          }}
          onPaste={onPaste}
          placeholder={recipients.length ? "Add another…" : "maya@example.com…"}
          ref={inputRef}
          spellCheck={false}
          type="email"
          value={query}
        />
        {suggestions.length > 0 ? (
          <div className="compose-recipient-suggestions" role="listbox">
            {suggestions.map((contact) => <button aria-selected="false" key={contact.email} onMouseDown={(event) => event.preventDefault()} onClick={() => addContacts([contact])} role="option" type="button"><strong>{contact.name ?? contact.email}</strong><span>{contact.email}</span></button>)}
          </div>
        ) : null}
      </div>
      {error ? <p className="compose-recipient-error" role="alert">{error}</p> : null}
    </div>
  );
}

function DraftStatus({ status }: { status: ComposeSaveStatus }) {
  return <span aria-live="polite" className={`compose-save-status compose-save-status-${status}`}><span aria-hidden="true" />{status === "saved" ? "Saved on this device" : status === "saving" ? "Saving…" : "Couldn’t save — keep this tab open"}</span>;
}

function getSlashQuery(body: string, cursor: number) {
  const line = body.slice(body.lastIndexOf("\n", cursor - 1) + 1, cursor);
  const match = line.match(/^\/([a-z]*)$/i);
  return match ? match[1]!.toLowerCase() : null;
}

function normalizePastedText(value: string) {
  return value.replace(/\r\n?/g, "\n").replace(/[\u00a0\u2007\u202f]/g, " ");
}
