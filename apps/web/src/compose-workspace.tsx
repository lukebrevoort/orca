import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useId,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { InboxMessage, MailContact } from "@orca/shared";

export type RecipientKind = "to" | "cc" | "bcc";
export type ComposeSaveStatus = "saved" | "saving" | "failed";

export type ComposeAttachment = {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  previewUrl: string | null;
};

export type ComposeDraft = {
  id: string;
  accountId: string;
  to: MailContact[];
  cc: MailContact[];
  bcc: MailContact[];
  subject: string;
  body: string;
  attachments: ComposeAttachment[];
  updatedAt: string;
};

export type ComposeDraftFields = Pick<ComposeDraft, "to" | "cc" | "bcc" | "subject" | "body" | "attachments">;

export type ComposeDraftController = {
  draft: ComposeDraft;
  saveStatus: ComposeSaveStatus;
  hasContent: boolean;
  updateDraft: (update: Partial<ComposeDraftFields>) => void;
  discardDraft: () => void;
};

export type ComposeAttachmentRejection = {
  filename: string;
  reason: string;
};

export type ComposeAttachmentAcceptance = {
  accepted: ComposeAttachment[];
  rejected: ComposeAttachmentRejection[];
};

export const MAX_COMPOSE_ATTACHMENTS = 25;
export const MAX_COMPOSE_ATTACHMENT_BYTES = 25 * 1024 * 1024;

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
    attachments: [],
    updatedAt: new Date().toISOString(),
  };
}

export function hasComposeContent(draft: ComposeDraft) {
  return draft.to.length + draft.cc.length + draft.bcc.length > 0
    || Boolean(draft.subject.trim())
    || Boolean(draft.body.trim())
    || draft.attachments.length > 0;
}

export function sanitizeAttachmentFilename(filename: string) {
  const base = filename.replace(/\\/g, "/").split("/").pop()?.trim() || "attachment";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").replace(/^\.+/, "").trim() || "attachment";
  return cleaned.slice(0, 255);
}

export function formatAttachmentSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function revokeComposeAttachment(attachment: ComposeAttachment) {
  if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
}

export function revokeComposeAttachments(attachments: ComposeAttachment[]) {
  for (const attachment of attachments) revokeComposeAttachment(attachment);
}

export function acceptComposeFiles(
  existing: ComposeAttachment[],
  files: Iterable<File>,
  createObjectUrl: (file: File) => string = (file) => URL.createObjectURL(file),
): ComposeAttachmentAcceptance {
  const accepted: ComposeAttachment[] = [];
  const rejected: ComposeAttachmentRejection[] = [];
  let totalBytes = existing.reduce((sum, attachment) => sum + attachment.size, 0);
  let remainingSlots = MAX_COMPOSE_ATTACHMENTS - existing.length;

  for (const file of files) {
    const filename = sanitizeAttachmentFilename(file.name);
    if (remainingSlots <= 0) {
      rejected.push({ filename, reason: `You can attach up to ${MAX_COMPOSE_ATTACHMENTS} files.` });
      continue;
    }
    if (!Number.isFinite(file.size) || file.size <= 0) {
      rejected.push({ filename, reason: "Empty files can’t be attached." });
      continue;
    }
    if (file.size > MAX_COMPOSE_ATTACHMENT_BYTES) {
      rejected.push({ filename, reason: `Each file must be ${formatAttachmentSize(MAX_COMPOSE_ATTACHMENT_BYTES)} or smaller.` });
      continue;
    }
    if (totalBytes + file.size > MAX_COMPOSE_ATTACHMENT_BYTES) {
      rejected.push({ filename, reason: `Attachments together must stay under ${formatAttachmentSize(MAX_COMPOSE_ATTACHMENT_BYTES)}.` });
      continue;
    }
    const mimeType = file.type.trim() || "application/octet-stream";
    const previewUrl = mimeType.startsWith("image/") ? createObjectUrl(file) : null;
    accepted.push({
      id: globalThis.crypto?.randomUUID?.() ?? `attachment-${Date.now()}-${accepted.length}`,
      filename,
      mimeType,
      size: file.size,
      previewUrl,
    });
    totalBytes += file.size;
    remainingSlots -= 1;
  }

  return { accepted, rejected };
}

