import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  organizationContextApplyRequestSchema,
  organizationContextQueryResponseSchema,
  organizationContextQuerySchema,
} from "./organization-contexts.ts";

describe("Context Organization contracts", () => {
  test("preserves stable typed identities for a Thread related to a project and customer", () => {
    const result = organizationContextQueryResponseSchema.parse({
      workspaceId: "workspace_1",
      accountIds: ["account_a"],
      workspaceRevision: 7,
      contextTypes: [
        { id: "type_project", name: "Project", position: 0, retiredAt: null, revision: 1, createdAt: "2026-08-24T12:00:00.000Z", updatedAt: "2026-08-24T12:00:00.000Z" },
        { id: "type_customer", name: "Customer", position: 1, retiredAt: null, revision: 1, createdAt: "2026-08-24T12:00:00.000Z", updatedAt: "2026-08-24T12:00:00.000Z" },
      ],
      relationshipTypes: [
        { id: "rel_project", contextTypeId: "type_project", name: "concerns", inverseName: "has incident", direction: "thread_to_context", position: 0, maximumPerThread: 4, retiredAt: null, revision: 1, createdAt: "2026-08-24T12:00:00.000Z", updatedAt: "2026-08-24T12:00:00.000Z" },
        { id: "rel_customer", contextTypeId: "type_customer", name: "affects", inverseName: "has incident", direction: "thread_to_context", position: 1, maximumPerThread: 2, retiredAt: null, revision: 1, createdAt: "2026-08-24T12:00:00.000Z", updatedAt: "2026-08-24T12:00:00.000Z" },
      ],
      contexts: [
        { id: "context_orca", contextTypeId: "type_project", name: "Orca", retiredAt: null, revision: 1, createdAt: "2026-08-24T12:00:00.000Z", updatedAt: "2026-08-24T12:00:00.000Z" },
        { id: "context_acme", contextTypeId: "type_customer", name: "Acme", retiredAt: null, revision: 1, createdAt: "2026-08-24T12:00:00.000Z", updatedAt: "2026-08-24T12:00:00.000Z" },
      ],
      relationships: [
        { id: "relationship_project", accountId: "account_a", threadId: "thread_incident", contextTypeId: "type_project", contextId: "context_orca", relationshipTypeId: "rel_project", direction: "thread_to_context", revision: 1, createdAt: "2026-08-24T12:00:00.000Z", updatedAt: "2026-08-24T12:00:00.000Z" },
        { id: "relationship_customer", accountId: "account_a", threadId: "thread_incident", contextTypeId: "type_customer", contextId: "context_acme", relationshipTypeId: "rel_customer", direction: "thread_to_context", revision: 1, createdAt: "2026-08-24T12:00:00.000Z", updatedAt: "2026-08-24T12:00:00.000Z" },
      ],
      threadRevisions: [{ accountId: "account_a", threadId: "thread_incident", revision: 2 }],
    });

    assert.equal(result.relationships.length, 2);
    assert.equal(new Set(result.relationships.map((relationship) => relationship.threadId)).size, 1);
    assert.deepEqual(result.relationships.map((relationship) => relationship.contextId), ["context_orca", "context_acme"]);
  });

  test("keeps create IDs server-derived and bounds relationship fan-out", () => {
    const base = {
      idempotencyKey: "context-change-1",
      expectedWorkspaceRevision: 1,
    };
    assert.equal(organizationContextApplyRequestSchema.safeParse({
      ...base,
      actions: [{ kind: "create_context_type", id: "caller-chosen", name: "Project", position: 0 }],
    }).success, false);
    assert.equal(organizationContextApplyRequestSchema.safeParse({
      ...base,
      actions: [{ kind: "create_relationship_type", contextTypeId: "type_project", name: "concerns", inverseName: "has incident", direction: "thread_to_context", position: 0, maximumPerThread: 21 }],
    }).success, false);
    assert.equal(organizationContextApplyRequestSchema.safeParse({
      ...base,
      actions: [{ kind: "create_context", contextTypeId: "type_project", name: "Orca", arbitraryFields: { owner: "Luke" } }],
    }).success, false);
    assert.equal(organizationContextApplyRequestSchema.safeParse({
      ...base,
      actions: [{ kind: "link_thread_context", accountId: "account_a", threadId: "thread_1", sourceContextId: "context_a", targetContextId: "context_b", relationshipTypeId: "rel_project", expectedThreadRevision: null }],
    }).success, false, "Context-to-Context graph edges and cycles are outside the bounded Thread-to-Context contract");
  });

  test("provides typed stable-identity filters without stringly joins", () => {
    assert.deepEqual(organizationContextQuerySchema.parse({
      accountIds: ["account_a"],
      contextRef: { contextTypeId: "type_project", contextId: "context_orca" },
      relationshipTypeId: "rel_project",
      includeRetired: true,
    }), {
      accountIds: ["account_a"],
      contextRef: { contextTypeId: "type_project", contextId: "context_orca" },
      relationshipTypeId: "rel_project",
      includeRetired: true,
      limit: 100,
    });
  });
});
