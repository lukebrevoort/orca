import { useEffect, useRef, useState } from "react";
import { attentionPreferencesSchema, mailAccountPageSchema, notificationSenderSchema, type AttentionPreferences, type MailAccount, type NotificationChoice } from "@orca/shared";
import { useOnlineStatus } from "./navigation";
import "./attention-page.css";

const demoAccounts: MailAccount[] = [{ id: "attention-demo", provider: "gmail", email: "luke@example.com", displayName: "Luke", capabilities: { read: true, draft: false, send: false } }];
const demoPreferences: AttentionPreferences = { accountId: "attention-demo", revision: 0, delivery: "proposal_only", defaultChoice: "quiet", senders: [
  { address: "maya@studio.co", choice: "notify" }, { address: "alex@work.co", choice: "notify" }, { address: "notifications@github.com", choice: "notify" }, { address: "hello@sundayedit.co", choice: "quiet" }, { address: "updates@figma.com", choice: "quiet" }, { address: "receipts@shop.co", choice: "quiet" },
] };
class RequestError extends Error { constructor(readonly status: number, message: string) { super(message); } }
async function request(path: string, init?: RequestInit) {
  const response = await fetch(path, { ...init, credentials: "include" });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new RequestError(response.status, body?.error?.message ?? "Could not load or save your choices.");
  }
  return response.json();
}
const label = (choice: NotificationChoice) => choice === "notify" ? "Notify me" : "Keep quiet";

