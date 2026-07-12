import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { AttentionViewSetting, InboxMessage, MailAccount, ResolvedSenderAttention, SyncStatus } from "@orca/shared";
import { attentionViewSettingSchema, inboxResponseSchema, meResponseSchema, resolvedSenderAttentionSchema, syncStatusSchema } from "@orca/shared";
import {
  messageIncludesPerson,
  messageBodies,
} from "./demo-data";
import { getContactSignature, type ContactSignature } from "./contact-signature";

type Theme = "light" | "dark";

type Mailbox = "inbox" | "sent" | "spam" | "all";

type MailboxItem = {
  id: Mailbox;
  label: string;
  gmailLabel?: string;
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

const mailboxes: MailboxItem[] = [
  { id: "inbox", label: "Inbox", gmailLabel: "INBOX" },
  { id: "sent", label: "Sent", gmailLabel: "SENT" },
  { id: "spam", label: "Spam", gmailLabel: "SPAM" },
  { id: "all", label: "All Mail" },
];

export function App() {
  const [theme, setTheme] = useState<Theme>(() => readStoredTheme());
  const [access, setAccess] = useState<"checking" | "authenticated" | "signedout">("checking");

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("orca-theme", theme);
  }, [theme]);

  useEffect(() => {
    if (isOAuthLoginRoute()) return;
    const abortController = new AbortController();
    fetch("/v1/auth/session", { credentials: "include", signal: abortController.signal })
      .then((response) => setAccess(response.ok ? "authenticated" : "signedout"))
      .catch(() => {
        if (!abortController.signal.aborted) setAccess("signedout");
      });
    return () => abortController.abort();
  }, []);

  if (isOAuthLoginRoute()) {
    return <GmailOAuthLoginPage />;
  }

  if (access === "checking") return <SessionCheckingScreen />;
  if (access === "signedout") return <LoginRequiredScreen />;

  if (isAttentionSettingsRoute()) {
    return <AttentionViewSettingsPage onSessionExpired={() => setAccess("signedout")} theme={theme} setTheme={setTheme} />;
  }

  return <InboxApp theme={theme} setTheme={setTheme} />;
}

const attentionViewSettingsSchema: JsonSchema<AttentionViewSetting[]> = {
  parse(value: unknown) {
    if (!Array.isArray(value)) {
      throw new Error("Attention view settings response was not a list.");
    }
    return value.map((setting) => attentionViewSettingSchema.parse(setting));
  },
};

const resolvedSenderAttentionResponseSchema: JsonSchema<ResolvedSenderAttention> = {
  parse(value: unknown) {
    return resolvedSenderAttentionSchema.parse(value);
  },
};

const attentionIconGlyphs: Record<string, string> = {
  bell: "●",
  sparkles: "✦",
  inbox: "↓",
  moon: "◒",
  "eye-off": "—",
};

function getAttentionIconGlyph(icon: string) {
  return attentionIconGlyphs[icon.toLowerCase()] ?? (icon.trim().slice(0, 1).toUpperCase() || "•");
}

