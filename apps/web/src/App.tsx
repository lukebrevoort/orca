import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { AttentionViewSetting, InboxMessage, MailAccount, MailContact, ResolvedSenderAttention, SyncStatus, ThreadDetail } from "@orca/shared";
import { attentionViewSettingSchema, inboxResponseSchema, meResponseSchema, resolvedSenderAttentionSchema, syncStatusSchema, threadDetailSchema } from "@orca/shared";
import {
  demoAccount,
  demoMessages,
  messageIncludesPerson,
  messageBodies,
} from "./demo-data";
import { getContactSignature, type ContactSignature } from "./contact-signature";

type Theme = "light" | "dark";

type Mailbox = "inbox" | "focus" | "quiet" | "hidden" | "all";
type InboxFilter = "all" | "notify" | "focus" | "normal";

type MailboxItem = {
  id: Mailbox;
  label: string;
  description: string;
};

type PersonItem = {
  initials: string;
  name: string;
  context: string;
  unread?: boolean;
};

type PanelMode = "compose" | null;
type AttentionBehavior = AttentionViewSetting["behavior"];
type OAuthConnectStatus = "idle" | "loading" | "error";
type OAuthReturnStatus =
  | { kind: "success"; email: string | null }
  | { kind: "error"; reason: string | null; message: string | null }
  | null;

const PANEL_ANIM_MS = 650;
const ZEN_ANIM_MS = 550;

type OrcaTransition = "reader-forward" | "reader-back" | "content" | "theme";

function runUiTransition(name: OrcaTransition, update: () => void) {
  const transitionDocument = document as Document & {
    startViewTransition?: (callback: () => void) => { finished: Promise<void> };
  };
  if (!transitionDocument.startViewTransition || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    update();
    return;
  }
  document.documentElement.dataset.orcaTransition = name;
  const transition = transitionDocument.startViewTransition(update);
  void transition.finished.finally(() => {
    delete document.documentElement.dataset.orcaTransition;
  });
}

const mailboxes: MailboxItem[] = [
  { id: "inbox", label: "Inbox", description: "What deserves your attention now" },
  { id: "focus", label: "Focus", description: "Notify me and Keep in focus" },
  { id: "quiet", label: "Quiet", description: "Available when you choose" },
  { id: "hidden", label: "Hidden", description: "Out of default views, never gone" },
  { id: "all", label: "All mail", description: "Every message, by attention" },
];

