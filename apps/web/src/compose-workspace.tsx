import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useId,
  type ClipboardEvent,
  type FormEvent,
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

export type ComposeDraftController = {
  draft: ComposeDraft;
  saveStatus: ComposeSaveStatus;
  hasContent: boolean;
  updateDraft: (update: Partial<Pick<ComposeDraft, "to" | "cc" | "bcc" | "subject" | "body">>) => void;
  discardDraft: () => void;
};

const EMAIL_PATTERN = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const SAVE_DELAY_MS = 420;

function draftStorageKey(accountId: string, scope = "new") {
  return `orca-compose-draft:${accountId}:${scope}`;
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

export function readComposeDraft(accountId: string, storage?: Pick<Storage, "getItem">, scope = "new"): ComposeDraft {
  const fallback = createEmptyComposeDraft(accountId);
  if (!storage) return fallback;
  try {
    const parsed = JSON.parse(storage.getItem(draftStorageKey(accountId, scope)) ?? "null") as Partial<ComposeDraft> | null;
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

export function useComposeDraft(accountId: string, scope = "new"): ComposeDraftController {
  const [draft, setDraft] = useState(() => readComposeDraft(accountId, typeof window === "undefined" ? undefined : window.localStorage, scope));
  const [saveStatus, setSaveStatus] = useState<ComposeSaveStatus>("saved");
  const persistedDraftRef = useRef(JSON.stringify(draft));
  const storageScopeRef = useRef(`${accountId}:${scope}`);

  useEffect(() => {
    const nextScope = `${accountId}:${scope}`;
    if (storageScopeRef.current === nextScope) return;
    storageScopeRef.current = nextScope;
    const restored = readComposeDraft(accountId, typeof window === "undefined" ? undefined : window.localStorage, scope);
    persistedDraftRef.current = JSON.stringify(restored);
    setDraft(restored);
    setSaveStatus("saved");
  }, [accountId, scope]);

  useEffect(() => {
    const serialized = JSON.stringify(draft);
    if (serialized === persistedDraftRef.current) return;
    setSaveStatus("saving");
    const timer = window.setTimeout(() => {
      try {
        window.localStorage.setItem(draftStorageKey(accountId, scope), serialized);
        persistedDraftRef.current = serialized;
        setSaveStatus("saved");
      } catch {
        setSaveStatus("failed");
      }
    }, SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [accountId, draft, scope]);

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
    window.localStorage.removeItem(draftStorageKey(accountId, scope));
    persistedDraftRef.current = JSON.stringify(empty);
    setDraft(empty);
    setSaveStatus("saved");
  }

  return { draft, saveStatus, hasContent, updateDraft, discardDraft };
}

const slashCommands = [
  { id: "heading", label: "Heading", hint: "A clear section break", block: "heading" },
  { id: "bullets", label: "Bulleted list", hint: "Turn thoughts into points", block: "bullets" },
  { id: "numbered", label: "Numbered list", hint: "Give ideas an order", block: "numbered" },
  { id: "quote", label: "Quote", hint: "Set a passage apart", block: "quote" },
  { id: "divider", label: "Divider", hint: "Create a quiet pause", block: "divider" },
] as const;

type SlashCommand = (typeof slashCommands)[number];

const composeIntros = [
  { kicker: "A note from you", title: "Write first. Send when it’s ready." },
  { kicker: "In your own words", title: "Make a little room for the thought." },
  { kicker: "A quiet place to begin", title: "Say the part that matters." },
] as const;

export function ComposeWorkspace({
  controller,
  contacts,
  autoFocusTo = false,
  variant = "panel",
  onExitZen,
  onClose,
  replyLabel,
}: {
  controller: ComposeDraftController;
  contacts: MailContact[];
  autoFocusTo?: boolean;
  variant?: "panel" | "zen" | "reply";
  onExitZen?: () => void;
  onClose?: () => void;
  replyLabel?: string;
}) {
  const { draft, saveStatus, hasContent, updateDraft, discardDraft } = controller;
  const [showCarbonCopy, setShowCarbonCopy] = useState(draft.cc.length + draft.bcc.length > 0);
  const contactsLabel = contacts.length === 1 ? "1 contact" : `${contacts.length} contacts`;
  const intro = composeIntros[hashText(draft.id) % composeIntros.length]!;
  const deliveryReason = draft.to.length === 0
    ? "Add at least one valid recipient to prepare this message."
    : "Sending needs Gmail send access. This account is connected read-only, so your draft stays safely saved in Orca.";

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

  const editor = (
    <>
      {variant !== "reply" ? <div className="compose-addressing">
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
      </div> : <div className="compose-reply-context"><span>Replying to</span><strong>{replyLabel ?? draft.to.map((recipient) => recipient.name ?? recipient.email).join(", ")}</strong><span>{draft.subject}</span></div>}

      {variant !== "reply" ? <label className="compose-subject-field">
        <span className="sr-only">Subject</span>
        <input autoComplete="off" name="subject" onChange={(event) => updateDraft({ subject: event.target.value })} placeholder="Give this note a subject…" type="text" value={draft.subject} />
      </label> : null}

      <RenderedBlockEditor autoFocus={variant === "zen" || variant === "reply"} body={draft.body} onChange={(body) => updateDraft({ body })} placeholder={variant === "zen" ? "Say what you mean." : variant === "reply" ? "Write a reply…" : "Start with the human part…"} />
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

  if (variant === "reply") {
    return (
      <section aria-label="Reply to conversation" className="compose-workspace compose-workspace-reply">
        {editor}
        <ComposeDeliveryBar controller={controller} deliveryReason={deliveryReason} onDiscard={closeOrDiscard} />
      </section>
    );
  }

  return (
    <section aria-label="Compose message" className="compose-workspace compose-workspace-panel">
      <div className="compose-workspace-intro">
        <div><span className="compose-kicker">{intro.kicker}</span><h3>{intro.title}</h3></div>
        <span className="compose-contact-count">{contactsLabel}</span>
      </div>
      {editor}
      <ComposeDeliveryBar controller={controller} deliveryReason={deliveryReason} onDiscard={closeOrDiscard} />
    </section>
  );
}

function RenderedBlockEditor({ autoFocus, body, onChange, placeholder }: { autoFocus: boolean; body: string; onChange: (body: string) => void; placeholder: string }) {
  const editorRef = useRef<HTMLDivElement>(null);
  const commandListId = useId();
  const lastBodyRef = useRef(body);
  const [slash, setSlash] = useState<{ query: string; top: number } | null>(null);
  const [activeCommand, setActiveCommand] = useState(0);
  const commands = slash === null ? [] : slashCommands.filter((command) => `${command.id} ${command.label}`.toLowerCase().includes(slash.query));

  useEffect(() => {
    if (!slash || !commands.length) return;
    document.getElementById(`${commandListId}-${commands[activeCommand]?.id}`)?.scrollIntoView({ block: "nearest" });
  }, [activeCommand, commandListId, commands, slash]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (editor.innerHTML === "" || (lastBodyRef.current !== body && document.activeElement !== editor)) {
      editor.innerHTML = markdownToEditorHtml(body);
      if (!body.trim() && editor.firstElementChild) (editor.firstElementChild as HTMLElement).dataset.placeholder = placeholder;
      lastBodyRef.current = body;
    }
    if (autoFocus) editor.focus();
  }, [autoFocus, body, placeholder]);

  function emitChange() {
    const editor = editorRef.current;
    if (!editor) return;
    const nextBody = editorToMarkdown(editor);
    lastBodyRef.current = nextBody;
    onChange(nextBody);
  }

  function updateSlashMenu() {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection?.anchorNode || !editor.contains(selection.anchorNode)) {
      setSlash(null);
      return;
    }
    const block = closestEditorBlock(selection.anchorNode, editor);
    const match = block?.textContent?.match(/^\/([a-z]*)$/i);
    if (!block || !match) {
      setSlash(null);
      return;
    }
    const query = match[1]!.toLowerCase();
    const matchingCommandCount = slashCommands.filter((command) => `${command.id} ${command.label}`.toLowerCase().includes(query)).length;
    const estimatedMenuHeight = Math.min(240, 30 + matchingCommandCount * 38);
    const fieldRect = editor.parentElement?.getBoundingClientRect();
    const blockRect = block.getBoundingClientRect();
    const topBelowLine = fieldRect ? blockRect.bottom - fieldRect.top + 6 : block.offsetTop + block.offsetHeight + 6;
    const topAboveLine = fieldRect ? blockRect.top - fieldRect.top - estimatedMenuHeight - 6 : 0;
    const hasRoomBelow = window.innerHeight - blockRect.bottom >= estimatedMenuHeight + 12;
    setActiveCommand(0);
    setSlash({ query, top: hasRoomBelow ? topBelowLine : Math.max(0, topAboveLine) });
  }

  function onInput(_event: FormEvent<HTMLDivElement>) {
    emitChange();
    updateSlashMenu();
  }

  function runCommand(command: SlashCommand) {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection?.anchorNode) return;
    const block = closestEditorBlock(selection.anchorNode, editor);
    if (!block) return;
    const next = createCommandBlock(command);
    if (Array.isArray(next)) {
      block.replaceWith(...next);
      placeCaret(next[next.length - 1]!);
    } else {
      block.replaceWith(next);
      placeCaret(next);
    }
    setSlash(null);
    emitChange();
  }

  function runToolbar(command: "bold" | "italic" | "insertUnorderedList" | "blockquote") {
    editorRef.current?.focus();
    if (command === "blockquote") document.execCommand("formatBlock", false, "blockquote");
    else document.execCommand(command);
    emitChange();
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (slash && commands.length) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveCommand((current) => (current + 1) % commands.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveCommand((current) => (current - 1 + commands.length) % commands.length);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        runCommand(commands[activeCommand] ?? commands[0]!);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSlash(null);
      }
    }
  }

  return (
    <div className="compose-writing-field">
      <div aria-label="Formatting" className="compose-formatting" role="toolbar">
        <button aria-label="Bold, Command B" onClick={() => runToolbar("bold")} type="button"><strong>B</strong></button>
        <button aria-label="Italic, Command I" onClick={() => runToolbar("italic")} type="button"><em>I</em></button>
        <button aria-label="Bulleted list" onClick={() => runToolbar("insertUnorderedList")} type="button">List</button>
        <button aria-label="Quote" onClick={() => runToolbar("blockquote")} type="button">Quote</button>
        <span>Type / for structure · ↑↓ to choose</span>
      </div>
      <div
        aria-activedescendant={slash && commands.length ? `${commandListId}-${commands[activeCommand]?.id}` : undefined}
        aria-autocomplete="list"
        aria-controls={commandListId}
        aria-label="Message body"
        aria-multiline="true"
        className="compose-writing-area compose-block-editor"
        contentEditable
        data-placeholder={placeholder}
        onInput={onInput}
        onKeyDown={onKeyDown}
        onPaste={(event) => {
          event.preventDefault();
          document.execCommand("insertText", false, normalizePastedText(event.clipboardData.getData("text")));
        }}
        ref={editorRef}
        role="textbox"
        spellCheck
        suppressContentEditableWarning
      />
      {slash && commands.length ? (
        <div aria-label="Writing commands" className="compose-command-menu" id={commandListId} role="listbox" style={{ top: slash.top }}>
          <p>Shape this block <span>↑↓ to move · ↵ to select</span></p>
          {commands.map((command, index) => (
            <button aria-selected={index === activeCommand} id={`${commandListId}-${command.id}`} key={command.id} onMouseDown={(event) => event.preventDefault()} onClick={() => runCommand(command)} role="option" type="button">
              <span>/{command.id}</span><strong>{command.label}</strong><small>{command.hint}</small>
            </button>
          ))}
        </div>
      ) : null}
      <span className="sr-only">Use Command B for bold, Command I for italic, Command Z to undo, and arrow keys to move through slash commands.</span>
    </div>
  );
}

function ComposeDeliveryBar({ controller, deliveryReason, onDiscard }: { controller: ComposeDraftController; deliveryReason: string; onDiscard: () => void }) {
  const reasonId = useId();
  const { draft, hasContent, saveStatus } = controller;
  return (
    <footer className="compose-delivery-bar">
      <div><DraftStatus status={saveStatus} /><span>{draft.body.trim() ? `${draft.body.trim().split(/\s+/).length} words` : "A blank page"}</span></div>
      <div className="compose-delivery-actions">
        {hasContent ? <button className="compose-discard" onClick={onDiscard} type="button">Discard</button> : null}
        <button aria-describedby={reasonId} className="compose-send" disabled type="button">Send</button>
      </div>
      <p id={reasonId}>{deliveryReason}</p>
    </footer>
  );
}

function hashText(value: string) {
  return [...value].reduce((hash, character) => ((hash << 5) - hash + character.charCodeAt(0)) | 0, 0) >>> 0;
}

function closestEditorBlock(node: Node, editor: HTMLElement) {
  let current = node.nodeType === Node.ELEMENT_NODE ? node as HTMLElement : node.parentElement;
  while (current && current.parentElement !== editor) current = current.parentElement;
  return current?.parentElement === editor ? current : null;
}

function createCommandBlock(command: SlashCommand): HTMLElement | HTMLElement[] {
  if (command.block === "divider") {
    const divider = document.createElement("hr");
    const paragraph = document.createElement("p");
    paragraph.append(document.createElement("br"));
    return [divider, paragraph];
  }
  if (command.block === "bullets" || command.block === "numbered") {
    const list = document.createElement(command.block === "bullets" ? "ul" : "ol");
    const item = document.createElement("li");
    item.append(document.createElement("br"));
    list.append(item);
    return list;
  }
  const block = document.createElement(command.block === "heading" ? "h2" : command.block === "quote" ? "blockquote" : "p");
  block.append(document.createElement("br"));
  return block;
}

function placeCaret(element: HTMLElement) {
  const target = element.matches("ul, ol") ? element.querySelector("li") ?? element : element;
  const range = document.createRange();
  range.selectNodeContents(target);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  (element.closest("[contenteditable]") as HTMLElement | null)?.focus();
}

export function markdownToEditorHtml(markdown: string) {
  if (!markdown.trim()) return "<p><br></p>";
  const lines = normalizePastedText(markdown).split("\n");
  const blocks: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^- /.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^- /.test(lines[index]!)) { items.push(`<li>${renderInlineMarkdown(lines[index]!.slice(2)) || "<br>"}</li>`); index += 1; }
      index -= 1;
      blocks.push(`<ul>${items.join("")}</ul>`);
    } else if (/^\d+\. /.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\d+\. /.test(lines[index]!)) { items.push(`<li>${renderInlineMarkdown(lines[index]!.replace(/^\d+\. /, "")) || "<br>"}</li>`); index += 1; }
      index -= 1;
      blocks.push(`<ol>${items.join("")}</ol>`);
    } else if (line.startsWith("## ")) blocks.push(`<h2>${renderInlineMarkdown(line.slice(3)) || "<br>"}</h2>`);
    else if (line.startsWith("> ")) blocks.push(`<blockquote>${renderInlineMarkdown(line.slice(2)) || "<br>"}</blockquote>`);
    else if (line.trim() === "---") blocks.push("<hr>");
    else blocks.push(`<p>${renderInlineMarkdown(line) || "<br>"}</p>`);
  }
  return blocks.join("");
}

