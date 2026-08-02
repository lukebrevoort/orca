import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type ReactNode,
  type Ref,
  type SetStateAction,
} from "react";
import type { AttentionViewSetting, Collection, DeliveryResult, GmailLabelMigration, InboxMessage, MailAccount, MailContact, Pin, Reminder, ResolvedSenderAttention, SyncStatus, ThreadDetail, ThreadDetailMessage, UserPreferences } from "@orca/shared";
import { attentionViewSettingSchema, collectionSchema, gmailLabelMigrationSchema, inboxResponseSchema, meResponseSchema, pinSchema, reminderSchema, reminderViewSettingsSchema, resolvedSenderAttentionSchema, syncStatusSchema, threadDetailSchema, userPreferencesSchema } from "@orca/shared";
import {
  demoAccount,
  demoMessages,
  demoThreadHistoryExtras,
  messageIncludesPerson,
  messageBodies,
  messageHtmlBodies,
} from "./demo-data";
import { getContactSignature, type ContactSignature } from "./contact-signature";
import { collectComposeContacts, ComposeWorkspace, useComposeDraft, type ComposeDraftFields } from "./compose-workspace";

type Theme = "light" | "dark";
export type ReaderPreferences = {
  theme: "system" | Theme;
  textSize: "standard" | "large";
  density: "calm" | "compact";
  motion: "system" | "reduced" | "full";
  notifyByDefault: boolean;
};

export const defaultReaderPreferences: ReaderPreferences = {
  theme: "system",
  textSize: "standard",
  density: "compact",
  motion: "system",
  notifyByDefault: false,
};

type Mailbox = "inbox" | "focus" | "quiet" | "hidden" | "all" | "later";
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
type SenderAttentionTarget = Pick<InboxMessage, "id" | "from">;
type OAuthConnectStatus = "idle" | "loading" | "error";
type OAuthReturnStatus =
  | { kind: "success"; email: string | null; intent: string | null }
  | { kind: "error"; reason: string | null; message: string | null; intent: string | null }
  | null;

const PANEL_ANIM_MS = 650;
const ZEN_ANIM_MS = 550;
const MICRO_ANIM_MS = 180;

type OrcaTransition = "reader-forward" | "reader-back" | "content" | "theme";

function runUiTransition(name: OrcaTransition, update: () => void) {
  const transitionDocument = document as Document & {
    startViewTransition?: (callback: () => void) => { finished: Promise<void> };
  };
  if (!transitionDocument.startViewTransition || shouldReduceMotion()) {
    update();
    return;
  }
  document.documentElement.dataset.orcaTransition = name;
  const transition = transitionDocument.startViewTransition(update);
  void transition.finished.finally(() => {
    delete document.documentElement.dataset.orcaTransition;
  });
}

function shouldReduceMotion() {
  const preference = document.documentElement.dataset.motion;
  return preference === "reduced"
    || (preference !== "full" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}

function useExitPresence(visible: boolean, duration = MICRO_ANIM_MS) {
  const [rendered, setRendered] = useState(visible);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (visible) {
      setRendered(true);
      setClosing(false);
      return;
    }
    if (!rendered) return;
    if (shouldReduceMotion()) {
      setRendered(false);
      setClosing(false);
      return;
    }
    setClosing(true);
    const timer = window.setTimeout(() => {
      setRendered(false);
      setClosing(false);
    }, duration);
    return () => window.clearTimeout(timer);
  }, [duration, rendered, visible]);

  return { closing, rendered };
}

const mailboxes: MailboxItem[] = [
  { id: "inbox", label: "Inbox", description: "What deserves your attention now" },
  { id: "focus", label: "Focus", description: "Notify me and Keep in focus" },
  { id: "quiet", label: "Quiet", description: "Available when you choose" },
  { id: "hidden", label: "Hidden", description: "Out of default views, never gone" },
  { id: "later", label: "Later", description: "Threads you chose to revisit" },
  { id: "all", label: "All mail", description: "Every message, by attention" },
];

const demoCollections: Collection[] = [
  { id: "collection_demo_work", accountId: demoAccount.id, name: "Orca launch", color: "#70867d", position: 0, threadIds: ["thread_1", "thread_4"], createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z" },
  { id: "collection_demo_life", accountId: demoAccount.id, name: "Life admin", color: "#a87360", position: 1, threadIds: ["thread_2", "thread_3"], createdAt: "2026-07-02T00:00:00.000Z", updatedAt: "2026-07-02T00:00:00.000Z" },
];

const collectionColors = [
  { name: "Moss", value: "#70867d" },
  { name: "Clay", value: "#a87360" },
  { name: "Harbor", value: "#6c8195" },
  { name: "Plum", value: "#83728d" },
  { name: "Ochre", value: "#a18757" },
  { name: "Stone", value: "#6d716f" },
] as const;

const demoPins: Pin[] = [
  { id: "pin_demo_sender", accountId: demoAccount.id, kind: "sender", targetId: "maya@example.com", label: "Maya Chen", position: 0, createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z" },
  { id: "pin_demo_thread", accountId: demoAccount.id, kind: "thread", targetId: "thread_3", label: "Dinner on Sunday?", position: 1, createdAt: "2026-07-02T00:00:00.000Z", updatedAt: "2026-07-02T00:00:00.000Z" },
];

const collectionsResponseSchema: JsonSchema<Collection[]> = { parse: (value) => Array.isArray(value) ? value.map((item) => collectionSchema.parse(item)) : (() => { throw new Error("Collections response was not a list."); })() };
const pinsResponseSchema: JsonSchema<Pin[]> = { parse: (value) => Array.isArray(value) ? value.map((item) => pinSchema.parse(item)) : (() => { throw new Error("Pins response was not a list."); })() };
const remindersResponseSchema: JsonSchema<Reminder[]> = { parse: (value) => Array.isArray(value) ? value.map((item) => reminderSchema.parse(item)) : (() => { throw new Error("Reminders response was not a list."); })() };

export function App() {
  const [preferences, setPreferences] = useState<ReaderPreferences>(() => readStoredPreferences());
  const [systemTheme, setSystemTheme] = useState<Theme>(() => getSystemTheme());
  const theme = preferences.theme === "system" ? systemTheme : preferences.theme;
  const setTheme: Dispatch<SetStateAction<Theme>> = (value) => {
    setPreferences((current) => ({
      ...current,
      theme: typeof value === "function" ? value(current.theme === "system" ? getSystemTheme() : current.theme) : value,
    }));
  };
  const [access, setAccess] = useState<"checking" | "authenticated" | "signedout">("checking");
  const devPreview = isDevPreviewRoute();

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.readerSize = preferences.textSize;
    document.documentElement.dataset.readerDensity = preferences.density;
    document.documentElement.dataset.motion = preferences.motion;
    window.localStorage.setItem("orca-reader-preferences", JSON.stringify(preferences));
  }, [preferences, theme]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemTheme(query.matches ? "dark" : "light");
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);

  useEffect(() => {
    if (isLoginRoute() || isReaderPreferencesRoute() || devPreview) return;
    const abortController = new AbortController();
    fetch("/v1/auth/session", { credentials: "include", signal: abortController.signal })
      .then((response) => setAccess(response.ok ? "authenticated" : "signedout"))
      .catch(() => {
        if (!abortController.signal.aborted) setAccess("signedout");
      });
    return () => abortController.abort();
  }, [devPreview]);

  if (isSettingsDevPreviewRoute()) {
    return <SettingsHome preferences={preferences} setPreferences={setPreferences} systemTheme={systemTheme} theme={theme} setTheme={setTheme} demoMode />;
  }
  if (devPreview) {
    return <InboxApp demoMode preferences={preferences} theme={theme} setTheme={setTheme} />;
  }

  if (isLoginRoute()) {
    return <GmailOAuthLoginPage />;
  }

  if (isReaderPreferencesRoute()) {
    return <ReaderPreferencesPage preferences={preferences} setPreferences={setPreferences} systemTheme={systemTheme} />;
  }

  if (isSettingsRoute()) {
    return <SettingsHome preferences={preferences} setPreferences={setPreferences} systemTheme={systemTheme} theme={theme} setTheme={setTheme} />;
  }

  if (access === "checking") return <SessionCheckingScreen />;
  if (access === "signedout") return isOnboardingRoute() ? <GmailOAuthLoginPage /> : <LoginRequiredScreen />;

  if (isOnboardingRoute() || isGmailLabelMigrationRoute()) {
    return <GmailLabelMigrationPage mode={isOnboardingRoute() ? "onboarding" : "settings"} theme={theme} setTheme={setTheme} />;
  }

  if (isGmailSettingsRoute()) {
    return <GmailConnectionSettingsPage theme={theme} setTheme={setTheme} />;
  }

  if (isAttentionSettingsRoute()) {
    return <AttentionViewSettingsPage onSessionExpired={() => setAccess("signedout")} theme={theme} setTheme={setTheme} />;
  }

  return <InboxApp preferences={preferences} theme={theme} setTheme={setTheme} />;
}

const defaultAccountPreferences: UserPreferences = { signature: "", composeFormat: "plain", replyBehavior: "reply", notifyByDefault: false };

