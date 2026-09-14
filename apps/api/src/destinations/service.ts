import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { destinationCreateSchema, destinationUpdateSchema, destinationRetireSchema, destinationRoutingChangeSchema, destinationListSchema, destinationRoutingStateSchema, attentionRoutingTargetSchema, type AttentionRoutingTarget, type OrganizationLaneAction } from "@orca/shared";
import type { createDatabaseClient } from "../db/client.ts";
import { createOrganization } from "../organization/module.ts";
import { createSqliteOrganizationRepository } from "../organization/sqlite-repository.ts";
import { resolveDestination } from "./resolution.ts";
type Db = ReturnType<typeof createDatabaseClient>["db"];
export class DestinationError extends Error {
    constructor(readonly status: 400 | 404 | 409, message: string) { super(message); }
}
export function createDestinations(db: Db, workspaceId: string) {
    const repository = createSqliteOrganizationRepository(db);
    const organization = createOrganization(repository);
    const scope = () => ({ actor: { id: workspaceId, type: "human" as const }, workspaceId, accountIds: repository.listAccountIds(workspaceId) });
    const revision = () => db.all<{
        revision: number;
    }>(sql `select revision from organization_workspace_states where workspace_id=${workspaceId}`)[0]!.revision;
    const check = (expected: number) => { if (revision() !== expected)
        throw new DestinationError(409, "Destinations changed. Refresh before trying again."); };
    const owned = (accountId: string) => { if (!scope().accountIds.includes(accountId))
        throw new DestinationError(404, "Mail account was not found."); };
    const config = () => repository.lanes!.getSnapshot(workspaceId, []).configuration;
    const active = (id: string) => { const lane = config().lanes.find(l => l.id === id && !l.retiredAt); if (!lane)
        throw new DestinationError(404, "Active destination was not found."); return lane; };
    function apply(expected: number, actions: OrganizationLaneAction[]) { check(expected); const id = randomUUID(); return organization.apply({ scope: scope(), command: { id, idempotencyKey: id, expectedWorkspaceRevision: expected, actions } }); }
    function list() {
        const c = config();
        const counts = db.all<{
            id: string;
            total: number;
            unread: number;
        }>(sql `select d.destination_id id,count(*) total,sum(case when e.is_read=0 then 1 else 0 end) unread from emails e join organization_effective_destinations d on d.account_id=e.account_id and d.thread_id=e.thread_id where d.workspace_id=${workspaceId} group by d.destination_id`);
        return destinationListSchema.parse({ revision: revision(), fallbackDestinationId: c.fallbackLaneId, legacyDestinationIds: { normal: c.fallbackLaneId, ...Object.fromEntries(db.all<{
                    behavior: string;
                    id: string;
                }>(sql `select behavior,destination_id id from organization_destination_legacy where workspace_id=${workspaceId}`).map(r => [r.behavior, r.id])) }, destinations: c.lanes.map(l => ({ ...l, isFallback: l.id === c.fallbackLaneId, notificationPreference: c.policies.find(p => p.id === l.defaultPolicyId)!.interruption, delivery: "proposal_only", counts: counts.find(n => n.id === l.id) ?? { total: 0, unread: 0 } })).map(({ defaultPolicyId, ...l }) => ({ ...l, counts: { total: l.counts.total, unread: l.counts.unread } })) });
    }
    function selection(accountId: string, target: AttentionRoutingTarget) {
        owned(accountId);
        let address = target.scope === "sender" ? target.address : "";
        if (target.scope === "conversation") {
            if (!db.all(sql `select id from threads where account_id=${accountId} and id=${target.threadId}`)[0])
                throw new DestinationError(404, "Conversation was not found in this account.");
            address = db.all<{
                address: string | null;
            }>(sql `select from_address address from emails where account_id=${accountId} and thread_id=${target.threadId} order by received_at desc,created_at desc,id asc limit 1`)[0]?.address ?? "";
        }
        const threadId = target.scope === "conversation" ? target.threadId : undefined;
        const value = target.scope === "account" ? "" : target.scope === "sender" ? address : target.threadId;
        const binding = db.all<{
            destinationId: string | null;
            revision: number;
        }>(sql `select destination_id destinationId,revision from organization_destination_bindings where workspace_id=${workspaceId} and account_id=${accountId} and scope=${target.scope} and value=${value}`)[0];
        let explicit = binding?.destinationId ?? null;
        const effective = resolveDestination(db, workspaceId, accountId, address, threadId);
        if (target.scope === "conversation") {
            explicit = db.all<{
                id: string | null;
            }>(sql `select manual_override_lane_id id from organization_thread_lane_states where workspace_id=${workspaceId} and account_id=${accountId} and thread_id=${target.threadId}`)[0]?.id ?? (!binding && effective.source === "conversation" ? effective.destinationId : null);
        }
        else if (!binding && effective.source === target.scope)
            explicit = effective.destinationId;
        const bindings = db.all<{
            scope: string;
            value: string;
            destinationId: string | null;
        }>(sql `select scope,value,destination_id destinationId from organization_destination_bindings where workspace_id=${workspaceId} and account_id=${accountId}`);
        const fallback = config().fallbackLaneId;
        const legacy = db.all<{
            behavior: string;
            destinationId: string;
        }>(sql `select behavior,destination_id destinationId from organization_destination_legacy where workspace_id=${workspaceId}`);
        const mapped = (behavior: string) => legacy.find(l => l.behavior === behavior)?.destinationId ?? fallback;
        const old = db.all<{
            scope: "address" | "domain";
            value: string;
            behavior: string;
        }>(sql `select scope,value,behavior from sender_attention_rules where account_id=${accountId} order by scope,value`);
        const senders = [...old.filter(r => r.scope !== "address" || !bindings.some(b => b.scope === "sender" && b.value === r.value)).map(r => ({ scope: r.scope, value: r.value, destinationId: mapped(r.behavior), source: "legacy" as const, editable: r.scope === "address" })), ...bindings.filter(b => b.scope === "sender" && b.destinationId !== null).map(b => ({ scope: "address" as const, value: b.value, destinationId: b.destinationId!, source: "user_choice" as const, editable: true }))].sort((a, b) => a.scope.localeCompare(b.scope) || a.value.localeCompare(b.value));
        const accountBinding = bindings.find(b => b.scope === "account");
        const accountLegacy = db.all<{
            behavior: string | null;
        }>(sql `select default_behavior behavior from account_attention_routing where account_id=${accountId}`)[0]?.behavior;
        const defaultDestinationId = accountBinding ? accountBinding.destinationId : accountLegacy ? mapped(accountLegacy) : null;
        return { state: destinationRoutingStateSchema.parse({ accountId, revision: revision(), defaultDestinationId, senders, selection: { target, explicitDestinationId: explicit, effective, inherited: resolveDestination(db, workspaceId, accountId, address, threadId, target.scope) } }), binding, value };
    }
    return {
        list: () => db.transaction(list, { behavior: "deferred" }),
        create(input: unknown) { const v = destinationCreateSchema.parse(input); return db.transaction(() => { check(v.expectedRevision); const id = randomUUID(), c = config(); apply(v.expectedRevision, [{ kind: "define_lane_policy", id, visibility: "standard", interruption: "quiet", review: "manual", retention: { mode: "keep", days: null } }, { kind: "define_lane", id, name: v.name, ...(v.color !== undefined ? { color: v.color } : {}), position: Math.max(-1, ...c.lanes.map(l => l.position)) + 1, defaultPolicyId: id }]); return { state: list(), destinationId: id }; }); },
        update(id: string, input: unknown) {
            const v = destinationUpdateSchema.parse(input);
            return db.transaction(() => {
                check(v.expectedRevision);
                const l = active(id), c = config(), actions: OrganizationLaneAction[] = [];
                const ordered = c.lanes.filter(n => n.id !== id);
                if (v.position !== undefined)
                    ordered.splice(Math.min(v.position, ordered.length), 0, l);
                else
                    ordered.splice(c.lanes.findIndex(n => n.id === id), 0, l);
                for (const [position, lane] of ordered.entries()) {
                    const name = lane.id === id ? v.name : undefined;
                    const color = lane.id === id ? v.color : undefined;
                    if (color !== undefined || name !== undefined || (v.position !== undefined && lane.position !== position))
                        actions.push({ kind: "update_lane", laneId: lane.id, ...(color !== undefined ? { color } : {}), ...(name !== undefined ? { name } : {}), ...(v.position !== undefined ? { position } : {}), expectedRevision: lane.revision });
                }
                if (v.notificationPreference !== undefined) {
                    const policy = c.policies.find(p => p.id === l.defaultPolicyId)!;
                    if (c.lanes.filter(n => n.defaultPolicyId === policy.id).length > 1)
                        throw new DestinationError(409, "This destination shares advanced preferences. Change them in Organization.");
                    actions.push({ kind: "update_lane_policy", policyId: policy.id, interruption: v.notificationPreference, expectedRevision: policy.revision });
                }
                if (actions.length)
                    apply(v.expectedRevision, actions);
                return { state: list(), destinationId: id };
            });
        },
        retire(id: string, input: unknown) {
            const v = destinationRetireSchema.parse(input);
            return db.transaction(() => {
                check(v.expectedRevision);
                const l = active(id);
                active(v.reassignToDestinationId);
                if (id === v.reassignToDestinationId || id === config().fallbackLaneId)
                    throw new DestinationError(409, "The fallback destination cannot be retired.");
                if (db.all(sql `select 1 from organization_destination_legacy where workspace_id=${workspaceId} and destination_id=${id}`)[0])
                    throw new DestinationError(409, "Legacy choices reference this destination. Keep it available until those choices are migrated.");
                if (db.all(sql `select 1 from organization_effective_destinations where workspace_id=${workspaceId} and destination_id=${id} limit 1`)[0] || db.all(sql `select 1 from organization_destination_bindings where workspace_id=${workspaceId} and destination_id=${id} limit 1`)[0])
                    throw new DestinationError(409, "Move conversations and update sender/account choices before retiring this destination.");
                // Existing engine also rejects stored lower placement references, including protected placements.
                if (db.all(sql `select 1 from organization_rule_revisions where workspace_id=${workspaceId} and compiled_json like ${'%' + id + '%'} limit 1`)[0])
                    throw new DestinationError(409, "Advanced rules reference this destination. Update them in Organization first.");
                apply(v.expectedRevision, [{ kind: "update_lane", laneId: id, retired: true, expectedRevision: l.revision }]);
                return { state: list(), destinationId: id };
            });
        },
        read(accountId: string, target: AttentionRoutingTarget = { scope: "account" }) { return db.transaction(() => selection(accountId, attentionRoutingTargetSchema.parse(target)).state, { behavior: "deferred" }); },
        save(accountId: string, input: unknown) {
            const v = destinationRoutingChangeSchema.parse(input);
            return db.transaction(() => {
                owned(accountId);
                check(v.expectedRevision);
                if (v.destinationId !== null)
                    active(v.destinationId);
                const before = selection(accountId, v.target);
                const actions: OrganizationLaneAction[] = [];
                if (v.target.scope === "conversation") {
                    const p = db.all<{
                        revision: number;
                        safety_locked: number;
                    }>(sql `select revision,safety_locked from organization_thread_lane_states where workspace_id=${workspaceId} and account_id=${accountId} and thread_id=${v.target.threadId}`)[0];
                    if (p?.safety_locked)
                        throw new DestinationError(409, "This conversation is protected. Review its safety lock in Organization.");
                    actions.push({ kind: "set_thread_manual_override", accountId, threadId: v.target.threadId, laneId: v.destinationId, expectedThreadRevision: p?.revision ?? null, reason: "User destination choice" });
                }
                actions.push({ kind: "set_destination_binding", accountId, scope: v.target.scope, value: before.value, destinationId: v.target.scope === "conversation" ? null : v.destinationId, expectedRevision: before.binding?.revision ?? null });
                apply(v.expectedRevision, actions);
                const state = selection(accountId, v.target).state;
                return { state, undo: { expectedRevision: state.revision, target: v.target, destinationId: before.state.selection.explicitDestinationId } };
            });
        }
    };
}
