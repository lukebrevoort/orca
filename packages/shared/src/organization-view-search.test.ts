import { describe, expect, test } from "bun:test";
import { prepareMailSearchView, type MailSearchViewSource } from "./organization-view-search";

const all: MailSearchViewSource = { query: "", mailbox: "all", evidence: "all", accountId: null, collectionId: null };
describe("Search to live View translation", () => {
  test("preserves account and effective evidence without materializing message membership", () => {
    const result = prepareMailSearchView({ ...all, accountId: "work", evidence: "human" }, "/?search=mail");
    expect(result.definition).toEqual({ revision: 1, accountIds: ["work"], humanSignal: { classifications: ["likely_human"] } });
    expect(result.unsupportedClauses).toEqual([]);
    expect(result.source).toEqual({ kind: "search", label: "Search mail", returnTarget: "/?search=mail" });
    expect(result.identity.name).toBe("Likely human mail");
  });
  test("blocks every unrepresentable clause without silently retaining only supported parts", () => {
    const result = prepareMailSearchView({ ...all, query: 'from:maya 100%_\\ "hello"', mailbox: "focus", collectionId: "launch", accountId: "work" }, "/?search=mail");
    expect(result.definition).toEqual({ revision: 1, accountIds: ["work"] });
    expect(result.unsupportedClauses.map((clause) => clause.id)).toEqual(["search.query", "search.mailbox", "search.collection"]);
    expect(result.unsupportedClauses[0]?.reason).toContain('from:maya 100%_\\ "hello"');
  });
  test("omits only no-op clauses and keeps future account scope dynamic", () => {
    expect(prepareMailSearchView({ ...all, query: "  " }, "/").definition).toEqual({ revision: 1 });
    for (const [evidence, classifications] of [["human", ["likely_human"]], ["tideline", ["automated_or_bulk"]], ["uncertain", ["uncertain", "unclassified"]]] as const) {
      expect(prepareMailSearchView({ ...all, evidence }, "/").definition).toEqual({ revision: 1, humanSignal: { classifications: [...classifications] } });
    }
    for (const mailbox of ["inbox", "focus", "quiet", "hidden"] as const) {
      expect(prepareMailSearchView({ ...all, mailbox }, "/").unsupportedClauses.map((item) => item.id)).toEqual(["search.mailbox"]);
    }
  });
});