function persistableDraft(draft: ComposeDraft) {
  const { attachments: _attachments, ...rest } = draft;
  return rest;
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
      // Attachment bytes are kept in memory only — never round-trip through localStorage.
      attachments: [],
    };
  } catch {
    return fallback;
  }
}

export function useComposeDraft(accountId: string, scope = "new"): ComposeDraftController {
  const [draft, setDraft] = useState(() => readComposeDraft(accountId, typeof window === "undefined" ? undefined : window.localStorage, scope));
  const [saveStatus, setSaveStatus] = useState<ComposeSaveStatus>("saved");
  const persistedDraftRef = useRef(JSON.stringify(persistableDraft(draft)));
  const storageScopeRef = useRef(`${accountId}:${scope}`);
  const pendingDraftRef = useRef<{ key: string; serialized: string } | null>(null);
  const skipPersistenceRef = useRef(false);
  const attachmentsRef = useRef(draft.attachments);

  useEffect(() => {
    attachmentsRef.current = draft.attachments;
  }, [draft.attachments]);

  useEffect(() => () => {
    revokeComposeAttachments(attachmentsRef.current);
  }, []);

  const flushPendingDraft = useCallback(() => {
    const pending = pendingDraftRef.current;
    if (!pending || typeof window === "undefined") return true;
    try {
      window.localStorage.setItem(pending.key, pending.serialized);
      persistedDraftRef.current = pending.serialized;
      pendingDraftRef.current = null;
      return true;
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    const nextScope = `${accountId}:${scope}`;
    if (storageScopeRef.current === nextScope) return;
    flushPendingDraft();
    storageScopeRef.current = nextScope;
    skipPersistenceRef.current = true;
    revokeComposeAttachments(attachmentsRef.current);
    const restored = readComposeDraft(accountId, typeof window === "undefined" ? undefined : window.localStorage, scope);
    persistedDraftRef.current = JSON.stringify(persistableDraft(restored));
    setDraft(restored);
    setSaveStatus("saved");
  }, [accountId, flushPendingDraft, scope]);

  useEffect(() => {
    if (skipPersistenceRef.current) {
      skipPersistenceRef.current = false;
      return;
    }
    const serialized = JSON.stringify(persistableDraft(draft));
    if (serialized === persistedDraftRef.current) return;
    pendingDraftRef.current = { key: draftStorageKey(accountId, scope), serialized };
    setSaveStatus("saving");
    const timer = window.setTimeout(() => {
      setSaveStatus(flushPendingDraft() ? "saved" : "failed");
    }, SAVE_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      flushPendingDraft();
    };
  }, [accountId, draft, flushPendingDraft, scope]);

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

  function updateDraft(update: Partial<ComposeDraftFields>) {
    setDraft((current) => {
      if (update.attachments) {
        const nextIds = new Set(update.attachments.map((attachment) => attachment.id));
        for (const attachment of current.attachments) {
          if (!nextIds.has(attachment.id)) revokeComposeAttachment(attachment);
        }
      }
      return { ...current, ...update, updatedAt: new Date().toISOString() };
    });
  }

  function discardDraft() {
    const empty = createEmptyComposeDraft(accountId);
    pendingDraftRef.current = null;
    revokeComposeAttachments(attachmentsRef.current);
    window.localStorage.removeItem(draftStorageKey(accountId, scope));
    persistedDraftRef.current = JSON.stringify(persistableDraft(empty));
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
  canSend = false,
  onRequestSendAccess,
}: {
  controller: ComposeDraftController;
  contacts: MailContact[];
  autoFocusTo?: boolean;
  variant?: "panel" | "zen" | "reply";
  onExitZen?: () => void;
  onClose?: () => void;
  replyLabel?: string;
  canSend?: boolean;
  onRequestSendAccess?: () => void;
}) {
  const { draft, saveStatus, hasContent, updateDraft, discardDraft } = controller;
  const [showCarbonCopy, setShowCarbonCopy] = useState(draft.cc.length + draft.bcc.length > 0);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const contactsLabel = contacts.length === 1 ? "1 contact" : `${contacts.length} contacts`;
  const intro = composeIntros[hashText(draft.id) % composeIntros.length]!;
  const deliveryReason = draft.to.length === 0
    ? "Add at least one valid recipient to prepare this message."
    : canSend
      ? "Gmail has confirmed draft and send access. Delivery stays off until Orca's send transport is connected."
      : "This account is read-only. Enable Gmail compose access before Orca can create drafts or send mail.";

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

  function applyFiles(fileList: Iterable<File>) {
    const { accepted, rejected } = acceptComposeFiles(draft.attachments, fileList);
    if (accepted.length) updateDraft({ attachments: [...draft.attachments, ...accepted] });
    setAttachmentError(rejected.length ? rejected.map((item) => `${item.filename}: ${item.reason}`).join(" ") : null);
  }

  function removeAttachment(attachmentId: string) {
    updateDraft({ attachments: draft.attachments.filter((attachment) => attachment.id !== attachmentId) });
    setAttachmentError(null);
  }

  function hasFilePayload(event: DragEvent) {
    return [...(event.dataTransfer?.types ?? [])].includes("Files");
  }

  function onDragOver(event: DragEvent<HTMLElement>) {
    if (!hasFilePayload(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDraggingFiles(true);
  }

  function onDragLeave(event: DragEvent<HTMLElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDraggingFiles(false);
  }

  function onDrop(event: DragEvent<HTMLElement>) {
    if (!hasFilePayload(event)) return;
    event.preventDefault();
    setDraggingFiles(false);
    const files = [...(event.dataTransfer.files ?? [])];
    if (files.length) applyFiles(files);
  }

  const dropHandlers = { onDragLeave, onDragOver, onDrop };
  const workspaceClass = `compose-workspace${draggingFiles ? " compose-workspace-drop" : ""}`;

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

      <RenderedBlockEditor
        attachments={draft.attachments}
        autoFocus={variant === "zen" || variant === "reply"}
        body={draft.body}
        canAttach={draft.attachments.length < MAX_COMPOSE_ATTACHMENTS}
        onAttachClick={() => fileInputRef.current?.click()}
        onChange={(body) => updateDraft({ body })}
        onRemoveAttachment={removeAttachment}
        placeholder={variant === "zen" ? "Say what you mean." : variant === "reply" ? "Write a reply…" : "Start with the human part…"}
      />
      {attachmentError ? <p className="compose-attachment-error" role="alert">{attachmentError}</p> : null}
      <input
        accept="*/*"
        aria-hidden="true"
        className="sr-only"
        multiple
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = "";
          if (files.length) applyFiles(files);
        }}
        ref={fileInputRef}
        tabIndex={-1}
        type="file"
      />
    </>
  );

  if (variant === "zen") {
    return (
      <section aria-label="Zen writing mode" aria-modal="true" className="zen-canvas" onKeyDown={(event) => { if (event.key === "Escape") onExitZen?.(); }} role="dialog" {...dropHandlers}>
        <header className="zen-header compose-zen-header">
          <button className="zen-back" onClick={onExitZen} type="button"><span aria-hidden="true">←</span><span>Return to compose</span></button>
          <DraftStatus status={saveStatus} />
        </header>
        <div className="zen-stage">
          <div className={`zen-column ${workspaceClass} compose-workspace-zen`}>
            {editor}
            {draggingFiles ? <ComposeDropOverlay /> : null}
          </div>
        </div>
      </section>
    );
  }

  if (variant === "reply") {
    return (
      <section aria-label="Reply to conversation" className={`${workspaceClass} compose-workspace-reply`} {...dropHandlers}>
        {editor}
        <ComposeDeliveryBar canSend={canSend} controller={controller} deliveryReason={deliveryReason} onDiscard={closeOrDiscard} onRequestSendAccess={onRequestSendAccess} />
        {draggingFiles ? <ComposeDropOverlay /> : null}
      </section>
    );
  }

  return (
    <section aria-label="Compose message" className={`${workspaceClass} compose-workspace-panel`} {...dropHandlers}>
      <div className="compose-workspace-intro">
        <div><span className="compose-kicker">{intro.kicker}</span><h3>{intro.title}</h3></div>
        <span className="compose-contact-count">{contactsLabel}</span>
      </div>
      {editor}
      <ComposeDeliveryBar canSend={canSend} controller={controller} deliveryReason={deliveryReason} onDiscard={closeOrDiscard} onRequestSendAccess={onRequestSendAccess} />
      {draggingFiles ? <ComposeDropOverlay /> : null}
    </section>
  );
}