export function AttentionPage({ demoMode = false, onAdvanced }: { demoMode?: boolean; onAdvanced: () => void }) {
  const online = useOnlineStatus();
  const [accounts, setAccounts] = useState<MailAccount[]>(demoMode ? demoAccounts : []);
  const [accountId, setAccountId] = useState(demoMode ? demoAccounts[0]!.id : "");
  const [accountsLoading, setAccountsLoading] = useState(!demoMode);
  const [preferences, setPreferences] = useState<AttentionPreferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [reload, setReload] = useState(0);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | NotificationChoice>("all");
  const [adding, setAdding] = useState(false);
  const [address, setAddress] = useState("");
  const [choice, setChoice] = useState<NotificationChoice>("notify");
  const [addError, setAddError] = useState("");
  const generation = useRef(0);
  const savingLock = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (demoMode) return;
    const controller = new AbortController();
    setAccountsLoading(true);
    void request("/v1/accounts", { signal: controller.signal }).then(raw => {
      if (controller.signal.aborted) return;
      const items = mailAccountPageSchema.parse(raw).items;
      setAccounts(items);
      setAccountId(current => items.some(item => item.id === current) ? current : items[0]?.id ?? "");
      setError("");
    }).catch(cause => { if (!controller.signal.aborted) setError(cause.message); })
      .finally(() => { if (!controller.signal.aborted) setAccountsLoading(false); });
    return () => controller.abort();
  }, [demoMode, reload]);

  useEffect(() => {
    const current = ++generation.current;
    const controller = new AbortController();
    setPreferences(null); if (accountId) setError(""); setStatus(""); setReadOnly(false); setStale(false); setSaving(false); savingLock.current = false;
    setAdding(false); setQuery(""); setFilter("all"); setLoading(Boolean(accountId));
    if (!accountId) return () => { ++generation.current; controller.abort(); };
    if (demoMode) { setPreferences(demoPreferences); setLoading(false); }
    else void request(`/v1/attention/preferences?accountId=${encodeURIComponent(accountId)}`, { signal: controller.signal }).then(raw => {
      if (current !== generation.current) return;
      const next = attentionPreferencesSchema.parse(raw);
      if (next.accountId !== accountId) throw new Error("The account changed. Reload your choices.");
      setPreferences(next);
    }).catch(cause => { if (current === generation.current && !controller.signal.aborted) setError(cause.message); })
      .finally(() => { if (current === generation.current) setLoading(false); });
    return () => { ++generation.current; controller.abort(); };
  }, [accountId, demoMode, reload]);

  useEffect(() => {
    if (adding) dialog.current?.showModal();
    else dialog.current?.close();
  }, [adding]);

  const locked = !online || readOnly || stale || saving || loading || accountsLoading || !preferences;
  async function save(next: Pick<AttentionPreferences, "senders" | "defaultChoice">): Promise<boolean> {
    if (locked || savingLock.current || !preferences) return false;
    savingLock.current = true; setSaving(true); setError(""); setStatus("");
    const current = generation.current;
    try {
      const result = demoMode ? { ...preferences, ...next, revision: preferences.revision + 1 } : attentionPreferencesSchema.parse(await request(`/v1/attention/preferences?accountId=${encodeURIComponent(accountId)}`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...next, expectedRevision: preferences.revision }),
      }));
      if (current !== generation.current) return false;
      if (result.accountId !== accountId) throw new Error("The account changed. Reload your choices.");
      setPreferences(result); setStatus(demoMode ? "Preview updated. Sample choices reset on reload." : "Choices saved. Mail notifications are not available yet.");
      return true;
    } catch (cause) {
      if (current !== generation.current) return false;
      if (cause instanceof RequestError && (cause.status === 401 || cause.status === 403)) setReadOnly(true);
      // An interrupted response may follow a successful server write. Require a reload before retrying.
      setStale(true);
      setError(`${cause instanceof Error ? cause.message : "The save could not be confirmed."} Showing your last loaded choices. Reload to check the saved version.`);
      return false;
    } finally { if (current === generation.current) { savingLock.current = false; setSaving(false); } }
  }
  const account = accounts.find(item => item.id === accountId);
  const visible = preferences?.senders.filter(sender => (filter === "all" || sender.choice === filter) && sender.address.includes(query.trim().toLowerCase())) ?? [];
  function closeAdd() { setAdding(false); addButton.current?.focus(); }

  return <section className="simple-attention" aria-labelledby="simple-attention-title" aria-busy={loading || saving || accountsLoading}>
    <header className="simple-attention-intro"><span>Your attention, your choice</span><h1 id="simple-attention-title">A little less noise.<br />Room for what matters.</h1><p>Choose whose mail you want to hear about.<br />Everything stays here, ready when you are.</p></header>
    <div className="simple-attention-account"><label>For account <select aria-label="Attention account" value={accountId} disabled={accountsLoading || saving || !accounts.length} onChange={event => setAccountId(event.target.value)}>{!accounts.length ? <option value="">No connected account</option> : accounts.map(item => <option key={item.id} value={item.id}>{item.email}</option>)}</select></label><button onClick={onAdvanced} type="button">Advanced organization ↗</button></div>
    <p className="simple-attention-notice">{demoMode ? "Design preview · Sample choices reset on reload. " : ""}These choices are saved for later. Mail notifications are not available yet.</p>
    {!online ? <p role="status">You’re offline. Reconnect to load or save choices.</p> : null}
    {readOnly ? <p role="status">Read-only. Sign in with access to this account to edit its choices.</p> : null}
    {error ? <p className="simple-attention-error" role="alert">{error} <button disabled={!online || saving} onClick={() => setReload(value => value + 1)} type="button">Reload choices</button></p> : null}
    {accountsLoading || loading ? <p role="status">Loading your choices…</p> : !accounts.length ? <p>Connect an account to start choosing your senders. <a href="/settings/integrations/gmail">Connected accounts →</a></p> : null}
    <div className="simple-attention-choices" aria-label="Filter senders by notification choice">{(["notify", "quiet"] as const).map(item => <button key={item} aria-pressed={filter === item} onClick={() => setFilter(filter === item ? "all" : item)} type="button"><span aria-hidden="true">{item === "notify" ? <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Z" /><path d="M10 21h4" /></svg> : "☾"}</span><small>{preferences?.senders.filter(sender => sender.choice === item).length ?? 0} senders</small><strong>{label(item)}</strong><p>{item === "notify" ? "Mail you want to hear about as it arrives." : "Read it on your own time."}</p></button>)}</div>
    <div className="simple-attention-list-heading"><h2>Your senders</h2><button ref={addButton} disabled={locked || (preferences?.senders.length ?? 0) >= 1000} onClick={() => { setAddress(""); setChoice("notify"); setAddError(""); setAdding(true); }} type="button">+ Add sender</button></div>
    <div className="simple-attention-search"><input aria-label="Search senders" placeholder="Find an email address" type="search" value={query} onChange={event => setQuery(event.target.value)} /><button aria-pressed={filter === "all"} onClick={() => setFilter("all")} type="button">All senders</button></div>
    <div className="simple-attention-rows">{visible.map(sender => <div className="simple-attention-row" key={sender.address}><span className="simple-attention-avatar" aria-hidden="true">{sender.address.slice(0, 1).toUpperCase()}</span><strong>{sender.address}</strong><label><span>{label(sender.choice)}</span><input role="switch" type="checkbox" aria-label={`Notify me about mail from ${sender.address}`} checked={sender.choice === "notify"} disabled={locked} onChange={event => { const nextChoice = event.target.checked ? "notify" : "quiet"; void save({ defaultChoice: preferences!.defaultChoice, senders: preferences!.senders.map(item => item.address === sender.address ? { ...item, choice: nextChoice } : item) }); }} /></label></div>)}</div>
    {preferences && !visible.length ? <p className="simple-attention-empty">{preferences.senders.length ? "No senders match your search and filter." : "Start with someone whose mail matters to you."}{preferences.senders.length ? <button onClick={() => { setQuery(""); setFilter("all"); }} type="button">Clear filters</button> : null}</p> : null}
    <div className="simple-attention-default"><div><h2>Everyone else</h2><p>For senders who aren’t on your list.</p></div><select aria-label="Notification choice for unlisted senders" disabled={locked} value={preferences?.defaultChoice ?? "quiet"} onChange={event => void save({ senders: preferences!.senders, defaultChoice: event.target.value as NotificationChoice })}><option value="quiet">Keep quiet</option><option value="notify">Notify me</option></select></div>
    <p className="simple-attention-footnote">These choices never move or delete mail.</p><p role="status">{saving ? "Saving your choices…" : status}</p>
    <dialog className="simple-attention-dialog" ref={dialog} aria-labelledby="attention-add-title" onCancel={() => setAdding(false)} onClose={() => setAdding(false)}><form onSubmit={async event => { event.preventDefault(); const parsed = notificationSenderSchema.safeParse({ address, choice }); if (!parsed.success) { setAddError("Enter a valid email address."); return; } if (preferences?.senders.some(sender => sender.address === parsed.data.address)) { setAddError("This sender is already on your list. Change their choice there."); return; } if (preferences && await save({ defaultChoice: preferences.defaultChoice, senders: [...preferences.senders, parsed.data] })) { setQuery(""); setFilter("all"); closeAdd(); } else setAddError("Could not confirm this save. Close this form and reload your choices."); }}>
      <h2 id="attention-add-title">Add a sender</h2><p>Save a choice for mail to {account?.email}.</p><label>Email address<input autoFocus type="email" required maxLength={254} value={address} onChange={event => setAddress(event.target.value)} /></label><label>Your choice<select value={choice} onChange={event => setChoice(event.target.value as NotificationChoice)}><option value="notify">Notify me</option><option value="quiet">Keep quiet</option></select></label>{addError ? <p role="alert">{addError}</p> : null}<footer><button onClick={closeAdd} type="button">Cancel</button><button disabled={locked} type="submit">{saving ? "Saving…" : "Add sender"}</button></footer>
    </form></dialog>
  </section>;
}
