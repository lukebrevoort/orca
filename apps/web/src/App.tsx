import { useEffect, useMemo, useRef, useState } from "react";
import type { InboxMessage, MailAccount } from "@orca/shared";
import { inboxResponseSchema, meResponseSchema } from "@orca/shared";
import {
  demoAccount,
  demoMessages,
  messageIncludesPerson,
  threadBodies,
} from "./demo-data";
import { getContactSignature, type ContactSignature } from "./contact-signature";

type Theme = "light" | "dark";

type MailboxItem = {
  label: string;
  count?: number;
  active?: boolean;
};

type PersonItem = {
  initials: string;
  name: string;
  context: string;
  unread?: boolean;
};

type PanelMode = "compose" | "thread" | null;

const PANEL_ANIM_MS = 650;
const ZEN_ANIM_MS = 550;

const pinnedPeople: PersonItem[] = [
  { initials: "MC", name: "Maya Chen", context: "Launch notes", unread: true },
  { initials: "JR", name: "Jon Rivera", context: "Product review" },
  { initials: "AL", name: "Anika Lee", context: "Design direction" },
];

const mailboxes: MailboxItem[] = [
  { label: "Inbox", active: true },
  { label: "Sent" },
  { label: "Spam", count: 2 },
  { label: "All Mail" },
];