export function SettingsHome({ preferences, setPreferences, systemTheme, theme, setTheme, demoMode = false }: {
  preferences: ReaderPreferences;
  setPreferences: Dispatch<SetStateAction<ReaderPreferences>>;
  systemTheme: Theme;
  theme: Theme;
  setTheme: Dispatch<SetStateAction<Theme>>;
  demoMode?: boolean;
}) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [accountPreferences, setAccountPreferences] = useState<UserPreferences>(defaultAccountPreferences);
  const [accountStatus, setAccountStatus] = useState<"loading" | "ready" | "saving" | "error">(demoMode ? "ready" : "loading");
  const [accountError, setAccountError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => { titleRef.current?.focus(); }, []);
  useEffect(() => {
    if (demoMode) return;
    const controller = new AbortController();
    fetchJson("/v1/preferences", userPreferencesSchema, controller.signal)
      .then((value) => { if (!controller.signal.aborted) { setAccountPreferences(value); setAccountStatus("ready"); } })
      .catch((error) => { if (!controller.signal.aborted) { setAccountStatus("error"); setAccountError(getErrorMessage(error)); } });
    return () => controller.abort();
  }, [demoMode]);

  const updateReader = <Key extends keyof ReaderPreferences>(key: Key, value: ReaderPreferences[Key]) => setPreferences((current) => ({ ...current, [key]: value }));
  const updateAccount = <Key extends keyof UserPreferences>(key: Key, value: UserPreferences[Key]) => { setSaved(false); setAccountPreferences((current) => ({ ...current, [key]: value })); };
  async function saveAccountPreferences() {
    if (accountPreferences.signature.length > 10_000) { setAccountError("Your signature must be 10,000 characters or fewer."); return; }
    if (demoMode) { setSaved(true); return; }
    setAccountStatus("saving"); setAccountError(null);
    try { setAccountPreferences(await fetchJson("/v1/preferences", userPreferencesSchema, undefined, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(accountPreferences) })); setSaved(true); setAccountStatus("ready"); }
    catch (error) { setAccountError(`Could not save your preferences. ${getErrorMessage(error)}`); setAccountStatus("error"); }
  }

  return <main className="settings-home-page">
    <header className="attention-settings-topbar"><a className="settings-brand" href="/"><span aria-hidden="true">O</span> Orca</a><div className="settings-topbar-actions"><a className="settings-back-link" href="/">← Inbox</a><button aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"} className="theme-toggle" onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")} type="button">{theme === "dark" ? "☾" : "☀"}</button></div></header>
    <div className="settings-home-layout">
      <aside className="settings-home-nav" aria-label="Settings sections"><p className="settings-eyebrow">Your workspace</p><a href="#account">Account</a><a href="#appearance">Appearance & reading</a><a href="#attention">Inbox & attention</a><a href="#writing">Writing</a><a href="#notifications">Notifications</a><a href="#connected">Connected accounts</a><a href="#privacy">Privacy & data</a></aside>
      <section className="settings-home-content" aria-labelledby="settings-title">
        <header className="settings-home-intro"><p className="settings-eyebrow">Settings</p><h1 id="settings-title" ref={titleRef} tabIndex={-1}>Make Orca<br /><em>yours.</em></h1><p>One calm place for the choices that shape how you read, write, and connect. Changes say whether they follow your account or only this device.</p></header>
        <SettingsSection id="account" title="Account" note="Account-level"><div className="settings-detail"><strong>Signed-in Orca account</strong><span>Your identity is managed through your connected Gmail account.</span></div><a className="settings-row-link" href="/settings/integrations/gmail">Review connected account →</a></SettingsSection>
        <SettingsSection id="appearance" title="Appearance & reading" note="This device"><PreferenceChoice label="Appearance" hint={`System is currently ${systemTheme}.`} name="settings-theme" value={preferences.theme} onChange={(value) => updateReader("theme", value as ReaderPreferences["theme"])} options={[{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} /><PreferenceChoice label="Reader text" hint="Changes message text, not navigation." name="settings-size" value={preferences.textSize} onChange={(value) => updateReader("textSize", value as ReaderPreferences["textSize"])} options={[{ value: "standard", label: "Standard" }, { value: "large", label: "Large" }]} /><PreferenceChoice label="Inbox & conversation spacing" hint="Compact fits more mail and thread history on screen." name="settings-density" value={preferences.density} onChange={(value) => updateReader("density", value as ReaderPreferences["density"])} options={[{ value: "calm", label: "Calm" }, { value: "compact", label: "Compact" }]} /><PreferenceChoice label="Motion" hint="System follows your operating system preference." name="settings-motion" value={preferences.motion} onChange={(value) => updateReader("motion", value as ReaderPreferences["motion"])} options={[{ value: "system", label: "System" }, { value: "reduced", label: "Reduced" }, { value: "full", label: "Full" }]} /></SettingsSection>
        <SettingsSection id="attention" title="Inbox & attention" note="Account-level"><p className="settings-section-copy">Tune the names, colors, and order of the views that help you decide what deserves attention.</p><a className="settings-row-link" href="/settings/attention-views">Manage Attention Views →</a></SettingsSection>
        <SettingsSection id="writing" title="Writing" note="Account-level"><label className="settings-field"><span>Default signature</span><textarea disabled={accountStatus === "loading" || accountStatus === "saving"} maxLength={10_000} onChange={(event) => updateAccount("signature", event.target.value)} placeholder="A thoughtful sign-off, if you use one." value={accountPreferences.signature} /></label><PreferenceChoice label="Compose format" hint="A starting point; you can still format each message." name="compose-format" value={accountPreferences.composeFormat} onChange={(value) => updateAccount("composeFormat", value as UserPreferences["composeFormat"])} options={[{ value: "plain", label: "Plain text" }, { value: "rich", label: "Rich text" }]} /><PreferenceChoice label="Reply behavior" hint="The default action when you choose Reply." name="reply-behavior" value={accountPreferences.replyBehavior} onChange={(value) => updateAccount("replyBehavior", value as UserPreferences["replyBehavior"])} options={[{ value: "reply", label: "Reply" }, { value: "reply_all", label: "Reply all" }]} /></SettingsSection>
        <SettingsSection id="notifications" title="Notifications & reminders" note="Account-level"><label className="preference-switch"><input checked={accountPreferences.notifyByDefault} disabled={accountStatus === "loading" || accountStatus === "saving"} onChange={(event) => updateAccount("notifyByDefault", event.target.checked)} type="checkbox" /><span><strong>Notify me for new reminders</strong><small>Orca will ask your browser for permission only when it needs to show a reminder.</small></span></label><p className="settings-capability">Browser notification capability: {typeof Notification === "undefined" ? "Unavailable in this browser" : Notification.permission === "granted" ? "Allowed" : Notification.permission === "denied" ? "Blocked by browser or OS" : "Not requested"}.</p></SettingsSection>
        <SettingsSection id="connected" title="Connected accounts" note="Provider access"><p className="settings-section-copy">See Gmail capabilities, connection health, last sync, and safely reconnect or import labels.</p><a className="settings-row-link" href="/settings/integrations/gmail">Gmail connection & permissions →</a><a className="settings-row-link" href="/settings/integrations/gmail/labels">Import Gmail labels →</a></SettingsSection>
        <SettingsSection id="privacy" title="Privacy & data" note="Clear boundaries"><p className="settings-section-copy">Orca stores your normalized mail locally and only requests the Gmail permissions shown in Connected accounts. Signing out ends this browser session; revoking access in Google prevents future sync and delivery.</p><a className="settings-row-link" href="https://myaccount.google.com/permissions">Manage Google provider access →</a></SettingsSection>
        <footer className="settings-save-bar" aria-live="polite" data-status={accountError ? "error" : accountStatus === "saving" ? "saving" : saved ? "saved" : "idle"}>{accountError ? <p role="alert">{accountError} <button onClick={() => void saveAccountPreferences()} type="button">Try again</button></p> : <p>{saved ? "Account preferences saved." : "Writing and reminder choices follow your account."}</p>}<button className="settings-save-button" disabled={accountStatus === "loading" || accountStatus === "saving"} onClick={() => void saveAccountPreferences()} type="button">{accountStatus === "saving" ? "Saving…" : saved ? "Saved" : "Save account choices"}</button></footer>
      </section>
    </div>
  </main>;
}

function SettingsSection({ id, title, note, children }: { id: string; title: string; note: string; children: ReactNode }) { return <section className="settings-section" id={id}><header><h2>{title}</h2><span>{note}</span></header><div>{children}</div></section>; }

export function ReaderPreferencesPage({ preferences, setPreferences, systemTheme }: {
  preferences: ReaderPreferences;
  setPreferences: Dispatch<SetStateAction<ReaderPreferences>>;
  systemTheme: Theme;
}) {
  const update = <Key extends keyof ReaderPreferences>(key: Key, value: ReaderPreferences[Key]) => {
    setPreferences((current) => ({ ...current, [key]: value }));
  };
  return (
    <main className="preferences-page">
      <header className="attention-settings-topbar">
        <a className="settings-brand" href="/"><span aria-hidden="true">O</span> Orca</a>
        <a className="settings-back-link" href="/">← Inbox</a>
      </header>
      <section className="preferences-shell" aria-labelledby="preferences-title">
        <header className="preferences-intro">
          <p className="settings-eyebrow">Settings / Reading</p>
          <h1 id="preferences-title">Read at<br /><em>your pace.</em></h1>
          <p>Orca follows your device until you make a choice. Every setting stays on this device and can be returned to system defaults.</p>
          <button className="preferences-reset" onClick={() => setPreferences(defaultReaderPreferences)} type="button">Use system defaults</button>
        </header>
        <div className="preferences-groups">
          <PreferenceChoice label="Appearance" hint={`System is currently ${systemTheme}.`} name="theme" value={preferences.theme} onChange={(value) => update("theme", value as ReaderPreferences["theme"])} options={[{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
          <PreferenceChoice label="Reader text" hint="Changes message text without enlarging navigation." name="text-size" value={preferences.textSize} onChange={(value) => update("textSize", value as ReaderPreferences["textSize"])} options={[{ value: "standard", label: "Standard" }, { value: "large", label: "Large" }]} />
          <PreferenceChoice label="Inbox & conversation spacing" hint="Compact fits more mail and thread history on screen." name="density" value={preferences.density} onChange={(value) => update("density", value as ReaderPreferences["density"])} options={[{ value: "calm", label: "Calm" }, { value: "compact", label: "Compact" }]} />
          <PreferenceChoice label="Motion" hint="System honors your device’s reduced-motion setting." name="motion" value={preferences.motion} onChange={(value) => update("motion", value as ReaderPreferences["motion"])} options={[{ value: "system", label: "System" }, { value: "reduced", label: "Reduced" }, { value: "full", label: "Full" }]} />
          <fieldset className="preference-group">
            <legend>Reminder notifications</legend>
            <label className="preference-switch">
              <input checked={preferences.notifyByDefault} onChange={(event) => update("notifyByDefault", event.target.checked)} type="checkbox" />
              <span><strong>Notify me by default</strong><small>New reminders start with notifications checked. You can still change each reminder.</small></span>
            </label>
          </fieldset>
        </div>
      </section>
    </main>
  );
}

function PreferenceChoice({ label, hint, name, value, onChange, options }: { label: string; hint: string; name: string; value: string; onChange: (value: string) => void; options: Array<{ value: string; label: string }> }) {
  return <fieldset className="preference-group"><legend>{label}</legend><p>{hint}</p><div className="preference-options">{options.map((option) => <label className={value === option.value ? "preference-option preference-option-selected" : "preference-option"} key={option.value}><input checked={value === option.value} name={name} onChange={() => onChange(option.value)} type="radio" value={option.value} /><span>{option.label}</span></label>)}</div></fieldset>;
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
  preferences = defaultReaderPreferences,
  theme,
  setTheme,
}: {
  demoMode?: boolean;
  preferences?: ReaderPreferences;
  theme: Theme;
  setTheme: Dispatch<SetStateAction<Theme>>;
}) {
  const [account, setAccount] = useState<MailAccount | null>(demoMode ? demoAccount : null);
  const [messages, setMessages] = useState<InboxMessage[]>(demoMode ? demoMessages : []);
  const [status, setStatus] = useState<"loading" | "syncing" | "ready" | "error" | "signedout">(demoMode ? "ready" : "loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [attentionByAddress, setAttentionByAddress] = useState<Record<string, AttentionBehavior>>({});
  const [collections, setCollections] = useState<Collection[]>(demoMode ? demoCollections : []);
  const [pins, setPins] = useState<Pin[]>(demoMode ? demoPins : []);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [laterLabel, setLaterLabel] = useState("Later");
  const [organizationError, setOrganizationError] = useState<string | null>(null);
  const [activeCollectionId, setActiveCollectionId] = useState<string | null>(null);
  const [organizerMessage, setOrganizerMessage] = useState<InboxMessage | null>(null);
  const [organizerClosing, setOrganizerClosing] = useState(false);
  const [activeMailbox, setActiveMailbox] = useState<Mailbox>("inbox");
  const [inboxFilter, setInboxFilter] = useState<InboxFilter>("all");
  const [refreshKey, setRefreshKey] = useState(0);
  const [personFilter, setPersonFilter] = useState<string | null>(null);
  const [panelMode, setPanelMode] = useState<PanelMode>(() => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("compose") === "1" ? "compose" : null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(() => typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("thread"));
  const [threadDetail, setThreadDetail] = useState<ThreadDetail | null>(null);
  const [readerStatus, setReaderStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [readerError, setReaderError] = useState<string | null>(null);
  const [readerRefreshKey, setReaderRefreshKey] = useState(0);
  const originMessageIdRef = useRef<string | null>(null);
  const messageRowRefs = useRef(new Map<string, HTMLButtonElement>());
  const composeDraft = useComposeDraft(account?.id ?? "preview", "new", demoMode);
  const [zen, setZen] = useState(false);
  const [panelClosing, setPanelClosing] = useState(false);
  const [showSendPermission, setShowSendPermission] = useState(false);
  const [permissionStatus, setPermissionStatus] = useState<"idle" | "loading" | "error">("idle");
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [zenClosing, setZenClosing] = useState(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const organizerCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current);
      }
      if (organizerCloseTimerRef.current) {
        clearTimeout(organizerCloseTimerRef.current);
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
    if (demoMode || !account || status !== "ready") return;
    const controller = new AbortController();
    void Promise.all([
      fetchJson("/v1/collections", collectionsResponseSchema, controller.signal),
      fetchJson("/v1/pins", pinsResponseSchema, controller.signal),
      fetchJson("/v1/reminders", remindersResponseSchema, controller.signal),
      fetchJson("/v1/reminders/view-settings", reminderViewSettingsSchema, controller.signal),
    ]).then(([nextCollections, nextPins, nextReminders, viewSettings]) => {
      if (controller.signal.aborted) return;
      setCollections(nextCollections);
      setPins(nextPins);
      setReminders(nextReminders);
      setLaterLabel(viewSettings.displayName);
    }).catch((error) => {
      if (!controller.signal.aborted) setOrganizationError(`Your saved items could not load. ${getErrorMessage(error)}`);
    });
    return () => controller.abort();
  }, [account, demoMode, status]);

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

  const mailboxMessages = useMemo(
    () => {
      const activeCollection = collections.find((collection) => collection.id === activeCollectionId);
      return activeCollection
        ? messages.filter((message) => activeCollection.threadIds.includes(message.threadId))
        : activeMailbox === "later"
          ? messages.filter((message) => reminders.some((reminder) => reminder.threadId === message.threadId && (reminder.status === "scheduled" || reminder.status === "resurfaced")))
        : getMessagesForMailbox(messages, activeMailbox, attentionByAddress);
    },
    [activeCollectionId, activeMailbox, attentionByAddress, collections, messages, reminders],
  );

  const visibleMessages = useMemo(() => {
    let filtered = personFilter
      ? mailboxMessages.filter((message) => messageIncludesPerson(message, personFilter))
      : mailboxMessages;
    if (!activeCollectionId && activeMailbox === "inbox" && inboxFilter !== "all") {
      filtered = filtered.filter((message) => {
        const behavior = attentionByAddress[message.from.email.trim().toLowerCase()] ?? message.attentionBehavior;
        return behavior === inboxFilter;
      });
    }
    return sortMessagesByAttention(filtered, attentionByAddress).map((message) => ({
      ...message,
      attentionBehavior: attentionByAddress[message.from.email.trim().toLowerCase()] ?? message.attentionBehavior,
    }));
  }, [activeCollectionId, activeMailbox, attentionByAddress, inboxFilter, mailboxMessages, personFilter]);

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
      if (event.key === "Escape" && !event.defaultPrevented && !document.querySelector(".sender-attention-control-expanded")) {
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
        label: mailbox.id === "later" ? laterLabel : mailbox.label,
        count: status === "ready" ? mailbox.id === "later"
          ? new Set(reminders.filter((reminder) => reminder.status === "scheduled" || reminder.status === "resurfaced").map((reminder) => reminder.threadId)).size
          : getMessagesForMailbox(messages, mailbox.id, attentionByAddress).length : undefined,
      })),
    [attentionByAddress, laterLabel, messages, reminders, status],
  );

  const activeMailboxItem = mailboxes.find((item) => item.id === activeMailbox) ?? mailboxes[0];
  const composeContacts = useMemo(() => collectComposeContacts(messages, account?.email ?? ""), [account?.email, messages]);
  const activeCollection = collections.find((collection) => collection.id === activeCollectionId) ?? null;
  const activeMailboxLabel = activeMailboxItem.label;
  const inboxTitle = personFilter ? personFilter : activeCollection?.name ?? activeMailboxLabel;
  const inboxEyebrow = personFilter
    ? `Filtered ${(activeCollection?.name ?? activeMailboxLabel).toLowerCase()}`
    : activeCollection
      ? `Collection · ${activeCollection.threadIds.length} ${activeCollection.threadIds.length === 1 ? "thread" : "threads"}`
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
    setZen(false);
  }

  function openOrganizer(message: InboxMessage) {
    if (organizerCloseTimerRef.current) {
      clearTimeout(organizerCloseTimerRef.current);
      organizerCloseTimerRef.current = null;
    }
    setOrganizerClosing(false);
    setOrganizerMessage(message);
  }

  function closeOrganizer() {
    if (!organizerMessage || organizerClosing) return;
    if (shouldReduceMotion()) {
      setOrganizerMessage(null);
      return;
    }
    setOrganizerClosing(true);
    organizerCloseTimerRef.current = setTimeout(() => {
      setOrganizerMessage(null);
      setOrganizerClosing(false);
      organizerCloseTimerRef.current = null;
    }, 220);
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

  async function reconcileSentMessage() {
    if (demoMode) {
      setReaderRefreshKey((key) => key + 1);
      return;
    }
    await fetchJson("/v1/sync/gmail", { parse: (value: unknown) => value }, undefined, { method: "POST" });
    setReaderRefreshKey((key) => key + 1);
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
      setActiveCollectionId(null);
      setSelectedThreadId(null);
      closePanel();
    });
  }

  function selectMailbox(mailbox: Mailbox) {
    runUiTransition("content", () => {
      setActiveMailbox(mailbox);
      setActiveCollectionId(null);
      setInboxFilter("all");
      setPersonFilter(null);
      setSelectedThreadId(null);
    });
  }

  function selectCollection(id: string) {
    runUiTransition("content", () => {
      setActiveCollectionId(id);
      setPersonFilter(null);
      setSelectedThreadId(null);
      setInboxFilter("all");
    });
  }

  async function createCollection(name: string, activate = true): Promise<Collection | null> {
    const trimmed = name.trim();
    if (!trimmed || !account) return null;
    setOrganizationError(null);
    try {
      const color = collectionColors[collections.length % collectionColors.length].value;
      const created = demoMode
        ? collectionSchema.parse({ id: `collection_demo_${Date.now()}`, accountId: account.id, name: trimmed, color, position: collections.length, threadIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
        : await fetchJson("/v1/collections", collectionSchema, undefined, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: trimmed, color }) });
      setCollections((current) => [...current, created]);
      if (activate) setActiveCollectionId(created.id);
      return created;
    } catch (error) {
      setOrganizationError(getErrorMessage(error));
      return null;
    }
  }

  async function updateCollection(collection: Collection, patch: { name?: string; color?: string; position?: number }) {
    setOrganizationError(null);
    try {
      if (demoMode) {
        setCollections((current) => reorderItems(current.map((item) => item.id === collection.id ? { ...item, ...patch, updatedAt: new Date().toISOString() } : item), collection.id, patch.position));
      } else {
        await fetchJson(`/v1/collections/${encodeURIComponent(collection.id)}`, collectionSchema, undefined, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
        setCollections(await fetchJson("/v1/collections", collectionsResponseSchema));
      }
    } catch (error) {
      setOrganizationError(getErrorMessage(error));
    }
  }

  async function deleteCollection(collection: Collection) {
    setOrganizationError(null);
    try {
      if (!demoMode) await fetchNoContent(`/v1/collections/${encodeURIComponent(collection.id)}`, { method: "DELETE" });
      setCollections((current) => current.filter((item) => item.id !== collection.id).map((item, position) => ({ ...item, position })));
      if (activeCollectionId === collection.id) setActiveCollectionId(null);
    } catch (error) {
      setOrganizationError(getErrorMessage(error));
    }
  }

  async function toggleCollectionMembership(collection: Collection, threadId: string) {
    const hasThread = collection.threadIds.includes(threadId);
    setOrganizationError(null);
    try {
      if (!demoMode) await fetchNoContent(`/v1/collections/${encodeURIComponent(collection.id)}/threads/${encodeURIComponent(threadId)}`, { method: hasThread ? "DELETE" : "PUT" }, !hasThread);
      setCollections((current) => current.map((item) => item.id === collection.id ? {
        ...item,
        threadIds: hasThread ? item.threadIds.filter((id) => id !== threadId) : [...item.threadIds, threadId],
        updatedAt: new Date().toISOString(),
      } : item));
    } catch (error) {
      setOrganizationError(getErrorMessage(error));
    }
  }

  async function createPin(input: Pick<Pin, "kind" | "targetId" | "label">) {
    if (!account || pins.some((pin) => pin.kind === input.kind && pin.targetId === input.targetId)) return;
    setOrganizationError(null);
    try {
      const created = demoMode
        ? pinSchema.parse({ ...input, id: `pin_demo_${Date.now()}`, accountId: account.id, position: pins.length, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
        : await fetchJson("/v1/pins", pinSchema, undefined, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
      setPins((current) => [...current, created]);
    } catch (error) {
      setOrganizationError(getErrorMessage(error));
    }
  }

  async function movePin(pin: Pin, direction: -1 | 1) {
    const position = pin.position + direction;
    if (position < 0 || position >= pins.length) return;
    try {
      if (demoMode) setPins((current) => reorderItems(current, pin.id, position));
      else {
        await fetchJson(`/v1/pins/${encodeURIComponent(pin.id)}`, pinSchema, undefined, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ position }) });
        setPins(await fetchJson("/v1/pins", pinsResponseSchema));
      }
    } catch (error) {
      setOrganizationError(getErrorMessage(error));
    }
  }

  async function deletePin(pin: Pin) {
    try {
      if (!demoMode) await fetchNoContent(`/v1/pins/${encodeURIComponent(pin.id)}`, { method: "DELETE" });
      setPins((current) => current.filter((item) => item.id !== pin.id).map((item, position) => ({ ...item, position })));
    } catch (error) {
      setOrganizationError(getErrorMessage(error));
    }
  }

  function selectPin(pin: Pin) {
    if (pin.kind === "view") selectMailbox(pin.targetId as Mailbox);
    if (pin.kind === "sender") togglePersonFilter(pin.targetId);
    if (pin.kind === "thread") {
      const message = messages.find((item) => item.threadId === pin.targetId);
      if (message) openThread(message);
    }
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

  async function saveReminder(input: { threadId: string; scheduledFor: string; timezone: string; notify: boolean }) {
    if (!account) return;
    const saved = demoMode
      ? reminderSchema.parse({ id: `reminder_demo_${input.threadId}`, accountId: account.id, ...input, status: "scheduled", resurfacedAt: null, completedAt: null, cancelledAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
      : await fetchJson("/v1/reminders", reminderSchema, undefined, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    setReminders((current) => [...current.filter((item) => item.threadId !== saved.threadId || !["scheduled", "resurfaced"].includes(item.status)), saved]);
  }

  async function finishReminder(reminder: Reminder, cancelled = false) {
    if (!demoMode && cancelled) await fetchNoContent(`/v1/reminders/${encodeURIComponent(reminder.id)}`, { method: "DELETE" });
    if (!demoMode && !cancelled) await fetchJson(`/v1/reminders/${encodeURIComponent(reminder.id)}/done`, reminderSchema, undefined, { method: "POST" });
    setReminders((current) => current.map((item) => item.id === reminder.id ? { ...item, status: cancelled ? "cancelled" : "completed", updatedAt: new Date().toISOString() } : item));
  }

  async function renameLaterView() {
    const displayName = window.prompt("Name this reminder view", laterLabel)?.trim();
    if (!displayName) return;
    if (!demoMode) await fetchJson("/v1/reminders/view-settings", reminderViewSettingsSchema, undefined, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ displayName }) });
    setLaterLabel(displayName);
  }

  return (
    <div className="app-root">
      <main className={`app-shell${selectedThreadId ? " app-shell-reader" : ""}`}>
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
            {activeMailbox === "later" ? <button className="later-rename" onClick={() => void renameLaterView()} type="button">Rename {laterLabel}</button> : null}
          </section>

          <a className="settings-link" href="/settings">
            <span aria-hidden="true">⚙</span> Settings
          </a>

          <OrganizationSidebar
            activeCollectionId={activeCollectionId}
            collections={collections}
            currentView={activeMailboxItem}
            error={organizationError}
            onCreateCollection={createCollection}
            onDeleteCollection={deleteCollection}
            onDeletePin={deletePin}
            onColorCollection={(collection, color) => void updateCollection(collection, { color })}
            onMoveCollection={(collection, direction) => void updateCollection(collection, { position: collection.position + direction })}
            onMovePin={(pin, direction) => void movePin(pin, direction)}
            onPinView={() => void createPin({ kind: "view", targetId: activeMailbox, label: activeMailboxLabel })}
            onRenameCollection={(collection, name) => void updateCollection(collection, { name })}
            onSelectCollection={selectCollection}
            onSelectPin={selectPin}
            pins={pins}
          />
        </aside>

        <section className={`content-pane${selectedThreadId ? " content-pane-reader" : ""}`} aria-label={selectedThreadId ? "Message reader" : "Inbox"}>
          <div style={{ display: selectedThreadId ? "none" : undefined }}>
            <InboxView
              account={account}
              errorMessage={errorMessage}
              inboxEyebrow={inboxEyebrow}
              inboxFilter={inboxFilter}
              inboxTitle={inboxTitle}
              isCollectionView={Boolean(activeCollection)}
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
              onOpenOrganizer={openOrganizer}
              onRemoveFromCollection={activeCollection ? (message) => void toggleCollectionMembership(activeCollection, message.threadId) : undefined}
              showInboxFilters={!activeCollectionId && activeMailbox === "inbox" && !personFilter}
            />
          </div>
          <div style={{ display: selectedThreadId ? undefined : "none" }}>
            <MessageReader
              detail={threadDetail}
              contacts={composeContacts}
              demoMode={demoMode}
              error={readerError}
              fallbackMessages={selectedThreadMessages}
              fallbackTitle={selectedThreadLatestMessage?.subject || "(no subject)"}
              onAttentionChange={updateSenderAttention}
              notifyByDefault={preferences.notifyByDefault}
              reminder={reminders.find((reminder) => reminder.threadId === selectedThreadId && (reminder.status === "scheduled" || reminder.status === "resurfaced")) ?? null}
              onSaveReminder={saveReminder}
              onFinishReminder={finishReminder}
              onBack={closeThread}
              onRetry={() => setReaderRefreshKey((key) => key + 1)}
              onSent={reconcileSentMessage}
              status={readerStatus}
            />
          </div>
        </section>
      </main>

      {organizerMessage ? (
        <ThreadOrganizer
          closing={organizerClosing}
          collections={collections}
          message={organizerMessage}
          onClose={closeOrganizer}
          onCreateCollection={async (name) => {
            const created = await createCollection(name, false);
            if (created) await toggleCollectionMembership(created, organizerMessage.threadId);
          }}
          onPin={(input) => void createPin(input)}
          onToggleCollection={(collection) => void toggleCollectionMembership(collection, organizerMessage.threadId)}
          pins={pins}
        />
      ) : null}

      {panelMode ? (
        <>
          <button
            aria-label="Close"
            aria-hidden={zen || undefined}
            className={`overlay-backdrop${panelClosing ? " overlay-backdrop-closing" : ""}`}
            inert={zen || undefined}
            onClick={closePanel}
            type="button"
          />

          <aside
            aria-hidden={zen || undefined}
            aria-label="Compose message"
            className={`slide-panel slide-panel-open${panelClosing ? " slide-panel-closing" : ""}`}
            inert={zen || undefined}
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
              <ComposeWorkspace
                autoFocusTo={panelMode === "compose"}
                canSend={account?.capabilities.send ?? false}
                contacts={composeContacts}
                controller={composeDraft}
                onClose={closePanel}
                onRequestSendAccess={() => setShowSendPermission(true)}
                onSent={closePanel}
              />
            </div>
          </aside>

          {zen ? (
            <ComposeWorkspace
              canSend={account?.capabilities.send ?? false}
              contacts={composeContacts}
              controller={composeDraft}
              onExitZen={exitZen}
              onRequestSendAccess={() => setShowSendPermission(true)}
              variant="zen"
            />
          ) : null}
          {showSendPermission ? (
            <GmailComposePermissionDialog
              error={permissionError}
              onCancel={() => { if (permissionStatus !== "loading") setShowSendPermission(false); }}
              onContinue={() => void beginGmailAuthorization("upgrade", `${window.location.origin}/?compose=1`, account?.id ?? null, setPermissionStatus, setPermissionError)}
              status={permissionStatus}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

export function GmailConnectionSettingsPage({ theme, setTheme }: {
  theme: Theme;
  setTheme: Dispatch<SetStateAction<Theme>>;
}) {
  const [account, setAccount] = useState<MailAccount | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [authorizationStatus, setAuthorizationStatus] = useState<"idle" | "loading" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const returnStatus = readOAuthReturnStatus();

  useEffect(() => {
    const controller = new AbortController();
    fetchJson("/v1/me", meResponseSchema, controller.signal)
      .then((next) => { setAccount(next); setStatus("ready"); })
      .catch((error) => { if (!controller.signal.aborted) { setStatus("error"); setErrorMessage(getErrorMessage(error)); } });
    return () => controller.abort();
  }, []);

  const returnTo = typeof window === "undefined" ? "/settings/integrations/gmail" : `${window.location.origin}/settings/integrations/gmail`;

  return (
    <main className="gmail-settings-page">
      <header className="attention-settings-topbar">
        <a className="settings-brand" href="/"><span aria-hidden="true">O</span> Orca</a>
        <div className="settings-topbar-actions">
          <a className="settings-back-link" href="/">← Inbox</a>
          <button aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"} className="theme-toggle" onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")} type="button">{theme === "dark" ? "☾" : "☀"}</button>
        </div>
      </header>
      <section className="gmail-settings-shell" aria-labelledby="gmail-settings-title">
        <header className="gmail-settings-intro">
          <p className="settings-eyebrow">Settings / Gmail connection</p>
          <h1 id="gmail-settings-title">Permission<br /><em>with purpose.</em></h1>
          <p>Your inbox connection stays readable while you deliberately decide whether Orca may create drafts and send mail.</p>
        </header>

        <section className="gmail-permission-card" aria-label="Gmail authorization state">
          {status === "loading" ? <p>Checking the confirmed Google grant…</p> : null}
          {status === "error" ? <div className="oauth-notice oauth-notice-error" role="alert"><strong>Connection needs attention</strong><span>{errorMessage}</span></div> : null}
          {returnStatus?.intent === "upgrade" ? <OAuthUpgradeReturnNotice status={returnStatus} /> : null}
          {account ? <>
            <div className="gmail-account-heading"><div><span>Connected account</span><strong>{account.email}</strong></div><span className="gmail-capability-badge">{account.capabilities.send ? "Compose + send" : "Read-only"}</span></div>
            <div className="gmail-capability-grid">
              <CapabilityRow active={account.capabilities.read} label="Read inbox" note="Keeps Orca synced with incoming mail." />
              <CapabilityRow active={account.capabilities.draft} label="Manage Gmail drafts" note="Creates and updates only messages you write." />
              <CapabilityRow active={account.capabilities.send} label="Send mail" note="Covers new messages, replies, and forwards." />
            </div>
            {!account.capabilities.send ? <div className="gmail-upgrade-explainer">
              <span>Optional permission</span>
              <h2>Let Orca finish what you write.</h2>
              <p>Google will ask for <code>gmail.compose</code>. It is the minimum single scope that supports Gmail drafts and sending. Orca does not request delete, label-editing, or broad mailbox-modification access.</p>
              <button disabled={authorizationStatus === "loading"} onClick={() => void beginGmailAuthorization("upgrade", returnTo, account.id, setAuthorizationStatus, setErrorMessage)} type="button">{authorizationStatus === "loading" ? "Opening Google…" : "Enable drafts and sending"}</button>
            </div> : <div className="gmail-upgrade-confirmed"><span aria-hidden="true">✓</span><div><strong>Google confirmed compose access</strong><p>Orca can now use the future draft and delivery transport for this account.</p></div></div>}
            {authorizationStatus === "error" ? <p className="gmail-authorization-error" role="alert">{errorMessage}</p> : null}
            <footer className="gmail-settings-actions">
              <button onClick={() => void beginGmailAuthorization("connect", returnTo, account.id, setAuthorizationStatus, setErrorMessage)} type="button">Reconnect Gmail</button>
              <a href="/settings/integrations/gmail/labels">Import Gmail labels →</a>
            </footer>
          </> : null}
        </section>
      </section>
    </main>
  );
}

function CapabilityRow({ active, label, note }: { active: boolean; label: string; note: string }) {
  return <div className={`gmail-capability-row${active ? " gmail-capability-row-active" : ""}`}><span aria-hidden="true">{active ? "✓" : "—"}</span><div><strong>{label}</strong><p>{note}</p></div><small>{active ? "Granted" : "Not granted"}</small></div>;
}

function OAuthUpgradeReturnNotice({ status }: { status: Exclude<OAuthReturnStatus, null> }) {
  return status.kind === "success"
    ? <div className="oauth-notice oauth-notice-success" role="status"><strong>Sending access confirmed</strong><span>Your existing inbox connection stayed in place.</span></div>
    : <div className="oauth-notice oauth-notice-error" role="alert"><strong>Nothing changed</strong><span>{oauthErrorMessage(status.reason, true)}</span></div>;
}

function GmailComposePermissionDialog({ error, onCancel, onContinue, status }: { error: string | null; onCancel: () => void; onContinue: () => void; status: "idle" | "loading" | "error" }) {
  const continueRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { continueRef.current?.focus(); }, []);

  return <div className="gmail-permission-backdrop" role="presentation"><section aria-labelledby="gmail-permission-title" aria-modal="true" className="gmail-permission-dialog" onKeyDown={(event) => { if (event.key === "Escape") onCancel(); }} role="dialog">
    <p className="settings-eyebrow">Before Google opens</p>
    <h2 id="gmail-permission-title">Enable drafts and sending?</h2>
    <p>Orca will request <code>gmail.compose</code> so it can create and update Gmail drafts, then send new messages, replies, and forwards. Reading continues even if you cancel or Google denies the request.</p>
    <ul><li>No deleting mail</li><li>No changing labels</li><li>No broader mailbox modification</li></ul>
    {error ? <p className="gmail-authorization-error" role="alert">{error}</p> : null}
    <div><button disabled={status === "loading"} onClick={onCancel} type="button">Not now</button><button className="gmail-permission-continue" disabled={status === "loading"} onClick={onContinue} ref={continueRef} type="button">{status === "loading" ? "Opening Google…" : "Continue to Google"}</button></div>
  </section></div>;
}

async function beginGmailAuthorization(
  intent: "connect" | "upgrade",
  returnTo: string,
  accountId: string | null,
  setStatus: (status: "idle" | "loading" | "error") => void,
  setError: (message: string | null) => void,
) {
  setStatus("loading");
  setError(null);
  try {
    const query = new URLSearchParams({ returnTo });
    if (intent === "upgrade" && accountId) query.set("accountId", accountId);
    const response = await fetch(`/v1/auth/gmail/${intent === "upgrade" ? "upgrade" : "connect"}?${query}`, { credentials: "include" });
    const body = await readJsonObject(response);
    if (!response.ok) throw new Error(getStringField(body, "message") ?? `Could not start Gmail authorization (${response.status})`);
    const authUrl = getStringField(body, "authUrl");
    if (!authUrl) throw new Error("The Gmail authorization response did not include an authUrl.");
    window.location.assign(authUrl);
  } catch (error) {
    setStatus("error");
    setError(getErrorMessage(error));
  }
}

export function GmailLabelMigrationPage({ mode, theme, setTheme }: {
  mode: "onboarding" | "settings";
  theme: Theme;
  setTheme: Dispatch<SetStateAction<Theme>>;
}) {
  const [migration, setMigration] = useState<GmailLabelMigration | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [status, setStatus] = useState<"loading" | "syncing" | "ready" | "saving" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        let next = await fetchJson("/v1/gmail-label-migration", gmailLabelMigrationSchema, controller.signal);
        if (mode === "onboarding" && next.status !== "pending") {
          window.location.replace("/");
          return;
        }
        if (!next.ready) {
          setStatus("syncing");
          next = await syncGmailLabelsUntilReady(
            next,
            () => fetchJson("/v1/sync/gmail", { parse: (value: unknown) => value }, controller.signal, { method: "POST" }),
            () => fetchJson("/v1/gmail-label-migration", gmailLabelMigrationSchema, controller.signal),
          );
        }
        if (!controller.signal.aborted) {
          setMigration(next);
          setStatus("ready");
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setStatus("error");
          setErrorMessage(getErrorMessage(error));
        }
      }
    }
    void load();
    return () => controller.abort();
  }, [mode]);

  async function finish(action: "skip" | "import") {
    setStatus("saving");
    setErrorMessage(null);
    try {
      const next = await fetchJson(
        `/v1/gmail-label-migration/${action}`,
        gmailLabelMigrationSchema,
        undefined,
        action === "skip"
          ? { method: "POST" }
          : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ labelIds: [...selectedIds] }) },
      );
      setMigration(next);
      setStatus("ready");
      if (mode === "onboarding") window.location.assign("/");
    } catch (error) {
      setStatus("error");
      setErrorMessage(getErrorMessage(error));
    }
  }

  const selectedThreadCount = migration?.labels.filter((label) => selectedIds.has(label.id)).reduce((sum, label) => sum + label.threadCount, 0) ?? 0;
  const completed = migration?.status === "completed";

  return (
    <main className="label-migration-page">
      <header className="attention-settings-topbar">
        <a className="settings-brand" href="/"><span aria-hidden="true">O</span> Orca</a>
        <div className="settings-topbar-actions">
          {mode === "settings" ? <a className="settings-back-link" href="/">← Inbox</a> : null}
          <button aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"} className="theme-toggle" onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")} type="button">{theme === "dark" ? "☾" : "☀"}</button>
        </div>
      </header>
      <section className="label-migration-shell" aria-labelledby="label-migration-title">
        <header className="label-migration-intro">
          <p className="settings-eyebrow">{mode === "onboarding" ? "One last choice" : "Settings / Gmail labels"}</p>
          <h1 id="label-migration-title">Keep the labels<br /><em>that still matter.</em></h1>
          <p>Turn selected Gmail labels into Orca Collections. This only copies your organization into Orca—nothing in Gmail is changed.</p>
          <div className="label-migration-safety"><strong>Read-only by design</strong><span>Messages stay in Gmail. Labels are never renamed, removed, or edited.</span></div>
        </header>

        <section className="label-migration-picker" aria-label="Gmail labels available to import">
          <div className="label-migration-heading"><span>Your labels</span><span>{migration ? `${migration.labels.length} available` : ""}</span></div>
          {status === "loading" ? <div className="attention-loading">Checking your Gmail organization…</div> : null}
          {status === "syncing" ? <div className="attention-loading">Reading labels from Gmail for the first time…</div> : null}
          {status === "error" ? <div className="attention-error" role="alert">{errorMessage ?? "Could not load Gmail labels."} <button onClick={() => window.location.reload()} type="button">Try again</button></div> : null}
          {status === "ready" && completed ? (
            <div className="label-migration-complete" role="status"><span aria-hidden="true">✓</span><div><strong>Gmail labels imported</strong><p>{migration?.labels.filter((label) => label.imported).length ?? 0} Collections were created. Reopening this page will never duplicate them.</p></div></div>
          ) : null}
          {(status === "ready" || status === "saving") && migration && !completed ? (
            <>
              {migration.labels.length ? <div className="label-migration-list">
                {migration.labels.map((label) => {
                  const selected = selectedIds.has(label.id);
                  return <label className={`label-migration-option${selected ? " label-migration-option-selected" : ""}`} key={label.id}>
                    <input checked={selected} disabled={status === "saving"} onChange={() => setSelectedIds((current) => { const next = new Set(current); selected ? next.delete(label.id) : next.add(label.id); return next; })} type="checkbox" />
                    <span className="label-migration-check" aria-hidden="true">{selected ? "✓" : ""}</span>
                    <span><strong>{label.name}</strong><small>{label.threadCount} {label.threadCount === 1 ? "thread" : "threads"}</small></span>
                  </label>;
                })}
              </div> : <div className="label-migration-empty"><strong>A clean start is ready.</strong><p>No user-created Gmail labels were found. System labels such as Inbox and Sent are intentionally left out.</p></div>}
              <footer className="label-migration-actions">
                <div><strong>{selectedIds.size} selected</strong><span>{selectedThreadCount} label memberships will be copied</span></div>
                <button disabled={status === "saving"} onClick={() => void finish("skip")} type="button">{migration.labels.length ? "Start clean" : "Continue to Orca"}</button>
                {migration.labels.length ? <button className="label-import-button" disabled={status === "saving" || selectedIds.size === 0} onClick={() => void finish("import")} type="button">{status === "saving" ? "Saving…" : "Import selected"}</button> : null}
              </footer>
            </>
          ) : null}
          {completed ? <a className="label-migration-return" href="/">Return to inbox →</a> : null}
        </section>
      </section>
    </main>
  );
}

