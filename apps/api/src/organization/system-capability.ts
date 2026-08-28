import type { OrganizationCapabilitySnapshot } from "@orca/shared";

export type OrganizationSystemCapabilityAdapter = {
  snapshot(input: { workspaceId: string; accountId: string }): OrganizationCapabilitySnapshot;
  live(input: { workspaceId: string; accountId: string; executor?: unknown }): {
    snapshot: OrganizationCapabilitySnapshot;
    revokedAt: string | null;
  };
};

function gmailSyncSnapshot(workspaceId: string, accountId: string): OrganizationCapabilitySnapshot {
  return {
    id: `system:gmail-sync:${accountId}`,
    revision: 1,
    actor: { id: "system:gmail-sync", type: "system" },
    scope: { workspaceId, accountIds: [accountId] },
    operations: ["apply"],
    resourceFamilies: ["mail", "thread", "lane", "collection", "facet", "context", "workflow_state", "trace", "change_set"],
    actionFamilies: ["organization_thread", "organization_attention"],
  };
}

/** Narrow first-party Capability adapter for the Gmail sync system Actor. */
export const gmailSyncOrganizationCapability: OrganizationSystemCapabilityAdapter = {
  snapshot({ workspaceId, accountId }) { return gmailSyncSnapshot(workspaceId, accountId); },
  live({ workspaceId, accountId }) {
    return { snapshot: gmailSyncSnapshot(workspaceId, accountId), revokedAt: null };
  },
};
