import type {
  OrganizationActor,
  OrganizationCapabilitySnapshot,
} from "@orca/shared";
import { canonicalOrganizationJson } from "./authority.ts";

export type OrganizationAgentScope = {
  actor: OrganizationActor & { type: "agent" };
  workspaceId: string;
  accountIds: string[];
};

export type OrganizationLiveCapability = {
  snapshot: OrganizationCapabilitySnapshot;
  revokedAt: string | null;
};

export function isHumanOrganizationActor(
  actor: OrganizationActor,
): actor is OrganizationActor & { type: "human" } {
  return actor.type === "human";
}

export function isAgentOrganizationActor(
  actor: OrganizationActor,
): actor is OrganizationActor & { type: "agent" } {
  return actor.type === "agent";
}

/**
 * Explicit trust seam for an authenticated external-agent adapter. Core
 * Organization modules remain human-only unless this source is injected.
 */
export type OrganizationAgentCapabilitySource = {
  /** The optional executor lets SQLite adapters re-resolve the grant on their active transaction. */
  load(scope: OrganizationAgentScope, executor?: unknown): OrganizationLiveCapability | null;
};

export function loadAuthorizedOrganizationAgentCapability(
  scope: OrganizationAgentScope,
  source: OrganizationAgentCapabilitySource | undefined,
  executor: unknown,
  requirement: {
    operation: OrganizationCapabilitySnapshot["operations"][number];
    resourceFamily: OrganizationCapabilitySnapshot["resourceFamilies"][number];
    actionFamily: OrganizationCapabilitySnapshot["actionFamilies"][number];
  },
): OrganizationLiveCapability | null {
  const live = source?.load(scope, executor) ?? null;
  if (!live || live.revokedAt !== null) return null;
  const snapshot = live.snapshot;
  if (snapshot.actor.type !== "agent"
    || snapshot.actor.id !== scope.actor.id
    || snapshot.scope.workspaceId !== scope.workspaceId
    || JSON.stringify([...snapshot.scope.accountIds].sort()) !== JSON.stringify([...scope.accountIds].sort())
    || !snapshot.operations.includes(requirement.operation)
    || !snapshot.resourceFamilies.includes(requirement.resourceFamily)
    || !snapshot.actionFamilies.includes(requirement.actionFamily)) return null;
  return live;
}

export function organizationReplayAuthorityMatches(
  scope: OrganizationAgentScope,
  authorityTrace: unknown,
  capabilitySnapshot?: OrganizationCapabilitySnapshot,
): boolean {
  if (typeof authorityTrace !== "object" || authorityTrace === null) return false;
  const trace = authorityTrace as {
    actor?: unknown;
    scope?: { workspaceId?: unknown; accountIds?: unknown };
    capabilitySnapshot?: unknown;
  };
  const actor = trace.actor as { id?: unknown; type?: unknown } | undefined;
  return actor?.id === scope.actor.id && actor.type === scope.actor.type
    && trace.scope?.workspaceId === scope.workspaceId
    && Array.isArray(trace.scope.accountIds)
    && JSON.stringify([...trace.scope.accountIds].sort()) === JSON.stringify([...scope.accountIds].sort())
    && (capabilitySnapshot === undefined
      || canonicalOrganizationJson(trace.capabilitySnapshot) === canonicalOrganizationJson(capabilitySnapshot));
}

export function requireOrganizationCapability(
  scope: { actor: OrganizationActor; workspaceId: string; accountIds: string[] },
  humanCapability: (actor: OrganizationActor & { type: "human" }) => OrganizationCapabilitySnapshot,
  agentSource?: OrganizationAgentCapabilitySource,
): OrganizationLiveCapability {
  if (isHumanOrganizationActor(scope.actor)) return { snapshot: humanCapability(scope.actor), revokedAt: null };
  if (!isAgentOrganizationActor(scope.actor) || !agentSource) throw new Error("No explicit external-agent Capability source authorizes this Organization write");
  const live = agentSource.load({ actor: scope.actor, workspaceId: scope.workspaceId, accountIds: scope.accountIds });
  if (!live) throw new Error("The external-agent Capability is unavailable or revoked");
  return live;
}