export function App() {
  const [theme, setTheme] = useState<Theme>(() => readStoredTheme());
  const [account, setAccount] = useState<MailAccount | null>(null);
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [personFilter, setPersonFilter] = useState<string | null>(null);
  const [panelMode, setPanelMode] = useState<PanelMode>(null);
  const [selectedMessage, setSelectedMessage] = useState<InboxMessage | null>(null);
  const [composeTo, setComposeTo] = useState("");
  const [composeSubject, setComposeSubject] = useState("");
  const [draft, setDraft] = useState("");
  const [zen, setZen] = useState(false);
  const [panelClosing, setPanelClosing] = useState(false);
  const [zenClosing, setZenClosing] = useState(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("orca-theme", theme);
  }, [theme]);

  useEffect(() => {
    const abortController = new AbortController();

    async function loadInbox() {
      setStatus("loading");
      setErrorMessage(null);

      try {
        const [meResult, inboxResult] = await Promise.allSettled([
          fetchJson("/v1/me", meResponseSchema, abortController.signal),
          fetchJson("/v1/inbox", inboxResponseSchema, abortController.signal),
        ]);

        if (abortController.signal.aborted) {
          return;
        }

        if (meResult.status === "fulfilled") {
          setAccount(meResult.value);
        }

        if (inboxResult.status === "fulfilled") {
          setAccount((currentAccount) => currentAccount ?? inboxResult.value.account);
          setMessages(
            inboxResult.value.messages.length > 0
              ? inboxResult.value.messages
              : demoMessages,
          );
          setStatus("ready");
          return;
        }

        setAccount(demoAccount);
        setMessages(demoMessages);
        setStatus("ready");
        setErrorMessage(
          meResult.status === "rejected"
            ? getErrorMessage(meResult.reason)
            : getErrorMessage(inboxResult.reason),
        );
      } catch (error) {
        if (abortController.signal.aborted) {
          return;
        }

        setAccount(demoAccount);
        setMessages(demoMessages);
        setStatus("ready");
        setErrorMessage(getErrorMessage(error));
      }
    }

    void loadInbox();

    return () => {
      abortController.abort();
    };
  }, []);

  const visibleMessages = useMemo(() => {
    if (!personFilter) {
      return messages;
    }

    return messages.filter((message) => messageIncludesPerson(message, personFilter));
  }, [messages, personFilter]);

  const mailboxItems = useMemo(
    () =>
      mailboxes.map((mailbox) =>
        mailbox.label === "Inbox"
          ? {
              ...mailbox,
              count:
                status === "ready"
                  ? personFilter
                    ? visibleMessages.length
                    : messages.length
                  : undefined,
            }
          : mailbox,
      ),
    [messages.length, personFilter, status, visibleMessages.length],
  );

  const inboxTitle = personFilter ? personFilter : "Inbox";
  const inboxEyebrow = personFilter ? "Filtered inbox" : "Human inbox";

  function openCompose() {
    if (panelClosing) {
      return;
    }

    setPanelClosing(false);
    setZenClosing(false);
    setSelectedMessage(null);
    setPanelMode("compose");
    setComposeTo("");
    setComposeSubject("");
    setDraft("");
    setZen(false);
  }

  function openThread(message: InboxMessage) {
    if (panelClosing) {
      return;
    }

    setPanelClosing(false);
    setZenClosing(false);
    setSelectedMessage(message);
    setPanelMode("thread");
    setComposeTo(message.from.name ?? message.from.email);
    setComposeSubject(replySubject(message.subject));
    setDraft("");
    setZen(false);
  }

  function closePanel() {
    if (!panelMode || panelClosing) {
      return;
    }

    setPanelClosing(true);
    if (zen) {
      setZenClosing(true);
    }

    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
    }

    closeTimerRef.current = setTimeout(() => {
      setPanelMode(null);
      setSelectedMessage(null);
      setComposeTo("");
      setComposeSubject("");
      setDraft("");
      setZen(false);
      setPanelClosing(false);
      setZenClosing(false);
      closeTimerRef.current = null;
    }, PANEL_ANIM_MS);
  }

  function exitZen() {
    if (!zen || zenClosing) {
      return;
    }

    setZenClosing(true);

    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
    }

    closeTimerRef.current = setTimeout(() => {
      setZen(false);
      setZenClosing(false);
      closeTimerRef.current = null;
    }, ZEN_ANIM_MS);
  }

  function enterZen() {
    if (zenClosing) {
      return;
    }

    setZenClosing(false);
    setZen(true);
  }

  function togglePersonFilter(name: string) {
    setPersonFilter((current) => (current === name ? null : name));
    closePanel();
  }

  return (
    <div className="app-root">
      <main className="app-shell">
        <aside className="sidebar" aria-label="Mailbox navigation">
          <header className="sidebar-header">
            <div className="brand">Orca</div>
            <div className="header-actions">
              <button
                aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
                className="theme-toggle"
                onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
                type="button"
              >
                {theme === "dark" ? "☀" : "☾"}
              </button>
              <button className="compose-button" onClick={openCompose} type="button">
                Compose
              </button>
            </div>
          </header>

          <label className="search-field">
            <span>Search mail</span>
            <input placeholder="People, subjects, words" />
          </label>

          <section className="sidebar-section mailbox-section">
            <h2>Mailboxes</h2>
            <nav className="nav-list">
              {mailboxItems.map((mailbox) => (
                <a
                  aria-current={mailbox.active ? "page" : undefined}
                  href={`/${mailbox.label.toLowerCase().replaceAll(" ", "-")}`}
                  key={mailbox.label}
                >
                  <span>{mailbox.label}</span>
                  {mailbox.count ? <small>{mailbox.count}</small> : null}
                </a>
              ))}
            </nav>
          </section>

          <SidebarSection
            activePerson={personFilter}
            items={pinnedPeople}
            onSelectPerson={togglePersonFilter}
            title="Pinned People"
          />
        </aside>

        <section className="content-pane" aria-label="Inbox">
          <header className="pane-header">
            <div>
              <p>{inboxEyebrow}</p>
              <h1>{inboxTitle}</h1>
            </div>
            <div className="pane-header-meta">
              {personFilter ? (
                <div className="filter-chip">
                  <span className="filter-chip-label">Showing threads with</span>
                  <strong>{personFilter}</strong>
                  <button
                    aria-label={`Clear filter for ${personFilter}`}
                    onClick={() => setPersonFilter(null)}
                    type="button"
                  >
                    ×
                  </button>
                </div>
              ) : null}
              <div className={`account-chip${account ? "" : " account-chip-muted"}`}>
                {account
                  ? `${formatProvider(account.provider)} · ${account.email}`
                  : "Connecting account..."}
              </div>
            </div>
          </header>

          <section className="inbox-body" aria-live="polite">
            {status === "loading" ? (
              <InboxStatusState
                description="Pulling your account and inbox list into Orca."
                eyebrow="Loading inbox"
                title="Connecting to the read-only API"
              />
            ) : null}

            {status === "ready" && visibleMessages.length === 0 ? (
              <InboxStatusState
                description={
                  personFilter
                    ? `No threads in your inbox include ${personFilter} yet.`
                    : "When synced mail arrives, your inbox list will appear here."
                }
                eyebrow={personFilter ? "No matches" : "Inbox empty"}
                title={personFilter ? "Nothing from this person" : "No messages yet"}
              />
            ) : null}

            {status === "ready" && visibleMessages.length > 0 ? (
              <ol className="message-list">
                {visibleMessages.map((message) => {
                  const signature = getContactSignature(message.from);
                  const isReply = message.subject.trim().toLowerCase().startsWith("re:");

                  return (
                    <li key={message.id}>
                      <button
                        className={`message-row${message.unread ? " message-row-unread" : ""}${isReply ? " message-row-reply" : ""}`}
                        onClick={() => openThread(message)}
                        style={
                          {
                            "--message-rail": signature.palette.rail,
                            "--message-mark-bg": signature.palette.bg,
                            "--message-mark-fg": signature.palette.fg,
                          } as React.CSSProperties
                        }
                        type="button"
                      >
                        <MessageMark signature={signature} unread={message.unread} />
                        <div className="message-copy">
                          <div className="message-meta">
                            <strong>{message.from.name ?? message.from.email}</strong>
                            <span>{formatReceivedAt(message.receivedAt)}</span>
                          </div>
                          <div className="message-subject-row">
                            <h2>{message.subject || "(no subject)"}</h2>
                            {message.unread ? <span className="message-unread-dot" /> : null}
                          </div>
                          <p>{message.snippet}</p>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ol>
            ) : null}
          </section>

          {errorMessage ? (
            <p className="filter-chip-label" style={{ marginTop: 12 }}>
              Previewing demo inbox — {errorMessage}
            </p>
          ) : null}
        </section>
      </main>

      {panelMode ? (
        <>
          <button
            aria-label="Close"
            className={`overlay-backdrop${panelClosing ? " overlay-backdrop-closing" : ""}`}
            onClick={closePanel}
            type="button"
          />

          <aside
            aria-label={panelMode === "compose" ? "Compose message" : "Thread"}
            className={`slide-panel slide-panel-open${panelClosing ? " slide-panel-closing" : ""}`}
          >
            <header className="panel-header">
              <h2>{panelMode === "compose" ? "New message" : selectedMessage?.subject || "Thread"}</h2>
              <div className="panel-actions">
                <button className="panel-zen" onClick={enterZen} type="button">
                  <ZenGlyph />
                  <span>Zen</span>
                </button>
                <button
                  aria-label="Close panel"
                  className="panel-close"
                  onClick={closePanel}
                  type="button"
                >
                  <ArrowGlyph direction="right" />
                </button>
              </div>
            </header>

            <div className="panel-body">
              {panelMode === "thread" && selectedMessage ? (
                <section aria-label="Thread message" className="thread-read">
                  <div className="thread-meta">
                    <strong>{selectedMessage.from.name ?? selectedMessage.from.email}</strong>
                    <span>
                      {selectedMessage.from.email} · {formatReceivedAt(selectedMessage.receivedAt)}
                    </span>
                  </div>
                  <div className="thread-body">
                    {threadBodies[selectedMessage.threadId] ?? selectedMessage.snippet}
                  </div>
                </section>
              ) : null}

              <ComposeFlow
                autoFocusTo={panelMode === "compose"}
                context={
                  panelMode === "thread" && selectedMessage
                    ? `Replying to ${selectedMessage.from.name ?? selectedMessage.from.email} · ${selectedMessage.subject || "no subject"}`
                    : ""
                }
                draft={draft}
                onDraftChange={setDraft}
                onSubjectChange={setComposeSubject}
                onToChange={setComposeTo}
                showContext={panelMode === "thread"}
                subject={composeSubject}
                to={composeTo}
              />
            </div>
          </aside>

          {zen ? (
            <ZenWriter
              closing={zenClosing}
              context={
                panelMode === "thread" && selectedMessage
                  ? `Replying to ${selectedMessage.from.name ?? selectedMessage.from.email} · ${selectedMessage.subject || "no subject"}`
                  : ""
              }
              draft={draft}
              onDraftChange={setDraft}
              onExit={exitZen}
              onSubjectChange={setComposeSubject}
              onToChange={setComposeTo}
              showContext={panelMode === "thread"}
              subject={composeSubject}
              to={composeTo}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function MessageMark({ signature, unread }: { signature: ContactSignature; unread: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`message-mark${unread ? " message-mark-unread" : ""}`}
      data-variant={signature.variant}
    >
      <ContactGlyph variant={signature.variant} />
    </span>
  );
}

function ContactGlyph({ variant }: { variant: number }) {
  switch (variant % 4) {
    case 0:
      return (
        <svg fill="none" viewBox="0 0 24 24">
          <path d="M4 16c4-8 12-8 16 0" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
          <path d="M8 18c2-3 6-3 8 0" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
        </svg>
      );
    case 1:
      return (
        <svg fill="currentColor" viewBox="0 0 24 24">
          <circle cx="8" cy="8" r="2.2" />
          <circle cx="16" cy="8" r="2.2" />
          <circle cx="12" cy="16" r="2.2" />
        </svg>
      );
    case 2:
      return (
        <svg fill="none" viewBox="0 0 24 24">
          <path d="M7 6v12M17 6v12" stroke="currentColor" strokeLinecap="round" strokeWidth="2.2" />
          <path d="M7 12h10" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4" opacity="0.45" />
        </svg>
      );
    default:
      return (
        <svg fill="none" viewBox="0 0 24 24">
          <path d="M6 18V8a4 4 0 0 1 8 0v10" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
          <path d="M6 14h8" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" opacity="0.5" />
        </svg>
      );
  }
}

function SidebarSection({
  title,
  items,
  activePerson,
  onSelectPerson,
}: {
  title: string;
  items: PersonItem[];
  activePerson: string | null;
  onSelectPerson: (name: string) => void;
}) {
  return (
    <section className="sidebar-section">
      <h2>{title}</h2>
      <div className="person-list">
        {items.map((item) => (
          <button
            aria-pressed={activePerson === item.name}
            className={`person-row${activePerson === item.name ? " person-row-active" : ""}`}
            key={item.name}
            onClick={() => onSelectPerson(item.name)}
            type="button"
          >
            <span className="avatar">{item.initials}</span>
            <span className="person-copy">
              <strong>{item.name}</strong>
              <small>{item.context}</small>
            </span>
            {item.unread ? <span className="unread-dot" /> : null}
          </button>
        ))}
      </div>
    </section>
  );
}

function ComposeFlow({
  to,
  context,
  subject,
  draft,
  showContext,
  autoFocusTo,
  onToChange,
  onSubjectChange,
  onDraftChange,
}: {
  to: string;
  context: string;
  subject: string;
  draft: string;
  showContext: boolean;
  autoFocusTo: boolean;
  onToChange: (value: string) => void;
  onSubjectChange: (value: string) => void;
  onDraftChange: (value: string) => void;
}) {
  const toInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocusTo) {
      toInputRef.current?.focus();
    }
  }, [autoFocusTo]);

  return (
    <section aria-label="Compose message" className="compose-flow">
      <label className="compose-field compose-field-who">
        <span className="compose-label">Who</span>
        <input
          className="compose-input compose-input-who"
          onChange={(event) => onToChange(event.target.value)}
          placeholder="Name or email"
          ref={toInputRef}
          type="text"
          value={to}
        />
      </label>

      {showContext && context ? (
        <div className="compose-field compose-field-context">
          <span className="compose-label">Context</span>
          <p className="compose-context">{context}</p>
        </div>
      ) : null}

      <label className="compose-field compose-field-subject">
        <span className="compose-label">Subject</span>
        <input
          className="compose-input compose-input-subject"
          onChange={(event) => onSubjectChange(event.target.value)}
          placeholder="Subject line"
          type="text"
          value={subject}
        />
      </label>

      <label className="compose-field compose-field-write">
        <span className="compose-label">Write</span>
        <textarea
          className="compose-input compose-input-write"
          onChange={(event) => onDraftChange(event.target.value)}
          placeholder="Start writing..."
          value={draft}
        />
      </label>
    </section>
  );
}

function ZenWriter({
  to,
  context,
  subject,
  draft,
  showContext,
  closing,
  onToChange,
  onSubjectChange,
  onDraftChange,
  onExit,
}: {
  to: string;
  context: string;
  subject: string;
  draft: string;
  showContext: boolean;
  closing: boolean;
  onToChange: (value: string) => void;
  onSubjectChange: (value: string) => void;
  onDraftChange: (value: string) => void;
  onExit: () => void;
}) {
  const writeRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    writeRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onExit();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onExit]);

  return (
    <section
      aria-label="Zen writing mode"
      className={`zen-canvas${closing ? " zen-canvas-closing" : ""}`}
    >
      <header className="zen-header">
        <button className="zen-back" onClick={onExit} type="button">
          <ArrowGlyph direction="right" />
          <span>Exit Zen</span>
        </button>
      </header>

      <div className="zen-stage">
        <div className="zen-column">
          <div className="zen-meta">
            <input
              aria-label="Who"
              className="zen-meta-who"
              onChange={(event) => onToChange(event.target.value)}
              placeholder="Who"
              type="text"
              value={to}
            />
            {showContext && context ? (
              <>
                <span aria-hidden="true" className="zen-meta-sep">
                  ·
                </span>
                <span className="zen-meta-context">{context}</span>
              </>
            ) : null}
            <span aria-hidden="true" className="zen-meta-sep">
              ·
            </span>
            <input
              aria-label="Subject"
              className="zen-meta-subject"
              onChange={(event) => onSubjectChange(event.target.value)}
              placeholder="Subject"
              type="text"
              value={subject}
            />
          </div>

          <textarea
            aria-label="Message body"
            className="zen-write"
            onChange={(event) => onDraftChange(event.target.value)}
            placeholder="Start writing..."
            ref={writeRef}
            value={draft}
          />
        </div>
      </div>
    </section>
  );
}

function ArrowGlyph({ direction }: { direction: "left" | "right" }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="16"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width="16"
    >
      {direction === "right" ? (
        <>
          <path d="M5 12h13" />
          <path d="M13 6l6 6-6 6" />
        </>
      ) : (
        <>
          <path d="M19 12H6" />
          <path d="M11 6l-6 6 6 6" />
        </>
      )}
    </svg>
  );
}

function ZenGlyph() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="16"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width="16"
    >
      <path d="M4 20 20 4" />
      <path d="M9 4h11v11" />
      <path d="M15 20H4V9" />
    </svg>
  );
}

