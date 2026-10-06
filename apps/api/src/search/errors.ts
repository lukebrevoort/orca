export type SearchErrorCode = "search_not_activated" | "search_mode_changed" | "search_index_updating" | "search_index_blocked" | "search_index_unavailable" | "search_cursor_stale" | "search_invalid_cursor" | "search_busy" | "search_aborted" | "search_budget_exceeded" | "search_failed";
const messages: Record<SearchErrorCode, string> = {
  search_not_activated: "Full stored-mail search has not been activated. Metadata search is available.",
  search_mode_changed: "Search mode changed. Refresh search capabilities and restart your search.",
  search_index_updating: "Search is catching up with stored mail. Your query and scope are unchanged.",
  search_index_blocked: "Search indexing needs attention for an account in this scope. Inbox remains available.",
  search_index_unavailable: "The stored-mail search index is not available yet.",
  search_cursor_stale: "Stored mail changed. Restart this search to load a consistent set of results.",
  search_invalid_cursor: "The search continuation is invalid.",
  search_busy: "Search is busy. Please try again shortly.",
  search_aborted: "Search was cancelled.",
  search_budget_exceeded: "This search could not finish within its execution budget. Retry or add a more specific phrase.",
  search_failed: "Search could not complete. Please try again.",
};
export class SearchError extends Error {
  constructor(readonly code: SearchErrorCode) { super(messages[code]); this.name = "SearchError"; }
}
