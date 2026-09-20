import { describe, expect, test } from "bun:test";
import { organizationViewPreparationInputSchema, organizationViewsFixture, type InboxMessage } from "@orca/shared";
import { createDemoStore, evaluateDemoDefinition, resolveDemoSenders } from "./demo-store";
import { demoAccount, demoMessages, demoThreadHistoryExtras } from "./demo-data";

const mom = demoMessages.find(message => message.from.name === "Mom")!;
const maya = demoMessages.find(message => message.from.email === "maya@example.com")!;
const self = demoMessages.find(message => message.from.email === demoAccount.email)!;
const reference = (message: InboxMessage) => ({ accountId: message.accountId, threadId: message.threadId, messageId: message.id });
const selected = (messages: InboxMessage[], targetView?: { id: string; revision: number }) => organizationViewPreparationInputSchema.parse({ kind: "selected_senders", source: { kind: "sender_selection", label: "Selected sample senders" }, identity: { name: "Family" }, references: messages.map(reference), targetView });

describe("truthful sample sender preparation", () => {
  test("Mom resolves her actual account and address, never the deploy fixture", () => {
    const { draft } = createDemoStore().prepare(selected([mom]));
    expect(draft.definition.accountIds).toEqual([demoAccount.id]);
    expect(draft.definition.sender?.addresses).toEqual([mom.from.email]);
    expect(draft.definition.sender?.addresses).not.toContain("deploy@status.example.com");
  });
  test("deduplicates senders and omits only real self messages", () => {
    const followup = demoThreadHistoryExtras.find(message => message.from.email === maya.from.email)!;
    const { draft, notices } = createDemoStore().prepare(selected([maya, followup, self]));
    expect(draft.definition.sender?.addresses).toEqual([maya.from.email]);
    expect(notices[0]?.omittedCount).toBe(1);
    expect(createDemoStore().prepare(selected([mom])).notices).toEqual([]);
    expect(() => createDemoStore().prepare(selected([self]))).toThrow("incoming sender");
  });
  test("rejects unavailable/mismatched references and mixed accounts", () => {
    for (const bad of [{ ...reference(mom), threadId: maya.threadId }, { ...reference(mom), messageId: "missing" }, { ...reference(mom), accountId: "account_gmail" }]) {
      expect(() => resolveDemoSenders([bad], demoMessages, [demoAccount])).toThrow();
    }
    expect(() => resolveDemoSenders([reference(mom), { ...reference(maya), accountId: "other" }], demoMessages, [demoAccount])).toThrow("one account");
  });
});

describe("page-session canonical demo views", () => {
  test("create/reopen/edit/switch returns current membership and explicit empty states", () => {
    const store = createDemoStore();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => notifications++);
    const draft = store.prepare(selected([mom])).draft;
    const created = store.create({ ...draft.identity, definition: draft.definition, skipInbox: true });
    expect(store.getSnapshot()).toContain(created);
    expect(store.prepare({ kind: "saved_view", viewId: created.id }).draft.definition).toEqual(draft.definition);
    const results = store.evaluate(created.id);
    expect(results.status).toBe("evaluated");
    if (results.status === "evaluated") {
      expect(results.count).toBe(results.threads.length);
      expect(results.threads.map(thread => thread.latest.threadId)).toContain(mom.threadId);
    }
    const empty = store.create({ ...draft.identity, definition: { revision: 1, sender: { addresses: ["nobody@example.net"] } }, skipInbox: false });
    expect(store.evaluate(empty.id).count).toBe(0);
    expect(store.evaluate(created.id).count).toBeGreaterThan(0);
    const edited = store.update(created.id, created.revision, { name: "Renamed family", definition: empty.definition });
    expect(store.getView(created.id)?.name).toBe("Renamed family");
    expect(store.evaluate(created.id).count).toBe(0);
    expect(() => store.update(created.id, created.revision, { name: "Stale" })).toThrow("changed");
    store.remove(created.id, edited.revision);
    expect(store.evaluate(created.id).status).toBe("missing");
    expect(() => store.prepare({ kind: "saved_view", viewId: created.id })).toThrow("no longer exists");
    expect(notifications).toBe(4);
    unsubscribe();
    store.reset();
    expect(store.getSnapshot()).toEqual(organizationViewsFixture);
    expect(createDemoStore().getView(empty.id)).toBeNull();
  });
  test("growth requires an explicit eligible target and preserves domains and other filters", () => {
    const store = createDemoStore();
    const draft = store.prepare(selected([mom])).draft;
    const created = store.create({ ...draft.identity, skipInbox: true, definition: { ...draft.definition, sender: { ...draft.definition.sender, domains: ["family.example"] }, thread: { readState: "unread" } } });
    const grown = store.prepare(selected([maya], { id: created.id, revision: created.revision })).draft;
    expect(grown.definition.sender).toEqual({ addresses: [mom.from.email, maya.from.email], domains: ["family.example"] });
    expect(grown.definition.thread).toEqual(created.definition.thread);
    expect(grown.skipInbox).toBe(true);
    expect(grown.identity.name).toBe(created.name);
    expect(() => store.prepare(selected([maya], { id: created.id, revision: 42 }))).toThrow("changed");
    for (const fixture of organizationViewsFixture) expect(() => store.prepare(selected([mom], { id: fixture.id, revision: fixture.revision }))).toThrow();
  });
  test("missing metadata/account evidence produces unknown counts, not false zeroes", () => {
    const store = createDemoStore();
    for (const view of organizationViewsFixture) {
      expect(store.evaluate(view.id).status).toBe("unavailable");
      expect(store.evaluate(view.id).count).toBeNull();
    }
  });
  test("sender domains are ORed; sender/date/signal must share a message witness", () => {
    const evaluate = (definition: Parameters<typeof evaluateDemoDefinition>[0]) => evaluateDemoDefinition(definition, [maya, { ...self, humanSignal: 10 }], [demoAccount]);
    expect(evaluate({ revision: 1, sender: { addresses: ["absent@example.net"], domains: ["example.com"] } }).count).toBe(1);
    expect(evaluate({ revision: 1, sender: { addresses: [maya.from.email] }, humanSignal: { minimumScore: 10 } }).count).toBe(0);
    expect(evaluate({ revision: 1, sender: { addresses: [maya.from.email] }, date: { receivedAfter: self.receivedAt } }).count).toBe(0);
  });
  test("missing classification is not invented to satisfy a filter", () => {
    const result = evaluateDemoDefinition({ revision: 1, humanSignal: { classifications: ["likely_human"] } }, [{ ...mom, humanClassification: null }], [demoAccount]);
    expect(result.count).toBe(0);
  });
});