function AttentionViewSettingsPage({
  onSessionExpired,
  theme,
  setTheme,
}: {
  onSessionExpired: () => void;
  theme: Theme;
  setTheme: Dispatch<SetStateAction<Theme>>;
}) {
  const [settings, setSettings] = useState<AttentionViewSetting[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [savedBehavior, setSavedBehavior] = useState<string | null>(null);
  const [dirtyBehaviors, setDirtyBehaviors] = useState<Set<string>>(() => new Set());
  const hasUnsavedChanges = dirtyBehaviors.size > 0;

  useEffect(() => {
    const abortController = new AbortController();
    setStatus("loading");
    setErrorMessage(null);

    fetchJson("/v1/attention/view-settings", attentionViewSettingsSchema, abortController.signal)
      .then((nextSettings) => {
        if (abortController.signal.aborted) return;
        setSettings(nextSettings);
        setStatus("ready");
      })
      .catch((error) => {
        if (abortController.signal.aborted) return;
        if (error instanceof ApiRequestError && error.status === 401) {
          onSessionExpired();
          return;
        }
        setStatus("error");
        setErrorMessage(getErrorMessage(error));
      });

    return () => abortController.abort();
  }, []);

  function updateDraft(behavior: string, patch: Partial<AttentionViewSetting>) {
    setSavedBehavior(null);
    setDirtyBehaviors((current) => new Set(current).add(behavior));
    setSettings((current) => current.map((setting) => (
      setting.behavior === behavior ? { ...setting, ...patch } : setting
    )));
  }

  async function saveSetting(setting: AttentionViewSetting) {
    setSaving(setting.behavior);
    setErrorMessage(null);
    try {
      const updated = await fetchJson(
        `/v1/attention/view-settings/${setting.behavior}`,
        attentionViewSettingSchema,
        undefined,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            displayName: setting.displayName.trim(),
            icon: setting.icon.trim(),
            color: setting.color,
            position: setting.position,
          }),
        },
      );
      setSettings((current) => current.map((item) => item.behavior === updated.behavior ? updated : item));
      setDirtyBehaviors((current) => {
        const next = new Set(current);
        next.delete(updated.behavior);
        return next;
      });
      setSavedBehavior(updated.behavior);
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 401) {
        onSessionExpired();
        return;
      }
      setErrorMessage(`Could not save ${setting.displayName}. ${getErrorMessage(error)}`);
    } finally {
      setSaving(null);
    }
  }

  async function moveSetting(setting: AttentionViewSetting, direction: -1 | 1) {
    const nextPosition = setting.position + direction;
    if (nextPosition < 0 || nextPosition >= settings.length) return;
    setSavedBehavior(null);
    setSaving(setting.behavior);
    setErrorMessage(null);
    try {
      const updated = await fetchJson(
        `/v1/attention/view-settings/${setting.behavior}`,
        attentionViewSettingSchema,
        undefined,
        { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ position: nextPosition }) },
      );
      const reorderedSettings = await fetchJson("/v1/attention/view-settings", attentionViewSettingsSchema);
      setSettings(reorderedSettings);
      setSavedBehavior(updated.behavior);
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 401) {
        onSessionExpired();
        return;
      }
      setErrorMessage(`Could not move ${setting.displayName}. ${getErrorMessage(error)}`);
    } finally {
      setSaving(null);
    }
  }

  return (
    <main className="attention-settings-page">
      <header className="attention-settings-topbar">
        <a className="settings-brand" href="/"><span aria-hidden="true">O</span> Orca</a>
        <div className="settings-topbar-actions">
          <a className="settings-back-link" href="/">← Inbox</a>
          <button
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            className="theme-toggle"
            onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")}
            type="button"
          >
            {theme === "dark" ? "☀" : "☾"}
          </button>
        </div>
      </header>

      <section className="attention-settings-shell" aria-labelledby="attention-settings-title">
        <header className="attention-settings-intro">
          <p className="settings-eyebrow">Settings / Attention views</p>
          <h1 id="attention-settings-title">Shape your<br /><em>attention.</em></h1>
          <p>Choose how each kind of message appears in your inbox. These names, marks, colors, and positions stay yours.</p>
        </header>

        <section aria-label="Attention view settings" className="attention-settings-list">
          <div className="attention-list-heading">
            <span>Your views</span>
            <span>{status === "ready" ? `${settings.length} views` : ""}</span>
          </div>

          {hasUnsavedChanges ? <p className="attention-unsaved-note" role="status">Save your edits before changing the order.</p> : null}

          {status === "loading" ? <div className="attention-loading">Loading your attention views…</div> : null}
          {status === "error" ? <div className="attention-error" role="alert">{errorMessage ?? "Could not load your attention views."} <button onClick={() => window.location.reload()} type="button">Try again</button></div> : null}
          {status === "ready" ? settings.map((setting, index) => (
            <article className="attention-setting-card" key={setting.behavior} style={{ "--view-color": setting.color } as CSSProperties}>
              <div className="attention-setting-number" aria-hidden="true">0{index + 1}</div>
              <div className="attention-setting-main">
                <div className="attention-setting-preview">
                  <span className="attention-setting-dot" />
                  <span aria-hidden="true" className="attention-setting-glyph">{getAttentionIconGlyph(setting.icon)}</span>
                </div>
                <div className="attention-setting-fields">
                  <label>
                    <span>View name</span>
                    <input aria-label={`${setting.behavior} view name`} disabled={saving !== null} maxLength={80} onChange={(event) => updateDraft(setting.behavior, { displayName: event.target.value })} value={setting.displayName} />
                  </label>
                  <label>
                    <span>Icon label</span>
                    <input aria-label={`${setting.behavior} icon`} disabled={saving !== null} maxLength={80} onChange={(event) => updateDraft(setting.behavior, { icon: event.target.value })} value={setting.icon} />
                  </label>
                  <label className="attention-color-field">
                    <span>Color</span>
                    <input aria-label={`${setting.behavior} color`} disabled={saving !== null} onChange={(event) => updateDraft(setting.behavior, { color: event.target.value })} type="color" value={setting.color} />
                    <code>{setting.color}</code>
                  </label>
                </div>
              </div>
              <div className="attention-setting-actions">
                <div className="attention-move-controls" aria-label={`Move ${setting.displayName}`}>
                  <button aria-label={`Move ${setting.displayName} up`} disabled={index === 0 || saving !== null || hasUnsavedChanges} onClick={() => void moveSetting(setting, -1)} type="button">↑</button>
                  <button aria-label={`Move ${setting.displayName} down`} disabled={index === settings.length - 1 || saving !== null || hasUnsavedChanges} onClick={() => void moveSetting(setting, 1)} type="button">↓</button>
                </div>
                <button className="attention-save-button" disabled={saving !== null || !setting.displayName.trim() || !setting.icon.trim()} onClick={() => void saveSetting(setting)} type="button">
                  {saving === setting.behavior ? "Saving…" : savedBehavior === setting.behavior ? "Saved" : "Save"}
                </button>
              </div>
            </article>
          )) : null}
        </section>
      </section>
    </main>
  );
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
  const [status, setStatus] = useState<"loading" | "syncing" | "ready" | "error" | "signedout">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [activeMailbox, setActiveMailbox] = useState<Mailbox>("inbox");
  const [refreshKey, setRefreshKey] = useState(0);
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
      setStatus(messages.length > 0 ? "syncing" : "loading");
      setErrorMessage(null);

      try {
        const currentAccount = await fetchJson("/v1/me", meResponseSchema, abortController.signal);
        if (abortController.signal.aborted) return;
        setAccount(currentAccount);
        setSyncStatus(await fetchJson("/v1/sync/status", syncStatusSchema, abortController.signal));

        setStatus("syncing");
        try {
          await fetchJson("/v1/sync/gmail", { parse: (value: unknown) => value }, abortController.signal, { method: "POST" });
          setSyncStatus(await fetchJson("/v1/sync/status", syncStatusSchema, abortController.signal));
        } catch (error) {
          if (abortController.signal.aborted) return;
          setErrorMessage(`Could not refresh Gmail just now. Showing your last successful sync. ${getErrorMessage(error)}`);
        }

        const inbox = await fetchJson("/v1/inbox", inboxResponseSchema, abortController.signal);
        if (abortController.signal.aborted) return;
        setAccount(inbox.account);
        setMessages(inbox.messages);
        setStatus("ready");
      } catch (error) {
        if (abortController.signal.aborted) return;
        if (error instanceof ApiRequestError && error.status === 401) {
          setStatus("signedout");
          return;
        }
        setStatus("error");
        setErrorMessage(getErrorMessage(error));
      }
    }

    void loadInbox();

    return () => {
      abortController.abort();
    };
  }, [refreshKey]);

  const pinnedPeople = useMemo(() => buildPinnedPeople(messages), [messages]);

  const mailboxMessages = useMemo(
    () => getMessagesForMailbox(messages, activeMailbox),
    [activeMailbox, messages],
  );

  const visibleMessages = useMemo(
    () => personFilter
      ? mailboxMessages.filter((message) => messageIncludesPerson(message, personFilter))
      : mailboxMessages,
    [mailboxMessages, personFilter],
  );

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
      mailboxes.map((mailbox) => ({
        ...mailbox,
        count: status === "ready" ? getMessagesForMailbox(messages, mailbox.id).length : undefined,
      })),
    [messages, status],
  );

  const activeMailboxLabel = mailboxes.find((item) => item.id === activeMailbox)?.label ?? "Inbox";
  const inboxTitle = personFilter ? personFilter : activeMailboxLabel;
  const inboxEyebrow = personFilter ? `Filtered ${activeMailboxLabel.toLowerCase()}` : "Gmail mailbox";

  if (status === "signedout") {
    return <LoginRequiredScreen />;
  }

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

  function selectMailbox(mailbox: Mailbox) {
    setActiveMailbox(mailbox);
    setPersonFilter(null);
    setSelectedThreadId(null);
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
                <button
                  aria-current={mailbox.id === activeMailbox ? "page" : undefined}
                  className="mailbox-tab"
                  onClick={() => selectMailbox(mailbox.id)}
                  key={mailbox.label}
                  type="button"
                >
                  <span>{mailbox.label}</span>
                  {mailbox.count !== undefined ? <small>{mailbox.count}</small> : null}
                </button>
              ))}
            </nav>
          </section>

          <a className="settings-link" href="/settings/attention-views">
            <span aria-hidden="true">⚙</span> Attention views
          </a>

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
              syncStatus={syncStatus}
              isRefreshing={status === "syncing" && messages.length > 0}
              onRefresh={() => setRefreshKey((key) => key + 1)}
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
  const isLogin = typeof window !== "undefined" && window.location.pathname === "/login";
  const isOnboarding = typeof window !== "undefined" && window.location.pathname === "/onboarding";

  async function connectGmail() {
    if (connectInFlightRef.current || connectStatus === "loading") {
      return;
    }

    connectInFlightRef.current = true;
    setReturnStatus(null);
    setConnectStatus("loading");
    setErrorMessage(null);

    try {
      const returnTo = typeof window === "undefined"
        ? "/onboarding"
        : `${window.location.origin}/${isLogin ? "onboarding" : ""}`;
      const response = await fetch(
        `/v1/auth/gmail/${isLogin ? "login" : "connect"}?returnTo=${encodeURIComponent(returnTo)}`,
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
          <p className="oauth-eyebrow">{isOnboarding ? "Your workspace is ready" : isLogin ? "A quieter way to email" : "Gmail connection"}</p>
          <h1 id="gmail-oauth-title">
            {isOnboarding && returnStatus?.kind === "success"
              ? "Welcome aboard."
              : isLogin
                ? "Make room for the people."
                : "Connect your Gmail inbox"}
          </h1>
          <p>
            {isOnboarding && returnStatus?.kind === "success"
              ? "Orca is now connected to your Gmail account. Your first inbox sync can begin when you enter your workspace."
              : "Orca uses Google to sign you in, then asks only for read-only Gmail access to build a calmer inbox—never to send, delete, or modify your messages."}
          </p>

          {returnStatus ? <OAuthReturnNotice status={returnStatus} /> : null}
          {errorMessage ? (
            <div className="oauth-notice oauth-notice-error" role="alert">
              <strong>Connection could not start</strong>
              <span>{errorMessage}</span>
            </div>
          ) : null}

          {isOnboarding && returnStatus?.kind === "success" ? (
            <a className="oauth-google-button oauth-enter-button" href="/">Enter Orca <span aria-hidden="true">→</span></a>
          ) : (
            <button
              className="oauth-google-button"
              disabled={connectStatus === "loading"}
              onClick={connectGmail}
              type="button"
            >
              <GoogleGlyph />
              <span>{connectStatus === "loading" ? "Opening Google..." : isLogin ? "Continue with Google" : "Connect Gmail"}</span>
            </button>
          )}

          <p className="oauth-fine-print">
            Uses `gmail.readonly` and `userinfo.email`. You can revoke access at any time in your Google Account security settings.
          </p>
        </div>

        <aside className="oauth-setup-panel" aria-label="Google OAuth setup checklist">
          <h2>{isLogin ? "What happens next" : "Google setup checklist"}</h2>
          <ol>
            {isLogin ? <>
              <li>Choose the Google account you want to bring to Orca.</li>
              <li>Review the read-only permission on Google’s secure screen.</li>
              <li>Return here to enter your new human-first inbox.</li>
            </> : <>
              <li>Create a Google Cloud OAuth client for a web application.</li>
              <li>Add `http://localhost:5173` as an authorized JavaScript origin.</li>
              <li>Add `http://localhost:3000/v1/auth/gmail/callback` as the redirect URI.</li>
              <li>Copy the client ID and secret into `.env`, then restart the API.</li>
            </>}
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
  syncStatus,
  isRefreshing,
  onClearFilter,
  onOpenThread,
  onRefresh,
}: {
  account: MailAccount | null;
  errorMessage: string | null;
  inboxEyebrow: string;
  inboxTitle: string;
  messages: InboxMessage[];
  personFilter: string | null;
  status: "loading" | "syncing" | "ready" | "error";
  syncStatus: SyncStatus | null;
  isRefreshing: boolean;
  onClearFilter: () => void;
  onOpenThread: (message: InboxMessage) => void;
  onRefresh: () => void;
}) {
  return (
    <>
      <header className="pane-header">
        <div>
          <p>{inboxEyebrow}</p>
          <h1>{inboxTitle}</h1>
        </div>
        <div className="pane-header-meta">
          <button
            className={`refresh-button${isRefreshing ? " refresh-button-active" : ""}`}
            disabled={isRefreshing}
            onClick={onRefresh}
            type="button"
          >
            <span aria-hidden="true">↻</span>
            {isRefreshing ? "Refreshing Gmail" : "Refresh"}
          </button>
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
          <SyncStatusChip status={syncStatus?.accounts.find((item) => item.id === account?.id) ?? null} />
        </div>
      </header>

      <section className="inbox-body" aria-live="polite">
        {status === "loading" || (status === "syncing" && messages.length === 0) ? (
          <InboxStatusState
            description={status === "syncing" ? "Reading your Gmail inbox and bringing the latest conversations into Orca." : "Checking your Orca session."}
            eyebrow={status === "syncing" ? "Syncing Gmail" : "Opening Orca"}
            title={status === "syncing" ? "Making room for your mail" : "Checking your key"}
          />
        ) : null}

        {status === "error" ? (
          <InboxStatusState description={errorMessage ?? "Please try again."} eyebrow="Could not open inbox" title="Your mailbox is safe—Orca just could not reach it." />
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
                  <div className="message-row-wrap">
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
                    <SenderAttentionControl compact message={message} />
                  </div>
                </li>
              );
            })}
          </ol>
        ) : null}
      </section>

      {errorMessage && status === "ready" ? (
        <p className="filter-chip-label" style={{ marginTop: 12 }}>
          {errorMessage} <a className="inbox-reconnect-link" href="/settings/integrations/gmail">Reconnect Gmail</a>
        </p>
      ) : null}
    </>
  );
}

