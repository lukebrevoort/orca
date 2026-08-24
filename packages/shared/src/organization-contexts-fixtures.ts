import { organizationContextQueryResponseSchema } from "./organization-contexts.ts";

const at = "2026-08-24T12:00:00.000Z";

/** One production incident, two typed Context relationships, one Thread identity. */
export const organizationProductionIncidentContextsFixture = organizationContextQueryResponseSchema.parse({
  workspaceId: "workspace_demo",
  accountIds: ["account_operations"],
  workspaceRevision: 5,
  contextTypes: [
    { id: "type_project", name: "Project", position: 0, retiredAt: null, revision: 1, createdAt: at, updatedAt: at },
    { id: "type_customer", name: "Customer", position: 1, retiredAt: null, revision: 1, createdAt: at, updatedAt: at },
  ],
  relationshipTypes: [
    { id: "relationship_type_project", contextTypeId: "type_project", name: "concerns", inverseName: "has incident", direction: "thread_to_context", position: 0, maximumPerThread: 4, retiredAt: null, revision: 1, createdAt: at, updatedAt: at },
    { id: "relationship_type_customer", contextTypeId: "type_customer", name: "affects", inverseName: "has incident", direction: "thread_to_context", position: 1, maximumPerThread: 2, retiredAt: null, revision: 1, createdAt: at, updatedAt: at },
  ],
  contexts: [
    { id: "context_orca", contextTypeId: "type_project", name: "Orca", retiredAt: null, revision: 1, createdAt: at, updatedAt: at },
    { id: "context_acme", contextTypeId: "type_customer", name: "Acme", retiredAt: null, revision: 1, createdAt: at, updatedAt: at },
  ],
  relationships: [
    { id: "relationship_incident_project", accountId: "account_operations", threadId: "thread_production_incident", contextTypeId: "type_project", contextId: "context_orca", relationshipTypeId: "relationship_type_project", direction: "thread_to_context", revision: 1, createdAt: at, updatedAt: at },
    { id: "relationship_incident_customer", accountId: "account_operations", threadId: "thread_production_incident", contextTypeId: "type_customer", contextId: "context_acme", relationshipTypeId: "relationship_type_customer", direction: "thread_to_context", revision: 1, createdAt: at, updatedAt: at },
  ],
  threadRevisions: [{ accountId: "account_operations", threadId: "thread_production_incident", revision: 1 }],
});
