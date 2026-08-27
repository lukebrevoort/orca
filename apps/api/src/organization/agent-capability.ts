import type {
  OrganizationActor,
  OrganizationCapabilitySnapshot,
} from "@orca/shared";

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
  load(scope: OrganizationAgentScope): OrganizationLiveCapability | null;
};

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
