import {
  growOrganizationViewSenders, organizationViewDefinitionSchema, organizationViewDraftInputSchema,
  organizationViewPreparationInputSchema, organizationViewSchema, organizationViewsFixture,
  type InboxMessage, type MailAccount, type OrganizationView, type OrganizationViewDefinition,
  type OrganizationViewDraftInput, type OrganizationViewPreparationInput,
  type OrganizationViewPreparationNotice, type OrganizationViewSelectedMessageReference,
} from "@orca/shared";
import { demoAccount, demoAgentMessages, demoMessages, demoThreadHistoryExtras } from "./demo-data";

export const demoSessionNotice = "Demonstration only. View changes last until this page is refreshed. No connected account is changed.";
export const demoSendNotice = "Demo send only — no real email is sent.";

type DemoThread = { account: MailAccount; messages: InboxMessage[]; latest: InboxMessage };
export type DemoViewEvaluation =
  | { status: "evaluated"; threads: DemoThread[]; count: number; detail: string }
  | { status: "unavailable" | "missing"; count: null; detail: string };
type ViewFields = Pick<OrganizationView, "name" | "description" | "color" | "position" | "definition" | "skipInbox">;

/** Exact sample references only: no positional substitution, provider lookups, or synthetic evidence. */
export function resolveDemoSenders(references: readonly OrganizationViewSelectedMessageReference[], messages: readonly InboxMessage[], accounts: readonly MailAccount[]) {
  const accountIds = [...new Set(references.map(reference => reference.accountId))];
  if (accountIds.length !== 1) throw new Error("Select sample messages from one account at a time.");
  const account = accounts.find(candidate => candidate.id === accountIds[0]);
  if (!account) throw new Error("The selected sample account is unavailable.");
  const addresses = new Set<string>();
  const seen = new Set<string>();
  let omittedCount = 0;
  for (const reference of references) {
    const key = JSON.stringify([reference.accountId, reference.threadId, reference.messageId]);
    if (seen.has(key)) continue;
    seen.add(key);
    const message = messages.find(candidate => candidate.accountId === reference.accountId && candidate.threadId === reference.threadId && candidate.id === reference.messageId);
    if (!message) throw new Error("A selected sample message is unavailable. Select it again.");
    const address = message.from.email.trim().toLowerCase();
    if (address === account.email.trim().toLowerCase()) omittedCount++;
    else addresses.add(address);
  }
  if (!addresses.size) throw new Error("Every selected sample message was sent by you. Select at least one incoming sender.");
  const definition = organizationViewDefinitionSchema.parse({ revision: 1, accountIds, sender: { addresses: [...addresses] } });
  const notices: OrganizationViewPreparationNotice[] = omittedCount ? [{ code: "self_sender_omitted", omittedCount, detail: `${omittedCount} selected sample message${omittedCount === 1 ? " was" : "s were"} sent by you and omitted.` }] : [];
  return { account, definition, notices };
}

/** Evaluates only evidence present in sample mail; unsupported metadata never becomes a zero. */
export function evaluateDemoDefinition(definition: OrganizationViewDefinition, messages: readonly InboxMessage[], accounts: readonly MailAccount[]): DemoViewEvaluation {
  if (definition.laneIds || definition.facetFilters || definition.contextFilters || definition.workflowStateIds)
    return { status: "unavailable", count: null, detail: "This sample mail has no Lane, Facet, Context, or Workflow evidence to evaluate these filters." };
  if (definition.accountIds?.some(id => !accounts.some(account => account.id === id)))
    return { status: "unavailable", count: null, detail: "Mail for this sample account is not available for evaluation." };
  const groups = new Map<string, DemoThread>();
  for (const message of messages) {
    const account = accounts.find(candidate => candidate.id === message.accountId);
    if (!account || (definition.accountIds && !definition.accountIds.includes(account.id))) continue;
    const key = JSON.stringify([account.id, message.threadId]);
    const group = groups.get(key);
    if (!group) groups.set(key, { account, messages: [message], latest: message });
    else {
      group.messages.push(message);
      if (message.receivedAt > group.latest.receivedAt) group.latest = message;
    }
  }
  const threads = [...groups.values()].filter(thread => {
    const filter = definition.thread;
    if (filter?.ids && !filter.ids.includes(thread.latest.threadId)) return false;
    if (filter?.subjectContains && !thread.messages[0]!.subject.toLowerCase().includes(filter.subjectContains.toLowerCase())) return false;
    if (filter?.readState && (thread.messages.some(message => message.unread) ? "unread" : "read") !== filter.readState) return false;
    return thread.messages.some(message => {
      const address = message.from.email.trim().toLowerCase();
      if (definition.sender && !(definition.sender.addresses?.includes(address) || definition.sender.domains?.includes(address.split("@")[1]!))) return false;
      if (definition.date?.receivedAfter && Date.parse(message.receivedAt) < Date.parse(definition.date.receivedAfter)) return false;
      if (definition.date?.receivedBefore && Date.parse(message.receivedAt) > Date.parse(definition.date.receivedBefore)) return false;
      const signal = definition.humanSignal;
      if (signal?.minimumScore !== undefined && (message.humanSignal === null || message.humanSignal < signal.minimumScore)) return false;
      if (signal?.maximumScore !== undefined && (message.humanSignal === null || message.humanSignal > signal.maximumScore)) return false;
      if (signal?.classifications && (!message.humanClassification || !signal.classifications.includes(message.humanClassification.effective.classification))) return false;
      if (signal?.evidenceReasonCodes && !signal.evidenceReasonCodes.some(code => message.humanClassification?.automatic?.reasonCodes.includes(code))) return false;
      return true;
    });
  }).sort((a, b) => b.latest.receivedAt.localeCompare(a.latest.receivedAt));
  return { status: "evaluated", threads, count: threads.length, detail: `${threads.length} matching sample Threads. Demonstration data only.` };
}