export async function syncGmailLabelsUntilReady(
  initial: GmailLabelMigration,
  sync: () => Promise<unknown>,
  reload: () => Promise<GmailLabelMigration>,
) {
  let migration = initial;
  while (!migration.ready) {
    await sync();
    migration = await reload();
  }
  return migration;
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
        : `${window.location.origin}${isLogin || isOnboarding ? "/onboarding" : "/"}`;
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
      <span>{oauthErrorMessage(status.reason, false)}</span>
    </div>
  );
}

function oauthErrorMessage(reason: string | null, preserveReading: boolean) {
  const suffix = preserveReading ? " Your read-only inbox still works." : "";
  switch (reason) {
    case "provider_error": return `Google permission was not granted.${suffix}`;
    case "compose_not_granted": return `Google did not grant Gmail draft and send access.${suffix}`;
    case "account_mismatch": return `Choose the same Google account that is already connected to Orca.${suffix}`;
    case "upgrade_account_missing": return `Orca could not find the Gmail connection to upgrade.${suffix}`;
    case "invalid_state":
    case "missing_state": return "The authorization return could not be verified. Start again from Orca.";
    case "token_exchange_failed":
    case "userinfo_failed": return `Google could not confirm the authorization. Try again.${suffix}`;
    default: return `The Gmail authorization flow did not complete.${suffix}`;
  }
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
  isCollectionView,
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
  onOpenOrganizer,
  onRemoveFromCollection,
  showInboxFilters,
  rowRefs,
}: {
  account: MailAccount | null;
  errorMessage: string | null;
  inboxEyebrow: string;
  inboxFilter: InboxFilter;
  inboxTitle: string;
  isCollectionView: boolean;
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
  onOpenOrganizer: (message: InboxMessage) => void;
  onRemoveFromCollection?: (message: InboxMessage) => void;
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
                : isCollectionView
                  ? "Use Keep on any conversation to add it here. Your inbox and attention placement will stay exactly as they are."
                : "When synced mail arrives, your inbox list will appear here."
            }
            eyebrow={personFilter ? "No matches" : isCollectionView ? "Collection empty" : "Inbox empty"}
            title={personFilter ? "Nothing from this person" : isCollectionView ? "Nothing saved here yet" : "No messages yet"}
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
                    <button
                      className={`keep-thread-button${onRemoveFromCollection ? " keep-thread-button-remove" : ""}`}
                      onClick={() => onRemoveFromCollection ? onRemoveFromCollection(message) : onOpenOrganizer(message)}
                      type="button"
                    >
                      <span aria-hidden="true">{onRemoveFromCollection ? "−" : "＋"}</span> {onRemoveFromCollection ? "Remove" : "Keep"}
                    </button>
                    <SenderAttentionControl compact initialBehavior={message.attentionBehavior} message={message} onBehaviorChange={onAttentionChange} />
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