function SyncStatusChip({ status }: { status: SyncStatus["accounts"][number] | null }) {
  if (!status) return null;
  const labels = {
    idle: status.lastSyncedAt ? `Synced ${formatReceivedAt(status.lastSyncedAt)}` : "Ready to sync",
    syncing: "Syncing Gmail…",
    auth_needed: "Gmail reconnect needed",
    error: status.error ?? "Gmail sync error",
  } as const;
  return <span className={`sync-status-chip sync-status-${status.state}`} role="status">{labels[status.state]}</span>;
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
        {messages.length > 0 ? <SenderAttentionControl message={messages[messages.length - 1]} /> : null}
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

function SenderAttentionControl({ message, compact = false }: { message: InboxMessage; compact?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [resolution, setResolution] = useState<ResolvedSenderAttention | null>(null);
  const [selectedBehavior, setSelectedBehavior] = useState<AttentionViewSetting["behavior"] | null>(null);
  const [applyToDomain, setApplyToDomain] = useState(false);
  const [status, setStatus] = useState<"idle" | "loading" | "saving" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const controlRef = useRef<HTMLDivElement>(null);
  const address = message.from.email.trim().toLowerCase();
  const domain = address.split("@")[1] ?? "";
  const senderName = message.from.name ?? address;
  const attentionChoices: Array<{ behavior: AttentionViewSetting["behavior"]; label: string; description: string }> = [
    { behavior: "notify", label: "Notify me", description: "Make this hard to miss" },
    { behavior: "focus", label: "Prioritize", description: "Keep it near the top" },
    { behavior: "normal", label: "Keep in inbox", description: "Treat it like regular mail" },
    { behavior: "quiet", label: "Quiet", description: "Keep it out of the way" },
    { behavior: "hidden", label: "Hide", description: "Remove it from your attention" },
  ];

  useEffect(() => {
    if (!expanded || resolution || !address) return;
    const controller = new AbortController();
    setStatus("loading");
    fetchJson(`/v1/attention/resolve?address=${encodeURIComponent(address)}`, resolvedSenderAttentionResponseSchema, controller.signal)
      .then((nextResolution) => {
        if (!controller.signal.aborted) {
          setResolution(nextResolution);
          setSelectedBehavior(nextResolution.behavior);
          setStatus("idle");
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setStatus("error");
          setErrorMessage(getErrorMessage(error));
        }
      });
    return () => controller.abort();
  }, [address, expanded, resolution]);

  useEffect(() => {
    if (!expanded) return;
    function dismissOnOutsidePointer(event: PointerEvent) {
      if (controlRef.current && !controlRef.current.contains(event.target as Node)) {
        setExpanded(false);
      }
    }
    function dismissOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setExpanded(false);
    }
    window.addEventListener("pointerdown", dismissOnOutsidePointer);
    window.addEventListener("keydown", dismissOnEscape);
    return () => {
      window.removeEventListener("pointerdown", dismissOnOutsidePointer);
      window.removeEventListener("keydown", dismissOnEscape);
    };
  }, [expanded]);

  async function saveRule() {
    if (!selectedBehavior) return;
    const scope = applyToDomain ? "domain" : "address";
    const behavior = selectedBehavior;
    const value = scope === "address" ? address : domain;
    if (!value) return;
    setStatus("saving");
    setErrorMessage(null);
    try {
      const existingRule = resolution?.rule?.scope === scope && resolution.rule.value === value
        ? resolution.rule
        : null;
      await fetchJson(existingRule ? `/v1/attention/rules/${existingRule.id}` : "/v1/attention/rules", { parse: (value: unknown) => value }, undefined, {
        method: existingRule ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(existingRule ? { behavior } : { scope, value, behavior, source: "user_choice" }),
      });
      setResolution(null);
      setExpanded(false);
      setStatus("idle");
    } catch (error) {
      setStatus("error");
      setErrorMessage(getErrorMessage(error));
    }
  }

  async function resetRule() {
    if (!resolution?.rule) return;
    setStatus("saving");
    try {
      const response = await fetch(`/v1/attention/rules/${resolution.rule.id}`, { method: "DELETE", credentials: "include" });
      if (!response.ok) throw new ApiRequestError(response.status, `Request failed with ${response.status} ${response.statusText}`.trim());
      setResolution(null);
      setExpanded(false);
      setStatus("idle");
    } catch (error) {
      setStatus("error");
      setErrorMessage(getErrorMessage(error));
    }
  }

  return (
    <div className={`sender-attention-control${compact ? " sender-attention-control-compact" : ""}${expanded ? " sender-attention-control-expanded" : ""}`} ref={controlRef}>
      <button aria-controls={`sender-attention-${message.id}`} aria-expanded={expanded} aria-label={`Manage mail from ${senderName}`} className="sender-attention-trigger" onClick={() => setExpanded((current) => !current)} type="button">
        <span aria-hidden="true">{compact ? "⌁" : "✦"}</span> {compact ? "Tune" : "Manage this sender"}
      </button>
      {expanded ? (
        <section className="sender-attention-menu" id={`sender-attention-${message.id}`} role="dialog" aria-label={`Mail handling for ${senderName}`}>
          <div className="sender-attention-heading">
            <div>
              <p className="sender-attention-kicker">Mail from <strong>{senderName}</strong></p>
              <span>{address}</span>
            </div>
            <button aria-label="Close sender controls" className="sender-attention-close" onClick={() => setExpanded(false)} type="button">×</button>
          </div>
          {status === "loading" ? <p>Loading current handling…</p> : null}
          {status !== "loading" ? <>
            <fieldset className="sender-attention-choices" disabled={status === "saving"}>
              <legend>Where should mail from this sender go?</legend>
              <div className="sender-attention-choice-grid">
                {attentionChoices.map(({ behavior, label, description }) => (
                  <button aria-pressed={selectedBehavior === behavior} key={behavior} onClick={() => setSelectedBehavior(behavior)} type="button">
                    <strong>{label}</strong>
                    <span>{description}</span>
                  </button>
                ))}
              </div>
            </fieldset>
            <div className="sender-attention-actions">
              {domain ? <label className="sender-attention-domain"><input checked={applyToDomain} onChange={(event) => setApplyToDomain(event.target.checked)} type="checkbox" /> Also apply to everyone at <strong>{domain}</strong></label> : null}
              <button className="sender-attention-save" disabled={status === "saving" || !selectedBehavior} onClick={() => void saveRule()} type="button">{status === "saving" ? "Saving…" : applyToDomain ? "Save for domain" : "Save for sender"}</button>
              {resolution?.rule ? <button className="sender-attention-reset" disabled={status === "saving"} onClick={() => void resetRule()} type="button">Use default</button> : null}
            </div>
          </> : null}
          {status === "error" ? <p className="sender-attention-error" role="alert">Could not update handling. {errorMessage}</p> : null}
        </section>
      ) : null}
    </div>
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

export function getMessagesForMailbox(messages: InboxMessage[], mailboxId: Mailbox) {
  const mailbox = mailboxes.find((item) => item.id === mailboxId);
  return mailbox?.gmailLabel
    ? messages.filter((message) => message.labels.includes(mailbox.gmailLabel!))
    : messages;
}

type JsonSchema<T> = {
  parse(value: unknown): T;
};

async function fetchJson<T>(
  input: string,
  schema: JsonSchema<T>,
  signal?: AbortSignal,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(input, { ...init, credentials: "include", signal });

  if (!response.ok) {
    throw new ApiRequestError(response.status, `Request failed with ${response.status} ${response.statusText}`.trim());
  }

  return schema.parse(await response.json());
}

class ApiRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function buildPinnedPeople(messages: InboxMessage[]): PersonItem[] {
  const seen = new Set<string>();
  const people: PersonItem[] = [];
  for (const message of messages) {
    const name = message.from.name ?? message.from.email;
    if (seen.has(name)) continue;
    seen.add(name);
    people.push({
      initials: name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase(),
      name,
      context: message.subject || "No subject",
      unread: message.unread,
    });
    if (people.length === 3) break;
  }
  return people;
}

function LoginRequiredScreen() {
  return (
    <main className="oauth-page login-required-page">
      <section className="login-required-shell">
        <div className="oauth-brand"><span className="oauth-brand-mark">O</span><span>Orca</span></div>
        <p className="oauth-eyebrow">A private workspace</p>
        <h1>Your inbox waits for its person.</h1>
        <p>Sign in with Google to open the Gmail account you connected to Orca.</p>
        <a className="oauth-google-button oauth-enter-button" href="/login"><GoogleGlyph />Continue with Google</a>
      </section>
    </main>
  );
}

function SessionCheckingScreen() {
  return (
    <main className="oauth-page login-required-page">
      <section className="login-required-shell" aria-live="polite">
        <div className="oauth-brand"><span className="oauth-brand-mark">O</span><span>Orca</span></div>
        <p className="oauth-eyebrow">Opening your private workspace</p>
        <h1>Checking your key.</h1>
      </section>
    </main>
  );
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

  return ["/login", "/onboarding", "/settings/integrations/gmail"].includes(window.location.pathname);
}

function isAttentionSettingsRoute() {
  return typeof window !== "undefined" && window.location.pathname === "/settings/attention-views";
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
