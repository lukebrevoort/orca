import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type MouseEvent,
  type ReactNode,
  type Ref,
  type SetStateAction,
} from "react";
import type { AttentionViewSetting, Collection, DeliveryResult, GmailLabelMigration, HumanClassification, InboxClassificationResponse, InboxMessage, MailAccount, MailContact, Pin, PinFilter, PinIcon, Reminder, ResolvedSenderAttention, SyncStatus, ThreadDetail, ThreadDetailMessage, UserPreferences } from "@orca/shared";
import { attentionViewSettingSchema, authSessionSchema, collectionSchema, gmailLabelMigrationSchema, humanClassificationOverrideSchema, inboxClassificationResponseSchema, mailAccountPageSchema, meResponseSchema, pinFilterSchema, pinSchema, reminderSchema, reminderViewSettingsSchema, resolvedSenderAttentionSchema, syncStatusSchema, threadDetailSchema, userPreferencesSchema } from "@orca/shared";
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
import { ClassificationBadge, ClassificationCorrection, ClassificationTabs, classificationViewItems, classificationViewLabel, type ClassificationCorrectionTarget, type ClassificationCounts, type ClassificationView } from "./classification-ui";

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
type PinMailbox = PinFilter["mailbox"];

const pinMailboxOptions: Array<{ id: PinMailbox; label: string }> = [
  { id: "inbox", label: "Inbox" },
  { id: "focus", label: "Focus" },
  { id: "quiet", label: "Quiet" },
  { id: "hidden", label: "Hidden" },
  { id: "all", label: "All mail" },
];

const pinAttentionOptions: Array<{ id: InboxFilter; label: string }> = [
  { id: "all", label: "Everything" },
  { id: "notify", label: "Notify me" },
  { id: "focus", label: "Keep in focus" },
  { id: "normal", label: "Flow" },
];

const pinIconOptions: Array<{ id: PinIcon; label: string; glyph: string }> = [
  { id: "person", label: "Person", glyph: "@" },
  { id: "thread", label: "Thread", glyph: "↗" },
  { id: "search", label: "Search", glyph: "⌕" },
  { id: "grid", label: "View", glyph: "◫" },
  { id: "star", label: "Star", glyph: "★" },
  { id: "bolt", label: "Bolt", glyph: "ϟ" },
  { id: "heart", label: "Heart", glyph: "♥" },
  { id: "bookmark", label: "Bookmark", glyph: "▮" },
];

const pinColorOptions = [
  { name: "Moss", value: "#70867d" },
  { name: "Clay", value: "#a87360" },
  { name: "Harbor", value: "#6c8195" },
  { name: "Plum", value: "#83728d" },
  { name: "Ochre", value: "#a18757" },
  { name: "Berry", value: "#9b6e83" },
] as const;

type PinInput = Pick<Pin, "kind" | "targetId" | "label"> & Partial<Pick<Pin, "icon" | "color">>;

type MailboxItem = {
  id: Mailbox;
  label: string;
  description: string;
};

type PersonItem = {
  initials: string;
  name: string;
  filterValue: string;
  context: string;
  unread?: boolean;
};

type PanelMode = "compose" | null;
type AttentionBehavior = AttentionViewSetting["behavior"];
type SenderAttentionTarget = Pick<InboxMessage, "id" | "from">;
type ClassificationMessage = Pick<InboxMessage, "id" | "accountId" | "from" | "humanClassification" | "humanSignal">;
type ClassificationOverride = NonNullable<NonNullable<InboxMessage["humanClassification"]>["userOverride"]>;
type OAuthProvider = "gmail" | "outlook";
type OAuthConnectStatus = "idle" | "loading" | "error";
type OAuthReturnStatus =
  | { provider: OAuthProvider; kind: "success"; email: string | null; intent: string | null }
  | { provider: OAuthProvider; kind: "error"; reason: string | null; message: string | null; intent: string | null }
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

function classificationMatchesView(message: Pick<InboxMessage, "humanClassification">, view: ClassificationView) {
  if (view === "all") return true;
  const classification = message.humanClassification?.effective.classification;
  if (view === "human") return classification === "likely_human";
  if (view === "tideline") return classification === "automated_or_bulk";
  return classification === "uncertain" || classification === "unclassified" || !classification;
}

function getClassificationCounts(source: InboxMessage[]): ClassificationCounts {
  return {
    likely_human: source.filter((message) => message.humanClassification?.effective.classification === "likely_human").length,
    automated_or_bulk: source.filter((message) => message.humanClassification?.effective.classification === "automated_or_bulk").length,
    uncertain: source.filter((message) => message.humanClassification?.effective.classification === "uncertain" || message.humanClassification?.effective.classification === "unclassified" || !message.humanClassification).length,
    unclassified: source.filter((message) => message.humanClassification?.effective.classification === "unclassified" || !message.humanClassification).length,
    all: source.length,
  };
}

const demoClassificationCounts = getClassificationCounts(demoMessages);

function demoMessagesForClassification(view: ClassificationView, source = demoMessages) {
  return source.filter((message) => classificationMatchesView(message, view));
}

const collectionColors = [
  { name: "Moss", value: "#70867d" },
  { name: "Clay", value: "#a87360" },
  { name: "Harbor", value: "#6c8195" },
  { name: "Plum", value: "#83728d" },
  { name: "Ochre", value: "#a18757" },
  { name: "Stone", value: "#6d716f" },
] as const;