export function sortThreadMessages(messages: ThreadDetailMessage[]) {
  return [...messages].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.id.localeCompare(b.id));
}

export function groupThreadMessages(messages: ThreadDetailMessage[]) {
  return sortThreadMessages(messages).reduce<Array<{ key: string; label: string; messages: ThreadDetailMessage[] }>>((groups, message) => {
    const date = new Date(message.receivedAt);
    const key = Number.isNaN(date.getTime()) ? "unknown" : date.toISOString().slice(0, 10);
    const existing = groups[groups.length - 1];
    if (existing?.key === key) {
      existing.messages.push(message);
      return groups;
    }
    groups.push({
      key,
      label: Number.isNaN(date.getTime())
        ? "Date unavailable"
        : new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(date),
      messages: [message],
    });
    return groups;
  }, []);
}

export function splitQuotedContent(body: string) {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const quoteStart = lines.findIndex((line, index) =>
    index > 0 && (/^\s*>/.test(line) || /^\s*On .+wrote:\s*$/i.test(line) || /^\s*-{2,}\s*Forwarded message\s*-{2,}\s*$/i.test(line)),
  );
  if (quoteStart < 0) return { current: body.trim(), quoted: null };
  return {
    current: lines.slice(0, quoteStart).join("\n").trim(),
    quoted: lines.slice(quoteStart).join("\n").trim(),
  };
}

