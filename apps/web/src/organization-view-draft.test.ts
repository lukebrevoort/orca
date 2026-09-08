import { expect, test } from "bun:test";
import { hydrateViewDraft, materializeViewDraft } from "./organization-view-draft";

test("unrelated refinements preserve advanced scalar types, ordering and timestamp precision without a catalog", () => {
  const definition = { revision: 1 as const, facetFilters: [{ facetId: "amount", operator: "equals" as const, value: 42 }, { facetId: "flag", operator: "equals" as const, value: false }], contextFilters: [{ context: { contextTypeId: "project", contextId: "orca" }, relationshipTypeId: "rel", direction: "context_to_thread" as const }], humanSignal: { maximumScore: 8, classifications: ["likely_human" as const] }, sender: { addresses: ["z@example.com", "a@example.com"], domains: ["example.org"] }, date: { receivedAfter: "2026-01-01T01:02:03.456Z" }, thread: { ids: ["t2", "t1"] } };
  const state = hydrateViewDraft(definition);
  expect(materializeViewDraft(state, [])).toEqual(definition);
  expect(materializeViewDraft({ ...state, subjectContains: "launch", activeClauses: [...state.activeClauses, "subject"] }, [])).toEqual({ ...definition, thread: { ids: ["t2", "t1"], subjectContains: "launch" } });
});