const demoPins: Pin[] = [
  { id: "pin_demo_sender", accountId: demoAccount.id, kind: "sender", targetId: "maya@example.com", label: "Maya Chen", icon: "person", color: "#70867d", position: 0, createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z" },
  { id: "pin_demo_mom", accountId: demoAccount.id, kind: "sender", targetId: "family@example.com", label: "Mom", icon: "person", color: "#a87360", position: 1, createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z" },
  { id: "pin_demo_anika", accountId: demoAccount.id, kind: "sender", targetId: "anika@example.com", label: "Anika Lee", icon: "person", color: "#6c8195", position: 2, createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z" },
  { id: "pin_demo_dana", accountId: demoAccount.id, kind: "sender", targetId: "dana@example.com", label: "Dana Brooks", icon: "person", color: "#83728d", position: 3, createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z" },
  { id: "pin_demo_thread", accountId: demoAccount.id, kind: "thread", targetId: "thread_3", label: "Dinner on Sunday?", icon: "thread", color: "#a18757", position: 4, createdAt: "2026-07-02T00:00:00.000Z", updatedAt: "2026-07-02T00:00:00.000Z" },
];

const demoReminders: Reminder[] = [
  { id: "reminder_demo_dana", accountId: demoAccount.id, threadId: "thread_5", scheduledFor: "2026-07-09T16:00:00.000Z", timezone: "America/Los_Angeles", notify: true, status: "scheduled", resurfacedAt: null, completedAt: null, cancelledAt: null, createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z" },
  { id: "reminder_demo_anika", accountId: demoAccount.id, threadId: "thread_4", scheduledFor: "2026-07-10T15:30:00.000Z", timezone: "America/Los_Angeles", notify: false, status: "scheduled", resurfacedAt: null, completedAt: null, cancelledAt: null, createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z" },
  { id: "reminder_demo_harbor", accountId: demoAccount.id, threadId: "thread_2", scheduledFor: "2026-07-11T16:00:00.000Z", timezone: "America/Los_Angeles", notify: false, status: "scheduled", resurfacedAt: null, completedAt: null, cancelledAt: null, createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z" },
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
  const onboardingPreview = isOnboardingDevPreviewRoute();

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
    if (isLoginRoute() || isReaderPreferencesRoute() || isSettingsDevPreviewRoute() || onboardingPreview || devPreview) return;
    const abortController = new AbortController();
    fetch("/v1/auth/session", { credentials: "include", signal: abortController.signal })
      .then(async (response) => {
        if (!response.ok) {
          setAccess("signedout");
          return;
        }
        const session = authSessionSchema.parse(await response.json());
        setAccess("authenticated");
        if (isOnboardingRoute() && session.onboardingCompletedAt) {
          window.location.replace("/");
        }
      })
      .catch(() => {
        if (!abortController.signal.aborted) setAccess("signedout");
      });
    return () => abortController.abort();
  }, [devPreview]);

  if (isSettingsDevPreviewRoute()) {
    return <SettingsHome preferences={preferences} setPreferences={setPreferences} systemTheme={systemTheme} theme={theme} setTheme={setTheme} demoMode />;
  }
  if (onboardingPreview) {
    return <WelcomeOrientationPage theme={theme} setTheme={setTheme} />;
  }
  if (devPreview) {
    return <InboxApp demoMode preferences={preferences} theme={theme} setTheme={setTheme} />;
  }

  if (isLoginRoute()) {
    return <OAuthLoginPage />;
  }

  if (isReaderPreferencesRoute()) {
    return <ReaderPreferencesPage preferences={preferences} setPreferences={setPreferences} systemTheme={systemTheme} />;
  }

  if (isSettingsRoute()) {
    return <SettingsHome preferences={preferences} setPreferences={setPreferences} systemTheme={systemTheme} theme={theme} setTheme={setTheme} />;
  }

  if (access === "checking") return <SessionCheckingScreen />;
  if (access === "signedout") return isOnboardingRoute() ? <OAuthLoginPage /> : <LoginRequiredScreen />;

  if (isOnboardingRoute()) {
    return <WelcomeOrientationPage onComplete={completeOnboarding} theme={theme} setTheme={setTheme} />;
  }

  if (isGmailLabelMigrationRoute()) {
    return <GmailLabelMigrationPage theme={theme} setTheme={setTheme} />;
  }

  if (isGmailSettingsRoute()) {
    return <GmailConnectionSettingsPage theme={theme} setTheme={setTheme} />;
  }

  if (isAttentionSettingsRoute()) {
    return <AttentionViewSettingsPage onSessionExpired={() => setAccess("signedout")} theme={theme} setTheme={setTheme} />;
  }

  return <InboxApp preferences={preferences} theme={theme} setTheme={setTheme} />;

  async function completeOnboarding() {
    const response = await fetch("/v1/auth/onboarding/complete", {
      method: "POST",
      credentials: "include",
    });
    if (!response.ok) {
      const body = await readJsonObject(response);
      throw new Error(getStringField(body, "message") ?? `Could not finish onboarding (${response.status})`);
    }
    window.location.replace("/");
  }
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
  const [connectedAccounts, setConnectedAccounts] = useState<MailAccount[]>(demoMode ? [demoAccount] : []);
  const [connectedAccountsStatus, setConnectedAccountsStatus] = useState<"loading" | "ready" | "error">(demoMode ? "ready" : "loading");
  const [connectedAccountsError, setConnectedAccountsError] = useState<string | null>(null);
  const [outlookAuthorizationStatus, setOutlookAuthorizationStatus] = useState<OAuthConnectStatus>("idle");
  const [outlookAuthorizationError, setOutlookAuthorizationError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const returnStatus = readOAuthReturnStatus();

  useEffect(() => { titleRef.current?.focus(); }, []);
  useEffect(() => {
    if (demoMode) return;
    const controller = new AbortController();
    fetchJson("/v1/preferences", userPreferencesSchema, controller.signal)
      .then((value) => { if (!controller.signal.aborted) { setAccountPreferences(value); setAccountStatus("ready"); } })
      .catch((error) => { if (!controller.signal.aborted) { setAccountStatus("error"); setAccountError(getErrorMessage(error)); } });
    return () => controller.abort();
  }, [demoMode]);
  useEffect(() => {
    if (demoMode) {
      setConnectedAccounts([demoAccount]);
      setConnectedAccountsStatus("ready");
      setConnectedAccountsError(null);
      return;
    }
    const controller = new AbortController();
    fetchJson("/v1/accounts", mailAccountPageSchema, controller.signal)
      .then((value) => { if (!controller.signal.aborted) { setConnectedAccounts(value.items); setConnectedAccountsStatus("ready"); } })
      .catch((error) => { if (!controller.signal.aborted) { setConnectedAccountsStatus("error"); setConnectedAccountsError(getErrorMessage(error)); } });
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
  const outlookReturnTo = typeof window === "undefined" ? "/settings" : `${window.location.origin}/settings`;
  function connectOutlook() {
    void beginProviderAuthorization("outlook", "connect", outlookReturnTo, setOutlookAuthorizationStatus, setOutlookAuthorizationError);
  }

  return <main className="settings-home-page">
    <header className="attention-settings-topbar"><a className="settings-brand" href="/"><span aria-hidden="true"><WaveGlyph /></span> Orca</a><div className="settings-topbar-actions"><a className="settings-back-link" href="/">← Inbox</a><button aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"} className="theme-toggle" onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")} type="button">{theme === "dark" ? "☾" : "☀"}</button></div></header>
    <div className="settings-home-layout">
      <aside className="settings-home-nav" aria-label="Settings sections"><p className="settings-eyebrow">Your workspace</p><a href="#account">Account</a><a href="#appearance">Appearance & reading</a><a href="#attention">Inbox & attention</a><a href="#writing">Writing</a><a href="#notifications">Notifications</a><a href="#connected">Connected accounts</a><a href="#privacy">Privacy & data</a></aside>
      <section className="settings-home-content" aria-labelledby="settings-title">
        <header className="settings-home-intro"><p className="settings-eyebrow">Settings</p><h1 id="settings-title" ref={titleRef} tabIndex={-1}>Make Orca<br /><em>yours.</em></h1><p>One calm place for the choices that shape how you read, write, and connect. Changes say whether they follow your account or only this device.</p></header>
        {returnStatus ? <OAuthReturnNotice status={returnStatus} /> : null}
        <SettingsSection id="account" title="Account" note="Account-level"><div className="settings-detail"><strong>Signed-in Orca account</strong><span>Your identity is managed through your connected mail provider.</span></div><a className="settings-row-link" href="#connected">Review connected accounts →</a></SettingsSection>
        <SettingsSection id="appearance" title="Appearance & reading" note="This device"><PreferenceChoice label="Appearance" hint={`System is currently ${systemTheme}.`} name="settings-theme" value={preferences.theme} onChange={(value) => updateReader("theme", value as ReaderPreferences["theme"])} options={[{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} /><PreferenceChoice label="Reader text" hint="Changes message text, not navigation." name="settings-size" value={preferences.textSize} onChange={(value) => updateReader("textSize", value as ReaderPreferences["textSize"])} options={[{ value: "standard", label: "Standard" }, { value: "large", label: "Large" }]} /><PreferenceChoice label="Inbox & conversation spacing" hint="Compact fits more mail and thread history on screen." name="settings-density" value={preferences.density} onChange={(value) => updateReader("density", value as ReaderPreferences["density"])} options={[{ value: "calm", label: "Calm" }, { value: "compact", label: "Compact" }]} /><PreferenceChoice label="Motion" hint="System follows your operating system preference." name="settings-motion" value={preferences.motion} onChange={(value) => updateReader("motion", value as ReaderPreferences["motion"])} options={[{ value: "system", label: "System" }, { value: "reduced", label: "Reduced" }, { value: "full", label: "Full" }]} /></SettingsSection>
        <SettingsSection id="attention" title="Inbox & attention" note="Account-level"><p className="settings-section-copy">Tune the names, colors, and order of the views that help you decide what deserves attention.</p><a className="settings-row-link" href="/settings/attention-views">Manage Attention Views →</a></SettingsSection>
        <SettingsSection id="writing" title="Writing" note="Account-level"><label className="settings-field"><span>Default signature</span><textarea disabled={accountStatus === "loading" || accountStatus === "saving"} maxLength={10_000} onChange={(event) => updateAccount("signature", event.target.value)} placeholder="A thoughtful sign-off, if you use one." value={accountPreferences.signature} /></label><PreferenceChoice label="Compose format" hint="A starting point; you can still format each message." name="compose-format" value={accountPreferences.composeFormat} onChange={(value) => updateAccount("composeFormat", value as UserPreferences["composeFormat"])} options={[{ value: "plain", label: "Plain text" }, { value: "rich", label: "Rich text" }]} /><PreferenceChoice label="Reply behavior" hint="The default action when you choose Reply." name="reply-behavior" value={accountPreferences.replyBehavior} onChange={(value) => updateAccount("replyBehavior", value as UserPreferences["replyBehavior"])} options={[{ value: "reply", label: "Reply" }, { value: "reply_all", label: "Reply all" }]} /></SettingsSection>
        <SettingsSection id="notifications" title="Notifications & reminders" note="Account-level"><label className="preference-switch"><input checked={accountPreferences.notifyByDefault} disabled={accountStatus === "loading" || accountStatus === "saving"} onChange={(event) => updateAccount("notifyByDefault", event.target.checked)} type="checkbox" /><span><strong>Notify me for new reminders</strong><small>Orca will ask your browser for permission only when it needs to show a reminder.</small></span></label><p className="settings-capability">Browser notification capability: {typeof Notification === "undefined" ? "Unavailable in this browser" : Notification.permission === "granted" ? "Allowed" : Notification.permission === "denied" ? "Blocked by browser or OS" : "Not requested"}.</p></SettingsSection>
        <SettingsSection id="connected" title="Connected accounts" note="Provider access">
          <p className="settings-section-copy">Gmail and Microsoft Outlook can live in the same Orca workspace. Each account stays separately permissioned and appears in the unified inbox when its sync is ready.</p>
          <div aria-live="polite" className="settings-account-list">
            {connectedAccountsStatus === "loading" ? <p className="settings-account-status">Checking connected accounts…</p> : null}
            {connectedAccountsStatus === "error" ? <p className="settings-account-status settings-account-status-error" role="alert">Could not load connected accounts. {connectedAccountsError}</p> : null}
            {connectedAccountsStatus === "ready" && connectedAccounts.length === 0 ? <p className="settings-account-status">No mail provider is connected yet.</p> : null}
            {connectedAccountsStatus === "ready" ? connectedAccounts.map((account) => <div className="settings-account-row" key={account.id}>
              <div><span className="settings-account-provider">{mailProviderLabel(account.provider)}</span><strong>{account.email}</strong></div>
              <span className="settings-account-capability">{account.capabilities.read ? "Read-only" : "Needs attention"}</span>
            </div>) : null}
          </div>
          <div className="settings-outlook-connect">
            <div><strong>Add Microsoft Outlook</strong><span>Read-only Mail.Read access. Outlook mail will appear after the Outlook sync step is enabled.</span></div>
            <button className="settings-outlook-button" disabled={outlookAuthorizationStatus === "loading"} onClick={connectOutlook} type="button">{outlookAuthorizationStatus === "loading" ? "Opening Outlook…" : "Connect Outlook"}</button>
          </div>
          {outlookAuthorizationError ? <p className="settings-outlook-error" role="alert">{outlookAuthorizationError}</p> : null}
          <a className="settings-row-link" href="/settings/integrations/gmail">Gmail connection & permissions →</a>
          <a className="settings-row-link" href="/settings/integrations/gmail/labels">Import Gmail labels →</a>
        </SettingsSection>
        <SettingsSection id="privacy" title="Privacy & data" note="Clear boundaries"><p className="settings-section-copy">Orca stores normalized mail locally and only requests the read-first permissions shown in Connected accounts. Signing out ends this browser session; revoking access in Google or Microsoft prevents future sync and delivery.</p><a className="settings-row-link" href="https://myaccount.google.com/permissions">Manage Google provider access →</a><a className="settings-row-link" href="https://myaccount.microsoft.com/organizations">Manage Microsoft provider access →</a></SettingsSection>
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
        <a className="settings-brand" href="/"><span aria-hidden="true"><WaveGlyph /></span> Orca</a>
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
        if (isSessionUnauthorizedError(error)) {
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
      if (isSessionUnauthorizedError(error)) {
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
      if (isSessionUnauthorizedError(error)) {
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
        <a className="settings-brand" href="/"><span aria-hidden="true"><WaveGlyph /></span> Orca</a>
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
  const [messages, setMessages] = useState<InboxMessage[]>(demoMode ? demoMessagesForClassification("human") : []);
  const [allMailMessages, setAllMailMessages] = useState<InboxMessage[]>(demoMode ? demoMessages : []);
  const [classificationView, setClassificationView] = useState<ClassificationView>("human");
  const [classificationCounts, setClassificationCounts] = useState<ClassificationCounts>(demoClassificationCounts);
  const [classificationCursor, setClassificationCursor] = useState<string | null>(null);
  const [allMailCursor, setAllMailCursor] = useState<string | null>(null);
  const [classificationLoading, setClassificationLoading] = useState(false);
  const [classificationError, setClassificationError] = useState<string | null>(null);
  const [classificationActionError, setClassificationActionError] = useState<string | null>(null);
  const [classificationActionMessage, setClassificationActionMessage] = useState<string | null>(null);
  const [isLoadingMoreMessages, setIsLoadingMoreMessages] = useState(false);
  const [status, setStatus] = useState<"loading" | "syncing" | "ready" | "error" | "signedout">(demoMode ? "ready" : "loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [attentionByAddress, setAttentionByAddress] = useState<Record<string, AttentionBehavior>>({});
  const [collections, setCollections] = useState<Collection[]>(demoMode ? demoCollections : []);
  const [pins, setPins] = useState<Pin[]>(demoMode ? demoPins : []);
  const [reminders, setReminders] = useState<Reminder[]>(demoMode ? demoReminders : []);
  const [laterLabel, setLaterLabel] = useState("Later");
  const [organizationError, setOrganizationError] = useState<string | null>(null);
  const [organizationOpen, setOrganizationOpen] = useState(false);
  const [activeCollectionId, setActiveCollectionId] = useState<string | null>(null);
  const [organizerMessage, setOrganizerMessage] = useState<InboxMessage | null>(null);
  const [organizerClosing, setOrganizerClosing] = useState(false);
  const [activeMailbox, setActiveMailbox] = useState<Mailbox>("inbox");
  const [inboxFilter, setInboxFilter] = useState<InboxFilter>("all");
  const [refreshKey, setRefreshKey] = useState(0);
  const [personFilter, setPersonFilter] = useState<string | null>(null);
  const [streamQuery, setStreamQuery] = useState("");
  const [panelMode, setPanelMode] = useState<PanelMode>(() => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("compose") === "1" ? "compose" : null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(() => typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("thread"));
  const [selectedThreadAccountId, setSelectedThreadAccountId] = useState<string | null>(null);
  const [threadDetail, setThreadDetail] = useState<ThreadDetail | null>(null);
  const [readerStatus, setReaderStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [readerError, setReaderError] = useState<string | null>(null);
  const [readerRefreshKey, setReaderRefreshKey] = useState(0);
  const originMessageIdRef = useRef<string | null>(null);
  const demoDataInitializedRef = useRef(false);
  const classificationRequestRef = useRef(0);
  const classificationPageRequestRef = useRef(0);
  const allMailPageRequestRef = useRef(0);
  const classificationViewRef = useRef(classificationView);
  classificationViewRef.current = classificationView;
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
  const libraryRef = useRef<HTMLElement>(null);
  const libraryReturnFocusRef = useRef<HTMLElement | null>(null);

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
    if (!organizationOpen) return;
    if (!libraryReturnFocusRef.current) libraryReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const drawer = libraryRef.current;
    const getFocusable = () => drawer ? Array.from(drawer.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')).filter((element) => !element.hasAttribute("hidden")) : [];
    window.requestAnimationFrame(() => getFocusable()[0]?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOrganizationOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = getFocusable();
      if (!focusable.length) {
        event.preventDefault();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      const returnFocus = libraryReturnFocusRef.current;
      libraryReturnFocusRef.current = null;
      window.requestAnimationFrame(() => returnFocus?.isConnected && returnFocus.focus());
    };
  }, [organizationOpen]);

  useEffect(() => {
    const requestId = ++classificationRequestRef.current;
    classificationPageRequestRef.current += 1;
    allMailPageRequestRef.current += 1;
    setIsLoadingMoreMessages(false);
    if (demoMode) {
      setAccount(demoAccount);
      const readThreadIds = readDemoReadState();
      const readMessages = demoMessages.map((message) =>
        readThreadIds.has(message.threadId) ? { ...message, unread: false } : message,
      );
      const sourceMessages = demoDataInitializedRef.current ? allMailMessages : readMessages;
      demoDataInitializedRef.current = true;
      setAllMailMessages(sourceMessages);
      setMessages(demoMessagesForClassification(classificationView, sourceMessages));
      setClassificationCounts(getClassificationCounts(sourceMessages));
      setClassificationCursor(null);
      setAllMailCursor(null);
      setClassificationError(null);
      setClassificationLoading(false);
      setStatus("ready");
      setErrorMessage(null);
      setErrorStatus(null);
      return;
    }

    const abortController = new AbortController();

    async function loadInbox() {
      setStatus("loading");
      setMessages([]);
      setClassificationCursor(null);
      setAllMailCursor(null);
      setClassificationLoading(true);
      setErrorMessage(null);
      setErrorStatus(null);
      setClassificationError(null);

      try {
        const currentAccount = await fetchJson("/v1/me", meResponseSchema, abortController.signal);
        if (abortController.signal.aborted) return;
        setAccount(currentAccount);
        setSyncStatus(await fetchJson("/v1/sync/status", syncStatusSchema, abortController.signal));

        const inboxPath = classificationView === "all"
          ? "/v1/inbox?view=all&classification=all&limit=100"
          : `/v1/inbox?classification=${classificationView}&limit=100`;
        const allInboxPath = "/v1/inbox?view=all&classification=all&limit=100";
        const [inbox, allInbox] = await Promise.all([
          fetchJson(inboxPath, inboxClassificationResponseSchema, abortController.signal),
          allInboxPath === inboxPath ? Promise.resolve(null) : fetchJson(allInboxPath, inboxClassificationResponseSchema, abortController.signal),
        ]);
        if (abortController.signal.aborted || requestId !== classificationRequestRef.current || classificationViewRef.current !== classificationView) return;
        setAccount(inbox.accounts[0] ?? currentAccount);
        setMessages(inbox.messages);
        setAllMailMessages(mergeMessages(allInbox?.messages ?? [], inbox.messages));
        setClassificationCounts(toClassificationCounts(inbox.counts.classification));
        setClassificationCursor(inbox.nextCursor);
        setAllMailCursor(allInbox?.nextCursor ?? inbox.nextCursor);
        setClassificationLoading(false);
        setStatus("ready");

        // Cached SQLite mail is now visible. Refresh Gmail without putting the
        // network round trip on the inbox's first-render path.
        void refreshGmailInBackground();
      } catch (error) {
        if (abortController.signal.aborted || requestId !== classificationRequestRef.current || classificationViewRef.current !== classificationView) return;
        setClassificationLoading(false);
        setClassificationCursor(null);
        if (isSessionUnauthorizedError(error)) {
          setStatus("signedout");
          return;
        }
        setStatus("error");
        setErrorMessage(getErrorMessage(error));
        setErrorStatus(error instanceof ApiRequestError ? error.status : null);
        setClassificationError(getErrorMessage(error));
      }
    }

    async function refreshGmailInBackground() {
      try {
        setSyncStatus(await fetchJson("/v1/sync/status", syncStatusSchema, abortController.signal));
        await fetchJson("/v1/sync/gmail", { parse: (value: unknown) => value }, abortController.signal, { method: "POST" });
        const refreshedPath = classificationView === "all"
          ? "/v1/inbox?view=all&classification=all&limit=100"
          : `/v1/inbox?classification=${classificationView}&limit=100`;
        const refreshedAllPath = "/v1/inbox?view=all&classification=all&limit=100";
        const [nextStatus, refreshedInbox, refreshedAllInbox] = await Promise.all([
          fetchJson("/v1/sync/status", syncStatusSchema, abortController.signal),
          fetchJson(refreshedPath, inboxClassificationResponseSchema, abortController.signal),
          refreshedAllPath === refreshedPath ? Promise.resolve(null) : fetchJson(refreshedAllPath, inboxClassificationResponseSchema, abortController.signal),
        ]);
        if (abortController.signal.aborted || requestId !== classificationRequestRef.current || classificationViewRef.current !== classificationView) return;
        classificationPageRequestRef.current += 1;
        allMailPageRequestRef.current += 1;
        setIsLoadingMoreMessages(false);
        setSyncStatus(nextStatus);
        setMessages(refreshedInbox.messages);
        setAllMailMessages(mergeMessages(refreshedAllInbox?.messages ?? [], refreshedInbox.messages));
        setClassificationCounts(toClassificationCounts(refreshedInbox.counts.classification));
        setClassificationCursor(refreshedInbox.nextCursor);
        setAllMailCursor(refreshedAllInbox?.nextCursor ?? refreshedInbox.nextCursor);
        setClassificationLoading(false);
      } catch (error) {
        if (abortController.signal.aborted) return;
        if (isSessionUnauthorizedError(error)) {
          setStatus("signedout");
          return;
        }
        setErrorMessage(`Could not refresh Gmail just now. Showing your last successful sync. ${getErrorMessage(error)}`);
        setErrorStatus(error instanceof ApiRequestError ? error.status : null);
        setClassificationError(getErrorMessage(error));
        setClassificationLoading(false);
      }
    }

    void loadInbox();

    return () => {
      abortController.abort();
    };
  }, [classificationView, demoMode, refreshKey]);

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

  const isClassificationMailbox = activeMailbox === "inbox" || activeMailbox === "all";
  const mailboxMessages = useMemo(
    () => {
      const activeCollection = collections.find((collection) => collection.id === activeCollectionId);
      return activeCollection
        ? allMailMessages.filter((message) => activeCollection.threadIds.includes(message.threadId))
        : isClassificationMailbox
          ? getMessagesForMailbox(messages, activeMailbox, attentionByAddress)
          : activeMailbox === "later"
            ? allMailMessages.filter((message) => reminders.some((reminder) => reminder.threadId === message.threadId && (reminder.status === "scheduled" || reminder.status === "resurfaced")))
            : getMessagesForMailbox(allMailMessages, activeMailbox, attentionByAddress);
    },
    [activeCollectionId, activeMailbox, allMailMessages, attentionByAddress, collections, isClassificationMailbox, messages, reminders],
  );

  const visibleMessages = useMemo(() => {
    let filtered = personFilter
      ? mailboxMessages.filter((message) => messageIncludesPerson(message, personFilter))
      : mailboxMessages;
    if (!activeCollectionId && isClassificationMailbox) {
      filtered = filtered.filter((message) => classificationMatchesView(message, classificationView));
      const latestRows = new Set(getLatestThreadRows(allMailMessages).map((message) => message.id));
      filtered = filtered.filter((message) => latestRows.has(message.id));
    }
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
  }, [activeCollectionId, activeMailbox, allMailMessages, attentionByAddress, classificationView, inboxFilter, isClassificationMailbox, mailboxMessages, personFilter]);

  const readerAccountId = getSelectedThreadAccountId(allMailMessages, selectedThreadId, selectedThreadAccountId);

  const selectedThreadMessages = useMemo(() => {
    if (!selectedThreadId) {
      return [];
    }

    return allMailMessages
      .filter((message) => message.threadId === selectedThreadId && (!readerAccountId || message.accountId === readerAccountId))
      .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  }, [allMailMessages, readerAccountId, selectedThreadId]);

  const selectedThreadLatestMessage =
    selectedThreadMessages[selectedThreadMessages.length - 1] ?? null;

  useEffect(() => {
    if (!selectedThreadId || !readerAccountId || !account) {
      setThreadDetail(null);
      setReaderStatus("idle");
      return;
    }

    if (demoMode) {
      setThreadDetail(createDemoThreadDetail(account, selectedThreadId, selectedThreadMessages, allMailMessages));
      setReaderStatus("ready");
      setReaderError(null);
      return;
    }

    const controller = new AbortController();
    setThreadDetail(null);
    setReaderStatus("loading");
    setReaderError(null);
    fetchJson(buildThreadDetailRequest({ threadId: selectedThreadId, accountId: readerAccountId }), threadDetailSchema, controller.signal)
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
  }, [account, allMailMessages, demoMode, readerAccountId, readerRefreshKey, selectedThreadId, selectedThreadMessages]);

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
          : getMessagesForMailbox(allMailMessages, mailbox.id, attentionByAddress).length : undefined,
      })),
    [allMailMessages, attentionByAddress, laterLabel, reminders, status],
  );

  const activeMailboxItem = mailboxes.find((item) => item.id === activeMailbox) ?? mailboxes[0];
  const activeMailboxCursor = activeCollectionId || !isClassificationMailbox ? allMailCursor : classificationCursor;
  const composeContacts = useMemo(() => collectComposeContacts(allMailMessages, account?.email ?? ""), [account?.email, allMailMessages]);
  const activeCollection = collections.find((collection) => collection.id === activeCollectionId) ?? null;
  const pinnedPeople = useMemo(
    () => buildPinnedPeopleFromPins(pins, allMailMessages),
    [allMailMessages, pins],
  );
  const pinnedSenderAddresses = useMemo(
    () => new Set(pins.filter((pin) => pin.kind === "sender").map((pin) => pin.targetId.trim().toLowerCase())),
    [pins],
  );
  const activePin = useMemo(
    () => pins.find((pin) => (pin.kind === "sender" || pin.kind === "filter") && isTopBarPinActive(pin, {
      inboxFilter,
      personFilter,
      searchQuery: streamQuery,
      viewMode: activeCollectionId ? "collection" : activeMailbox,
    })) ?? null,
    [activeCollectionId, activeMailbox, inboxFilter, personFilter, pins, streamQuery],
  );
  const automatedMessages = useMemo(
    () => getLatestThreadRows(allMailMessages).filter(isTidelineMessage),
    [allMailMessages],
  );
  const activeMailboxLabel = activeMailboxItem.label;
  const personFilterName = personFilter
    ? pinnedPeople.find((person) => person.filterValue === personFilter)?.name
      ?? allMailMessages.find((message) => messageIncludesPerson(message, personFilter))?.from.name
      ?? activePin?.label
      ?? personFilter
    : null;
  const inboxTitle = personFilterName ?? activeCollection?.name ?? (isClassificationMailbox ? classificationViewLabel(classificationView) : activeMailboxLabel);
  const inboxEyebrow = personFilter
    ? `Filtered ${(activeCollection?.name ?? classificationViewLabel(classificationView)).toLowerCase()}`
    : activeCollection
      ? `Collection · ${activeCollection.threadIds.length} ${activeCollection.threadIds.length === 1 ? "thread" : "threads"}`
      : isClassificationMailbox
        ? classificationViewItems.find((item) => item.id === classificationView)?.description ?? activeMailboxItem.description
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

  function openLibrary() {
    libraryReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOrganizationOpen(true);
  }

  function toggleLibrary() {
    if (organizationOpen) setOrganizationOpen(false);
    else openLibrary();
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
      setSelectedThreadAccountId(message.accountId);
    });

    if (message.unread) {
      if (!demoMode) {
        fetch(`/v1/threads/${encodeURIComponent(message.threadId)}/read?accountId=${encodeURIComponent(message.accountId)}`, { method: "PATCH", credentials: "include" }).catch(() => {});
      } else {
        writeDemoReadState(message.threadId);
      }
      setMessages((prev) =>
        prev.map((m) => (m.threadId === message.threadId ? { ...m, unread: false } : m)),
      );
      setAllMailMessages((prev) =>
        prev.map((m) => (m.threadId === message.threadId ? { ...m, unread: false } : m)),
      );
    }
  }

  function closeThread() {
    runUiTransition("reader-back", () => {
      setSelectedThreadId(null);
      setSelectedThreadAccountId(null);
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
      setSelectedThreadAccountId(null);
      closePanel();
    });
  }

  function selectMailbox(mailbox: Mailbox) {
    runUiTransition("content", () => {
      setActiveMailbox(mailbox);
      if (mailbox === "inbox") setClassificationView("human");
      if (mailbox === "all") setClassificationView("all");
      setActiveCollectionId(null);
      setInboxFilter("all");
      setPersonFilter(null);
      setSelectedThreadId(null);
      setSelectedThreadAccountId(null);
      setOrganizationOpen(false);
    });
  }

  function retryInbox() {
    setClassificationActionError(null);
    setClassificationActionMessage(null);
    setRefreshKey((key) => key + 1);
  }

  function selectClassification(view: ClassificationView) {
    const sameView = view === classificationView;
    if (sameView && isClassificationMailbox) {
      if (classificationLoading) return;
      if (status === "ready" && !classificationError) return;
      retryInbox();
      return;
    }
    runUiTransition("content", () => {
      setClassificationView(view);
      setActiveCollectionId(null);
      setPersonFilter(null);
      setSelectedThreadId(null);
      setSelectedThreadAccountId(null);
      setClassificationActionError(null);
      setClassificationActionMessage(null);
      setActiveMailbox(view === "all" ? "all" : "inbox");
    });
    if (sameView) retryInbox();
  }

  async function loadMoreMessages() {
    const useClassificationSource = isClassificationMailbox && !activeCollectionId;
    const view = classificationView;
    const cursor = useClassificationSource ? classificationCursor : allMailCursor;
    if (demoMode || !cursor || isLoadingMoreMessages) return;
    const requestId = useClassificationSource ? ++classificationPageRequestRef.current : ++allMailPageRequestRef.current;
    setIsLoadingMoreMessages(true);
    setClassificationError(null);
    try {
      const path = useClassificationSource && view !== "all"
        ? `/v1/inbox?classification=${view}&limit=100`
        : "/v1/inbox?view=all&classification=all&limit=100";
      const next = await fetchJson(`${path}&cursor=${encodeURIComponent(cursor)}`, inboxClassificationResponseSchema);
      const isCurrent = useClassificationSource
        ? requestId === classificationPageRequestRef.current && classificationViewRef.current === view
        : requestId === allMailPageRequestRef.current;
      if (!isCurrent) return;
      if (useClassificationSource) {
        setMessages((current) => mergeMessages(current, next.messages));
        setAllMailMessages((current) => mergeMessages(current, next.messages));
        setClassificationCursor(next.nextCursor);
        setClassificationCounts(toClassificationCounts(next.counts.classification));
      } else {
        setAllMailMessages((current) => mergeMessages(current, next.messages));
        setAllMailCursor(next.nextCursor);
      }
    } catch (error) {
      const isCurrent = useClassificationSource
        ? requestId === classificationPageRequestRef.current && classificationViewRef.current === view
        : requestId === allMailPageRequestRef.current;
      if (!isCurrent) return;
      const sourceLabel = useClassificationSource ? classificationViewLabel(view).toLowerCase() : "mailbox";
      setClassificationError(`Could not load more ${sourceLabel} messages. ${getErrorMessage(error)}`);
    } finally {
      const isCurrent = useClassificationSource
        ? requestId === classificationPageRequestRef.current && classificationViewRef.current === view
        : requestId === allMailPageRequestRef.current;
      if (isCurrent) setIsLoadingMoreMessages(false);
    }
  }

  function normalizeClassificationCorrectionTarget(message: ClassificationMessage, target: ClassificationCorrectionTarget): ClassificationOverride["target"] {
    if (target.scope === "message") return { scope: "message", messageId: (target.messageId ?? message.id).trim() };
    const address = message.from.email.trim().toLowerCase();
    if (target.scope === "sender_address") return { scope: "sender_address", address: (target.address ?? address).trim().toLowerCase() };
    return { scope: "sender_domain", domain: (target.domain ?? address.split("@").at(-1) ?? "").trim().toLowerCase() };
  }

  async function correctClassification(message: ClassificationMessage, target: ClassificationCorrectionTarget, classification: HumanClassification | "reset") {
    setClassificationActionError(null);
    setClassificationActionMessage(null);
    const existingOverride = message.humanClassification?.userOverride ?? message.humanClassification?.effective.userOverride ?? null;
    const targetPayload = normalizeClassificationCorrectionTarget(message, target);
    const matchesOverride = existingOverride ? classificationTargetsEqual(existingOverride.target, targetPayload) : false;
    let savedOverride: ClassificationOverride | null = existingOverride;
    try {
      if (demoMode) {
        if (classification === "reset") savedOverride = null;
        else savedOverride = {
          id: `classification-override:demo:${Date.now()}`,
          accountId: message.accountId,
          target: targetPayload,
          classification,
          source: "user_choice" as const,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      } else if (classification === "reset") {
        if (!existingOverride || !matchesOverride) throw new Error("Choose the correction target that owns this override before resetting it.");
        await fetchNoContent(`/v1/classification/overrides/${encodeURIComponent(existingOverride.id)}?accountId=${encodeURIComponent(message.accountId)}`, { method: "DELETE" });
        savedOverride = null;
      } else if (existingOverride && matchesOverride) {
        savedOverride = await fetchJson(`/v1/classification/overrides/${encodeURIComponent(existingOverride.id)}?accountId=${encodeURIComponent(message.accountId)}`, humanClassificationOverrideSchema, undefined, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ classification }),
        });
      } else {
        savedOverride = await fetchJson("/v1/classification/overrides", humanClassificationOverrideSchema, undefined, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ accountId: message.accountId, target: targetPayload, classification }),
        });
      }

      const matchesTarget = (candidate: InboxMessage) => {
        if (candidate.accountId !== message.accountId) return false;
        if (targetPayload.scope === "message") return candidate.id === targetPayload.messageId;
        if (targetPayload.scope === "sender_address") return candidate.from.email.trim().toLowerCase() === targetPayload.address;
        return candidate.from.email.split("@").at(-1)?.trim().toLowerCase() === targetPayload.domain;
      };
      const update = (candidate: InboxMessage) => matchesTarget(candidate)
        && shouldApplyClassificationTarget(candidate, targetPayload, classification)
        ? { ...candidate, ...applyLocalClassification(candidate, classification, savedOverride) }
        : candidate;
      const nextMessages = messages.map(update);
      const nextAllMailMessages = allMailMessages.map(update);
      setMessages(nextMessages);
      setAllMailMessages(nextAllMailMessages);
      if (demoMode) setClassificationCounts(getClassificationCounts(nextAllMailMessages));
      setClassificationActionMessage(classification === "reset" ? "Reset to Orca’s automatic estimate." : `Saved for ${target.scope === "message" ? "this message" : target.scope === "sender_address" ? "this sender" : "this domain"}.`);
      if (!demoMode) setRefreshKey((key) => key + 1);
    } catch (error) {
      const messageText = getErrorMessage(error);
      setClassificationActionError(`That correction was not saved. ${messageText}`);
      throw error;
    }
  }

  function selectCollection(id: string) {
    runUiTransition("content", () => {
      setActiveCollectionId(id);
      setPersonFilter(null);
      setSelectedThreadId(null);
      setSelectedThreadAccountId(null);
      setInboxFilter("all");
      setOrganizationOpen(false);
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

  async function createPin(input: PinInput) {
    if (!account || pins.some((pin) => pin.kind === input.kind && pin.targetId === input.targetId)) return;
    setOrganizationError(null);
    try {
      const normalizedInput = {
        ...input,
        icon: input.icon ?? defaultPinIcon(input.kind),
        color: input.color ?? pinColorOptions[pins.length % pinColorOptions.length]!.value,
      };
      const created = demoMode
        ? pinSchema.parse({ ...normalizedInput, id: `pin_demo_${Date.now()}`, accountId: account.id, position: pins.length, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
        : await fetchJson("/v1/pins", pinSchema, undefined, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(normalizedInput) });
      setPins((current) => [...current, created]);
    } catch (error) {
      setOrganizationError(getErrorMessage(error));
    }
  }

  async function updatePin(pin: Pin, patch: Partial<Pick<Pin, "label" | "icon" | "color">> & { position?: number }) {
    if (!account) return;
    setOrganizationError(null);
    try {
      if (demoMode) {
        setPins((current) => reorderItems(current.map((item) => item.id === pin.id ? { ...item, ...patch, updatedAt: new Date().toISOString() } : item), pin.id, patch.position));
      } else {
        await fetchJson(`/v1/pins/${encodeURIComponent(pin.id)}`, pinSchema, undefined, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
        setPins(await fetchJson("/v1/pins", pinsResponseSchema));
      }
    } catch (error) {
      setOrganizationError(getErrorMessage(error));
      throw error;
    }
  }

  async function reorderPin(pin: Pin, position: number) {
    try {
      await updatePin(pin, { position });
    } catch {
      // updatePin already exposes the bounded organization error to the user.
    }
  }

  async function removePin(pin: Pin) {
    if (!account) return;
    setOrganizationError(null);
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
    if (pin.kind === "filter") {
      const filter = parsePinFilterTarget(pin.targetId);
      if (!filter) return;
      runUiTransition("content", () => {
        setActiveMailbox(filter.mailbox);
        setActiveCollectionId(null);
        setInboxFilter(filter.attention);
        setPersonFilter(filter.person);
        setStreamQuery(filter.query);
        setSelectedThreadId(null);
        setSelectedThreadAccountId(null);
        setOrganizationOpen(false);
      });
    }
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

  async function saveReminder(input: { threadId: string; scheduledFor: string; timezone: string; notify: boolean }, existingReminder?: Reminder | null) {
    if (!account) return;
    const request = buildReminderSaveRequest(input, existingReminder);
    const saved = demoMode
      ? reminderSchema.parse({ id: existingReminder?.id ?? `reminder_demo_${input.threadId}`, accountId: account.id, ...input, status: "scheduled", resurfacedAt: null, completedAt: null, cancelledAt: null, createdAt: existingReminder?.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString() })
      : await fetchJson(request.path, reminderSchema, undefined, {
        method: request.method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request.body),
      });
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
      <button
        aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        className="theme-toggle app-theme-toggle"
        onClick={() => runUiTransition("theme", () => setTheme((current) => (current === "dark" ? "light" : "dark")))}
        title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        type="button"
      >
        {theme === "dark" ? "☾" : "☀"}
      </button>
      <main className={`app-shell${selectedThreadId ? " app-shell-reader" : ""}`}>
        <WaveRail
          activeMailbox={activeMailbox}
          libraryOpen={organizationOpen}
          onOpenLibrary={toggleLibrary}
          onSelectMailbox={selectMailbox}
        />

        {organizationOpen ? <button aria-label="Close library" className="rail-library-backdrop" onClick={() => setOrganizationOpen(false)} tabIndex={-1} type="button" /> : null}
        <aside aria-label="Collections and pins" aria-hidden={!organizationOpen} aria-modal={organizationOpen || undefined} className={`sidebar rail-library${organizationOpen ? " rail-library-open" : ""}`} id="collections-and-pins-drawer" inert={!organizationOpen || undefined} ref={libraryRef} role={organizationOpen ? "dialog" : undefined}>
          <header className="sidebar-header">
            <div className="brand-wrap">
              <div className="brand"><WaveGlyph /> Orca</div>
              {demoMode ? <span className="dev-preview-badge">Preview</span> : null}
            </div>
            <div className="header-actions">
              <button aria-label="Close library" className="compose-button" onClick={() => setOrganizationOpen(false)} type="button">Close</button>
            </div>
          </header>

          <label className="search-field">
            <span>Search mail</span>
            <input onChange={(event) => setStreamQuery(event.target.value)} placeholder="People, subjects, words" value={streamQuery} />
          </label>

          <OrganizationSidebar
            activeCollectionId={activeCollectionId}
            collections={collections}
            error={organizationError}
            onCreateCollection={createCollection}
            onColorCollection={(collection, color) => void updateCollection(collection, { color })}
            onDeleteCollection={deleteCollection}
            onMoveCollection={(collection, direction) => void updateCollection(collection, { position: collection.position + direction })}
            onRenameCollection={(collection, name) => void updateCollection(collection, { name })}
            onSelectCollection={selectCollection}
          />

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
        </aside>

        <section aria-label={selectedThreadId ? "Message reader" : "Inbox"} className={`content-pane${selectedThreadId ? " content-pane-reader" : ""}`} inert={organizationOpen || undefined}>
          <div style={{ display: selectedThreadId ? "none" : undefined }}>
            <InboxView
              account={account}
              automatedMessages={automatedMessages}
              errorMessage={errorMessage}
              errorStatus={errorStatus}
              inboxEyebrow={inboxEyebrow}
              inboxFilter={inboxFilter}
              inboxTitle={inboxTitle}
              classificationView={classificationView}
              classificationCounts={classificationCounts}
              classificationLoading={classificationLoading}
              classificationError={classificationError}
              classificationActionError={classificationActionError}
              classificationActionMessage={classificationActionMessage}
              hasMoreMessages={Boolean(activeMailboxCursor)}
              isLoadingMoreMessages={isLoadingMoreMessages}
              isCollectionView={Boolean(activeCollection)}
              collection={activeCollection}
              currentViewLabel={activeMailboxLabel}
              allMessages={allMailMessages}
              attentionByAddress={attentionByAddress}
              activePin={activePin}
              messages={visibleMessages}
              pins={pins}
              pinnedPeople={pinnedPeople}
              pinnedSenderAddresses={pinnedSenderAddresses}
              onClearFilter={() => setPersonFilter(null)}
              onSelectClassification={selectClassification}
              onLoadMoreMessages={() => void loadMoreMessages()}
              onRetry={retryInbox}
              onClassificationChange={correctClassification}
              onOpenThread={openThread}
              onCreatePin={(input) => void createPin(input)}
              onRemovePin={(pin) => void removePin(pin)}
              onReorderPin={(pin, position) => void reorderPin(pin, position)}
              onUpdatePin={(pin, patch) => updatePin(pin, patch)}
              onPinPerson={(message) => void createPin({ kind: "sender", targetId: message.from.email, label: message.from.name ?? message.from.email })}
              onSelectPin={selectPin}
              rowRefs={messageRowRefs}
              personFilter={personFilter}
              status={status}
              syncStatus={syncStatus}
              isRefreshing={status === "syncing" && messages.length > 0}
              onRefresh={() => setRefreshKey((key) => key + 1)}
              onAttentionChange={updateSenderAttention}
              onInboxFilterChange={selectInboxFilter}
              onOpenOrganizer={openOrganizer}
              onFinishLater={(reminder) => void finishReminder(reminder)}
              onSnoozeLater={(message, reminder) => saveReminder({ threadId: message.threadId, scheduledFor: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", notify: reminder?.notify ?? false }, reminder)}
              onRenameCollection={activeCollection ? () => { const name = window.prompt("Rename collection", activeCollection.name)?.trim(); if (name) void updateCollection(activeCollection, { name }); } : undefined}
              onRemoveFromCollection={activeCollection ? (message) => void toggleCollectionMembership(activeCollection, message.threadId) : undefined}
              onSearchChange={setStreamQuery}
              searchQuery={streamQuery}
              reminders={reminders}
              showInboxFilters={!activeCollectionId && activeMailbox === "inbox" && !personFilter}
              viewMode={activeCollection ? "collection" : activeMailbox}
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
              onClassificationChange={correctClassification}
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

      {!selectedThreadId ? <button className="tidal-compose-fab" inert={organizationOpen || undefined} onClick={openCompose} type="button"><span aria-hidden="true">◇</span> Write</button> : null}

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
                  <span>Open in Zen</span>
                </button>
                <button
                  aria-label="Close panel"
                  className="panel-close"
                  onClick={closePanel}
                  type="button"
                >
                  <span aria-hidden="true">×</span>
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

export type GmailAuthorizationState = {
  accountId: string | null;
  status: "idle" | "loading" | "error";
  errorMessage: string | null;
};

export function withGmailAccountId(path: string, accountId?: string | null) {
  if (!accountId) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}accountId=${encodeURIComponent(accountId)}`;
}

export function buildGmailAuthorizationRequestPath(intent: "connect" | "upgrade", returnTo: string, accountId?: string | null) {
  const endpoint = intent === "upgrade" ? "/v1/auth/gmail/upgrade" : "/v1/auth/gmail/connect";
  const query = new URLSearchParams({ returnTo });
  if (accountId) query.set("accountId", accountId);
  return `${endpoint}?${query.toString()}`;
}

export function buildGmailLabelMigrationPath(accountId?: string | null) {
  return withGmailAccountId("/settings/integrations/gmail/labels", accountId);
}

export function GmailAccountSettingsList({
  accounts,
  authorization,
  onAuthorize,
}: {
  accounts: MailAccount[];
  authorization: GmailAuthorizationState;
  onAuthorize: (intent: "connect" | "upgrade", accountId: string) => void;
}) {
  return <div className="gmail-account-list" aria-label="Connected Gmail accounts">
    {accounts.map((account) => {
      const accountIsLoading = authorization.status === "loading" && authorization.accountId === account.id;
      const accountHasError = authorization.status === "error" && authorization.accountId === account.id;
      return <article aria-labelledby={`gmail-account-${account.id}`} className="gmail-account-card" data-account-id={account.id} key={account.id}>
        <div className="gmail-account-heading">
          <div><span>Connected account</span><strong id={`gmail-account-${account.id}`}>{account.email}</strong></div>
          <span className="gmail-capability-badge">{account.capabilities.send ? "Compose + send" : "Read-only"}</span>
        </div>
        <div aria-label={`Gmail capabilities for ${account.email}`} className="gmail-capability-grid">
          <CapabilityRow active={account.capabilities.read} label="Read inbox" note="Keeps Orca synced with incoming mail." />
          <CapabilityRow active={account.capabilities.draft} label="Manage Gmail drafts" note="Creates and updates only messages you write." />
          <CapabilityRow active={account.capabilities.send} label="Send mail" note="Covers new messages, replies, and forwards." />
        </div>
        {!account.capabilities.send ? <div className="gmail-upgrade-explainer">
          <span>Optional permission</span>
          <h2>Let Orca finish what you write.</h2>
          <p>Google will ask for <code>gmail.compose</code>. It is the minimum single scope that supports Gmail drafts and sending. Orca does not request delete, label-editing, or broad mailbox-modification access.</p>
          <button aria-label={`Enable drafts and sending for ${account.email}`} className="gmail-account-action gmail-account-action-primary" disabled={authorization.status === "loading"} onClick={() => onAuthorize("upgrade", account.id)} type="button">{accountIsLoading ? "Opening Google…" : "Enable drafts and sending"}</button>
        </div> : <div className="gmail-upgrade-confirmed"><span aria-hidden="true">✓</span><div><strong>Google confirmed compose access</strong><p>Orca can now use the future draft and delivery transport for this account.</p></div></div>}
        {accountHasError ? <p className="gmail-authorization-error" role="alert">{authorization.errorMessage}</p> : null}
        <footer className="gmail-settings-actions">
          <button aria-label={`Reconnect Gmail for ${account.email}`} className="gmail-account-action" disabled={authorization.status === "loading"} onClick={() => onAuthorize("connect", account.id)} type="button">{accountIsLoading ? "Opening Google…" : "Reconnect Gmail"}</button>
          <a aria-label={`Import Gmail labels for ${account.email}`} className="gmail-account-action-link" href={buildGmailLabelMigrationPath(account.id)}>Import Gmail labels →</a>
        </footer>
      </article>;
    })}
  </div>;
}

export function GmailConnectionSettingsPage({ theme, setTheme }: {
  theme: Theme;
  setTheme: Dispatch<SetStateAction<Theme>>;
}) {
  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [authorization, setAuthorization] = useState<GmailAuthorizationState>({ accountId: null, status: "idle", errorMessage: null });
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const returnStatus = readOAuthReturnStatus();
  const returnTo = typeof window === "undefined" ? "/settings/integrations/gmail" : `${window.location.origin}/settings/integrations/gmail`;

  useEffect(() => {
    const controller = new AbortController();
    setStatus("loading");
    setErrorMessage(null);
    fetchJson("/v1/accounts", mailAccountPageSchema, controller.signal)
      .then((next) => { setAccounts(next.items.filter((account) => account.provider === "gmail")); setStatus("ready"); })
      .catch((error) => { if (!controller.signal.aborted) { setStatus("error"); setErrorMessage(getErrorMessage(error)); } });
    return () => controller.abort();
  }, [reloadToken]);

  useEffect(() => {
    if (status === "ready" || status === "error") titleRef.current?.focus();
  }, [status]);

  function authorize(intent: "connect" | "upgrade", accountId: string | null) {
    if (authorization.status === "loading") return;
    setAuthorization({ accountId, status: "loading", errorMessage: null });
    void beginGmailAuthorization(
      intent,
      returnTo,
      accountId,
      (nextStatus) => setAuthorization((current) => ({ ...current, status: nextStatus })),
      (nextError) => setAuthorization((current) => ({ ...current, status: "error", errorMessage: nextError })),
    );
  }

  return (
    <main className="gmail-settings-page">
      <header className="attention-settings-topbar">
        <a className="settings-brand" href="/"><span aria-hidden="true"><WaveGlyph /></span> Orca</a>
        <div className="settings-topbar-actions">
          <a className="settings-back-link" href="/">← Inbox</a>
          <button aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"} className="theme-toggle" onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")} type="button">{theme === "dark" ? "☾" : "☀"}</button>
        </div>
      </header>
      <section className="gmail-settings-shell" aria-labelledby="gmail-settings-title">
        <header className="gmail-settings-intro">
          <p className="settings-eyebrow">Settings / Gmail connection</p>
          <h1 id="gmail-settings-title" ref={titleRef} tabIndex={-1}>Permission<br /><em>with purpose.</em></h1>
          <p>Your inbox connection stays readable while you deliberately decide whether Orca may create drafts and send mail.</p>
        </header>

        <section aria-busy={status === "loading"} aria-label="Gmail authorization state" className="gmail-permission-card">
          {status === "loading" ? <p aria-live="polite" role="status">Checking the confirmed Google grant…</p> : null}
          {status === "error" ? <div className="oauth-notice oauth-notice-error" role="alert"><strong>Connection needs attention</strong><span>{errorMessage}</span><button className="gmail-account-action" onClick={() => setReloadToken((current) => current + 1)} type="button">Try again</button></div> : null}
          {returnStatus?.intent === "upgrade" ? <OAuthUpgradeReturnNotice status={returnStatus} /> : null}
          {status === "ready" && accounts.length > 0 ? <GmailAccountSettingsList accounts={accounts} authorization={authorization} onAuthorize={(intent, accountId) => authorize(intent, accountId)} /> : null}
          {status === "ready" && accounts.length === 0 ? <p aria-live="polite" className="gmail-empty-state" role="status">No Gmail accounts are connected yet. Add one to start your inbox.</p> : null}
          <footer className="gmail-settings-actions"><button aria-label="Add a Gmail account" className="gmail-account-action gmail-account-action-primary" disabled={status === "loading" || authorization.status === "loading"} onClick={() => authorize("connect", null)} type="button">{authorization.status === "loading" && authorization.accountId === null ? "Opening Google…" : "Add Gmail account"}</button></footer>
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

export function WelcomeOrientationPage({ onComplete, theme, setTheme }: {
  onComplete?: () => Promise<void>;
  theme: Theme;
  setTheme: Dispatch<SetStateAction<Theme>>;
}) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [completionStatus, setCompletionStatus] = useState<"idle" | "loading" | "error">("idle");
  const [completionError, setCompletionError] = useState<string | null>(null);
  useEffect(() => { titleRef.current?.focus(); }, []);

  async function handleComplete(event: MouseEvent<HTMLAnchorElement>) {
    if (!onComplete) return;
    event.preventDefault();
    setCompletionStatus("loading");
    setCompletionError(null);
    try {
      await onComplete();
    } catch (error) {
      setCompletionStatus("error");
      setCompletionError(getErrorMessage(error));
    }
  }

  return <main className="onboarding-page">
    <header className="onboarding-topbar">
      <a className="settings-brand" href="/"><span aria-hidden="true"><WaveGlyph /></span> Orca</a>
      <button aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"} className="theme-toggle" onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")} type="button">{theme === "dark" ? "☾" : "☀"}</button>
    </header>
    <section className="onboarding-card" aria-labelledby="onboarding-title">
      <p className="settings-eyebrow">You’re in</p>
      <h1 id="onboarding-title" ref={titleRef} tabIndex={-1}>Welcome to a<br /><em>quieter inbox.</em></h1>
      <p className="onboarding-lede">Orca is syncing your Gmail now. Your workspace starts with the mail that feels most human, without changing anything in Gmail.</p>
      <ul className="onboarding-orientation">
        <li><span>01</span><div><strong>Read what matters</strong><p>Your inbox brings people forward and keeps the rest within reach.</p></div></li>
        <li><span>02</span><div><strong>Tune as you go</strong><p>Move senders into Focus, Quiet, or Hidden whenever their rhythm becomes clear.</p></div></li>
      </ul>
      <div className="onboarding-actions">
        <a aria-busy={completionStatus === "loading" || undefined} className="onboarding-enter" href="/" onClick={onComplete ? (event) => void handleComplete(event) : undefined}>{completionStatus === "loading" ? "Opening your inbox…" : "Open my inbox"} <span aria-hidden="true">→</span></a>
        {completionError ? <p className="onboarding-error" role="alert">{completionError}</p> : null}
        <p>Want your old organization later? Import Gmail labels from Settings.</p>
      </div>
    </section>
  </main>;
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
    const response = await fetch(buildGmailAuthorizationRequestPath(intent, returnTo, accountId), { credentials: "include" });
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

export function GmailLabelMigrationPage({ theme, setTheme }: {
  theme: Theme;
  setTheme: Dispatch<SetStateAction<Theme>>;
}) {
  const [migration, setMigration] = useState<GmailLabelMigration | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [status, setStatus] = useState<"loading" | "syncing" | "ready" | "saving" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const accountId = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("accountId");
  const migrationPath = withGmailAccountId("/v1/gmail-label-migration", accountId);
  const syncPath = withGmailAccountId("/v1/sync/gmail", accountId);
  const importPath = withGmailAccountId("/v1/gmail-label-migration/import", accountId);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        let next = await fetchJson(migrationPath, gmailLabelMigrationSchema, controller.signal);
        if (!next.ready) {
          setStatus("syncing");
          next = await syncGmailLabelsUntilReady(
            next,
            () => fetchJson(syncPath, { parse: (value: unknown) => value }, controller.signal, { method: "POST" }),
            () => fetchJson(migrationPath, gmailLabelMigrationSchema, controller.signal),
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
  }, [migrationPath, syncPath]);

  async function importLabels() {
    setStatus("saving");
    setErrorMessage(null);
    try {
      const next = await fetchJson(
        importPath,
        gmailLabelMigrationSchema,
        undefined,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ labelIds: [...selectedIds] }) },
      );
      setMigration(next);
      setStatus("ready");
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
        <a className="settings-brand" href="/"><span aria-hidden="true"><WaveGlyph /></span> Orca</a>
        <div className="settings-topbar-actions">
          <a className="settings-back-link" href="/">← Inbox</a>
          <button aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"} className="theme-toggle" onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")} type="button">{theme === "dark" ? "☾" : "☀"}</button>
        </div>
      </header>
      <section className="label-migration-shell" aria-labelledby="label-migration-title">
        <header className="label-migration-intro">
          <p className="settings-eyebrow">Settings / Gmail labels</p>
          <h1 id="label-migration-title">Keep the labels<br /><em>that still matter.</em></h1>
          <p>Turn selected Gmail labels into Orca Collections. This only copies your organization into Orca—nothing in Gmail is changed.</p>
          <div className="label-migration-safety"><strong>Read-only by design</strong><span>Messages stay in Gmail. Labels are never renamed, removed, or edited.</span></div>
        </header>

        <section className="label-migration-picker" aria-label="Gmail labels available to import">
          <div className="label-migration-heading"><span>Your labels</span><span>{migration ? `${migration.labels.length} available` : ""}</span></div>
          {status === "loading" ? <div aria-live="polite" className="attention-loading" role="status">Checking your Gmail organization…</div> : null}
          {status === "syncing" ? <div aria-live="polite" className="attention-loading" role="status">Reading labels from Gmail for the first time…</div> : null}
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
                <a className="label-migration-cancel" href="/">Not now</a>
                {migration.labels.length ? <button className="label-import-button" disabled={status === "saving" || selectedIds.size === 0} onClick={() => void importLabels()} type="button">{status === "saving" ? "Saving…" : "Import selected"}</button> : null}
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

function OAuthLoginPage() {
  const [connectStatus, setConnectStatus] = useState<OAuthConnectStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [returnStatus, setReturnStatus] = useState<OAuthReturnStatus>(() => readOAuthReturnStatus());
  const [activeProvider, setActiveProvider] = useState<OAuthProvider | null>(null);
  const connectInFlightRef = useRef(false);
  const isLogin = typeof window !== "undefined" && window.location.pathname === "/login";
  const isOnboarding = typeof window !== "undefined" && window.location.pathname === "/onboarding";
  const returnProvider = returnStatus?.provider ?? "gmail";

  async function connectProvider(provider: OAuthProvider) {
    if (connectInFlightRef.current || connectStatus === "loading") {
      return;
    }

    connectInFlightRef.current = true;
    setActiveProvider(provider);
    setReturnStatus(null);
    const returnTo = typeof window === "undefined"
      ? "/onboarding"
      : `${window.location.origin}${isLogin || isOnboarding ? "/onboarding" : "/"}`;
    const started = await beginProviderAuthorization(provider, isLogin || isOnboarding ? "login" : "connect", returnTo, setConnectStatus, setErrorMessage);
    if (!started) {
      connectInFlightRef.current = false;
      setActiveProvider(null);
    }
  }

  return (
    <main className="oauth-page">
      <section className="oauth-shell" aria-labelledby="oauth-title">
        <div className="oauth-brand">
          <span className="oauth-brand-mark" aria-hidden="true">
            <WaveGlyph />
          </span>
          <span>Orca</span>
        </div>

        <div className="oauth-hero">
          <p className="oauth-eyebrow">{isOnboarding ? "Your workspace is ready" : isLogin ? "A quieter way to email" : `${providerDisplayName(returnProvider)} connection`}</p>
          <h1 id="oauth-title">
            {isOnboarding && returnStatus?.kind === "success"
              ? "Welcome aboard."
              : isLogin
                ? <>Make room for <em>the people.</em></>
                : `Connect your ${providerDisplayName(returnProvider)} inbox`}
          </h1>
          <p>
            {isOnboarding && returnStatus?.kind === "success"
              ? returnProvider === "outlook"
                ? "Orca is now connected to your Microsoft Outlook account. Outlook mail will appear after the Graph sync step is enabled."
                : "Orca is now connected to your Gmail account. Your first inbox sync can begin when you enter your workspace."
              : "Choose Gmail or Microsoft Outlook to sign in. Orca asks for read-only mail access to build a calmer inbox—never to send, delete, or modify your messages."}
          </p>

          {returnStatus ? <OAuthReturnNotice status={returnStatus} /> : null}
          {errorMessage ? (
            <div className="oauth-notice oauth-notice-error" role="alert">
              <strong>Connection could not start</strong>
              <span>{errorMessage}</span>
            </div>
          ) : null}

          {isOnboarding && returnStatus?.kind === "success" ? (
            <a className="oauth-provider-button oauth-enter-button" href="/">Enter Orca <span aria-hidden="true">→</span></a>
          ) : (
            <div aria-label="Choose a mail provider" className="oauth-provider-list">
              <button
                className="oauth-google-button"
                disabled={connectStatus === "loading"}
                onClick={() => void connectProvider("gmail")}
                type="button"
              >
                <GoogleGlyph />
                <span>{connectStatus === "loading" && activeProvider === "gmail" ? "Opening Google…" : isLogin ? "Continue with Google" : "Connect Gmail"}</span>
              </button>
              <div className="oauth-provider-separator" aria-hidden="true"><span>or</span></div>
              <button
                className="oauth-outlook-button"
                disabled={connectStatus === "loading"}
                onClick={() => void connectProvider("outlook")}
                type="button"
              >
                <OutlookGlyph />
                <span>{connectStatus === "loading" && activeProvider === "outlook" ? "Opening Outlook…" : isLogin ? "Continue with Outlook" : "Connect Outlook"}</span>
              </button>
            </div>
          )}

          <p className="oauth-fine-print">
            Gmail uses `gmail.readonly`; Outlook uses Microsoft Graph `Mail.Read`. You can revoke access at any time from your provider’s security settings.
          </p>
        </div>

        <aside className="oauth-setup-panel" aria-label="OAuth setup checklist">
          <h2>{isLogin ? "What happens next" : "Provider setup checklist"}</h2>
          <ol>
            {isLogin ? <>
              <li>Choose the Gmail or Outlook account you want to bring to Orca.</li>
              <li>Review the read-only permission on your provider’s secure screen.</li>
              <li>Return here to enter your new human-first inbox.</li>
            </> : <>
              <li>Create an OAuth client for the provider you want to connect.</li>
              <li>Add `http://localhost:5173` as an authorized JavaScript origin.</li>
              <li>Add the provider callback URI shown in its setup guide.</li>
              <li>Copy the client ID and secret into `.env`, then restart the API.</li>
            </>}
          </ol>
          <div className="oauth-setup-links">
            <a href="/docs/gmail-oauth-setup.html">Gmail setup guide</a>
            <a href="/docs/outlook-oauth-setup.html">Outlook setup guide</a>
          </div>
        </aside>
      </section>
    </main>
  );
}

function providerDisplayName(provider: OAuthProvider) {
  return provider === "outlook" ? "Microsoft Outlook" : "Gmail";
}

function mailProviderLabel(provider: MailAccount["provider"]) {
  return providerDisplayName(provider);
}

async function beginProviderAuthorization(
  provider: OAuthProvider,
  intent: "login" | "connect",
  returnTo: string,
  setStatus: (status: OAuthConnectStatus) => void,
  setError: (message: string | null) => void,
): Promise<boolean> {
  setStatus("loading");
  setError(null);
  try {
    const query = new URLSearchParams({ returnTo });
    const response = await fetch(`/v1/auth/${provider}/${intent}?${query}`, { credentials: "include" });
    const body = await readJsonObject(response);
    if (!response.ok) {
      throw new Error(getStringField(body, "message") ?? `Could not start ${providerDisplayName(provider)} OAuth (${response.status} ${response.statusText})`.trim());
    }
    const authUrl = getStringField(body, "authUrl");
    if (!authUrl) {
      throw new Error(`The ${providerDisplayName(provider)} OAuth response did not include an authUrl.`);
    }
    window.location.assign(authUrl);
    return true;
  } catch (error) {
    setStatus("error");
    setError(getErrorMessage(error));
    return false;
  }
}

function OAuthReturnNotice({ status }: { status: OAuthReturnStatus }) {
  if (!status) {
    return null;
  }

  if (status.kind === "success") {
    return (
      <div className="oauth-notice oauth-notice-success" role="status">
        <strong>{providerDisplayName(status.provider)} connected</strong>
        <span>
          {status.provider === "outlook"
            ? status.email
              ? `${status.email} is connected. Outlook mail will appear after the Graph sync step is enabled.`
              : "Your Microsoft Outlook account is connected. Mail will appear after the Graph sync step is enabled."
            : status.email
              ? `${status.email} is ready for read-only inbox sync.`
              : "Your Gmail account is ready for read-only inbox sync."}
        </span>
      </div>
    );
  }

  return (
    <div className="oauth-notice oauth-notice-error" role="alert">
      <strong>{providerDisplayName(status.provider)} returned an error</strong>
      <span>{oauthErrorMessage(status.reason, false, status.provider)}</span>
    </div>
  );
}

function oauthErrorMessage(reason: string | null, preserveReading: boolean, provider: OAuthProvider = "gmail") {
  const providerName = providerDisplayName(provider);
  const suffix = preserveReading ? " Your read-only inbox still works." : "";
  switch (reason) {
    case "provider_error": return `${providerName} permission was not granted.${suffix}`;
    case "compose_not_granted": return `Google did not grant Gmail draft and send access.${suffix}`;
    case "account_mismatch": return `Choose the same ${providerName} account that is already connected to Orca.${suffix}`;
    case "upgrade_account_missing": return `Orca could not find the Gmail connection to upgrade.${suffix}`;
    case "invalid_state":
    case "missing_state": return "The authorization return could not be verified. Start again from Orca.";
    case "token_exchange_failed":
    case "userinfo_failed": return `${providerName} could not confirm the authorization. Try again.${suffix}`;
    default: return `The ${providerName} authorization flow did not complete.${suffix}`;
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

function WaveGlyph() {
  return <svg aria-hidden="true" className="wave-glyph" viewBox="0 0 24 24"><path d="M3 8.5c2.5-2.7 4.6-2.7 7.1 0s4.6 2.7 7.1 0 3.8-2.7 3.8-2.7M3 14.5c2.5-2.7 4.6-2.7 7.1 0s4.6 2.7 7.1 0 3.8-2.7 3.8-2.7" /></svg>;
}

function RailGlyph({ name }: { name: "inbox" | "focus" | "quiet" | "later" | "library" | "settings" }) {
  if (name === "inbox") return <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 5.5h16v13H4zM4 14h4l1.5 2h5l1.5-2h4" /></svg>;
  if (name === "focus") return <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m12 3 1.4 4.2L18 9l-4.6 1.8L12 15l-1.4-4.2L6 9l4.6-1.8zM18.5 15l.7 2.1 2.3.9-2.3.9-.7 2.1-.7-2.1-2.3-.9 2.3-.9z" /></svg>;
  if (name === "quiet") return <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M19.2 15.2A8 8 0 0 1 8.8 4.8 8.5 8.5 0 1 0 19.2 15.2Z" /></svg>;
  if (name === "later") return <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2" /></svg>;
  if (name === "library") return <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m4 8 8-4 8 4-8 4zM4 12l8 4 8-4M4 16l8 4 8-4" /></svg>;
  return <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 7h10M18 7h2M4 12h3M11 12h9M4 17h8M16 17h4"/><circle cx="16" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="14" cy="17" r="2"/></svg>;
}

function WaveRail({ activeMailbox, libraryOpen, onOpenLibrary, onSelectMailbox }: {
  activeMailbox: Mailbox;
  libraryOpen: boolean;
  onOpenLibrary: () => void;
  onSelectMailbox: (mailbox: Mailbox) => void;
}) {
  const items: Array<{ id: "inbox" | "focus" | "quiet" | "later"; label: string }> = [
    { id: "inbox", label: "Inbox" }, { id: "focus", label: "Focus" }, { id: "quiet", label: "Quiet" }, { id: "later", label: "Later" },
  ];
  return <aside aria-label="Primary navigation" className="wave-rail" inert={libraryOpen || undefined}>
    <button aria-label="Inbox stream" className="wave-rail-brand" onClick={() => onSelectMailbox("inbox")} type="button"><WaveGlyph /></button>
    <nav>{items.map((item) => <button aria-current={activeMailbox === item.id ? "page" : undefined} aria-label={item.label} key={item.id} onClick={() => onSelectMailbox(item.id)} title={item.label} type="button"><RailGlyph name={item.id} /></button>)}
      <button aria-controls="collections-and-pins-drawer" aria-expanded={libraryOpen} aria-label={libraryOpen ? "Close collections and pins menu" : "Open collections and pins menu"} className={libraryOpen ? "wave-rail-selected" : ""} onClick={onOpenLibrary} title={libraryOpen ? "Close collections and pins menu" : "Open collections and pins menu"} type="button"><RailGlyph name="library" /></button>
      <a aria-label="Settings" href="/settings" title="Settings"><RailGlyph name="settings" /></a>
    </nav>
    <a aria-label="Account settings" className="wave-rail-account" href="/settings">L</a>
  </aside>;
}

function PinRail({ pins, pinnedPeople, inboxFilter, personFilter, searchQuery, viewMode, onSelectPin, onReorderPin, onUpdatePin }: {
  pins: Pin[];
  pinnedPeople: PersonItem[];
  inboxFilter: InboxFilter;
  personFilter: string | null;
  searchQuery: string;
  viewMode: "collection" | Mailbox;
  onSelectPin: (pin: Pin) => void;
  onReorderPin: (pin: Pin, position: number) => void;
  onUpdatePin: (pin: Pin, patch: Partial<Pick<Pin, "label" | "icon" | "color">>) => Promise<void>;
}) {
  const [draggedPinId, setDraggedPinId] = useState<string | null>(null);
  const [dropPinId, setDropPinId] = useState<string | null>(null);
  const [editingPinId, setEditingPinId] = useState<string | null>(null);
  const [moveMessage, setMoveMessage] = useState("");
  const editingPin = pins.find((pin) => pin.id === editingPinId) ?? null;

  function clearDragState() {
    setDraggedPinId(null);
    setDropPinId(null);
  }

  function handleDrop(event: React.DragEvent<HTMLButtonElement>, targetPin: Pin) {
    event.preventDefault();
    const draggedId = draggedPinId ?? event.dataTransfer.getData("text/plain");
    const draggedPin = pins.find((pin) => pin.id === draggedId);
    if (!draggedPin || draggedPin.id === targetPin.id) {
      clearDragState();
      return;
    }
    const remaining = pins.filter((pin) => pin.id !== draggedPin.id);
    const targetIndex = remaining.findIndex((pin) => pin.id === targetPin.id);
    if (targetIndex < 0) {
      clearDragState();
      return;
    }
    const targetRect = event.currentTarget.getBoundingClientRect();
    const insertAfter = event.clientX >= targetRect.left + targetRect.width / 2;
    const nextPosition = Math.max(0, Math.min(targetIndex + (insertAfter ? 1 : 0), remaining.length));
    onReorderPin(draggedPin, nextPosition);
    setMoveMessage(`${draggedPin.label} moved to position ${nextPosition + 1} of ${pins.length}.`);
    clearDragState();
  }

  function moveWithKeyboard(pin: Pin, direction: -1 | 1) {
    const currentIndex = pins.findIndex((item) => item.id === pin.id);
    const nextPosition = currentIndex + direction;
    if (currentIndex < 0 || nextPosition < 0 || nextPosition >= pins.length) return;
    onReorderPin(pin, nextPosition);
    setMoveMessage(`${pin.label} moved to position ${nextPosition + 1} of ${pins.length}.`);
  }

  return <>
    <div className="pin-rail-items" onDragEnd={clearDragState}>
      {pins.map((pin) => {
        const person = pin.kind === "sender"
          ? pinnedPeople.find((item) => item.filterValue === pin.targetId.trim().toLowerCase()) ?? null
          : null;
        const active = isTopBarPinActive(pin, { inboxFilter, personFilter, searchQuery, viewMode });
        const isDragging = draggedPinId === pin.id;
        const isDropTarget = dropPinId === pin.id && !isDragging;
        return <div className={`pinned-pin-item${isDragging ? " pinned-pin-item-dragging" : ""}${isDropTarget ? " pinned-pin-item-drop-target" : ""}`} key={pin.id}>
          <button
            aria-describedby="pin-rail-instructions"
            aria-grabbed={isDragging}
            aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
            aria-label={`Open ${pin.label} pin`}
            aria-pressed={active}
            className={`pinned-pin pinned-pin-${pin.kind}`}
            draggable
            onClick={() => onSelectPin(pin)}
            onDragEnter={() => { if (draggedPinId && draggedPinId !== pin.id) setDropPinId(pin.id); }}
            onDragOver={(event) => { if (!draggedPinId || draggedPinId === pin.id) return; event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDropPinId(pin.id); }}
            onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", pin.id); setDraggedPinId(pin.id); setMoveMessage(""); }}
            onDrop={(event) => handleDrop(event, pin)}
            onKeyDown={(event) => {
              if (!event.altKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
              event.preventDefault();
              moveWithKeyboard(pin, event.key === "ArrowLeft" ? -1 : 1);
            }}
            style={{ "--pin-color": pin.color } as CSSProperties}
            title={`${pin.label} · drag to reorder`}
            type="button"
          >
            <span className="pinned-avatar">{pinTopBarMark(pin, person)}{person?.unread ? <i /> : null}</span>
            <small>{pinTopBarLabel(pin, person)}</small>
          </button>
          <button aria-label={`Customize ${pin.label} pin`} className="pinned-pin-edit" onClick={() => setEditingPinId(pin.id)} title={`Customize ${pin.label}`} type="button">✎</button>
        </div>;
      })}
      <p className="pin-rail-instructions visually-hidden" id="pin-rail-instructions">Drag to reorder · select the customize button to choose an icon and color · Option plus arrow keys also move pins.</p>
      <span aria-live="polite" className="visually-hidden">{moveMessage}</span>
    </div>
    {editingPin ? <PinAppearanceEditor pin={editingPin} onClose={() => setEditingPinId(null)} onSave={onUpdatePin} /> : null}
  </>;
}

function PinAppearanceEditor({ pin, onClose, onSave }: {
  pin: Pin;
  onClose: () => void;
  onSave: (pin: Pin, patch: Partial<Pick<Pin, "icon" | "color">>) => Promise<void>;
}) {
  const [icon, setIcon] = useState<PinIcon>(pin.icon);
  const [color, setColor] = useState<string>(pin.color);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, saving]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await onSave(pin, { icon, color });
      onClose();
    } catch (saveError) {
      setError(getErrorMessage(saveError));
    } finally {
      setSaving(false);
    }
  }

  return <div className="pin-appearance-layer" role="presentation">
    <button aria-label="Close pin customization" className="pin-appearance-backdrop" disabled={saving} onClick={onClose} type="button" />
    <section aria-labelledby="pin-appearance-title" aria-modal="true" className="pin-appearance" role="dialog">
      <header className="pin-appearance-heading">
        <div><p>Make it yours</p><h2 id="pin-appearance-title">Customize this pin</h2><span>Choose a mark and color so this shortcut is easy to spot.</span></div>
        <button aria-label="Close pin customization" autoFocus disabled={saving} onClick={onClose} type="button">×</button>
      </header>
      <form onSubmit={submit}>
        <div className="pin-appearance-preview" style={{ "--pin-color": color } as CSSProperties}>
          <span>{pinTopBarMark({ ...pin, icon }, null)}</span>
          <div><strong>{pin.label}</strong><small>{pinTopBarLabel({ ...pin, icon }, null)}</small></div>
        </div>
        <fieldset className="pin-appearance-icons">
          <legend>Icon</legend>
          <div aria-label="Pin icons" role="group">
            {pinIconOptions.map((option) => <button aria-label={`${option.label}${icon === option.id ? ", selected" : ""}`} aria-pressed={icon === option.id} className={icon === option.id ? "pin-appearance-icon-selected" : ""} disabled={saving} key={option.id} onClick={() => setIcon(option.id)} title={option.label} type="button"><span aria-hidden="true">{option.glyph}</span><small>{option.label}</small></button>)}
          </div>
        </fieldset>
        <fieldset className="pin-appearance-colors">
          <legend>Color</legend>
          <div aria-label="Pin colors" role="group">
            {pinColorOptions.map((option) => <button aria-label={`${option.name}${color.toLowerCase() === option.value ? ", selected" : ""}`} aria-pressed={color.toLowerCase() === option.value} className="pin-appearance-color-swatch" disabled={saving} key={option.value} onClick={() => setColor(option.value)} style={{ "--swatch-color": option.value } as CSSProperties} title={option.name} type="button" />)}
            <label className="pin-appearance-custom-color"><span>Custom</span><input aria-label="Custom pin color" disabled={saving} onChange={(event) => setColor(event.target.value)} type="color" value={color} /></label>
          </div>
          <code>{color}</code>
        </fieldset>
        {error ? <p className="pin-appearance-error" role="alert">Could not save this pin. {error}</p> : null}
        <footer className="pin-appearance-actions"><button disabled={saving} onClick={onClose} type="button">Cancel</button><button className="pin-appearance-save" disabled={saving} type="submit">{saving ? "Saving…" : "Save pin style"}</button></footer>
      </form>
    </section>
  </div>;
}

function InboxView({
  account,
  automatedMessages,
  collection,
  errorMessage,
  errorStatus,
  inboxEyebrow,
  inboxFilter,
  inboxTitle,
  classificationView,
  classificationCounts,
  classificationLoading,
  classificationError,
  classificationActionError,
  classificationActionMessage,
  hasMoreMessages,
  isLoadingMoreMessages,
  isCollectionView,
  allMessages,
  attentionByAddress,
  activePin,
  messages,
  pins,
  pinnedPeople,
  pinnedSenderAddresses,
  currentViewLabel,
  reminders,
  personFilter,
  status,
  syncStatus,
  isRefreshing,
  onClearFilter,
  onSelectClassification,
  onLoadMoreMessages,
  onRetry,
  onClassificationChange,
  onCreatePin,
  onRemovePin,
  onReorderPin,
  onUpdatePin,
  onOpenThread,
  onPinPerson,
  onSelectPin,
  onRefresh,
  onAttentionChange,
  onInboxFilterChange,
  onOpenOrganizer,
  onFinishLater,
  onSnoozeLater,
  onRenameCollection,
  onSearchChange,
  onRemoveFromCollection,
  searchQuery,
  showInboxFilters,
  viewMode,
  rowRefs,
}: {
  account: MailAccount | null;
  automatedMessages: InboxMessage[];
  collection: Collection | null;
  errorMessage: string | null;
  errorStatus: number | null;
  inboxEyebrow: string;
  inboxFilter: InboxFilter;
  inboxTitle: string;
  classificationView: ClassificationView;
  classificationCounts: ClassificationCounts;
  classificationLoading: boolean;
  classificationError: string | null;
  classificationActionError: string | null;
  classificationActionMessage: string | null;
  hasMoreMessages: boolean;
  isLoadingMoreMessages: boolean;
  isCollectionView: boolean;
  currentViewLabel: string;
  allMessages: InboxMessage[];
  attentionByAddress: Record<string, AttentionBehavior>;
  activePin: Pin | null;
  messages: InboxMessage[];
  pins: Pin[];
  pinnedPeople: PersonItem[];
  pinnedSenderAddresses: Set<string>;
  reminders: Reminder[];
  personFilter: string | null;
  status: "loading" | "syncing" | "ready" | "error";
  syncStatus: SyncStatus | null;
  isRefreshing: boolean;
  onClearFilter: () => void;
  onSelectClassification: (view: ClassificationView) => void;
  onLoadMoreMessages: () => void;
  onRetry: () => void;
  onClassificationChange: (message: ClassificationMessage, target: ClassificationCorrectionTarget, classification: HumanClassification | "reset") => Promise<void>;
  onCreatePin: (input: PinInput) => void;
  onRemovePin: (pin: Pin) => void;
  onReorderPin: (pin: Pin, position: number) => void;
  onUpdatePin: (pin: Pin, patch: Partial<Pick<Pin, "label" | "icon" | "color">>) => Promise<void>;
  onOpenThread: (message: InboxMessage) => void;
  onPinPerson: (message: InboxMessage) => void;
  onSelectPin: (pin: Pin) => void;
  onRefresh: () => void;
  onAttentionChange: (address: string, behavior?: AttentionBehavior) => Promise<AttentionBehavior>;
  onInboxFilterChange: (filter: InboxFilter) => void;
  onOpenOrganizer: (message: InboxMessage) => void;
  onFinishLater: (reminder: Reminder) => void;
  onSnoozeLater: (message: InboxMessage, reminder: Reminder | null) => Promise<void>;
  onRenameCollection?: () => void;
  onSearchChange: (query: string) => void;
  onRemoveFromCollection?: (message: InboxMessage) => void;
  searchQuery: string;
  showInboxFilters: boolean;
  viewMode: "collection" | Mailbox;
  rowRefs: React.MutableRefObject<Map<string, HTMLButtonElement>>;
}) {
  const inboxFilters: Array<{ id: InboxFilter; label: string }> = [
    { id: "all", label: "Everything" },
    { id: "notify", label: "Notify me" },
    { id: "focus", label: "Keep in focus" },
    { id: "normal", label: "Flow" },
  ];
  const searchInputRef = useRef<HTMLInputElement>(null);
  const pinMenuRef = useRef<HTMLDivElement>(null);
  const pinMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const pinBuilderInputRef = useRef<HTMLInputElement>(null);
  const [snoozingThreadId, setSnoozingThreadId] = useState<string | null>(null);
  const [laterError, setLaterError] = useState<string | null>(null);
  const [sweptThreadIds, setSweptThreadIds] = useState<Set<string>>(new Set());
  const [pinMenuOpen, setPinMenuOpen] = useState(false);
  const [pinFilterMailbox, setPinFilterMailbox] = useState<PinMailbox>("inbox");
  const [pinFilterAttention, setPinFilterAttention] = useState<InboxFilter>("all");
  const [pinFilterPerson, setPinFilterPerson] = useState<string | null>(null);
  const [pinFilterQuery, setPinFilterQuery] = useState("");
  const [pinFilterIcon, setPinFilterIcon] = useState<PinIcon>("search");
  const [pinFilterColor, setPinFilterColor] = useState<string>(pinColorOptions[0].value);
  const displayMessages = useMemo(() => getStreamMessages(messages, viewMode, searchQuery).filter((message) => !sweptThreadIds.has(message.threadId)), [messages, searchQuery, sweptThreadIds, viewMode]);
  const pinPeople = useMemo(() => {
    const candidates = new Map<string, { email: string; name: string; unread: boolean }>();
    for (const message of allMessages) {
      const email = message.from.email.trim().toLowerCase();
      if (!email) continue;
      const current = candidates.get(email);
      candidates.set(email, { email, name: current?.name ?? message.from.name ?? email, unread: Boolean(current?.unread || message.unread) });
    }
    return [...candidates.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, 8);
  }, [allMessages]);
  const canPinCurrentView = !isCollectionView && viewMode !== "later";
  const pinFilter = useMemo<PinFilter>(() => ({
    mailbox: pinFilterMailbox,
    attention: pinFilterMailbox === "inbox" ? pinFilterAttention : "all",
    person: pinFilterPerson,
    query: pinFilterQuery.trim(),
  }), [pinFilterAttention, pinFilterMailbox, pinFilterPerson, pinFilterQuery]);
  const pinPreview = useMemo(() => {
    let candidates = getMessagesForMailbox(allMessages, pinFilter.mailbox, attentionByAddress);
    if (pinFilter.mailbox === "inbox" && pinFilter.attention !== "all") {
      candidates = candidates.filter((message) => (attentionByAddress[message.from.email.trim().toLowerCase()] ?? message.attentionBehavior) === pinFilter.attention);
    }
    if (pinFilter.person) candidates = candidates.filter((message) => messageIncludesPerson(message, pinFilter.person!));
    const matchingMessages = getStreamMessages(candidates, pinFilter.mailbox, pinFilter.query);
    return { count: matchingMessages.length, messages: matchingMessages.slice(0, 3) };
  }, [allMessages, attentionByAddress, pinFilter]);
  const selectedPinPerson = pinPeople.find((person) => person.email === pinFilter.person) ?? null;
  const pinFilterDisplayLabel = pinFilterLabel(pinFilter, selectedPinPerson?.name);
  const streamSectionLabels = useMemo(() => {
    const now = new Date();
    return displayMessages.map((message) => getStreamSectionLabel(message.receivedAt, now));
  }, [displayMessages]);
  const unreadCount = displayMessages.filter((message) => message.unread).length;
  const dateLabel = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(new Date());
  useEffect(() => {
    if (collection) return;
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, [collection]);

  useEffect(() => {
    if (!pinMenuOpen) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!pinMenuRef.current?.contains(event.target as Node)) setPinMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setPinMenuOpen(false);
      pinMenuTriggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [pinMenuOpen]);

  useEffect(() => {
    if (pinMenuOpen) window.requestAnimationFrame(() => pinBuilderInputRef.current?.focus());
  }, [pinMenuOpen]);

  function openPinBuilder() {
    setPinFilterMailbox(canPinCurrentView ? viewMode as PinMailbox : "inbox");
    setPinFilterAttention(viewMode === "inbox" ? inboxFilter : "all");
    setPinFilterPerson(personFilter);
    setPinFilterQuery(searchQuery);
    setPinFilterIcon("search");
    setPinFilterColor(pinColorOptions[pins.length % pinColorOptions.length]!.value);
    setPinMenuOpen(true);
  }

  function closePinBuilder() {
    setPinMenuOpen(false);
    pinMenuTriggerRef.current?.focus();
  }

  function savePinFilter(event: React.FormEvent) {
    event.preventDefault();
    if (!pinPreview.count) return;
    onCreatePin({ kind: "filter", targetId: JSON.stringify(pinFilter), label: pinFilterDisplayLabel, icon: pinFilterIcon, color: pinFilterColor });
    closePinBuilder();
  }

  async function snoozeLater(message: InboxMessage, reminder: Reminder | null) {
    setLaterError(null);
    setSnoozingThreadId(message.threadId);
    try {
      await onSnoozeLater(message, reminder);
    } catch (error) {
      setLaterError(`Could not snooze this message. ${getErrorMessage(error)}`);
    } finally {
      setSnoozingThreadId(null);
    }
  }
  return (
    <div className={`inbox-view inbox-view-${viewMode}${isCollectionView ? " inbox-view-collection" : ""}`}>
      <header className="pane-header">
        <div>
          <p className="stream-date">{viewMode === "collection" ? inboxEyebrow : viewMode === "later" ? "Messages waiting for a better moment" : dateLabel}</p>
          <div className="stream-title-line">
            <h1>{inboxTitle}</h1>
            <span>{unreadCount} unread · {pins.length} {pins.length === 1 ? "pin" : "pins"}</span>
            {activePin ? (
              <button aria-label={`Remove ${activePin.label} pin`} className="active-pin-action" onClick={() => onRemovePin(activePin)} type="button">
                Unpin
              </button>
            ) : null}
          </div>
          <p className="stream-context">{viewMode === "collection" && collection ? `Named by you · ${collection.threadIds.length} of ${collection.threadIds.length} threads here` : inboxEyebrow}</p>
        </div>
        {collection ? <div className="collection-view-actions"><button onClick={onRenameCollection} type="button">Rename</button><button onClick={() => { if (displayMessages[0]) onOpenThread(displayMessages[0]); }} type="button">Open latest thread</button></div> : null}
        {!collection ? <label className="stream-search"><span aria-hidden="true">⌕</span><input aria-label="Search the stream" onChange={(event) => onSearchChange(event.target.value)} placeholder="Search the stream…" ref={searchInputRef} value={searchQuery}/><kbd>⌘K</kbd></label> : null}
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

      {!collection ? <ClassificationTabs counts={classificationCounts} active={classificationView} loading={classificationLoading} onChange={onSelectClassification} /> : null}
      <div
        aria-labelledby={!collection ? `classification-tab-${classificationView}` : undefined}
        className="classification-panel"
        id={!collection ? "classification-panel" : undefined}
        role={!collection ? "tabpanel" : undefined}
        tabIndex={!collection ? 0 : undefined}
      >
        {classificationActionMessage ? <p className="classification-action-message" role="status">{classificationActionMessage}</p> : null}
        {classificationActionError ? <p className="classification-action-error" role="alert">{classificationActionError}</p> : null}
        {classificationError ? <p className="classification-action-error" role="alert">{classificationError}</p> : null}

        <nav aria-label="Saved pins" className="pinned-people">
        <PinRail pins={pins} pinnedPeople={pinnedPeople} inboxFilter={inboxFilter} personFilter={personFilter} searchQuery={searchQuery} viewMode={viewMode} onReorderPin={onReorderPin} onSelectPin={onSelectPin} onUpdatePin={onUpdatePin} />
        <div className="pinned-person-add-wrap" ref={pinMenuRef}>
          <button
            aria-controls="pin-builder"
            aria-expanded={pinMenuOpen}
            aria-haspopup="dialog"
            className="pinned-person-add"
            onClick={() => pinMenuOpen ? closePinBuilder() : openPinBuilder()}
            ref={pinMenuTriggerRef}
            type="button"
          >
            <span className="pinned-avatar">＋</span><small>Pin</small>
          </button>
          {pinMenuOpen ? (
            <div className="pin-builder-layer">
              <button aria-label="Close pin builder" className="pin-builder-backdrop" onClick={closePinBuilder} type="button" />
              <section aria-labelledby="pin-builder-title" aria-modal="true" className="pin-builder" id="pin-builder" role="dialog">
                <header className="pin-builder-heading">
                  <div><p>Keep a filter</p><h2 id="pin-builder-title">Pin anything you can find.</h2><span>Build a slice of mail, preview it, and keep it one click away.</span></div>
                  <button aria-label="Close pin builder" onClick={closePinBuilder} type="button">×</button>
                </header>
                <form onSubmit={savePinFilter}>
                  <label className="pin-builder-search">
                    <span>Search mail</span>
                    <input autoComplete="off" onChange={(event) => setPinFilterQuery(event.target.value)} placeholder="Try a subject, phrase, or sender…" ref={pinBuilderInputRef} value={pinFilterQuery} />
                  </label>
                  <div className="pin-builder-fields">
                    <label><span>View</span><select onChange={(event) => setPinFilterMailbox(event.target.value as PinMailbox)} value={pinFilterMailbox}>{pinMailboxOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
                    <label><span>Attention</span><select disabled={pinFilterMailbox !== "inbox"} onChange={(event) => setPinFilterAttention(event.target.value as InboxFilter)} value={pinFilterAttention}>{pinAttentionOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
                  </div>
                  <fieldset className="pin-builder-people">
                    <legend>Person filter <small>optional</small></legend>
                    <div>
                      <button aria-pressed={!pinFilterPerson} className={!pinFilterPerson ? "pin-builder-person-active" : ""} onClick={() => setPinFilterPerson(null)} type="button">Everyone</button>
                      {pinPeople.map((person) => <button aria-pressed={pinFilterPerson === person.email} className={pinFilterPerson === person.email ? "pin-builder-person-active" : ""} key={person.email} onClick={() => setPinFilterPerson(person.email)} type="button">{person.name}</button>)}
                    </div>
                  </fieldset>
                  <div className="pin-builder-presets">
                    <span>Quick start</span>
                    {canPinCurrentView ? <button onClick={() => { setPinFilterMailbox(viewMode as PinMailbox); setPinFilterAttention(viewMode === "inbox" ? inboxFilter : "all"); setPinFilterPerson(null); setPinFilterQuery(""); }} type="button">Use {currentViewLabel}</button> : null}
                    {pinPeople.slice(0, 3).map((person) => <button key={person.email} onClick={() => { setPinFilterPerson(person.email); setPinFilterQuery(""); }} type="button">{person.name}</button>)}
                  </div>
                  <fieldset className="pin-builder-appearance">
                    <legend>Pin style</legend>
                    <div className="pin-builder-icon-options" aria-label="Choose a pin icon" role="group">
                      {pinIconOptions.map((option) => <button aria-label={`${option.label}${pinFilterIcon === option.id ? ", selected" : ""}`} aria-pressed={pinFilterIcon === option.id} className={pinFilterIcon === option.id ? "pin-builder-icon-selected" : ""} key={option.id} onClick={() => setPinFilterIcon(option.id)} title={option.label} type="button"><span aria-hidden="true">{option.glyph}</span></button>)}
                    </div>
                    <label className="pin-builder-color-field"><span>Color</span><input aria-label="Pin color" onChange={(event) => setPinFilterColor(event.target.value)} type="color" value={pinFilterColor} /><code>{pinFilterColor}</code></label>
                  </fieldset>
                  <section aria-live="polite" className="pin-builder-preview">
                    <header><div><span>Preview</span><strong>{pinPreview.count} matching {pinPreview.count === 1 ? "thread" : "threads"}</strong></div><small>{pinFilterDisplayLabel}</small></header>
                    {pinPreview.messages.length ? (
                      <ul>
                        {pinPreview.messages.map((message) => {
                          const signature = getContactSignature(message.from);
                          return <li key={message.id}><span aria-hidden="true" className="pin-preview-avatar" style={{ background: signature.palette.bg, color: signature.palette.fg }}>{(message.from.name ?? message.from.email).split(/\s+/).map((part) => part[0]).join("").slice(0, 2)}</span><span><strong>{message.from.name ?? message.from.email}</strong><b>{message.subject || "(no subject)"}</b><small>{message.snippet}</small></span></li>;
                        })}
                      </ul>
                    ) : <p className="pin-builder-empty">No messages match yet. Try a broader search or another view.</p>}
                  </section>
                  <footer className="pin-builder-actions"><span>Saved as <strong>{pinFilterDisplayLabel}</strong></span><button onClick={closePinBuilder} type="button">Cancel</button><button className="pin-builder-save" disabled={!pinPreview.count} type="submit">Pin this filter</button></footer>
                </form>
              </section>
            </div>
          ) : null}
        </div>
        </nav>

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
          <InboxStatusState
            action={errorStatus === 404 ? <a className="empty-state-action" href="/login">Reconnect Gmail <span aria-hidden="true">→</span></a> : <button className="empty-state-action" onClick={onRetry} type="button">Try again <span aria-hidden="true">↻</span></button>}
            description={errorStatus === 404 ? "Your mailbox is safe, but this browser needs to reconnect to Gmail before Orca can open it." : errorMessage ?? "Please try again."}
            eyebrow="Could not open inbox"
            title={errorStatus === 404 ? "Reconnect to open your inbox." : "Your mailbox is safe—Orca just could not reach it."}
          />
        ) : null}

        {status === "ready" && displayMessages.length === 0 ? (
          <InboxStatusState
            description={
              searchQuery.trim()
                ? `No messages match “${searchQuery.trim()}”. Try a person, subject, or phrase.`
                : personFilter
                ? `No threads in your inbox include ${personFilter} yet.`
                : isCollectionView
                  ? "Use Add to collection on any conversation to add it here. Your inbox and attention placement will stay exactly as they are."
                  : "When synced mail arrives, your inbox list will appear here."
            }
            eyebrow={searchQuery.trim() || personFilter ? "No matches" : isCollectionView ? "Collection empty" : "Inbox empty"}
            title={searchQuery.trim() ? "Nothing found" : personFilter ? "Nothing from this person" : isCollectionView ? "Nothing saved here yet" : "No messages yet"}
          />
        ) : null}

        {status === "ready" && displayMessages.length > 0 ? (
          <ol className="message-list">
            {displayMessages.map((message, index) => {
              const signature = getContactSignature(message.from);
              const isReply = message.subject.trim().toLowerCase().startsWith("re:");
              const senderAddress = message.from.email.trim().toLowerCase();
              const senderPinned = pinnedSenderAddresses.has(senderAddress);
              const senderName = message.from.name ?? message.from.email;

              return (
                <li key={message.id}>
                  {index === 0 || streamSectionLabels[index] !== streamSectionLabels[index - 1] ? <div className="stream-section-label">{streamSectionLabels[index]}</div> : null}
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
                      <span aria-hidden="true" className={`stream-avatar stream-avatar-variant-${signature.variant}`} style={{ background: signature.palette.bg, color: signature.palette.fg }}>{(message.from.name ?? message.from.email).split(/\s+/).map((part) => part[0]).join("").slice(0, 2)}</span>
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
                    <ClassificationCorrection message={message} onCorrect={(target, classification) => onClassificationChange(message, target, classification)} compact />
                    {viewMode !== "later" ? <button
                      aria-label={senderPinned ? `${senderName} is pinned` : `Pin ${senderName}`}
                      aria-pressed={senderPinned}
                      className={`pin-sender-button${senderPinned ? " pin-sender-button-pinned" : ""}`}
                      disabled={senderPinned}
                      onClick={() => onPinPerson(message)}
                      title={senderPinned ? "Person pinned" : "Pin person"}
                      type="button"
                    >
                      <span aria-hidden="true">{senderPinned ? "✓" : "＋"}</span>
                      <span className="pin-sender-label">{senderPinned ? "Pinned" : "Pin"}</span>
                    </button> : null}
                    {viewMode !== "later" ? <button
                      className={`keep-thread-button${onRemoveFromCollection ? " keep-thread-button-remove" : ""}`}
                      onClick={() => onRemoveFromCollection ? onRemoveFromCollection(message) : onOpenOrganizer(message)}
                      type="button"
                    >
                      <span aria-hidden="true">{onRemoveFromCollection ? "−" : "＋"}</span> {onRemoveFromCollection ? "Remove" : "Keep"}
                    </button> : null}
                    {viewMode === "later" ? (() => {
                      const activeReminder = reminders.find((item) => item.threadId === message.threadId && (item.status === "scheduled" || item.status === "resurfaced"));
                      const snoozing = snoozingThreadId === message.threadId;
                      return <div className="later-row-actions"><span>◷ {activeReminder?.status === "resurfaced" ? "Ready now" : activeReminder ? `Returns ${formatReceivedAt(activeReminder.scheduledFor)}` : "Ready now"}</span>{activeReminder ? <button disabled={snoozing} onClick={() => onFinishLater(activeReminder)} type="button">Done</button> : null}<button aria-busy={snoozing || undefined} disabled={snoozing} onClick={() => void snoozeLater(message, activeReminder ?? null)} type="button">{snoozing ? "Snoozing…" : "Snooze"}</button></div>;
                    })() : null}
                    <SenderAttentionControl compact initialBehavior={message.attentionBehavior} message={message} onBehaviorChange={onAttentionChange} />
                  </div>
                </li>
              );
            })}
          </ol>
        ) : null}
        {laterError ? <p className="later-error" role="alert">{laterError}</p> : null}
        {hasMoreMessages ? <div className="classification-load-more"><button disabled={isLoadingMoreMessages} onClick={onLoadMoreMessages} type="button">{isLoadingMoreMessages ? "Loading more…" : searchQuery.trim() ? "Load more messages to search" : "Load more messages"}</button></div> : null}
        {status === "ready" && viewMode === "inbox" && !searchQuery.trim() && automatedMessages.length ? <section className="tideline-section" aria-label="Automated messages"><div className="tideline-label"><span /><strong><WaveGlyph /> Tideline</strong><small>machines and newsletters rest below</small><span /></div><div className="automation-summary"><span className="automation-mark">⌁</span><div><strong>{automatedMessages.length} automated threads</strong><small>{automatedMessages.map((message) => message.from.name ?? message.from.email).slice(0, 2).join(" · ")}</small></div><button onClick={() => onSelectClassification("tideline")} type="button">Review</button>{sweptThreadIds.size ? <button className="sweep-button" onClick={() => setSweptThreadIds(new Set())} type="button">Undo sweep</button> : <button className="sweep-button" onClick={() => setSweptThreadIds(new Set(automatedMessages.map((message) => message.threadId)))} type="button">◇ Sweep away</button>}</div>{sweptThreadIds.size ? <p className="tideline-local-note" role="status">{sweptThreadIds.size} thread{sweptThreadIds.size === 1 ? " is" : "s are"} hidden for this preview only. Nothing changed at Gmail or Outlook.</p> : null}</section> : null}
        </section>

        {errorMessage && status === "ready" ? (
          <p className="filter-chip-label" style={{ marginTop: 12 }}>
            {errorMessage} <a className="inbox-reconnect-link" href={errorStatus === 404 ? "/login" : "/settings/integrations/gmail"}>Reconnect Gmail</a>
          </p>
        ) : null}
      </div>
    </div>
  );
}

function SyncStatusChip({ status }: { status: SyncStatus["accounts"][number] | null }) {
  if (!status) return null;

  if (status.state === "auth_needed") {
    return (
      <a
        className="sync-status-chip sync-status-auth_needed inbox-reconnect-link"
        href="/settings/integrations/gmail"
      >
        Reconnect Gmail →
      </a>
    );
  }

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
  onClassificationChange = async () => {},
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
  onClassificationChange?: (message: ClassificationMessage, target: ClassificationCorrectionTarget, classification: HumanClassification | "reset") => Promise<void>;
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
          <span>Inbox</span>
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
            <p className="reader-kicker">Focus · {messages.length} {messages.length === 1 ? "message" : "messages"}</p>
            <h1 id="reader-title" ref={headingRef} tabIndex={-1}>{title}</h1>
            <p className="reader-participants">{formatThreadParticipants(detail.thread.participants, detail.account.email)} · you — over {messageGroups.length} {messageGroups.length === 1 ? "day" : "days"}</p>
            <div className="reader-top-actions"><RemindMeControl threadId={detail.thread.id} reminder={reminder} notifyByDefault={notifyByDefault} onSave={onSaveReminder} onFinish={onFinishReminder} /><button aria-label="Star conversation" type="button">☆</button><button aria-label="More conversation actions" type="button">•••</button></div>
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
                  {group.messages.map((message, index) => {
                    const signature = getContactSignature(message.from);
                    const plainBody = !message.bodyHtml && message.bodyText?.trim() ? splitQuotedContent(message.bodyText) : null;
                    const isNewest = message.id === newestMessage?.id;
                    const isFirstUnread = message.id === firstUnreadMessage?.id;
                    const isFirstInGroup = index === 0;
                    return (
                      <li className={`reader-message${message.unread ? " reader-message-unread" : ""}`} key={message.id}>
                        {isFirstUnread ? <div className={`reader-unread-divider${isFirstInGroup ? " reader-unread-divider-first" : ""}`} role="separator"><span>Unread messages</span></div> : null}
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
                      <time className="reader-sent-time" dateTime={message.receivedAt}>{formatReceivedAt(message.receivedAt)}</time>
                      <ClassificationCorrection message={message} onCorrect={(target, classification) => onClassificationChange(message, target, classification)} compact />
                      <SenderAttentionControl compact initialBehavior={fallbackAttentionByAddress.get(message.from.email.trim().toLowerCase()) ?? "normal"} reader message={message} onBehaviorChange={onAttentionChange} />
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
  error,
  onCreateCollection,
  onColorCollection,
  onDeleteCollection,
  onMoveCollection,
  onRenameCollection,
  onSelectCollection,
}: {
  activeCollectionId: string | null;
  collections: Collection[];
  error: string | null;
  onCreateCollection: (name: string) => Promise<Collection | null>;
  onColorCollection: (collection: Collection, color: string) => void;
  onDeleteCollection: (collection: Collection) => Promise<void>;
  onMoveCollection: (collection: Collection, direction: -1 | 1) => void;
  onRenameCollection: (collection: Collection, name: string) => void;
  onSelectCollection: (id: string) => void;
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
    <section className="collections-zone" aria-labelledby="collections-zone-title">
      <div className="keep-group collection-group">
        <div className="keep-group-heading">
          <h3 id="collections-zone-title">Collections</h3>
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
        <footer><span>Saved in {collections.filter((collection) => collection.threadIds.includes(message.threadId)).length} {collections.filter((collection) => collection.threadIds.includes(message.threadId)).length === 1 ? "collection" : "collections"} · elsewhere untouched</span><button onClick={onClose} type="button">Cancel</button><button className="organizer-keep" onClick={onClose} type="button">Keep thread</button></footer>
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
            aria-pressed={activePerson === item.filterValue}
            className={`person-row${activePerson === item.filterValue ? " person-row-active" : ""}`}
            key={item.filterValue}
            onClick={() => onSelectPerson(item.filterValue)}
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

function OutlookGlyph() {
  return (
    <svg aria-hidden="true" height="20" viewBox="0 0 24 24" width="20">
      <path d="M2 3.5h9v8.5H2z" fill="#f25022" />
      <path d="M12.5 3.5H22v8.5h-9.5z" fill="#7fba00" />
      <path d="M2 12.5h9v8H2z" fill="#00a4ef" />
      <path d="M12.5 12.5H22v8h-9.5z" fill="#ffb900" />
    </svg>
  );
}

function InboxStatusState({
  action,
  eyebrow,
  title,
  description,
}: {
  action?: ReactNode;
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className="empty-state">
      <p>{eyebrow}</p>
      <h2>{title}</h2>
      <span>{description}</span>
      {action ? <div className="empty-state-actions">{action}</div> : null}
    </div>
  );
}

export function getSelectedThreadAccountId(
  messages: InboxMessage[],
  selectedThreadId: string | null,
  selectedThreadAccountId: string | null,
) {
  if (!selectedThreadId) return null;
  return selectedThreadAccountId
    ?? messages.find((message) => message.threadId === selectedThreadId)?.accountId
    ?? null;
}

function toClassificationCounts(counts: InboxClassificationResponse["counts"]["classification"]): ClassificationCounts {
  return {
    likely_human: counts.likely_human,
    automated_or_bulk: counts.automated_or_bulk,
    uncertain: counts.uncertain + counts.unclassified,
    unclassified: counts.unclassified,
    all: counts.all,
  };
}

function applyLocalClassification(
  message: Pick<InboxMessage, "humanClassification" | "humanSignal">,
  classification: HumanClassification | "reset",
  override: NonNullable<NonNullable<InboxMessage["humanClassification"]>["userOverride"]> | null,
) {
  const automatic = message.humanClassification?.automatic;
  if (classification === "reset") {
    if (!automatic) return { humanSignal: null, humanClassification: null };
    return {
      humanSignal: automatic.score,
      humanClassification: {
        automatic,
        effective: { ...automatic, source: "automatic_heuristic" as const, userOverride: null },
        userOverride: null,
      },
    };
  }
  const effective = {
    classification,
    score: null,
    reasonCodes: override?.target.scope === "sender_address"
      ? ["user_sender_address_override" as const]
      : override?.target.scope === "sender_domain"
        ? ["user_sender_domain_override" as const]
        : ["user_message_override" as const],
    classifierVersion: null,
    source: "user_override" as const,
    userOverride: override,
  };
  return {
    humanSignal: null,
    humanClassification: {
      automatic: automatic ?? null,
      effective,
      userOverride: override,
    },
  };
}

function classificationTargetsEqual(
  left: ClassificationCorrectionTarget,
  right: ClassificationCorrectionTarget,
) {
  if (left.scope !== right.scope) return false;
  if (left.scope === "message") return left.messageId === right.messageId;
  if (left.scope === "sender_address") return left.address?.trim().toLowerCase() === right.address?.trim().toLowerCase();
  return left.domain?.trim().toLowerCase() === right.domain?.trim().toLowerCase();
}

function classificationOverridePriority(scope: ClassificationCorrectionTarget["scope"]) {
  return scope === "message" ? 3 : scope === "sender_address" ? 2 : 1;
}

function shouldApplyClassificationTarget(
  message: Pick<InboxMessage, "humanClassification">,
  target: ClassificationCorrectionTarget,
  classification: HumanClassification | "reset",
) {
  const existing = message.humanClassification?.userOverride ?? message.humanClassification?.effective.userOverride ?? null;
  if (classification === "reset") return Boolean(existing && classificationTargetsEqual(existing.target, target));
  if (!existing || classificationTargetsEqual(existing.target, target)) return true;
  return classificationOverridePriority(target.scope) > classificationOverridePriority(existing.target.scope);
}

export function getLatestThreadRows(messages: InboxMessage[]) {
  const latest = new Map<string, InboxMessage>();
  for (const message of messages) {
    const current = latest.get(message.threadId);
    if (!current || message.receivedAt.localeCompare(current.receivedAt) > 0 || (message.receivedAt === current.receivedAt && message.id.localeCompare(current.id) > 0)) {
      latest.set(message.threadId, message);
    }
  }
  return [...latest.values()].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt) || a.id.localeCompare(b.id));
}

export function mergeMessages(existing: InboxMessage[], incoming: InboxMessage[]) {
  const merged = new Map(existing.map((message) => [message.id, message]));
  for (const message of incoming) merged.set(message.id, message);
  return [...merged.values()];
}

export function buildThreadDetailRequest(message: Pick<InboxMessage, "threadId" | "accountId">) {
  return `/v1/threads/${encodeURIComponent(message.threadId)}?accountId=${encodeURIComponent(message.accountId)}`;
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

  if (!response.ok) throw await buildApiRequestError(response);

  return schema.parse(await response.json());
}

async function fetchNoContent(input: string, init: RequestInit, _acceptsJson = false) {
  const response = await fetch(input, { ...init, credentials: "include" });
  if (!response.ok) throw await buildApiRequestError(response);
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

export class ApiRequestError extends Error {
  constructor(readonly status: number, message: string, readonly code: string | null = null) {
    super(message);
  }
}

export function isSessionUnauthorizedError(error: unknown) {
  return error instanceof ApiRequestError && error.code === "unauthorized";
}

export function isTidelineMessage(message: InboxMessage) {
  return message.humanClassification?.effective.classification === "automated_or_bulk";
}

export function getStreamMessages(messages: InboxMessage[], viewMode: "collection" | Mailbox, query = "") {
  const normalizedQuery = query.trim().toLowerCase();
  const seen = new Set<string>();
  return messages.filter((message) => {
    if (seen.has(message.threadId)) return false;
    seen.add(message.threadId);
    if (!normalizedQuery) return true;
    return [message.from.name, message.from.email, message.subject, message.snippet]
      .filter((value): value is string => Boolean(value))
      .some((value) => value.toLowerCase().includes(normalizedQuery));
  });
}

export function getStreamSectionLabel(receivedAt: string, now = new Date()) {
  const received = new Date(receivedAt);
  if (Number.isNaN(received.getTime())) return "Date unavailable";
  const localDayNumber = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
  const difference = localDayNumber(now) - localDayNumber(received);
  if (difference <= 0) return "Today";
  if (difference === 1) return "Yesterday";
  if (difference < 7) return "Earlier this week";
  return "Older";
}

export function buildReminderSaveRequest(input: { threadId: string; scheduledFor: string; timezone: string; notify: boolean }, existingReminder?: Reminder | null) {
  if (!existingReminder) return { path: "/v1/reminders", method: "POST" as const, body: input };
  return {
    path: `/v1/reminders/${encodeURIComponent(existingReminder.id)}`,
    method: "PATCH" as const,
    body: { scheduledFor: input.scheduledFor, timezone: input.timezone, notify: input.notify },
  };
}

function parsePinFilterTarget(targetId: string): PinFilter | null {
  try {
    const parsed = pinFilterSchema.safeParse(JSON.parse(targetId));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function pinFilterLabel(filter: PinFilter, personName?: string | null) {
  const mailboxLabel = pinMailboxOptions.find((option) => option.id === filter.mailbox)?.label ?? filter.mailbox;
  const parts = [mailboxLabel];
  if (filter.attention !== "all") parts.push(pinAttentionOptions.find((option) => option.id === filter.attention)?.label ?? filter.attention);
  if (personName) parts.push(personName);
  if (filter.query) parts.push(`“${filter.query}”`);
  return parts.join(" · ");
}

function defaultPinIcon(kind: Pin["kind"]): PinIcon {
  if (kind === "sender") return "person";
  if (kind === "thread") return "thread";
  if (kind === "filter") return "search";
  return "grid";
}

function pinIconGlyph(icon: PinIcon) {
  return pinIconOptions.find((option) => option.id === icon)?.glyph ?? "•";
}

function pinTopBarMark(pin: Pin, person: PersonItem | null) {
  if (pin.icon === "person" && pin.kind === "sender") return person?.initials ?? pin.label.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
  return pinIconGlyph(pin.icon);
}

function pinTopBarLabel(pin: Pin, person: PersonItem | null) {
  if (pin.kind === "sender") return (person?.name ?? pin.label).split(/\s+/)[0] ?? pin.label;
  if (pin.kind !== "filter") return pin.label;
  const filter = parsePinFilterTarget(pin.targetId);
  if (!filter) return pin.label;
  const personLabel = filter.person ? (person?.name ?? filter.person.split("@")[0]) : null;
  const parts = [personLabel?.split(/\s+/)[0], filter.query ? `“${filter.query}”` : null].filter(Boolean);
  if (parts.length) return parts.join(" · ");
  return pinMailboxOptions.find((option) => option.id === filter.mailbox)?.label ?? filter.mailbox;
}

function isTopBarPinActive(pin: Pin, current: { inboxFilter: InboxFilter; personFilter: string | null; searchQuery: string; viewMode: "collection" | Mailbox }) {
  if (pin.kind === "sender") return current.personFilter?.trim().toLowerCase() === pin.targetId.trim().toLowerCase();
  if (pin.kind === "view") return current.viewMode === pin.targetId;
  if (pin.kind !== "filter") return false;
  const filter = parsePinFilterTarget(pin.targetId);
  if (!filter || current.viewMode !== filter.mailbox) return false;
  const samePerson = (current.personFilter ?? "").trim().toLowerCase() === (filter.person ?? "").trim().toLowerCase();
  return samePerson
    && current.searchQuery.trim() === filter.query
    && (filter.mailbox !== "inbox" || current.inboxFilter === filter.attention);
}

export function buildPinnedPeopleFromPins(pins: Pin[], messages: InboxMessage[]): PersonItem[] {
  const messagesByAddress = new Map<string, InboxMessage[]>();
  for (const message of messages) {
    const address = message.from.email.trim().toLowerCase();
    const current = messagesByAddress.get(address) ?? [];
    current.push(message);
    messagesByAddress.set(address, current);
  }
  return pins
    .filter((pin) => pin.kind === "sender")
    .slice()
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
    .map((pin) => {
      const address = pin.targetId.trim().toLowerCase();
      const senderMessages = messagesByAddress.get(address) ?? [];
      const latest = [...senderMessages].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))[0];
      const name = latest?.from.name ?? pin.label;
      return {
        initials: name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase(),
        name,
        filterValue: address,
        context: latest?.subject || address,
        unread: senderMessages.some((message) => message.unread),
      };
    });
}

function LoginRequiredScreen() {
  return (
    <main className="oauth-page login-required-page">
      <section className="login-required-shell">
        <div className="oauth-brand"><span className="oauth-brand-mark"><WaveGlyph /></span><span>Orca</span></div>
        <p className="oauth-eyebrow">A private workspace</p>
        <h1>Your inbox waits for its person.</h1>
        <p>Your session needs a quick refresh. Choose Gmail or Outlook to return to the inbox.</p>
        <a className="oauth-provider-button oauth-enter-button" href="/login">Choose a provider <span aria-hidden="true">→</span></a>
      </section>
    </main>
  );
}

function SessionCheckingScreen() {
  return (
    <main className="oauth-page login-required-page">
      <section className="login-required-shell" aria-live="polite">
        <div className="oauth-brand"><span className="oauth-brand-mark"><WaveGlyph /></span><span>Orca</span></div>
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

async function buildApiRequestError(response: Response) {
  const body = await readJsonObject(response);
  const error = body.error;
  const details = error && typeof error === "object" && !Array.isArray(error)
    ? error as Record<string, unknown>
    : {};
  const code = typeof details.code === "string" ? details.code : null;
  const message = typeof details.message === "string" && details.message.trim()
    ? details.message
    : `Request failed with ${response.status} ${response.statusText}`.trim();
  return new ApiRequestError(response.status, message, code);
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

function isOnboardingDevPreviewRoute() {
  return typeof window !== "undefined" && import.meta.env.DEV && window.location.pathname === "/dev/onboarding";
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
  const provider = params.get("provider") === "outlook" ? "outlook" : "gmail";

  if (status === "success") {
    return {
      provider,
      kind: "success",
      email: params.get("email"),
      intent: params.get("intent"),
    };
  }

  if (status === "error") {
    return {
      provider,
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

function createDemoThreadDetail(account: MailAccount, threadId: string, messages: InboxMessage[], sourceMessages = messages): ThreadDetail {
  const demoMessagesForThread = threadId === "thread_1"
    ? [...sourceMessages.filter((message) => message.threadId === threadId), ...demoThreadHistoryExtras].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))
    : sourceMessages.filter((message) => message.threadId === threadId).sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
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
      attention: { hasUnread: demoMessagesForThread.some((message) => message.unread), hasStarred: false, hasDraft: false, humanSignal: 10 },
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

const DEMO_READ_STATE_KEY = "orca-demo-read-threads";

function readDemoReadState(): Set<string> {
  try {
    const raw = window.localStorage.getItem(DEMO_READ_STATE_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

function writeDemoReadState(threadId: string) {
  const current = readDemoReadState();
  current.add(threadId);
  try {
    window.localStorage.setItem(DEMO_READ_STATE_KEY, JSON.stringify([...current]));
  } catch {
    // localStorage unavailable
  }
}

function replySubject(subject: string) {
  const trimmed = subject.trim();
  if (!trimmed) {
    return "Re: (no subject)";
  }

  return trimmed.toLowerCase().startsWith("re:") ? trimmed : `Re: ${trimmed}`;
}