function RenderedBlockEditor({
  attachments,
  autoFocus,
  body,
  canAttach,
  onAttachClick,
  onChange,
  onRemoveAttachment,
  placeholder,
}: {
  attachments: ComposeAttachment[];
  autoFocus: boolean;
  body: string;
  canAttach: boolean;
  onAttachClick: () => void;
  onChange: (body: string) => void;
  onRemoveAttachment: (attachmentId: string) => void;
  placeholder: string;
}) {
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
    if (slash) {
      if (event.key === "Escape") {
        event.preventDefault();
        setSlash(null);
        return;
      }
      if (!commands.length) return;
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
    }
  }

  return (
    <div className="compose-writing-field">
      <div aria-label="Formatting" className="compose-formatting" role="toolbar">
        <button aria-label="Bold, Command B" onClick={() => runToolbar("bold")} type="button"><strong>B</strong></button>
        <button aria-label="Italic, Command I" onClick={() => runToolbar("italic")} type="button"><em>I</em></button>
        <button aria-label="Bulleted list" onClick={() => runToolbar("insertUnorderedList")} type="button">List</button>
        <button aria-label="Quote" onClick={() => runToolbar("blockquote")} type="button">Quote</button>
        <button aria-label="Attach files" className="compose-attach-quiet" disabled={!canAttach} onClick={onAttachClick} type="button">Attach</button>
        <span>Type / for structure · drop anywhere to attach</span>
      </div>
      <div
        aria-activedescendant={slash && commands.length ? `${commandListId}-${commands[activeCommand]?.id}` : undefined}
        aria-autocomplete={slash && commands.length ? "list" : undefined}
        aria-controls={slash ? commandListId : undefined}
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
      {slash ? (
        <div aria-label="Writing commands" className="compose-command-menu" id={commandListId} role={commands.length ? "listbox" : "status"} style={{ top: slash.top }}>
          <p>Shape this block <span>↑↓ to move · ↵ to select</span></p>
          {commands.length ? commands.map((command, index) => (
            <button aria-selected={index === activeCommand} id={`${commandListId}-${command.id}`} key={command.id} onMouseDown={(event) => event.preventDefault()} onClick={() => runCommand(command)} role="option" type="button">
              <span>/{command.id}</span><strong>{command.label}</strong><small>{command.hint}</small>
            </button>
          )) : <span className="compose-command-empty">No commands found · Esc to close</span>}
        </div>
      ) : null}
      {attachments.length ? (
        <ul aria-label={attachments.length === 1 ? "1 attachment" : `${attachments.length} attachments`} className="compose-attachment-chips">
          {attachments.map((attachment) => (
            <li key={attachment.id}>
              {attachment.previewUrl ? (
                <img alt="" className="compose-attachment-chip-preview" src={attachment.previewUrl} />
              ) : (
                <span aria-hidden="true" className="compose-attachment-chip-glyph">↳</span>
              )}
              <span className="compose-attachment-chip-meta">
                <strong title={attachment.filename}>{attachment.filename}</strong>
                <small>{formatAttachmentSize(attachment.size)}</small>
              </span>
              <button aria-label={`Remove ${attachment.filename}`} onClick={() => onRemoveAttachment(attachment.id)} type="button">×</button>
            </li>
          ))}
        </ul>
      ) : null}
      <span className="sr-only">Use Command B for bold, Command I for italic, Command Z to undo, and arrow keys to move through slash commands. Drop files onto the compose canvas to attach them.</span>
    </div>
  );
}