/** One page-lifetime store. Navigation/remount preserves it; refresh creates a fresh instance. */
export function createDemoStore(options: { views?: readonly OrganizationView[]; messages?: readonly InboxMessage[]; accounts?: readonly MailAccount[] } = {}) {
  const initialViews = structuredClone(options.views ?? organizationViewsFixture);
  const messages = structuredClone(options.messages ?? [...demoMessages, ...demoAgentMessages, ...demoThreadHistoryExtras]);
  const accounts = structuredClone(options.accounts ?? [demoAccount]);
  let views: OrganizationView[] = [...structuredClone(initialViews)];
  const listeners = new Set<() => void>();
  const publish = (next: OrganizationView[]) => { views = next; for (const listener of listeners) listener(); };
  const requireView = (id: string, revision?: number) => {
    const view = views.find(candidate => candidate.id === id);
    if (!view) throw new Error("This sample View no longer exists.");
    if (revision !== undefined && view.revision !== revision) throw new Error("This sample View changed. Reopen it before saving.");
    return view;
  };
  return {
    getSnapshot: () => views,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getView: (id: string) => views.find(view => view.id === id) ?? null,
    getAccounts: () => structuredClone(accounts),
    evaluate(id: string): DemoViewEvaluation {
      const view = views.find(candidate => candidate.id === id);
      return view ? evaluateDemoDefinition(view.definition, messages, accounts) : { status: "missing", count: null, detail: "This sample View no longer exists." };
    },
    prepare(input: OrganizationViewPreparationInput): { draft: OrganizationViewDraftInput; notices: OrganizationViewPreparationNotice[] } {
      const preparation = organizationViewPreparationInputSchema.parse(input);
      const saved = preparation.kind === "saved_view" ? requireView(preparation.viewId) : preparation.kind === "selected_senders" && preparation.targetView ? requireView(preparation.targetView.id, preparation.targetView.revision) : null;
      const selection = preparation.kind === "selected_senders" ? resolveDemoSenders(preparation.references, messages, accounts) : null;
      const definition = selection ? saved ? growOrganizationViewSenders(saved.definition, selection.account.id, selection.definition.sender!.addresses!) : selection.definition : preparation.kind === "typed_definition" ? preparation.definition : saved!.definition;
      return { draft: organizationViewDraftInputSchema.parse({
        mode: saved ? "update" : "create", viewId: saved?.id ?? null, viewRevision: saved?.revision ?? null,
        source: preparation.kind === "saved_view" ? { kind: "saved_view", label: saved!.name } : preparation.source,
        identity: saved ? { name: saved.name, description: saved.description, color: saved.color, position: saved.position } : preparation.kind !== "saved_view" ? preparation.identity : undefined,
        definition, skipInbox: saved?.skipInbox ?? (preparation.kind !== "saved_view" && preparation.skipInbox),
        unsupportedClauses: preparation.kind === "typed_definition" ? preparation.unsupportedClauses : [],
      }), notices: selection?.notices ?? [] };
    },
    create(fields: ViewFields) {
      const now = new Date().toISOString();
      const view = organizationViewSchema.parse({ ...fields, id: `view_demo_${crypto.randomUUID()}`, workspaceId: "workspace_demo", revision: 1, createdAt: now, updatedAt: now });
      publish([...views, view]); return view;
    },
    update(id: string, revision: number, patch: Partial<ViewFields>) {
      const current = requireView(id, revision);
      const view = organizationViewSchema.parse({ ...current, ...patch, id: current.id, workspaceId: current.workspaceId, createdAt: current.createdAt, revision: current.revision + 1, updatedAt: new Date().toISOString() });
      publish(views.map(candidate => candidate.id === id ? view : candidate)); return view;
    },
    remove(id: string, revision: number) { requireView(id, revision); publish(views.filter(view => view.id !== id)); },
    reset() { publish([...structuredClone(initialViews)]); },
  };
}

export const demoStore = createDemoStore();