function renderInlineMarkdown(value: string) {
  return escapeHtml(value)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/_(.+?)_/g, "<em>$1</em>");
}

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function editorToMarkdown(editor: HTMLElement) {
  return [...editor.childNodes].map((node) => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    const element = node as HTMLElement;
    const tag = element.tagName.toLowerCase();
    if (tag === "h2") return `## ${inlineNodeToMarkdown(element)}`.trimEnd();
    if (tag === "blockquote") return `> ${inlineNodeToMarkdown(element)}`.trimEnd();
    if (tag === "hr") return "---";
    if (tag === "ul" || tag === "ol") return [...element.children].map((item, index) => `${tag === "ul" ? "-" : `${index + 1}.`} ${inlineNodeToMarkdown(item)}`.trimEnd()).join("\n");
    return inlineNodeToMarkdown(element);
  }).join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

function inlineNodeToMarkdown(node: Node): string {
  return [...node.childNodes].map((child) => {
    if (child.nodeType === Node.TEXT_NODE) return child.textContent ?? "";
    const element = child as HTMLElement;
    const content = inlineNodeToMarkdown(element);
    if (element.matches("strong, b")) return `**${content}**`;
    if (element.matches("em, i")) return `_${content}_`;
    if (element.matches("br")) return "";
    return content;
  }).join("");
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