function InboxStatusState({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className="empty-state">
      <p>{eyebrow}</p>
      <h2>{title}</h2>
      <span>{description}</span>
    </div>
  );
}

type JsonSchema<T> = {
  parse(value: unknown): T;
};

async function fetchJson<T>(
  input: string,
  schema: JsonSchema<T>,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(input, { signal });

  if (!response.ok) {
    throw new Error(`Request failed with ${response.status} ${response.statusText}`.trim());
  }

  return schema.parse(await response.json());
}

function readStoredTheme(): Theme {
  if (typeof window === "undefined") {
    return "dark";
  }

  try {
    const stored = window.localStorage.getItem("orca-theme");
    return stored === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function formatProvider(provider: MailAccount["provider"]) {
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function formatReceivedAt(receivedAt: string) {
  const date = new Date(receivedAt);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const now = new Date();
  const options: Intl.DateTimeFormatOptions =
    date.toDateString() === now.toDateString()
      ? { hour: "numeric", minute: "2-digit" }
      : { month: "short", day: "numeric" };

  return new Intl.DateTimeFormat(undefined, options).format(date);
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return "An unexpected error occurred while loading inbox data.";
}

function replySubject(subject: string) {
  const trimmed = subject.trim();
  if (!trimmed) {
    return "Re: (no subject)";
  }

  return trimmed.toLowerCase().startsWith("re:") ? trimmed : `Re: ${trimmed}`;
}