export function shouldShowReaderJumpToTop(scrollY: number, viewportHeight: number) {
  return scrollY > Math.max(360, viewportHeight * 0.4);
}

export function MessageReader({
  detail,
  contacts = [],
  error,
  fallbackMessages,
  fallbackTitle,
  onBack,
  onRetry,
  onSent = () => {},
  status,
  onAttentionChange,
  reminder = null,
  onSaveReminder = async () => {},
  onFinishReminder = async () => {},
  notifyByDefault = false,
  demoMode = false,
}: {
  detail: ThreadDetail | null;
  contacts?: MailContact[];
  error: string | null;
  fallbackMessages: InboxMessage[];
  fallbackTitle: string;
  onBack: () => void;
  onRetry: () => void;
  onSent?: (result: DeliveryResult) => Promise<void> | void;
  status: "idle" | "loading" | "ready" | "error";
  onAttentionChange: (address: string, behavior?: AttentionBehavior) => Promise<AttentionBehavior>;
  reminder?: Reminder | null;
  onSaveReminder?: (input: { threadId: string; scheduledFor: string; timezone: string; notify: boolean }) => Promise<void>;
  onFinishReminder?: (reminder: Reminder, cancelled?: boolean) => Promise<void>;
  notifyByDefault?: boolean;
  demoMode?: boolean;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const messageRefs = useRef(new Map<string, HTMLElement>());
  const [showJumpToTop, setShowJumpToTop] = useState(false);
  const messages = useMemo(() => sortThreadMessages(detail?.messages ?? []), [detail]);
  const messageGroups = useMemo(() => groupThreadMessages(messages), [messages]);
  const fallbackAttentionByAddress = useMemo(() => new Map(fallbackMessages.map((message) => [message.from.email.trim().toLowerCase(), message.attentionBehavior])), [fallbackMessages]);
  const newestMessage = messages[messages.length - 1];
  const newestUnreadMessage = [...messages].reverse().find((message) => message.unread);
  const firstUnreadMessage = messages.find((message) => message.unread);
  const jumpTarget = newestUnreadMessage ?? newestMessage;
  const title = detail?.thread.subject || fallbackTitle;

  useEffect(() => {
    if (status === "ready") headingRef.current?.focus();
  }, [status]);

  useEffect(() => {
    if (status !== "ready") return;
    const updateJumpToTop = () => setShowJumpToTop(shouldShowReaderJumpToTop(window.scrollY, window.innerHeight));
    updateJumpToTop();
    window.addEventListener("scroll", updateJumpToTop, { passive: true });
    return () => window.removeEventListener("scroll", updateJumpToTop);
  }, [status]);

  function jumpToNewest() {
    if (!jumpTarget) return;
    const node = messageRefs.current.get(jumpTarget.id);
    node?.scrollIntoView({ behavior: shouldReduceMotion() ? "auto" : "smooth", block: "start" });
    node?.focus({ preventScroll: true });
  }

  function jumpToTop() {
    headingRef.current?.focus({ preventScroll: true });
    window.scrollTo({
      top: 0,
      behavior: shouldReduceMotion() ? "auto" : "smooth",
    });
  }

  return (
    <article className="message-reader" aria-labelledby="reader-title">
      <nav className="reader-nav" aria-label="Reader controls">
        <button className="reader-back" onClick={onBack} type="button">
          <ArrowGlyph direction="left" />
          <span>Back to inbox</span>
        </button>
        <span className="reader-escape-hint" aria-hidden="true">esc</span>
      </nav>
      <button
        className="reader-jump reader-jump-top"
        hidden={!showJumpToTop}
        onClick={jumpToTop}
        type="button"
      >
        <span>Jump to top</span>
        <span aria-hidden="true">↑</span>
      </button>

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
            <p className="reader-participants">With {formatThreadParticipants(detail.thread.participants, detail.account.email)}</p>
            <RemindMeControl threadId={detail.thread.id} reminder={reminder} notifyByDefault={notifyByDefault} onSave={onSaveReminder} onFinish={onFinishReminder} />
          </header>

          {messages.length >= 5 && jumpTarget ? (
            <button className="reader-jump" onClick={jumpToNewest} type="button">
              <span>{newestUnreadMessage ? "Jump to newest unread" : "Jump to newest"}</span>
              <span aria-hidden="true">↓</span>
            </button>
          ) : null}

          <div className="reader-message-list" aria-label="Messages in conversation">
            {messageGroups.map((group) => (
              <section className="reader-day-group" key={group.key} aria-labelledby={`reader-day-${group.key}`}>
                <h2 className="reader-day" id={`reader-day-${group.key}`}>{group.label}</h2>
                <ol>
                  {group.messages.map((message) => {
                    const signature = getContactSignature(message.from);
                    const plainBody = !message.bodyHtml && message.bodyText?.trim() ? splitQuotedContent(message.bodyText) : null;
                    const isNewest = message.id === newestMessage?.id;
                    const isFirstUnread = message.id === firstUnreadMessage?.id;
                    return (
                      <li className={`reader-message${message.unread ? " reader-message-unread" : ""}`} key={message.id}>
                        {isFirstUnread ? <div className="reader-unread-divider" role="separator"><span>Unread messages</span></div> : null}
                        <article
                          aria-labelledby={`reader-sender-${message.id}`}
                          ref={(node) => {
                            if (node) messageRefs.current.set(message.id, node);
                            else messageRefs.current.delete(message.id);
                          }}
                          tabIndex={-1}
                        >
                    <header className="reader-sender">
                      <MessageMark signature={signature} unread={message.unread} />
                      <div className="reader-sender-copy">
                        <div className="reader-sender-line">
                          <h3 id={`reader-sender-${message.id}`}>{message.from.name ?? message.from.email}</h3>
                          {message.unread ? <span className="reader-status-label">Unread</span> : null}
                          {isNewest ? <span className="reader-status-label">Newest</span> : null}
                        </div>
                        <details>
                          <summary>Message details</summary>
                          <dl>
                            <div><dt>Sent</dt><dd><time dateTime={message.receivedAt}>{formatFullReceivedAt(message.receivedAt)}</time></dd></div>
                            <div><dt>From</dt><dd>{message.from.email}</dd></div>
                            <div><dt>To</dt><dd>{formatRecipientAddresses(message.to)}</dd></div>
                            {message.cc.length ? <div><dt>Cc</dt><dd>{formatRecipientAddresses(message.cc)}</dd></div> : null}
                            {message.bcc.length ? <div><dt>Bcc</dt><dd>{formatRecipientAddresses(message.bcc)}</dd></div> : null}
                          </dl>
                        </details>
                      </div>
                      {isNewest ? <SenderAttentionControl compact initialBehavior={fallbackAttentionByAddress.get(message.from.email.trim().toLowerCase()) ?? "normal"} reader message={message} onBehaviorChange={onAttentionChange} /> : null}
                    </header>
                    {message.bodyHtml ? (
                      <div className="reader-body reader-body-html" dangerouslySetInnerHTML={{ __html: message.bodyHtml }} />
                    ) : plainBody ? (
                      <>
                        <div className="reader-body reader-body-plain">{plainBody.current}</div>
                        {plainBody.quoted ? (
                          <details className="reader-quoted">
                            <summary>Show quoted history</summary>
                            <div>{plainBody.quoted}</div>
                          </details>
                        ) : null}
                      </>
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
              </section>
            ))}
          </div>
          <ThreadReplyComposer
            account={detail.account}
            contacts={contacts}
            demoMode={demoMode}
            detail={detail}
            message={newestMessage}
            onSent={onSent}
          />
          <footer className="reader-end"><span aria-hidden="true">◒</span><p>You’re all caught up.</p></footer>
        </div>
      ) : null}
    </article>
  );
}

export type ReaderMessageAction = "reply" | "reply_all" | "forward";

function ThreadReplyComposer({ account, contacts, demoMode = false, detail, message, onSent }: { account: MailAccount; contacts: MailContact[]; demoMode?: boolean; detail: ThreadDetail; message?: ThreadDetailMessage; onSent: (result: DeliveryResult) => Promise<void> | void }) {
  const [action, setAction] = useState<ReaderMessageAction | null>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const [reconciliationError, setReconciliationError] = useState<string | null>(null);
  const [showPermission, setShowPermission] = useState(false);
  const [permissionStatus, setPermissionStatus] = useState<"idle" | "loading" | "error">("idle");
  const [permissionError, setPermissionError] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.isComposing || event.repeat || target?.matches("input, textarea, [contenteditable=true]")) return;
      const next = event.key.toLowerCase() === "r" ? "reply" : event.key.toLowerCase() === "a" ? "reply_all" : event.key.toLowerCase() === "f" ? "forward" : null;
      if (!next) return;
      event.preventDefault();
      setReconciliationError(null);
      setAction(next);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (!action || !message) {
    return (
      <section aria-label="Reply to conversation" className="reader-reply reader-reply-collapsed">
        <div><span aria-hidden="true">↩</span><div><strong>Continue the conversation</strong><p>Write back without leaving the thread.</p></div></div>
        {reconciliationError ? <p className="compose-delivery-error" role="alert">{reconciliationError}</p> : null}
        <ReaderActionButtons active={null} onSelect={(next) => { setReconciliationError(null); setAction(next); }} ref={actionsRef} />
      </section>
    );
  }

  return (
    <section className="reader-reply reader-reply-expanded">
      <div className="reader-reply-heading"><ReaderActionButtons active={action} onSelect={setAction} ref={actionsRef} /><button aria-label={`Collapse ${readerActionLabel(action).toLowerCase()}`} onClick={() => setAction(null)} type="button">−</button></div>
      <ThreadActionWorkspace action={action} account={account} contacts={contacts} demoMode={demoMode} detail={detail} key={action} message={message} onRequestSendAccess={() => setShowPermission(true)} onSent={async (result) => {
        setAction(null);
        window.requestAnimationFrame(() => actionsRef.current?.querySelector<HTMLButtonElement>("button")?.focus());
        try {
          await onSent(result);
        } catch {
          setReconciliationError("Message sent, but Orca could not refresh the conversation. Refresh to see the delivered message.");
        }
      }} />
      {showPermission ? <GmailComposePermissionDialog
        error={permissionError}
        onCancel={() => { if (permissionStatus !== "loading") setShowPermission(false); }}
        onContinue={() => void beginGmailAuthorization("upgrade", `${window.location.origin}/?thread=${encodeURIComponent(detail.thread.id)}`, account.id, setPermissionStatus, setPermissionError)}
        status={permissionStatus}
      /> : null}
    </section>
  );
}

const ReaderActionButtons = function ReaderActionButtons({ active, onSelect, ref }: { active: ReaderMessageAction | null; onSelect: (action: ReaderMessageAction) => void; ref?: Ref<HTMLDivElement> }) {
  return <div aria-label="Message actions" className="reader-reply-actions" ref={ref} role="toolbar">
    {(["reply", "reply_all", "forward"] as const).map((action) => <button aria-keyshortcuts={action === "reply" ? "R" : action === "reply_all" ? "A" : "F"} aria-pressed={active === action} key={action} onClick={() => onSelect(action)} title={`${readerActionLabel(action)} (${action === "reply" ? "R" : action === "reply_all" ? "A" : "F"})`} type="button">{readerActionLabel(action)}</button>)}
  </div>;
};

function ThreadActionWorkspace({ action, account, contacts, demoMode, detail, message, onRequestSendAccess, onSent }: { action: ReaderMessageAction; account: MailAccount; contacts: MailContact[]; demoMode: boolean; detail: ThreadDetail; message: ThreadDetailMessage; onRequestSendAccess: () => void; onSent: (result: DeliveryResult) => Promise<void> | void }) {
  const controller = useComposeDraft(account.id, `${action}:${detail.thread.id}:${message.id}`, demoMode);
  const fields = useMemo(() => buildReaderActionDraft(detail, message, action), [action, detail, message]);
  useEffect(() => {
    if (controller.isHydrated !== false && !controller.hasContent) controller.updateDraft(fields);
  }, [controller.hasContent, controller.isHydrated, fields]);
  const recipients = [...fields.to, ...fields.cc];
  return <ComposeWorkspace
    actionLabel={readerActionLabel(action)}
    canSend={account.capabilities.send}
    contacts={contacts}
    controller={controller}
    onRequestSendAccess={onRequestSendAccess}
    onSent={onSent}
    replyLabel={recipients.map((recipient) => recipient.name ?? recipient.email).join(", ") || "new recipients"}
    variant="reply"
  />;
}

function readerActionLabel(action: ReaderMessageAction): "Reply" | "Reply all" | "Forward" {
  return action === "reply_all" ? "Reply all" : action === "forward" ? "Forward" : "Reply";
}

export function buildReaderActionDraft(detail: ThreadDetail, message: ThreadDetailMessage, action: ReaderMessageAction): ComposeDraftFields {
  const owned = new Set([detail.account.email.trim().toLowerCase()]);
  if (message.labels.some((label) => label.toUpperCase() === "SENT")) owned.add(message.from.email.trim().toLowerCase());
  const dedupe = (contacts: MailContact[], excluded = new Set<string>()) => {
    const seen = new Set(excluded);
    return contacts.filter((contact) => {
      const email = contact.email.trim().toLowerCase();
      if (!email || owned.has(email) || seen.has(email)) return false;
      seen.add(email);
      return true;
    });
  };
  const context = {
    kind: action,
    threadId: detail.thread.id,
    messageId: message.id,
    providerMessageId: message.providerMessageId,
    providerThreadId: detail.thread.providerThreadId,
    inReplyTo: message.internetMessageId,
    references: message.references,
  } as const;
  if (action === "forward") {
    return { to: [], cc: [], bcc: [], subject: normalizeForwardSubject(message.subject), body: forwardedMessageBody(message), context };
  }
  const sender = dedupe([message.from]);
  const to = action === "reply"
    ? (sender.length ? sender : dedupe([...message.to, ...message.cc]))
    : dedupe([...sender, ...message.to]);
  const cc = action === "reply_all" ? dedupe(message.cc, new Set(to.map((contact) => contact.email.trim().toLowerCase()))) : [];
  return { to, cc, bcc: [], subject: normalizeReplySubject(message.subject), body: "", context };
}

export function normalizeForwardSubject(subject: string) {
  const trimmed = subject.trim();
  return /^(fwd?|forward):/i.test(trimmed) ? trimmed : `Fwd: ${trimmed || "(no subject)"}`;
}

function forwardedMessageBody(message: ThreadDetailMessage) {
  const body = message.bodyText?.trim() || message.snippet.trim() || "(No readable message body)";
  const attachmentLine = message.attachments.length ? `\nOriginal attachments (not included automatically): ${message.attachments.map((attachment) => attachment.filename).join(", ")}` : "";
  return `\n\n---------- Forwarded message ----------\nFrom: ${message.from.name ? `${message.from.name} <${message.from.email}>` : message.from.email}\nDate: ${formatFullReceivedAt(message.receivedAt)}\nSubject: ${message.subject || "(no subject)"}\nTo: ${formatRecipientAddresses(message.to)}${message.cc.length ? `\nCc: ${formatRecipientAddresses(message.cc)}` : ""}${attachmentLine}\n\n${body}`;
}

export function normalizeReplySubject(subject: string) {
  const trimmed = subject.trim();
  return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed || "(no subject)"}`;
}

export function getReplyRecipient(detail: ThreadDetail, newestMessage?: ThreadDetailMessage) {
  const accountEmail = detail.account.email.trim().toLowerCase();
  const messages = newestMessage && !detail.messages.some((message) => message.id === newestMessage.id)
    ? [...detail.messages, newestMessage]
    : detail.messages;
  const newestExternalMessage = [...messages]
    .sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime())
    .find((message) => message.from.email.trim().toLowerCase() !== accountEmail);
  if (newestExternalMessage) return newestExternalMessage.from;
  return detail.thread.participants.find((participant) => participant.email.trim().toLowerCase() !== accountEmail) ?? null;
}

function RemindMeControl({ threadId, reminder, notifyByDefault, onSave, onFinish }: { threadId: string; reminder: Reminder | null; notifyByDefault: boolean; onSave: (input: { threadId: string; scheduledFor: string; timezone: string; notify: boolean }) => Promise<void>; onFinish: (reminder: Reminder, cancelled?: boolean) => Promise<void> }) {
  const [expanded, setExpanded] = useState(false);
  const presence = useExitPresence(expanded);
  const [delayStep, setDelayStep] = useState(0);
  const [notify, setNotify] = useState(notifyByDefault);
  const [saving, setSaving] = useState(false);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const save = async (date: Date) => {
    setSaving(true);
    try { await onSave({ threadId, scheduledFor: date.toISOString(), timezone, notify }); setExpanded(false); }
    finally { setSaving(false); }
  };
  const delayHours = delayStep <= 12 ? delayStep : (delayStep - 12) * 24;
  const delayLabel = delayStep <= 12
    ? `${delayStep} ${delayStep === 1 ? "hour" : "hours"}`
    : `${delayStep - 12} ${delayStep === 13 ? "day" : "days"}`;
  if (reminder) return <div className="remind-control remind-control-active"><span>↻ {reminder.status === "resurfaced" ? "Ready now" : `Returns ${formatFullReceivedAt(reminder.scheduledFor)}`}</span><button onClick={() => void onFinish(reminder)} type="button">Done</button><button onClick={() => void onFinish(reminder, true)} type="button">Cancel</button></div>;
  return (
    <div className="remind-control">
      <button aria-expanded={expanded} onClick={() => setExpanded((current) => !current)} type="button">↻ Remind me</button>
      {presence.rendered ? (
        <div className={`remind-menu remind-menu-hours${presence.closing ? " remind-menu-closing" : ""}`}>
          <div className="remind-hours" aria-label="Reminder delay">
            <button aria-label="One step less" disabled={delayStep === 0 || saving} onClick={() => setDelayStep((current) => current - 1)} type="button">−</button>
            <strong>In {delayLabel}</strong>
            <button aria-label="One step more" disabled={delayStep === 43 || saving} onClick={() => setDelayStep((current) => current + 1)} type="button">+</button>
          </div>
          <small>{delayStep < 12 ? "Increase up to 12 hours, then continue in days." : "Each step now adds one day."}</small>
          <div className="remind-custom-actions">
            <label className="remind-notify"><input checked={notify} onChange={(event) => setNotify(event.target.checked)} type="checkbox" /> Notify me</label>
            <button disabled={saving || delayHours === 0} onClick={() => void save(new Date(Date.now() + delayHours * 60 * 60 * 1000))} type="button">{saving ? "Saving…" : "Set reminder"}</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ReaderLoading({ title, messages }: { title: string; messages: InboxMessage[] }) {
  return <section className="reader-document reader-loading" aria-busy="true" aria-live="polite"><header className="reader-heading"><p className="reader-kicker">Opening conversation</p><h1 id="reader-title">{title}</h1></header><div className="reader-loading-line" /><div className="reader-loading-line reader-loading-line-short" /><span className="visually-hidden">Loading {messages.length || 1} message conversation</span></section>;
}

function SenderAttentionControl({ message, compact = false, initialBehavior, reader = false, onBehaviorChange }: { message: SenderAttentionTarget; compact?: boolean; initialBehavior: AttentionBehavior; reader?: boolean; onBehaviorChange: (address: string, behavior?: AttentionBehavior) => Promise<AttentionBehavior> }) {
  const [expanded, setExpanded] = useState(false);
  const presence = useExitPresence(expanded);
  const [resolution, setResolution] = useState<ResolvedSenderAttention | null>(null);
  const [selectedBehavior, setSelectedBehavior] = useState<AttentionViewSetting["behavior"] | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "saving" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const controlRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLElement>(null);
  const focusAfterCloseRef = useRef<{ behavior?: AttentionBehavior } | null>(null);
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
      setSelectedBehavior((current) => current ?? initialBehavior);
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
  }, [address, expanded, initialBehavior, resolution]);

  useEffect(() => {
    if (!presence.rendered || presence.closing) return;
    const selectedChoice = menuRef.current?.querySelector<HTMLButtonElement>('.sender-attention-choices button[aria-pressed="true"]');
    (selectedChoice ?? menuRef.current?.querySelector<HTMLButtonElement>(".sender-attention-choices button:not([disabled])"))?.focus();
    function dismissOnOutsidePointer(event: PointerEvent) {
      if (controlRef.current && !controlRef.current.contains(event.target as Node)) {
        closeAndRestoreFocus();
      }
    }
    function dismissOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeAndRestoreFocus();
      }
    }
    window.addEventListener("pointerdown", dismissOnOutsidePointer);
    window.addEventListener("keydown", dismissOnEscape);
    return () => {
      window.removeEventListener("pointerdown", dismissOnOutsidePointer);
      window.removeEventListener("keydown", dismissOnEscape);
    };
  }, [presence.closing, presence.rendered]);

  useEffect(() => {
    if (!expanded || presence.closing || status !== "idle" || !selectedBehavior) return;
    menuRef.current?.querySelector<HTMLButtonElement>('.sender-attention-choices button[aria-pressed="true"]')?.focus();
  }, [expanded, presence.closing, selectedBehavior, status]);

  useEffect(() => {
    if (presence.rendered || !focusAfterCloseRef.current) return;
    const { behavior } = focusAfterCloseRef.current;
    focusAfterCloseRef.current = null;
    requestAnimationFrame(() => {
      if (behavior === "hidden" && !reader) {
        document.querySelector<HTMLButtonElement>(".message-row")?.focus();
      } else if (triggerRef.current?.isConnected) {
        triggerRef.current.focus();
      } else {
        document.querySelector<HTMLButtonElement>(reader ? ".reader-back" : ".message-row")?.focus();
      }
    });
  }, [presence.rendered, reader]);

  function closeAndRestoreFocus(behavior?: AttentionBehavior) {
    if (!expanded || presence.closing) return;
    focusAfterCloseRef.current = { behavior };
    setExpanded(false);
  }

  function captureListFocusTarget() {
    if (reader) return null;
    const currentRow = controlRef.current?.closest<HTMLElement>(".message-row-wrap");
    if (!currentRow) return null;
    const rows = Array.from(document.querySelectorAll<HTMLElement>(".message-row-wrap"));
    const currentIndex = rows.indexOf(currentRow);
    const nextRow = rows[currentIndex + 1] ?? rows[currentIndex - 1];
    return nextRow?.querySelector<HTMLButtonElement>(".message-row") ?? null;
  }

  function finishBehaviorChange(behavior: AttentionBehavior, listFocusTarget: HTMLButtonElement | null) {
    if (!reader && !triggerRef.current?.isConnected) {
      requestAnimationFrame(() => {
        const target = listFocusTarget?.isConnected
          ? listFocusTarget
          : document.querySelector<HTMLButtonElement>(".message-row")
            ?? document.querySelector<HTMLButtonElement>('[aria-label="Inbox attention filters"] button[aria-pressed="true"]')
            ?? document.querySelector<HTMLButtonElement>('button[aria-current="page"]');
        target?.focus();
      });
      return;
    }
    closeAndRestoreFocus(behavior);
  }

  async function saveRule(behavior: AttentionViewSetting["behavior"]) {
    if (!address) return;
    setSelectedBehavior(behavior);
    const listFocusTarget = captureListFocusTarget();
    if (isDevPreviewRoute()) {
      const appliedBehavior = await onBehaviorChange(address, behavior);
      finishBehaviorChange(appliedBehavior, listFocusTarget);
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
      finishBehaviorChange(appliedBehavior, listFocusTarget);
      setStatus("idle");
    } catch (error) {
      setStatus("error");
      setErrorMessage(getErrorMessage(error));
    }
  }

  async function resetRule() {
    if (resolution?.rule?.scope !== "address") return;
    const listFocusTarget = captureListFocusTarget();
    setStatus("saving");
    setErrorMessage(null);
    try {
      const response = await fetch(`/v1/attention/rules/${resolution.rule.id}`, { method: "DELETE", credentials: "include" });
      if (!response.ok) throw new ApiRequestError(response.status, `Request failed with ${response.status} ${response.statusText}`.trim());
      setResolution(null);
      const inheritedBehavior = await onBehaviorChange(address);
      finishBehaviorChange(inheritedBehavior, listFocusTarget);
      setStatus("idle");
    } catch (error) {
      setStatus("error");
      setErrorMessage(getErrorMessage(error));
    }
  }

  return (
    <div className={`sender-attention-control${compact ? " sender-attention-control-compact" : ""}${reader ? " sender-attention-control-reader" : ""}${presence.rendered ? " sender-attention-control-expanded" : ""}${presence.closing ? " sender-attention-control-closing" : ""}`} ref={controlRef}>
      <button aria-controls={`sender-attention-${message.id}`} aria-expanded={expanded} aria-label={`Manage mail from ${senderName}`} className="sender-attention-trigger" onClick={() => expanded ? closeAndRestoreFocus() : setExpanded(true)} ref={triggerRef} type="button">
        {reader ? "Attention" : <><span aria-hidden="true">{compact ? "⌁" : "✦"}</span> {compact ? "Tune" : "Manage this sender"}</>}
      </button>
      {presence.rendered ? (
        <section className={`sender-attention-menu${presence.closing ? " sender-attention-menu-closing" : ""}`} id={`sender-attention-${message.id}`} ref={menuRef} role="group" aria-label={`Mail handling for ${senderName}`}>
          <div className="sender-attention-heading">
            <p className="sender-attention-kicker">All mail from <strong>{senderName}</strong></p>
            <button aria-label="Close sender controls" className="sender-attention-close" onClick={() => closeAndRestoreFocus()} type="button">×</button>
          </div>
          {status === "loading" ? <p>Loading…</p> : null}
          {status !== "loading" ? <>
            <div aria-label="Destination for all sender mail" className="sender-attention-choices" role="group">
              {!compact ? <><span className="sender-attention-choice-label">Send to</span><p className="sender-attention-explainer">This is your attention choice. Human signal only describes whether a message seems person-written; it never decides this destination.</p></> : null}
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

function OrganizationSidebar({
  activeCollectionId,
  collections,
  currentView,
  error,
  onCreateCollection,
  onColorCollection,
  onDeleteCollection,
  onDeletePin,
  onMoveCollection,
  onMovePin,
  onPinView,
  onRenameCollection,
  onSelectCollection,
  onSelectPin,
  pins,
}: {
  activeCollectionId: string | null;
  collections: Collection[];
  currentView: MailboxItem;
  error: string | null;
  onCreateCollection: (name: string) => Promise<Collection | null>;
  onColorCollection: (collection: Collection, color: string) => void;
  onDeleteCollection: (collection: Collection) => Promise<void>;
  onDeletePin: (pin: Pin) => Promise<void>;
  onMoveCollection: (collection: Collection, direction: -1 | 1) => void;
  onMovePin: (pin: Pin, direction: -1 | 1) => void;
  onPinView: () => void;
  onRenameCollection: (collection: Collection, name: string) => void;
  onSelectCollection: (id: string) => void;
  onSelectPin: (pin: Pin) => void;
  pins: Pin[];
}) {
  const [addingCollection, setAddingCollection] = useState(false);
  const collectionPresence = useExitPresence(addingCollection);
  const [collectionName, setCollectionName] = useState("");

  useEffect(() => {
    const closeMenus = (event: PointerEvent) => {
      if ((event.target as HTMLElement).closest(".keep-row-menu")) return;
      document.querySelectorAll<HTMLDetailsElement>(".keep-row-menu[open]").forEach((menu) => { menu.open = false; });
    };
    document.addEventListener("pointerdown", closeMenus);
    return () => document.removeEventListener("pointerdown", closeMenus);
  }, []);

  async function submitCollection(event: React.FormEvent) {
    event.preventDefault();
    if (!collectionName.trim()) return;
    await onCreateCollection(collectionName);
    setCollectionName("");
    setAddingCollection(false);
  }

  return (
    <section className="keep-zone" aria-labelledby="keep-zone-title">
      <header className="keep-zone-heading">
        <div><span aria-hidden="true">◇</span><h2 id="keep-zone-title">Keep</h2></div>
        <small>Optional</small>
      </header>
      <p className="keep-zone-note">A personal layer. Nothing moves out of your inbox.</p>

      <div className="keep-group">
        <div className="keep-group-heading">
          <h3>Pins</h3>
          <button className="keep-group-action" disabled={pins.some((pin) => pin.kind === "view" && pin.targetId === currentView.id)} onClick={onPinView} type="button"><span aria-hidden="true">＋</span>{pins.some((pin) => pin.kind === "view" && pin.targetId === currentView.id) ? "View pinned" : `Pin ${currentView.label}`}</button>
        </div>
        {pins.length ? (
          <div className="keep-list">
            {pins.map((pin, index) => (
              <div className="keep-row" key={pin.id}>
                <button className="keep-row-main" onClick={() => onSelectPin(pin)} type="button">
                  <span className={`pin-kind pin-kind-${pin.kind}`} aria-hidden="true">{pin.kind === "sender" ? "@" : pin.kind === "thread" ? "↗" : "◫"}</span>
                  <span><strong>{pin.label}</strong><small>{pin.kind}</small></span>
                </button>
                <details className="keep-row-menu">
                  <summary aria-label={`Options for ${pin.label}`}>•••</summary>
                  <div onClick={(event) => { const menu = event.currentTarget.closest("details"); if (menu) menu.open = false; }}>
                    <button disabled={index === 0} onClick={() => onMovePin(pin, -1)} type="button">↑ Move up</button>
                    <button disabled={index === pins.length - 1} onClick={() => onMovePin(pin, 1)} type="button">↓ Move down</button>
                    <button className="keep-menu-danger" onClick={() => void onDeletePin(pin)} type="button">× Remove pin</button>
                  </div>
                </details>
              </div>
            ))}
          </div>
        ) : <p className="keep-empty">Pin a view, person, or conversation for quick return.</p>}
      </div>

      <div className="keep-group collection-group">
        <div className="keep-group-heading">
          <h3>Collections</h3>
          <button aria-expanded={addingCollection} className="keep-group-action" onClick={() => setAddingCollection((current) => !current)} type="button"><span aria-hidden="true">＋</span>New collection</button>
        </div>
        {collectionPresence.rendered ? (
          <form className={`collection-create${collectionPresence.closing ? " collection-create-closing" : ""}`} onSubmit={submitCollection}>
            <input aria-label="Collection name" autoFocus maxLength={80} onChange={(event) => setCollectionName(event.target.value)} placeholder="Name this collection" value={collectionName} />
            <button disabled={!collectionName.trim()} type="submit">Add</button>
          </form>
        ) : null}
        {collections.length ? (
          <div className="keep-list">
            {collections.map((collection, index) => (
              <div className={`keep-row collection-row${activeCollectionId === collection.id ? " collection-row-active" : ""}`} key={collection.id}>
                <button aria-current={activeCollectionId === collection.id ? "page" : undefined} className="keep-row-main" onClick={() => onSelectCollection(collection.id)} type="button">
                  <span className="collection-mark" aria-hidden="true" style={{ "--collection-color": collection.color } as CSSProperties} />
                  <span><strong>{collection.name}</strong><small>{collection.threadIds.length} {collection.threadIds.length === 1 ? "thread" : "threads"}</small></span>
                </button>
                <details className="keep-row-menu">
                  <summary aria-label={`Options for ${collection.name}`}>•••</summary>
                  <div onClick={(event) => { const menu = event.currentTarget.closest("details"); if (menu) menu.open = false; }}>
                    <button disabled={index === 0} onClick={() => onMoveCollection(collection, -1)} type="button">↑ Move up</button>
                    <button disabled={index === collections.length - 1} onClick={() => onMoveCollection(collection, 1)} type="button">↓ Move down</button>
                    <button onClick={() => {
                      const nextName = window.prompt("Rename collection", collection.name);
                      if (nextName?.trim() && nextName.trim() !== collection.name) onRenameCollection(collection, nextName.trim());
                    }} type="button">✎ Rename</button>
                    <div aria-label={`Color for ${collection.name}`} className="collection-color-picker" role="group">
                      <span>Color</span>
                      <div>
                        {collectionColors.map((color) => (
                          <button
                            aria-label={`${color.name}${collection.color === color.value ? ", selected" : ""}`}
                            aria-pressed={collection.color === color.value}
                            className="collection-color-swatch"
                            key={color.value}
                            onClick={() => onColorCollection(collection, color.value)}
                            style={{ "--swatch-color": color.value } as CSSProperties}
                            title={color.name}
                            type="button"
                          />
                        ))}
                      </div>
                    </div>
                    <button className="keep-menu-danger" onClick={() => {
                      if (window.confirm(`Delete “${collection.name}”? Messages and Gmail labels will stay untouched.`)) void onDeleteCollection(collection);
                    }} type="button">× Delete</button>
                  </div>
                </details>
              </div>
            ))}
          </div>
        ) : <p className="keep-empty">Create a collection when a project deserves its own record.</p>}
      </div>
      {error ? <p className="keep-error" role="alert">{error}</p> : null}
    </section>
  );
}

function ThreadOrganizer({ closing, collections, message, onClose, onCreateCollection, onPin, onToggleCollection, pins }: {
  closing: boolean;
  collections: Collection[];
  message: InboxMessage;
  onClose: () => void;
  onCreateCollection: (name: string) => Promise<void>;
  onPin: (input: Pick<Pin, "kind" | "targetId" | "label">) => void;
  onToggleCollection: (collection: Collection) => void;
  pins: Pin[];
}) {
  const [name, setName] = useState("");
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  const senderPinned = pins.some((pin) => pin.kind === "sender" && pin.targetId === message.from.email);
  const threadPinned = pins.some((pin) => pin.kind === "thread" && pin.targetId === message.threadId);
  return (
    <div className={`organizer-layer${closing ? " organizer-layer-closing" : ""}`} role="presentation">
      <button aria-label="Close organizer" className="organizer-backdrop" onClick={onClose} type="button" />
      <section aria-labelledby="organizer-title" aria-modal="true" className={`thread-organizer${closing ? " thread-organizer-closing" : ""}`} role="dialog">
        <header>
          <div><p>Keep, don’t move</p><h2 id="organizer-title">Save this thread</h2></div>
          <button aria-label="Close organizer" autoFocus onClick={onClose} type="button">×</button>
        </header>
        <div className="organizer-thread-preview"><span>Conversation</span><strong>{message.subject || "(no subject)"}</strong><small>{message.from.name ?? message.from.email}</small></div>
        <div className="organizer-pin-grid">
          <button aria-pressed={senderPinned} disabled={senderPinned} onClick={() => onPin({ kind: "sender", targetId: message.from.email, label: message.from.name ?? message.from.email })} type="button"><span>@</span><strong>{senderPinned ? "Person pinned" : "Pin person"}</strong><small>{message.from.email}</small></button>
          <button aria-pressed={threadPinned} disabled={threadPinned} onClick={() => onPin({ kind: "thread", targetId: message.threadId, label: message.subject || "(no subject)" })} type="button"><span>↗</span><strong>{threadPinned ? "Thread pinned" : "Pin thread"}</strong><small>Return straight here</small></button>
        </div>
        <div className="organizer-collections">
          <h3>Add to collections</h3>
          {collections.map((collection) => {
            const included = collection.threadIds.includes(message.threadId);
            return <button aria-pressed={included} className={included ? "organizer-collection-active" : ""} key={collection.id} onClick={() => onToggleCollection(collection)} type="button"><span className="collection-mark" style={{ "--collection-color": collection.color } as CSSProperties} /><strong>{collection.name}</strong><small>{included ? "Added" : `${collection.threadIds.length} threads`}</small><span aria-hidden="true">{included ? "✓" : "＋"}</span></button>;
          })}
          <form onSubmit={(event) => { event.preventDefault(); if (name.trim()) void onCreateCollection(name).then(() => setName("")); }}>
            <input aria-label="New collection name" maxLength={80} onChange={(event) => setName(event.target.value)} placeholder="Create a new collection" value={name} />
            <button disabled={!name.trim()} type="submit">Create</button>
          </form>
        </div>
        <footer>Threads can live in several collections. Attention placement never changes.</footer>
      </section>
    </div>
  );
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

async function fetchNoContent(input: string, init: RequestInit, _acceptsJson = false) {
  const response = await fetch(input, { ...init, credentials: "include" });
  if (!response.ok) throw new ApiRequestError(response.status, `Request failed with ${response.status} ${response.statusText}`.trim());
}

function reorderItems<T extends { id: string; position: number }>(items: T[], id: string, requestedPosition?: number) {
  if (requestedPosition === undefined) return items;
  const currentIndex = items.findIndex((item) => item.id === id);
  if (currentIndex < 0) return items;
  const next = [...items];
  const [item] = next.splice(currentIndex, 1);
  next.splice(Math.max(0, Math.min(requestedPosition, next.length)), 0, item);
  return next.map((entry, position) => ({ ...entry, position }));
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

function isLoginRoute() {
  if (typeof window === "undefined") {
    return false;
  }
  return window.location.pathname === "/login";
}

function isOnboardingRoute() {
  return typeof window !== "undefined" && window.location.pathname === "/onboarding";
}

function isGmailLabelMigrationRoute() {
  return typeof window !== "undefined" && window.location.pathname === "/settings/integrations/gmail/labels";
}

function isGmailSettingsRoute() {
  return typeof window !== "undefined" && window.location.pathname === "/settings/integrations/gmail";
}

function isAttentionSettingsRoute() {
  return typeof window !== "undefined" && window.location.pathname === "/settings/attention-views";
}

function isReaderPreferencesRoute() {
  return typeof window !== "undefined" && window.location.pathname === "/settings/reading";
}

function isSettingsRoute() { return typeof window !== "undefined" && window.location.pathname === "/settings"; }
function isSettingsDevPreviewRoute() { return typeof window !== "undefined" && import.meta.env.DEV && window.location.pathname === "/dev/settings"; }

export function isDevPreviewPath(pathname: string, isDevelopment: boolean, isDemoBuild = false) {
  return (isDevelopment && pathname === "/dev/inbox")
    || (isDemoBuild && (pathname === "/" || pathname === "/dev/inbox"));
}

function isDevPreviewRoute() {
  return typeof window !== "undefined"
    && isDevPreviewPath(window.location.pathname, import.meta.env.DEV, import.meta.env.VITE_ORCA_DEMO === "true");
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
      intent: params.get("intent"),
    };
  }

  if (status === "error") {
    return {
      kind: "error",
      reason: params.get("reason"),
      message: params.get("message"),
      intent: params.get("intent"),
    };
  }

  return null;
}

export function readStoredPreferences(storage?: Pick<Storage, "getItem">): ReaderPreferences {
  const source = storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
  if (!source) return defaultReaderPreferences;
  try {
    const stored = source.getItem("orca-reader-preferences");
    if (stored) {
      const value = JSON.parse(stored) as Partial<ReaderPreferences>;
      return {
        theme: ["system", "light", "dark"].includes(value.theme ?? "") ? value.theme! : "system",
        textSize: ["standard", "large"].includes(value.textSize ?? "") ? value.textSize! : "standard",
        density: ["calm", "compact"].includes(value.density ?? "") ? value.density! : defaultReaderPreferences.density,
        motion: ["system", "reduced", "full"].includes(value.motion ?? "") ? value.motion! : "system",
        notifyByDefault: value.notifyByDefault === true,
      };
    }
    const legacyTheme = source.getItem("orca-theme");
    return legacyTheme === "light" || legacyTheme === "dark" ? { ...defaultReaderPreferences, theme: legacyTheme } : defaultReaderPreferences;
  } catch {
    return defaultReaderPreferences;
  }
}

function getSystemTheme(): Theme {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
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

function formatThreadParticipants(participants: MailContact[], accountEmail: string) {
  const names = [...new Map(
    participants
      .filter((participant) => participant.email.toLowerCase() !== accountEmail.toLowerCase())
      .map((participant) => [participant.email.toLowerCase(), participant.name ?? participant.email]),
  ).values()];
  if (!names.length) return "yourself";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
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
  const demoMessagesForThread = threadId === "thread_1"
    ? [...messages, ...demoThreadHistoryExtras].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))
    : messages;
  const latest = demoMessagesForThread[demoMessagesForThread.length - 1];
  const recipients = [{ name: account.displayName, email: account.email }];
  return {
    account,
    thread: {
      id: threadId,
      provider: "gmail",
      providerThreadId: threadId,
      subject: latest?.subject.replace(/^Re:\s*/i, "") ?? "",
      latestReceivedAt: latest?.receivedAt ?? new Date(0).toISOString(),
      messageCount: demoMessagesForThread.length,
      labels: [...new Set(demoMessagesForThread.flatMap((message) => message.labels))],
      participants: [...demoMessagesForThread.map((message) => message.from), ...recipients],
      readState: demoMessagesForThread.some((message) => message.unread) ? "unread" : "read",
      attention: { hasUnread: demoMessagesForThread.some((message) => message.unread), hasStarred: false, hasDraft: false, humanSignal: 100 },
    },
    messages: demoMessagesForThread.map((message) => ({
      ...message,
      to: message.labels.includes("SENT") ? [{ name: "Maya Chen", email: "maya@example.com" }] : recipients,
      cc: [],
      bcc: [],
      bodyText: (messageBodies[message.id] ?? message.snippet) || null,
      bodyHtml: messageHtmlBodies[message.id] ?? null,
      internetMessageId: `<${message.providerMessageId}@mail.gmail.com>`,
      references: [],
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
