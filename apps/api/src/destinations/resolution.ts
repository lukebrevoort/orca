import { sql } from "drizzle-orm";
import type { DestinationResolution, AttentionRoutingTarget } from "@orca/shared";
import type { createDatabaseClient } from "../db/client.ts";
type Db = ReturnType<typeof createDatabaseClient>["db"];
export function readThreadDestination(db: Db, workspaceId: string, accountId: string, threadId: string): DestinationResolution | null {
    const row = db.all<{
        destination_id: string;
        source: DestinationResolution["source"];
        locked: number;
    }>(sql `select destination_id, source, locked from organization_effective_destinations where workspace_id=${workspaceId} and account_id=${accountId} and thread_id=${threadId}`)[0];
    return row ? { destinationId: row.destination_id, source: row.source, locked: Boolean(row.locked), reason: row.locked ? "Protected conversation placement" : `Placement from ${row.source}` } : null;
}
export function resolveDestination(db: Db, workspaceId: string, accountId: string, address = "", threadId?: string, skip?: AttentionRoutingTarget["scope"]): DestinationResolution {
    address = address.trim().toLowerCase();
    const fallback = db.all<{
        id: string;
    }>(sql `select fallback_lane_id id from organization_workspace_lane_settings where workspace_id=${workspaceId}`)[0]!.id;
    const bindings = db.all<{
        scope: string;
        value: string;
        destinationId: string | null;
    }>(sql `select scope,value,destination_id destinationId from organization_destination_bindings where workspace_id=${workspaceId} and account_id=${accountId}`);
    const binding = (scope: string, value: string) => bindings.find(b => b.scope === scope && b.value === value);
    const legacy = (behavior: string) => db.all<{
        id: string;
    }>(sql `select destination_id id from organization_destination_legacy where workspace_id=${workspaceId} and behavior=${behavior}`)[0]?.id ?? fallback;
    const result = (destinationId: string, source: DestinationResolution["source"], locked = false): DestinationResolution => ({ destinationId, source, locked, reason: locked ? "Protected conversation placement" : `Placement from ${source}` });
    const placement = threadId ? db.all<{
        primary_lane_id: string;
        manual_override_lane_id: string | null;
        safety_locked: number;
        safety_lock_lane_id: string | null;
        placement_source: string;
    }>(sql `select * from organization_thread_lane_states where workspace_id=${workspaceId} and account_id=${accountId} and thread_id=${threadId}`)[0] : undefined;
    if (placement?.safety_locked)
        return result(placement.safety_lock_lane_id ?? placement.manual_override_lane_id ?? placement.primary_lane_id, "safety_lock", true);
    if (skip !== "conversation" && placement?.manual_override_lane_id)
        return result(placement.manual_override_lane_id, "conversation");
    if (skip !== "conversation" && threadId && !binding("conversation", threadId)) {
        const old = db.all<{
            behavior: string;
        }>(sql `select behavior from thread_attention_overrides where account_id=${accountId} and thread_id=${threadId}`)[0];
        if (old)
            return result(legacy(old.behavior), "conversation");
    }
    const sender = binding("sender", address);
    if (skip !== "sender") {
        if (sender?.destinationId)
            return result(sender.destinationId, "sender");
        if (!sender) {
            const old = db.all<{
                behavior: string;
            }>(sql `select behavior from sender_attention_rules where account_id=${accountId} and scope='address' and value=${address}`)[0];
            if (old)
                return result(legacy(old.behavior), "sender");
        }
    }
    if (placement && ["rule_revision", "lane_policy"].includes(placement.placement_source))
        return result(placement.primary_lane_id, "advanced");
    const domain = db.all<{
        behavior: string;
    }>(sql `select behavior from sender_attention_rules where account_id=${accountId} and scope='domain' and value=${address.split("@")[1] ?? ""}`)[0];
    if (domain)
        return result(legacy(domain.behavior), "legacy");
    const account = binding("account", "");
    if (skip !== "account") {
        if (account?.destinationId)
            return result(account.destinationId, "account");
        if (!account) {
            const old = db.all<{
                behavior: string | null;
            }>(sql `select default_behavior behavior from account_attention_routing where account_id=${accountId}`)[0];
            if (old?.behavior)
                return result(legacy(old.behavior), "account");
        }
    }
    return result(fallback, "fallback");
}
