import { organizationViewPreparationInputSchema, type OrganizationViewDefinition, type OrganizationViewPreparationInput, type OrganizationViewUnsupportedClause } from "./organization-views";

/** The complete predicate state of global Search; navigation and result IDs are deliberately absent. */
export type MailSearchViewSource = {
  query: string;
  mailbox: "inbox" | "focus" | "quiet" | "hidden" | "all";
  evidence: "human" | "tideline" | "uncertain" | "all";
  accountId: string | null;
  collectionId: string | null;
};

export function prepareMailSearchView(search: MailSearchViewSource, returnTarget: string): Extract<OrganizationViewPreparationInput, { kind: "typed_definition" }> {
  const definition: OrganizationViewDefinition = { revision: 1 };
  if (search.accountId) definition.accountIds = [search.accountId];
  if (search.evidence !== "all") definition.humanSignal = { classifications: search.evidence === "human" ? ["likely_human"] : search.evidence === "tideline" ? ["automated_or_bulk"] : ["uncertain", "unclassified"] };
  const unsupportedClauses: OrganizationViewUnsupportedClause[] = [];
  if (search.query.trim()) unsupportedClauses.push({ id: "search.query", label: "General text search", reason: `“${search.query.trim()}” searches sender name/address, message subject and snippet. A subject-only View changes this meaning. Replace explicitly or remove this clause.` });
  if (search.mailbox !== "all") unsupportedClauses.push({ id: "search.mailbox", label: `Mailbox: ${search.mailbox}`, reason: "Mailbox attention behavior has no equivalent View predicate. An Organization Lane is different. Remove this restriction explicitly or return to Search." });
  if (search.collectionId) unsupportedClauses.push({ id: "search.collection", label: "Space membership", reason: `Space ${search.collectionId} has live collection membership, which Views cannot represent. Remove explicitly or return to Search; current member IDs will never be saved.` });
  const name = search.query.trim() ? `Search · ${search.query.trim()}` : search.evidence === "human" ? "Likely human mail" : search.evidence === "tideline" ? "Automated or bulk mail" : search.evidence === "uncertain" ? "Mail needing review" : "Account mail";
  return organizationViewPreparationInputSchema.parse({ kind: "typed_definition", source: { kind: "search", label: "Search mail", returnTarget }, identity: { name: name.slice(0, 120) }, definition, unsupportedClauses }) as Extract<OrganizationViewPreparationInput, { kind: "typed_definition" }>;
}