export function App() {
  const [theme, setTheme] = useState<Theme>(() => readStoredTheme());
  const [access, setAccess] = useState<"checking" | "authenticated" | "signedout">("checking");
  const devPreview = isDevPreviewRoute();

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("orca-theme", theme);
  }, [theme]);

  useEffect(() => {
    if (isOAuthLoginRoute() || devPreview) return;
    const abortController = new AbortController();
    fetch("/v1/auth/session", { credentials: "include", signal: abortController.signal })
      .then((response) => setAccess(response.ok ? "authenticated" : "signedout"))
      .catch(() => {
        if (!abortController.signal.aborted) setAccess("signedout");
      });
    return () => abortController.abort();
  }, [devPreview]);

  if (devPreview) {
    return <InboxApp demoMode theme={theme} setTheme={setTheme} />;
  }

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
            {theme === "dark" ? "☾" : "☀"}
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
  demoMode = false,
  theme,
  setTheme,
}: {
  demoMode?: boolean;
  theme: Theme;
  setTheme: Dispatch<SetStateAction<Theme>>;
}) {
  const [account, setAccount] = useState<MailAccount | null>(demoMode ? demoAccount : null);
  const [messages, setMessages] = useState<InboxMessage[]>(demoMode ? demoMessages : []);
  const [status, setStatus] = useState<"loading" | "syncing" | "ready" | "error" | "signedout">(demoMode ? "ready" : "loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [attentionByAddress, setAttentionByAddress] = useState<Record<string, AttentionBehavior>>({});
  const [activeMailbox, setActiveMailbox] = useState<Mailbox>("inbox");
  const [inboxFilter, setInboxFilter] = useState<InboxFilter>("all");
  const [refreshKey, setRefreshKey] = useState(0);
  const [personFilter, setPersonFilter] = useState<string | null>(null);
  const [panelMode, setPanelMode] = useState<PanelMode>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [threadDetail, setThreadDetail] = useState<ThreadDetail | null>(null);
  const [readerStatus, setReaderStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [readerError, setReaderError] = useState<string | null>(null);
  const [readerRefreshKey, setReaderRefreshKey] = useState(0);
  const originMessageIdRef = useRef<string | null>(null);
  const messageRowRefs = useRef(new Map<string, HTMLButtonElement>());
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
    if (demoMode) {
      setAccount(demoAccount);
      setMessages(demoMessages);
      setStatus("ready");
      setErrorMessage(null);
      return;
    }

    const abortController = new AbortController();

    async function loadInbox() {
      setStatus(messages.length > 0 ? "ready" : "loading");
      setErrorMessage(null);

      try {
        const currentAccount = await fetchJson("/v1/me", meResponseSchema, abortController.signal);
        if (abortController.signal.aborted) return;
        setAccount(currentAccount);
        setSyncStatus(await fetchJson("/v1/sync/status", syncStatusSchema, abortController.signal));

        const inbox = await fetchJson("/v1/inbox?view=all", inboxResponseSchema, abortController.signal);
        if (abortController.signal.aborted) return;
        setAccount(inbox.account);
        setMessages(inbox.messages);
        setStatus("ready");

        // Cached SQLite mail is now visible. Refresh Gmail without putting the
        // network round trip on the inbox's first-render path.
        void refreshGmailInBackground();
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

    async function refreshGmailInBackground() {
      try {
        setSyncStatus(await fetchJson("/v1/sync/status", syncStatusSchema, abortController.signal));
        await fetchJson("/v1/sync/gmail", { parse: (value: unknown) => value }, abortController.signal, { method: "POST" });
        const [nextStatus, refreshedInbox] = await Promise.all([
          fetchJson("/v1/sync/status", syncStatusSchema, abortController.signal),
          fetchJson("/v1/inbox?view=all", inboxResponseSchema, abortController.signal),
        ]);
        if (abortController.signal.aborted) return;
        setSyncStatus(nextStatus);
        setMessages(refreshedInbox.messages);
      } catch (error) {
        if (abortController.signal.aborted) return;
        setErrorMessage(`Could not refresh Gmail just now. Showing your last successful sync. ${getErrorMessage(error)}`);
      }
    }

    void loadInbox();

    return () => {
      abortController.abort();
    };
  }, [demoMode, refreshKey]);

  useEffect(() => {
    const addresses = [...new Set(messages.map((message) => message.from.email.trim().toLowerCase()).filter(Boolean))];
    if (demoMode) {
      setAttentionByAddress(Object.fromEntries(addresses.map((address) => [
        address,
        messages.find((message) => message.from.email.trim().toLowerCase() === address)?.attentionBehavior ?? "normal",
      ])));
      return;
    }
    if (status !== "ready" || addresses.length === 0) return;
    const controller = new AbortController();
    void Promise.all(addresses.map(async (address) => {
      const resolved = await fetchJson(`/v1/attention/resolve?address=${encodeURIComponent(address)}`, resolvedSenderAttentionResponseSchema, controller.signal);
      return [address, resolved.behavior] as const;
    })).then((entries) => {
      if (!controller.signal.aborted) setAttentionByAddress(Object.fromEntries(entries));
    }).catch(() => {
      // Inbox mail remains visible if attention preferences cannot be loaded.
    });
    return () => controller.abort();
  }, [demoMode, messages, status]);

  const pinnedPeople = useMemo(
    () => buildPinnedPeople(applySenderAttention(messages, attentionByAddress)),
    [attentionByAddress, messages],
  );

  const mailboxMessages = useMemo(
    () => getMessagesForMailbox(messages, activeMailbox, attentionByAddress),
    [activeMailbox, attentionByAddress, messages],
  );

  const visibleMessages = useMemo(() => {
    let filtered = personFilter
      ? mailboxMessages.filter((message) => messageIncludesPerson(message, personFilter))
      : mailboxMessages;
    if (activeMailbox === "inbox" && inboxFilter !== "all") {
      filtered = filtered.filter((message) => {
        const behavior = attentionByAddress[message.from.email.trim().toLowerCase()] ?? message.attentionBehavior;
        return behavior === inboxFilter;
      });
    }
    return sortMessagesByAttention(filtered, attentionByAddress).map((message) => ({
      ...message,
      attentionBehavior: attentionByAddress[message.from.email.trim().toLowerCase()] ?? message.attentionBehavior,
    }));
  }, [activeMailbox, attentionByAddress, inboxFilter, mailboxMessages, personFilter]);

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

  useEffect(() => {
    if (!selectedThreadId || !account) {
      setThreadDetail(null);
      setReaderStatus("idle");
      return;
    }

    if (demoMode) {
      setThreadDetail(createDemoThreadDetail(account, selectedThreadId, selectedThreadMessages));
      setReaderStatus("ready");
      setReaderError(null);
      return;
    }

    const controller = new AbortController();
    setThreadDetail(null);
    setReaderStatus("loading");
    setReaderError(null);
    fetchJson(`/v1/threads/${encodeURIComponent(selectedThreadId)}?accountId=${encodeURIComponent(account.id)}`, threadDetailSchema, controller.signal)
      .then((detail) => {
        if (controller.signal.aborted) return;
        setThreadDetail(detail);
        setReaderStatus("ready");
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setReaderStatus("error");
        setReaderError(getErrorMessage(error));
      });
    return () => controller.abort();
  }, [account, demoMode, readerRefreshKey, selectedThreadId, selectedThreadMessages]);

  useEffect(() => {
    if (!selectedThreadId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeThread();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedThreadId]);

  const mailboxItems = useMemo(
    () =>
      mailboxes.map((mailbox) => ({
        ...mailbox,
        count: status === "ready" ? getMessagesForMailbox(messages, mailbox.id, attentionByAddress).length : undefined,
      })),
    [attentionByAddress, messages, status],
  );

  const activeMailboxItem = mailboxes.find((item) => item.id === activeMailbox) ?? mailboxes[0];
  const activeMailboxLabel = activeMailboxItem.label;
  const inboxTitle = personFilter ? personFilter : activeMailboxLabel;
  const inboxEyebrow = personFilter
    ? `Filtered ${activeMailboxLabel.toLowerCase()}`
    : activeMailboxItem.description;

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

    runUiTransition("reader-forward", () => {
      setPanelClosing(false);
      setZenClosing(false);
      originMessageIdRef.current = message.id;
      setSelectedThreadId(message.threadId);
    });
  }

  function closeThread() {
    runUiTransition("reader-back", () => {
      setSelectedThreadId(null);
      setThreadDetail(null);
      setReaderStatus("idle");
    });
    window.requestAnimationFrame(() => messageRowRefs.current.get(originMessageIdRef.current ?? "")?.focus());
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
    runUiTransition("content", () => {
      setPersonFilter((current) => (current === name ? null : name));
      setSelectedThreadId(null);
      closePanel();
    });
  }

  function selectMailbox(mailbox: Mailbox) {
    runUiTransition("content", () => {
      setActiveMailbox(mailbox);
      setInboxFilter("all");
      setPersonFilter(null);
      setSelectedThreadId(null);
    });
  }

  function selectInboxFilter(filter: InboxFilter) {
    runUiTransition("content", () => setInboxFilter(filter));
  }

  async function updateSenderAttention(address: string, behavior?: AttentionBehavior) {
    if (behavior) {
      setAttentionByAddress((current) => ({ ...current, [address]: behavior }));
      return behavior;
    }
    if (demoMode) {
      setAttentionByAddress((current) => ({ ...current, [address]: "normal" }));
      return "normal" as const;
    }
    try {
      const resolved = await fetchJson(`/v1/attention/resolve?address=${encodeURIComponent(address)}`, resolvedSenderAttentionResponseSchema);
      setAttentionByAddress((current) => ({ ...current, [address]: resolved.behavior }));
      return resolved.behavior;
    } catch {
      setAttentionByAddress((current) => ({ ...current, [address]: "normal" }));
      return "normal" as const;
    }
  }

  return (
    <div className="app-root">
      <main className="app-shell">
        <aside className="sidebar" aria-label="Mailbox navigation">
          <header className="sidebar-header">
            <div className="brand-wrap">
              <div className="brand">Orca</div>
              {demoMode ? <span className="dev-preview-badge">Preview</span> : null}
            </div>
            <div className="header-actions">
              <button
                aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
                className="theme-toggle"
                onClick={() => runUiTransition("theme", () => setTheme((current) => (current === "dark" ? "light" : "dark")))}
                type="button"
              >
                {theme === "dark" ? "☾" : "☀"}
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

        <section className={`content-pane${selectedThreadId ? " content-pane-reader" : ""}`} aria-label={selectedThreadId ? "Message reader" : "Inbox"}>
          {selectedThreadId ? (
            <MessageReader
              detail={threadDetail}
              error={readerError}
              fallbackMessages={selectedThreadMessages}
              fallbackTitle={selectedThreadLatestMessage?.subject || "(no subject)"}
              onAttentionChange={updateSenderAttention}
              onBack={closeThread}
              onRetry={() => setReaderRefreshKey((key) => key + 1)}
              status={readerStatus}
            />
          ) : (
            <InboxView
              account={account}
              errorMessage={errorMessage}
              inboxEyebrow={inboxEyebrow}
              inboxFilter={inboxFilter}
              inboxTitle={inboxTitle}
              messages={visibleMessages}
              onClearFilter={() => setPersonFilter(null)}
              onOpenThread={openThread}
              rowRefs={messageRowRefs}
              personFilter={personFilter}
              status={status}
              syncStatus={syncStatus}
              isRefreshing={status === "syncing" && messages.length > 0}
              onRefresh={() => setRefreshKey((key) => key + 1)}
              onAttentionChange={updateSenderAttention}
              onInboxFilterChange={selectInboxFilter}
              showInboxFilters={activeMailbox === "inbox" && !personFilter}
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
  inboxFilter,
  inboxTitle,
  messages,
  personFilter,
  status,
  syncStatus,
  isRefreshing,
  onClearFilter,
  onOpenThread,
  onRefresh,
  onAttentionChange,
  onInboxFilterChange,
  showInboxFilters,
  rowRefs,
}: {
  account: MailAccount | null;
  errorMessage: string | null;
  inboxEyebrow: string;
  inboxFilter: InboxFilter;
  inboxTitle: string;
  messages: InboxMessage[];
  personFilter: string | null;
  status: "loading" | "syncing" | "ready" | "error";
  syncStatus: SyncStatus | null;
  isRefreshing: boolean;
  onClearFilter: () => void;
  onOpenThread: (message: InboxMessage) => void;
  onRefresh: () => void;
  onAttentionChange: (address: string, behavior?: AttentionBehavior) => Promise<AttentionBehavior>;
  onInboxFilterChange: (filter: InboxFilter) => void;
  showInboxFilters: boolean;
  rowRefs: React.MutableRefObject<Map<string, HTMLButtonElement>>;
}) {
  const inboxFilters: Array<{ id: InboxFilter; label: string }> = [
    { id: "all", label: "Everything" },
    { id: "notify", label: "Notify me" },
    { id: "focus", label: "Keep in focus" },
    { id: "normal", label: "Flow" },
  ];
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

      {showInboxFilters ? (
        <nav aria-label="Filter Inbox by attention treatment" className="inbox-filter-bar">
          <span>Within Inbox</span>
          <div role="group" aria-label="Inbox attention filters">
            {inboxFilters.map((filter) => (
              <button
                aria-pressed={inboxFilter === filter.id}
                key={filter.id}
                onClick={() => onInboxFilterChange(filter.id)}
                type="button"
              >
                {filter.label}
              </button>
            ))}
          </div>
        </nav>
      ) : null}

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
                      ref={(node) => {
                        if (node) rowRefs.current.set(message.id, node);
                        else rowRefs.current.delete(message.id);
                      }}
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
                          <span className={`attention-badge attention-badge-${message.attentionBehavior}`} title={`Attention treatment: ${message.attentionBehavior}. Human signal (${message.humanSignal ?? "unknown"}) is a separate estimate, not a routing rule.`}>
                            {message.attentionBehavior === "notify" ? "Notify me" : message.attentionBehavior === "focus" ? "Keep in focus" : message.attentionBehavior}
                          </span>
                          <span>{formatReceivedAt(message.receivedAt)}</span>
                        </div>
                        <div className="message-subject-row">
                          <h2>{message.subject || "(no subject)"}</h2>
                          {message.unread ? <span className="message-unread-dot" /> : null}
                        </div>
                        <p>{message.snippet}</p>
                      </div>
                    </button>
                    <SenderAttentionControl compact message={message} onBehaviorChange={onAttentionChange} />
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

function MessageReader({
  detail,
  error,
  fallbackMessages,
  fallbackTitle,
  onBack,
  onRetry,
  status,
  onAttentionChange,
}: {
  detail: ThreadDetail | null;
  error: string | null;
  fallbackMessages: InboxMessage[];
  fallbackTitle: string;
  onBack: () => void;
  onRetry: () => void;
  status: "idle" | "loading" | "ready" | "error";
  onAttentionChange: (address: string, behavior?: AttentionBehavior) => Promise<AttentionBehavior>;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const messages = detail?.messages ?? [];
  const title = detail?.thread.subject || fallbackTitle;

  useEffect(() => {
    if (status === "ready") headingRef.current?.focus();
  }, [status]);

  return (
    <article className="message-reader" aria-labelledby="reader-title">
      <nav className="reader-nav" aria-label="Reader controls">
        <button className="reader-back" onClick={onBack} type="button">
          <ArrowGlyph direction="left" />
          <span>Back to inbox</span>
        </button>
        <span className="reader-escape-hint" aria-hidden="true">esc</span>
      </nav>

      {status === "loading" || status === "idle" ? <ReaderLoading title={fallbackTitle} messages={fallbackMessages} /> : null}
      {status === "error" ? (
        <section className="reader-state" role="alert">
          <p>Message unavailable</p>
          <h1 id="reader-title">This conversation couldn’t open.</h1>
          <span>{error ?? "Orca could not load the message body."}</span>
          <button onClick={onRetry} type="button">Try again</button>
        </section>
      ) : null}
      {status === "ready" && detail ? (
        <div className="reader-document">
          <header className="reader-heading">
            <p className="reader-kicker">Conversation · {messages.length} {messages.length === 1 ? "message" : "messages"}</p>
            <h1 id="reader-title" ref={headingRef} tabIndex={-1}>{title}</h1>
          </header>

          <ol className="reader-message-list" aria-label="Messages in conversation">
            {messages.map((message, index) => {
              const signature = getContactSignature(message.from);
              const recipients = [...message.to, ...message.cc, ...message.bcc];
              return (
                <li className="reader-message" key={message.id}>
                  <article aria-labelledby={`reader-sender-${message.id}`}>
                    <header className="reader-sender">
                      <MessageMark signature={signature} unread={message.unread} />
                      <div className="reader-sender-copy">
                        <h2 id={`reader-sender-${message.id}`}>{message.from.name ?? message.from.email}</h2>
                        <details>
                          <summary>{formatFullReceivedAt(message.receivedAt)} · to {formatRecipients(recipients)}</summary>
                          <dl>
                            <div><dt>From</dt><dd>{message.from.email}</dd></div>
                            <div><dt>To</dt><dd>{formatRecipientAddresses(message.to)}</dd></div>
                            {message.cc.length ? <div><dt>Cc</dt><dd>{formatRecipientAddresses(message.cc)}</dd></div> : null}
                          </dl>
                        </details>
                      </div>
                      {index === messages.length - 1 && fallbackMessages.length ? <SenderAttentionControl compact message={fallbackMessages[fallbackMessages.length - 1]} onBehaviorChange={onAttentionChange} /> : null}
                    </header>
                    {message.bodyText?.trim() ? (
                      <div className="reader-body">{message.bodyText}</div>
                    ) : (
                      <p className="reader-no-body">This message has no readable text body.</p>
                    )}
                    {message.attachments.length ? (
                      <section className="reader-attachments" aria-label={`${message.attachments.length} attachments`}>
                        <h3>Attachments</h3>
                        <ul>{message.attachments.map((attachment) => <li key={attachment.id}><span aria-hidden="true">↳</span><div><strong>{attachment.filename}</strong><small>{formatFileSize(attachment.size)} · {attachment.mimeType}</small></div></li>)}</ul>
                      </section>
                    ) : null}
                  </article>
                </li>
              );
            })}
          </ol>
          <footer className="reader-end"><span aria-hidden="true">◒</span><p>You’re all caught up.</p></footer>
        </div>
      ) : null}
    </article>
  );
}

function ReaderLoading({ title, messages }: { title: string; messages: InboxMessage[] }) {
  return <section className="reader-document reader-loading" aria-busy="true" aria-live="polite"><header className="reader-heading"><p className="reader-kicker">Opening conversation</p><h1 id="reader-title">{title}</h1></header><div className="reader-loading-line" /><div className="reader-loading-line reader-loading-line-short" /><span className="visually-hidden">Loading {messages.length || 1} message conversation</span></section>;
}

function SenderAttentionControl({ message, compact = false, onBehaviorChange }: { message: InboxMessage; compact?: boolean; onBehaviorChange: (address: string, behavior?: AttentionBehavior) => Promise<AttentionBehavior> }) {
  const [expanded, setExpanded] = useState(false);
  const [resolution, setResolution] = useState<ResolvedSenderAttention | null>(null);
  const [selectedBehavior, setSelectedBehavior] = useState<AttentionViewSetting["behavior"] | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "saving" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const controlRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLElement>(null);
  const address = message.from.email.trim().toLowerCase();
  const senderName = message.from.name ?? address;
  const attentionChoices: Array<{ behavior: AttentionViewSetting["behavior"]; label: string }> = [
    { behavior: "notify", label: "Notify me" },
    { behavior: "focus", label: "Prioritize" },
    { behavior: "normal", label: "Keep in inbox" },
    { behavior: "quiet", label: "Quiet" },
    { behavior: "hidden", label: "Hide" },
  ];

  useEffect(() => {
    if (!expanded || resolution || !address) return;
    if (isDevPreviewRoute()) {
      setSelectedBehavior((current) => current ?? message.attentionBehavior);
      setStatus("idle");
      return;
    }
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
  }, [address, expanded, message.attentionBehavior, resolution]);

  useEffect(() => {
    if (!expanded) return;
    const selectedChoice = menuRef.current?.querySelector<HTMLButtonElement>('.sender-attention-choices button[aria-pressed="true"]');
    (selectedChoice ?? menuRef.current?.querySelector<HTMLButtonElement>(".sender-attention-choices button:not([disabled])"))?.focus();
    function dismissOnOutsidePointer(event: PointerEvent) {
      if (controlRef.current && !controlRef.current.contains(event.target as Node)) {
        closeAndRestoreFocus();
      }
    }
    function dismissOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        closeAndRestoreFocus();
      }
    }
    window.addEventListener("pointerdown", dismissOnOutsidePointer);
    window.addEventListener("keydown", dismissOnEscape);
    return () => {
      window.removeEventListener("pointerdown", dismissOnOutsidePointer);
      window.removeEventListener("keydown", dismissOnEscape);
    };
  }, [expanded]);

  useEffect(() => {
    if (!expanded || status !== "idle" || !selectedBehavior) return;
    menuRef.current?.querySelector<HTMLButtonElement>('.sender-attention-choices button[aria-pressed="true"]')?.focus();
  }, [expanded, selectedBehavior, status]);

  function closeAndRestoreFocus(behavior?: AttentionBehavior) {
    setExpanded(false);
    requestAnimationFrame(() => {
      if (behavior === "hidden" || !triggerRef.current?.isConnected) {
        document.querySelector<HTMLButtonElement>(".message-row")?.focus();
      } else {
        triggerRef.current.focus();
      }
    });
  }

  async function saveRule(behavior: AttentionViewSetting["behavior"]) {
    if (!address) return;
    setSelectedBehavior(behavior);
    if (isDevPreviewRoute()) {
      const appliedBehavior = await onBehaviorChange(address, behavior);
      closeAndRestoreFocus(appliedBehavior);
      return;
    }
    setStatus("saving");
    setErrorMessage(null);
    try {
      const existingRule = resolution?.rule?.scope === "address" && resolution.rule.value === address
        ? resolution.rule
        : null;
      await fetchJson(existingRule ? `/v1/attention/rules/${existingRule.id}` : "/v1/attention/rules", { parse: (value: unknown) => value }, undefined, {
        method: existingRule ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(existingRule ? { behavior } : { scope: "address", value: address, behavior, source: "user_choice" }),
      });
      setResolution(null);
      const appliedBehavior = await onBehaviorChange(address, behavior);
      closeAndRestoreFocus(appliedBehavior);
      setStatus("idle");
    } catch (error) {
      setStatus("error");
      setErrorMessage(getErrorMessage(error));
    }
  }

  async function resetRule() {
    if (resolution?.rule?.scope !== "address") return;
    setStatus("saving");
    setErrorMessage(null);
    try {
      const response = await fetch(`/v1/attention/rules/${resolution.rule.id}`, { method: "DELETE", credentials: "include" });
      if (!response.ok) throw new ApiRequestError(response.status, `Request failed with ${response.status} ${response.statusText}`.trim());
      setResolution(null);
      const inheritedBehavior = await onBehaviorChange(address);
      closeAndRestoreFocus(inheritedBehavior);
      setStatus("idle");
    } catch (error) {
      setStatus("error");
      setErrorMessage(getErrorMessage(error));
    }
  }

  return (
    <div className={`sender-attention-control${compact ? " sender-attention-control-compact" : ""}${expanded ? " sender-attention-control-expanded" : ""}`} ref={controlRef}>
      <button aria-controls={`sender-attention-${message.id}`} aria-expanded={expanded} aria-label={`Manage mail from ${senderName}`} className="sender-attention-trigger" onClick={() => expanded ? closeAndRestoreFocus() : setExpanded(true)} ref={triggerRef} type="button">
        <span aria-hidden="true">{compact ? "⌁" : "✦"}</span> {compact ? "Tune" : "Manage this sender"}
      </button>
      {expanded ? (
        <section className="sender-attention-menu" id={`sender-attention-${message.id}`} ref={menuRef} role="group" aria-label={`Mail handling for ${senderName}`}>
          <div className="sender-attention-heading">
            <p className="sender-attention-kicker">All mail from <strong>{senderName}</strong></p>
            <button aria-label="Close sender controls" className="sender-attention-close" onClick={() => closeAndRestoreFocus()} type="button">×</button>
          </div>
          {status === "loading" ? <p>Loading…</p> : null}
          {status !== "loading" ? <>
            <div aria-label="Destination for all sender mail" className="sender-attention-choices" role="group">
              <span className="sender-attention-choice-label">Send to</span>
              <p className="sender-attention-explainer">This is your attention choice. Human signal only describes whether a message seems person-written; it never decides this destination.</p>
              <div className="sender-attention-choice-grid">
                {attentionChoices.map(({ behavior, label }) => (
                  <button aria-pressed={selectedBehavior === behavior} disabled={status === "saving"} key={behavior} onClick={() => void saveRule(behavior)} type="button">
                    {status === "saving" && selectedBehavior === behavior ? "Saving…" : label}
                  </button>
                ))}
              </div>
              {resolution?.rule?.scope === "address" ? <button className="sender-attention-default" disabled={status === "saving"} onClick={() => void resetRule()} type="button">Use default</button> : null}
            </div>
          </> : null}
          <span aria-live="polite" className="visually-hidden">{status === "loading" ? "Loading sender preference" : status === "saving" ? "Saving sender preference" : ""}</span>
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

export function getMessagesForMailbox(messages: InboxMessage[], mailboxId: Mailbox, attentionByAddress: Record<string, AttentionBehavior> = {}) {
  if (mailboxId === "all") return messages;
  return messages.filter((message) => {
    const behavior = attentionByAddress[message.from.email.trim().toLowerCase()] ?? message.attentionBehavior;
    if (mailboxId === "inbox") return behavior !== "quiet" && behavior !== "hidden";
    return mailboxId === "focus" ? behavior === "notify" || behavior === "focus" : behavior === mailboxId;
  });
}

export function applySenderAttention(messages: InboxMessage[], attentionByAddress: Record<string, AttentionBehavior>) {
  return sortMessagesByAttention(messages.filter((message) => (attentionByAddress[message.from.email.trim().toLowerCase()] ?? message.attentionBehavior) !== "hidden"), attentionByAddress);
}

export function sortMessagesByAttention(messages: InboxMessage[], attentionByAddress: Record<string, AttentionBehavior>) {
  const rank: Record<AttentionBehavior, number> = { notify: 0, focus: 1, normal: 2, quiet: 3, hidden: 4 };
  return messages
    .map((message) => ({ message }))
    .sort((a, b) => {
      const aBehavior = attentionByAddress[a.message.from.email.trim().toLowerCase()] ?? a.message.attentionBehavior;
      const bBehavior = attentionByAddress[b.message.from.email.trim().toLowerCase()] ?? b.message.attentionBehavior;
      return rank[aBehavior] - rank[bBehavior]
        || b.message.receivedAt.localeCompare(a.message.receivedAt)
        || a.message.id.localeCompare(b.message.id);
    })
    .map(({ message }) => message);
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

export function isDevPreviewPath(pathname: string, isDevelopment: boolean) {
  return isDevelopment && pathname === "/dev/inbox";
}

function isDevPreviewRoute() {
  return typeof window !== "undefined"
    && isDevPreviewPath(window.location.pathname, import.meta.env.DEV);
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

function formatFullReceivedAt(receivedAt: string) {
  const date = new Date(receivedAt);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function formatRecipients(recipients: MailContact[]) {
  if (!recipients.length) return "undisclosed recipients";
  if (recipients.length === 1) return recipients[0].name ?? recipients[0].email;
  return `${recipients[0].name ?? recipients[0].email} +${recipients.length - 1}`;
}

function formatRecipientAddresses(recipients: MailContact[]) {
  return recipients.length ? recipients.map((recipient) => recipient.name ? `${recipient.name} <${recipient.email}>` : recipient.email).join(", ") : "None";
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function createDemoThreadDetail(account: MailAccount, threadId: string, messages: InboxMessage[]): ThreadDetail {
  const latest = messages[messages.length - 1];
  const recipients = [{ name: account.displayName, email: account.email }];
  return {
    account,
    thread: {
      id: threadId,
      provider: "gmail",
      providerThreadId: threadId,
      subject: latest?.subject.replace(/^Re:\s*/i, "") ?? "",
      latestReceivedAt: latest?.receivedAt ?? new Date(0).toISOString(),
      messageCount: messages.length,
      labels: [...new Set(messages.flatMap((message) => message.labels))],
      participants: [...messages.map((message) => message.from), ...recipients],
      readState: messages.some((message) => message.unread) ? "unread" : "read",
      attention: { hasUnread: messages.some((message) => message.unread), hasStarred: false, hasDraft: false, humanSignal: 100 },
    },
    messages: messages.map((message) => ({
      ...message,
      to: message.labels.includes("SENT") ? [{ name: "Maya Chen", email: "maya@example.com" }] : recipients,
      cc: [],
      bcc: [],
      bodyText: (messageBodies[message.id] ?? message.snippet) || null,
      bodyHtml: null,
      attachments: message.id === "msg_2" ? [{ id: "attachment_demo", filename: "Orca-reader-notes.pdf", mimeType: "application/pdf", size: 2483200 }] : [],
    })),
  };
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