function ComposeDropOverlay() {
  return (
    <div aria-hidden="true" className="compose-drop-overlay">
      <strong>Drop to attach</strong>
      <span>Images and files land here — the writing canvas stays clear until then.</span>
    </div>
  );
}

function ComposeDeliveryBar({ canSend, controller, deliveryReason, onDiscard, onRequestSendAccess }: { canSend: boolean; controller: ComposeDraftController; deliveryReason: string; onDiscard: () => void; onRequestSendAccess?: () => void }) {
  const reasonId = useId();
  const { draft, hasContent, saveStatus } = controller;
  return (
    <footer className="compose-delivery-bar">
      <div><DraftStatus status={saveStatus} /><span>{draft.body.trim() ? `${draft.body.trim().split(/\s+/).length} words` : "A blank page"}</span></div>
      <div className="compose-delivery-actions">
        {hasContent ? <button className="compose-discard" onClick={onDiscard} type="button">Discard</button> : null}
        <button
          aria-describedby={reasonId}
          className="compose-send"
          disabled={draft.to.length === 0 || canSend || !onRequestSendAccess}
          onClick={onRequestSendAccess}
          type="button"
        >{canSend ? "Send" : "Enable sending"}</button>
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
  const [activeSuggestion, setActiveSuggestion] = useState(0);
  const [suggestionsOpen, setSuggestionsOpen] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const labelId = useId();
  const suggestionListId = useId();
  const recipientEmails = useMemo(() => new Set(recipients.map((recipient) => recipient.email.toLowerCase())), [recipients]);
  const suggestions = query.trim().length === 0 ? [] : contacts.filter((contact) => {
    const needle = query.toLowerCase();
    return !recipientEmails.has(contact.email.toLowerCase()) && `${contact.name ?? ""} ${contact.email}`.toLowerCase().includes(needle);
  }).slice(0, 5);

  useEffect(() => { if (autoFocus) inputRef.current?.focus(); }, [autoFocus]);
  useEffect(() => { setActiveSuggestion((current) => suggestions.length ? Math.min(current, suggestions.length - 1) : 0); }, [suggestions.length]);
  useEffect(() => {
    if (!suggestions.length || !suggestionsOpen) return;
    document.getElementById(`${suggestionListId}-${activeSuggestion}`)?.scrollIntoView({ block: "nearest" });
  }, [activeSuggestion, suggestionListId, suggestions.length, suggestionsOpen]);

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
    setActiveSuggestion(0);
    setSuggestionsOpen(false);
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
      <span className="compose-recipient-label" id={labelId}>{label}</span>
      <div aria-labelledby={labelId} className={`compose-recipient-box${error ? " compose-recipient-box-error" : ""}`}>
        {recipients.map((recipient) => (
          <span className="compose-recipient-chip" key={recipient.email}>
            <span>{recipient.name ?? recipient.email}</span>
            <button aria-label={`Remove ${recipient.name ?? recipient.email} from ${label}`} onClick={() => onChange(recipients.filter((item) => item.email !== recipient.email))} type="button">×</button>
          </span>
        ))}
        <input
          aria-label={`Add ${label} recipient`}
          aria-autocomplete="list"
          aria-activedescendant={suggestionsOpen && suggestions.length ? `${suggestionListId}-${activeSuggestion}` : undefined}
          aria-controls={suggestionsOpen && suggestions.length ? suggestionListId : undefined}
          aria-expanded={suggestionsOpen && suggestions.length > 0}
          aria-invalid={Boolean(error)}
          autoComplete="off"
          name={`${kind}-recipient`}
          onBlur={() => { if (query.trim() && suggestions.length === 0) commitQuery(); }}
          onChange={(event) => { setQuery(event.target.value); setActiveSuggestion(0); setSuggestionsOpen(true); setError(null); }}
          onKeyDown={(event) => {
            if (suggestionsOpen && suggestions.length && event.key === "ArrowDown") { event.preventDefault(); setActiveSuggestion((current) => (current + 1) % suggestions.length); return; }
            if (suggestionsOpen && suggestions.length && event.key === "ArrowUp") { event.preventDefault(); setActiveSuggestion((current) => (current - 1 + suggestions.length) % suggestions.length); return; }
            if (event.key === "Escape" && suggestionsOpen && suggestions.length) { event.preventDefault(); setSuggestionsOpen(false); return; }
            if ((event.key === "Enter" || event.key === "," || event.key === ";") && query.trim()) { event.preventDefault(); suggestionsOpen && suggestions.length ? addContacts([suggestions[activeSuggestion] ?? suggestions[0]!]) : commitQuery(); }
            if (event.key === "Backspace" && !query && recipients.length) onChange(recipients.slice(0, -1));
          }}
          onPaste={onPaste}
          placeholder={recipients.length ? "Add another…" : "maya@example.com…"}
          ref={inputRef}
          spellCheck={false}
          type="email"
          value={query}
        />
        {suggestionsOpen && suggestions.length > 0 ? (
          <div className="compose-recipient-suggestions" id={suggestionListId} role="listbox">
            {suggestions.map((contact, index) => <button aria-selected={index === activeSuggestion} id={`${suggestionListId}-${index}`} key={contact.email} onMouseEnter={() => setActiveSuggestion(index)} onMouseDown={(event) => event.preventDefault()} onClick={() => addContacts([contact])} role="option" type="button"><strong>{contact.name ?? contact.email}</strong><span>{contact.email}</span></button>)}
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
