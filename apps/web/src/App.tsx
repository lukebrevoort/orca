import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { InboxMessage, MailAccount } from "@orca/shared";
import { inboxResponseSchema, meResponseSchema } from "@orca/shared";
import {
  demoAccount,
  demoMessages,
  messageIncludesPerson,
  messageBodies,
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

type PanelMode = "compose" | null;
type OAuthConnectStatus = "idle" | "loading" | "error";
type OAuthReturnStatus =
  | { kind: "success"; email: string | null }
  | { kind: "error"; reason: string | null; message: string | null }
  | null;

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

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("orca-theme", theme);
  }, [theme]);

  if (isOAuthLoginRoute()) {
    return <GmailOAuthLoginPage />;
  }

  return <InboxApp theme={theme} setTheme={setTheme} />;
}

function InboxApp({
  theme,
  setTheme,
}: {
  theme: Theme;
  setTheme: Dispatch<SetStateAction<Theme>>;
}) {
  const [account, setAccount] = useState<MailAccount | null>(null);
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [status, setStatus] = useState<"loading" | "ready">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [personFilter, setPersonFilter] = useState<string | null>(null);
  const [panelMode, setPanelMode] = useState<PanelMode>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
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

  const selectedThreadMessages = useMemo(() => {
    if (!selectedThreadId) {
      return [];
    }

    return messages
      .filter((message) => message.threadId === selectedThreadId)
      .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  }, [messages, selectedThreadId]);

  const selectedThreadLatestMessage =
    selectedThreadMessages[selectedThreadMessages.length - 1] ?? null;

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
    setSelectedThreadId(message.threadId);
  }

  function closeThread() {
    setSelectedThreadId(null);
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
    setSelectedThreadId(null);
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

        <section className="content-pane" aria-label={selectedThreadId ? "Thread" : "Inbox"}>
          {selectedThreadId && selectedThreadLatestMessage ? (
            <ThreadView
              messages={selectedThreadMessages}
              onBack={closeThread}
              title={selectedThreadLatestMessage.subject || "(no subject)"}
            />
          ) : (
            <InboxView
              account={account}
              errorMessage={errorMessage}
              inboxEyebrow={inboxEyebrow}
              inboxTitle={inboxTitle}
              messages={visibleMessages}
              onClearFilter={() => setPersonFilter(null)}
              onOpenThread={openThread}
              personFilter={personFilter}
              status={status}
            />
          )}
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
            aria-label="Compose message"
            className={`slide-panel slide-panel-open${panelClosing ? " slide-panel-closing" : ""}`}
          >
            <header className="panel-header">
              <h2>New message</h2>
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
              <ComposeFlow
                autoFocusTo={panelMode === "compose"}
                context=""
                draft={draft}
                onDraftChange={setDraft}
                onSubjectChange={setComposeSubject}
                onToChange={setComposeTo}
                showContext={false}
                subject={composeSubject}
                to={composeTo}
              />
            </div>
          </aside>

          {zen ? (
            <ZenWriter
              closing={zenClosing}
              context=""
              draft={draft}
              onDraftChange={setDraft}
              onExit={exitZen}
              onSubjectChange={setComposeSubject}
              onToChange={setComposeTo}
              showContext={false}
              subject={composeSubject}
              to={composeTo}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function GmailOAuthLoginPage() {
  const [connectStatus, setConnectStatus] = useState<OAuthConnectStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [returnStatus, setReturnStatus] = useState<OAuthReturnStatus>(() => readOAuthReturnStatus());
  const connectInFlightRef = useRef(false);

  async function connectGmail() {
    if (connectInFlightRef.current || connectStatus === "loading") {
      return;
    }

    connectInFlightRef.current = true;
    setReturnStatus(null);
    setConnectStatus("loading");
    setErrorMessage(null);

    try {
      const returnTo =
        typeof window === "undefined"
          ? "/settings/integrations/gmail"
          : `${window.location.origin}/settings/integrations/gmail`;
      const response = await fetch(
        `/v1/auth/gmail/connect?returnTo=${encodeURIComponent(returnTo)}`,
        {
          credentials: "include",
        },
      );

      if (!response.ok) {
        const body = await readJsonObject(response);
        throw new Error(
          getStringField(body, "message") ??
            `Could not start Gmail OAuth (${response.status} ${response.statusText})`.trim(),
        );
      }

      const body = await readJsonObject(response);
      const authUrl = getStringField(body, "authUrl");
      if (!authUrl) {
        throw new Error("The Gmail OAuth connect response did not include an authUrl.");
      }

      window.location.assign(authUrl);
    } catch (error) {
      connectInFlightRef.current = false;
      setConnectStatus("error");
      setErrorMessage(getErrorMessage(error));
    }
  }

  return (
    <main className="oauth-page">
      <section className="oauth-shell" aria-labelledby="gmail-oauth-title">
        <div className="oauth-brand">
          <span className="oauth-brand-mark" aria-hidden="true">
            O
          </span>
          <span>Orca</span>
        </div>

        <div className="oauth-hero">
          <p className="oauth-eyebrow">Gmail OAuth</p>
          <h1 id="gmail-oauth-title">Connect your Gmail inbox</h1>
          <p>
            Give Orca read-only access to Gmail so it can sync human mail without
            sending, deleting, or modifying messages.
          </p>

          {returnStatus ? <OAuthReturnNotice status={returnStatus} /> : null}
          {errorMessage ? (
            <div className="oauth-notice oauth-notice-error" role="alert">
              <strong>Connection could not start</strong>
              <span>{errorMessage}</span>
            </div>
          ) : null}

          <button
            className="oauth-google-button"
            disabled={connectStatus === "loading"}
            onClick={connectGmail}
            type="button"
          >
            <GoogleGlyph />
            <span>{connectStatus === "loading" ? "Opening Google..." : "Continue with Google"}</span>
          </button>

          <p className="oauth-fine-print">
            Uses the `gmail.readonly` and `userinfo.email` scopes. You can revoke
            access later in your Google Account security settings.
          </p>
        </div>

        <aside className="oauth-setup-panel" aria-label="Google OAuth setup checklist">
          <h2>Google setup checklist</h2>
          <ol>
            <li>Create a Google Cloud OAuth client for a web application.</li>
            <li>Add `http://localhost:5173` as an authorized JavaScript origin.</li>
            <li>Add `http://localhost:3000/v1/auth/gmail/callback` as the redirect URI.</li>
            <li>Copy the client ID and secret into `.env`, then restart the API.</li>
          </ol>
          <a href="/docs/gmail-oauth-setup.html">Open setup guide</a>
        </aside>
      </section>
    </main>
  );
}

function OAuthReturnNotice({ status }: { status: OAuthReturnStatus }) {
  if (!status) {
    return null;
  }

  if (status.kind === "success") {
    return (
      <div className="oauth-notice oauth-notice-success" role="status">
        <strong>Gmail connected</strong>
        <span>
          {status.email
            ? `${status.email} is ready for read-only inbox sync.`
            : "Your Gmail account is ready for read-only inbox sync."}
        </span>
      </div>
    );
  }

  return (
    <div className="oauth-notice oauth-notice-error" role="alert">
      <strong>Google returned an error</strong>
      <span>{status.message ?? status.reason ?? "The Gmail OAuth flow did not complete."}</span>
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

function InboxView({
  account,
  errorMessage,
  inboxEyebrow,
  inboxTitle,
  messages,
  personFilter,
  status,
  onClearFilter,
  onOpenThread,
}: {
  account: MailAccount | null;
  errorMessage: string | null;
  inboxEyebrow: string;
  inboxTitle: string;
  messages: InboxMessage[];
  personFilter: string | null;
  status: "loading" | "ready";
  onClearFilter: () => void;
  onOpenThread: (message: InboxMessage) => void;
}) {
  return (
    <>
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
                onClick={onClearFilter}
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

        {status === "ready" && messages.length === 0 ? (
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

        {status === "ready" && messages.length > 0 ? (
          <ol className="message-list">
            {messages.map((message) => {
              const signature = getContactSignature(message.from);
              const isReply = message.subject.trim().toLowerCase().startsWith("re:");

              return (
                <li key={message.id}>
                  <button
                    className={`message-row${message.unread ? " message-row-unread" : ""}${isReply ? " message-row-reply" : ""}`}
                    onClick={() => onOpenThread(message)}
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
    </>
  );
}

function ThreadView({
  messages,
  title,
  onBack,
}: {
  messages: InboxMessage[];
  title: string;
  onBack: () => void;
}) {
  return (
    <article className="thread-view">
      <header className="thread-view-header">
        <button className="thread-back" onClick={onBack} type="button">
          <ArrowGlyph direction="left" />
          <span>Inbox</span>
        </button>
        <div>
          <p>Thread</p>
          <h1>{title}</h1>
          <span>
            {messages.length} {messages.length === 1 ? "message" : "messages"}
          </span>
        </div>
      </header>

      <ol className="thread-message-list">
        {messages.map((message) => (
          <li className="thread-message" key={message.id}>
            <div className="thread-message-meta">
              <div>
                <strong>{message.from.name ?? message.from.email}</strong>
                <span>{message.from.email}</span>
              </div>
              <time dateTime={message.receivedAt}>{formatReceivedAt(message.receivedAt)}</time>
            </div>
            <div className="thread-body">{getThreadBody(message)}</div>
          </li>
        ))}
      </ol>
    </article>
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

function GoogleGlyph() {
  return (
    <svg aria-hidden="true" height="20" viewBox="0 0 24 24" width="20">
      <path
        d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.3Z"
        fill="#4285F4"
      />
      <path
        d="M12 22c2.7 0 5-0.9 6.6-2.5L15.4 17c-.9.6-2 .9-3.4.9a6 6 0 0 1-5.7-4.1H3v2.6A10 10 0 0 0 12 22Z"
        fill="#34A853"
      />
      <path
        d="M6.3 13.8a6 6 0 0 1 0-3.6V7.6H3a10 10 0 0 0 0 8.8l3.3-2.6Z"
        fill="#FBBC05"
      />
      <path
        d="M12 6.1c1.5 0 2.8.5 3.8 1.5l2.9-2.9A9.7 9.7 0 0 0 12 2a10 10 0 0 0-9 5.6l3.3 2.6A6 6 0 0 1 12 6.1Z"
        fill="#EA4335"
      />
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

async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json();
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function getStringField(value: Record<string, unknown>, key: string) {
  const field = value[key];
  return typeof field === "string" && field.trim() ? field : null;
}

function isOAuthLoginRoute() {
  if (typeof window === "undefined") {
    return false;
  }

  return window.location.pathname === "/login" || window.location.pathname === "/settings/integrations/gmail";
}

function readOAuthReturnStatus(): OAuthReturnStatus {
  if (typeof window === "undefined") {
    return null;
  }

  const params = new URLSearchParams(window.location.search);
  const status = params.get("status");

  if (status === "success") {
    return {
      kind: "success",
      email: params.get("email"),
    };
  }

  if (status === "error") {
    return {
      kind: "error",
      reason: params.get("reason"),
      message: params.get("message"),
    };
  }

  return null;
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

function getThreadBody(message: InboxMessage) {
  return messageBodies[message.id] ?? message.snippet;
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
