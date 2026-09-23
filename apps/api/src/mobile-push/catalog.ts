import type { Database } from "bun:sqlite";

import { inboxDestinationId } from "../organization/views/inbox-policy.ts";

export type NotificationSpaceKind = "destination" | "collection" | "view";
export type NotificationSpace = { id: string; kind: NotificationSpaceKind; name: string; color: string };
export type NotificationSpaceReference = { id: string; kind: NotificationSpaceKind; resourceId: string };

export class NotificationSelectionError extends Error {
  constructor(message: string) { super(message); this.name = "NotificationSelectionError"; }
}

export function parseNotificationSpaceId(id: string): NotificationSpaceReference | null {
  const separator = id.indexOf(":");
  if (separator <= 0 || separator === id.length - 1) return null;
  const kind = id.slice(0, separator);
  if (kind !== "destination" && kind !== "collection" && kind !== "view") return null;
  return { id, kind, resourceId: id.slice(separator + 1) };
}

export function listNotificationSpaces(sqlite: Database, userId: string): NotificationSpace[] {
  const inboxId = inboxDestinationId(sqlite, userId);
  const destinations = sqlite.query(`SELECT id,name,color FROM organization_lanes
    WHERE workspace_id=? AND retired_at IS NULL AND id<>? ORDER BY position,id`)
    .all(userId, inboxId ?? "") as Array<{ id: string; name: string; color: string }>;
  const collections = sqlite.query(`SELECT c.id,c.name,c.color FROM collections c
    JOIN oauth_accounts a ON a.id=c.account_id WHERE a.user_id=? ORDER BY a.id,c.position,c.id`)
    .all(userId) as Array<{ id: string; name: string; color: string }>;
  const views = sqlite.query(`SELECT id,name,color FROM organization_views WHERE workspace_id=? ORDER BY position,id`)
    .all(userId) as Array<{ id: string; name: string; color: string }>;
  return [
    ...destinations.map((space) => ({ ...space, id: `destination:${space.id}`, kind: "destination" as const })),
    ...collections.map((space) => ({ ...space, id: `collection:${space.id}`, kind: "collection" as const })),
    ...views.map((space) => ({ ...space, id: `view:${space.id}`, kind: "view" as const })),
  ];
}

export function resolveNotificationSpaceSelection(sqlite: Database, userId: string, spaceIds: readonly string[]) {
  const available = new Map(listNotificationSpaces(sqlite, userId).map((space) => [space.id, space]));
  return spaceIds.map((id) => {
    const parsed = parseNotificationSpaceId(id);
    if (!parsed || !available.has(id)) throw new NotificationSelectionError(`Notification Space is unavailable: ${id}`);
    return parsed;
  });
}
