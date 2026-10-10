import type { Database } from "bun:sqlite";
import { organizationViewDefinitionSchema } from "@orca/shared";
import { threadMatchPredicate } from "./thread-predicate.ts";

/** Matches the catalog's displayed Inbox identity, including an explicit normal mapping. */
export function inboxDestinationId(sqlite: Database, workspaceId: string): string | null {
  return (sqlite.query(`SELECT coalesce(
    (SELECT destination_id FROM organization_destination_legacy WHERE workspace_id=? AND behavior='normal'),
    (SELECT fallback_lane_id FROM organization_workspace_lane_settings WHERE workspace_id=?)
  ) id`).get(workspaceId, workspaceId) as { id: string | null }).id;
}

/** SQL over the caller's email and effective-destination aliases; never changes placement. */
export function inboxVisibilityPredicate(sqlite: Database, workspaceId: string, destinationAlias = "destination") {
  const inboxId = inboxDestinationId(sqlite, workspaceId);
  const views = sqlite.query("SELECT definition FROM organization_views WHERE workspace_id=? AND skip_inbox=1 ORDER BY id").all(workspaceId) as Array<{ definition: string }>;
  if (!inboxId || !views.length) return { sql: "1", params: [] as Array<string | number> };
  const accountIds = (sqlite.query("SELECT id FROM oauth_accounts WHERE user_id=? ORDER BY id").all(workspaceId) as Array<{ id: string }>).map(row => row.id);
  const matches = views.map(row => {
    const definition = organizationViewDefinitionSchema.parse(JSON.parse(row.definition));
    // Removed accounts cannot match, and must not prevent remaining owned accounts matching.
    if (definition.accountIds) {
      const owned = definition.accountIds.filter(id => accountIds.includes(id));
      if (!owned.length) return { sql: "0", params: [] as Array<string | number> };
      definition.accountIds = owned;
    }
    const predicate = threadMatchPredicate({ workspaceId, accountIds }, { definition });
    return {
      sql: `EXISTS (SELECT 1 FROM threads t JOIN oauth_accounts oa ON oa.id=t.account_id
        JOIN organization_thread_lane_states lane ON lane.workspace_id=oa.user_id AND lane.account_id=t.account_id AND lane.thread_id=t.id
        WHERE t.account_id=${destinationAlias}.account_id AND t.id=${destinationAlias}.thread_id AND ${predicate.conditions.join(" AND ")})`,
      params: predicate.params,
    };
  });
  return {
    sql: `(${destinationAlias}.destination_id <> ? OR ${destinationAlias}.source IN ('conversation','safety_lock') OR ${destinationAlias}.locked=1 OR NOT (${matches.map(match => match.sql).join(" OR ")}))`,
    params: [inboxId, ...matches.flatMap(match => match.params)],
  };
}

export const latestThreadMessageSql = `e.id=(select latest.id from emails latest where latest.account_id=e.account_id and latest.thread_id=e.thread_id order by latest.received_at desc,latest.created_at desc,latest.id asc limit 1)`;
// Gmail's INBOX label is authoritative when its provider catalog is available.
// Outlook sync is not implemented; do not infer folder membership from categories.
export const providerInboxSql = `not exists (select 1 from labels inbox_label where inbox_label.account_id=e.account_id and inbox_label.provider_label_id='INBOX') or exists (
  select 1 from emails inbox_email join email_labels inbox_link on inbox_link.email_id=inbox_email.id
  join labels inbox_label on inbox_label.id=inbox_link.label_id
  where inbox_email.account_id=e.account_id and inbox_email.thread_id=e.thread_id and inbox_label.account_id=e.account_id and inbox_label.provider_label_id='INBOX')`;
