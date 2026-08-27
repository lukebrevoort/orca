import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  OrganizationAccessError,
  OrganizationAuthorityError,
  OrganizationOperationDisabledError,
  createOrganization,
  type OrganizationRepository,
} from "./module.ts";

function classification(value: "likely_human" | "automated_or_bulk") {
  const assessment = {
    classification: value,
    score: value === "likely_human" ? 8 : 2,
    reasonCodes: [value === "likely_human" ? "direct_recipient" as const : "provider_bulk_signal" as const],
    classifierVersion: "test-v1",
  };
  return {
    automatic: assessment,
    effective: { ...assessment, source: "automatic_heuristic" as const, userOverride: null },
    userOverride: null,
  };
}

function threadRecord(id: string, accountId = "account_a", receivedAt = "2026-08-23T12:00:00.000Z") {
  return {
    id,
    accountId,
    subject: id,
    latestReceivedAt: receivedAt,
    messageCount: 1,
    readState: "unread" as const,
    messages: [{
      id: `message_${id}`,
      sourceId: `source_${id}`,
      from: { name: "Ada", email: "ada@example.com" },
      subject: id,
      snippet: id,
      receivedAt,
      unread: true,
      labels: [],
      humanSignal: 8,
      humanClassification: classification("likely_human"),
    }],
    attentionRules: [],
  };
}

const repository: OrganizationRepository = {
  listAccountIds(workspaceId) {
    return workspaceId === "workspace_owner" ? ["account_a", "account_b"] : ["account_private"];
  },
  listThreads(accountIds) {
    const allowed = new Set(accountIds);
    return [
      {
        id: "thread_a",
        accountId: "account_a",
        subject: "Alpha",
        latestReceivedAt: "2026-08-23T12:00:00.000Z",
        messageCount: 2,
        readState: "unread" as const,
        messages: [
          {
            id: "message_a2",
            sourceId: "source_a2",
            from: { name: "Ada", email: "ada@example.com" },
            subject: "Alpha",
            snippet: "Latest alpha",
            receivedAt: "2026-08-23T12:00:00.000Z",
            unread: true,
            labels: ["Inbox"],
            humanSignal: 8,
            humanClassification: null,
          },
          {
            id: "message_a1",
            sourceId: "source_a1",
            from: { name: "Ada", email: "ada@example.com" },
            subject: "Alpha",
            snippet: "Earlier alpha",
            receivedAt: "2026-08-23T11:00:00.000Z",
            unread: false,
            labels: ["Inbox"],
            humanSignal: 7,
            humanClassification: null,
          },
        ],
        attentionRules: [{ scope: "domain" as const, value: "example.com", behavior: "focus" as const }],
      },
      {
        id: "thread_b",
        accountId: "account_b",
        subject: "Beta",
        latestReceivedAt: "2026-08-23T10:00:00.000Z",
        messageCount: 1,
        readState: "read" as const,
        messages: [{
          id: "message_b",
          sourceId: "source_b",
          from: { name: "Bea", email: "bea@other.example" },
          subject: "Beta",
          snippet: "Beta body",
          receivedAt: "2026-08-23T10:00:00.000Z",
          unread: false,
          labels: [],
          humanSignal: 2,
          humanClassification: null,
        }],
        attentionRules: [],
      },
      {
        id: "thread_private",
        accountId: "account_private",
        subject: "Private",
        latestReceivedAt: "2026-08-23T13:00:00.000Z",
        messageCount: 1,
        readState: "unread" as const,
        messages: [{
          id: "message_private",
          sourceId: "source_private",
          from: { name: null, email: "private@example.net" },
          subject: "Private",
          snippet: "Must not leak",
          receivedAt: "2026-08-23T13:00:00.000Z",
          unread: true,
          labels: [],
          humanSignal: 10,
          humanClassification: null,
        }],
        attentionRules: [],
      },
    ].filter((thread) => allowed.has(thread.accountId));
  },
};

const ownerScope = {
  actor: { id: "human_owner", type: "human" as const },
  workspaceId: "workspace_owner",
  accountIds: ["account_a", "account_b"],
};

describe("Organization module contract", () => {
  test("describes the revision-4 schema without advertising an uninstalled apply adapter", () => {
    const organization = createOrganization(repository);

    const result = organization.describe({ scope: ownerScope });

    assert.deepEqual(result.workspaceSchema, {
      revision: 4,
      aggregate: "thread",
      resources: ["account", "thread", "lane", "lane_policy", "facet", "workflow_state", "context", "context_relationship"],
      filters: ["account", "thread", "attention", "classification", "sender", "text", "received_at", "facet", "workflow_state", "context", "context_relationship", "lane"],
    });
    assert.deepEqual(result.capabilities.operations, {
      describe: true,
      query: true,
      simulate: true,
      apply: false,
      revert: true,
    });
    assert.deepEqual(result.capabilities.authority, { sendMail: false, deleteProviderMail: false });
    assert.deepEqual(result.capabilities.surfaces, {
      rest: { describe: true, query: true, simulate: true, apply: false, revert: true, correct: true },
      mcp: { describe: false, query: false, simulate: false, apply: false, revert: false, correct: false },
    });
    assert.deepEqual(result.accountIds, ["account_a", "account_b"]);
    assert.equal(JSON.stringify(result).includes("gmail"), false);
  });

  test("queries Thread organization across authorized Accounts and applies Account as a filter", () => {
    const organization = createOrganization(repository);

    const workspace = organization.query({ scope: ownerScope, query: { limit: 25 } });
    assert.deepEqual(workspace.threads.map((thread) => [thread.id, thread.accountId]), [
      ["thread_a", "account_a"],
      ["thread_b", "account_b"],
    ]);
    assert.equal(workspace.threads[0]?.organization.attentionBehavior, "focus");
    assert.equal(workspace.threads[0]?.organization.humanSignal, 8);
    assert.deepEqual(workspace.counts, { threads: 2, messages: 3 });

    const account = organization.query({
      scope: ownerScope,
      query: { accountIds: ["account_b"], limit: 25 },
    });
    assert.deepEqual(account.accountIds, ["account_b"]);
    assert.deepEqual(account.threads.map((thread) => thread.id), ["thread_b"]);
  });

  test("reads definitions and Thread projections from one coherent repository snapshot", () => {
    let legacyReadCount = 0;
    let snapshotFilter: { threadId?: string } | undefined;
    const coherentRepository: OrganizationRepository = {
      contexts: {
        getSnapshot: () => {
          legacyReadCount += 1;
          throw new Error("split Context read must not run");
        },
      } as unknown as NonNullable<OrganizationRepository["contexts"]>,
      listAccountIds: () => ["account_a"],
      listThreads: () => {
        legacyReadCount += 1;
        throw new Error("split Thread read must not run");
      },
      getFacetWorkflowSnapshot: () => {
        legacyReadCount += 1;
        throw new Error("split definition read must not run");
      },
      readOrganizationSnapshot: (_workspaceId, _accountIds, filter) => {
        snapshotFilter = filter;
        return {
          facetWorkflow: {
            workspaceRevision: 7,
            facetDefinitions: [{
              id: "facet_generation",
              name: "Generation seven",
              position: 0,
              valueType: { kind: "text", maxLength: 40 },
              cardinality: { kind: "single" },
              isOptional: true,
              defaultValue: null,
              retiredAt: null,
              revision: 7,
            }],
            workflowStates: [],
            threads: [],
          },
          threads: [{
            ...threadRecord("thread_generation"),
            facetValues: [{ facetId: "facet_generation", value: "seven", updatedAt: "2026-08-24T06:00:00.000Z" }],
            organizationRevision: 7,
          }],
          contexts: {
            workspaceId: "workspace_owner",
            accountIds: ["account_a"],
            workspaceRevision: 7,
            contextTypes: [{ id: "type_generation", name: "Generation", position: 0, retiredAt: null, revision: 7, createdAt: "2026-08-24T06:00:00.000Z", updatedAt: "2026-08-24T06:00:00.000Z" }],
            relationshipTypes: [{ id: "relationship_type_generation", contextTypeId: "type_generation", name: "concerns", inverseName: "has thread", direction: "thread_to_context", position: 0, maximumPerThread: 1, retiredAt: null, revision: 7, createdAt: "2026-08-24T06:00:00.000Z", updatedAt: "2026-08-24T06:00:00.000Z" }],
            contexts: [{ id: "context_generation", contextTypeId: "type_generation", name: "Generation seven", retiredAt: null, revision: 7, createdAt: "2026-08-24T06:00:00.000Z", updatedAt: "2026-08-24T06:00:00.000Z" }],
            relationships: [{ id: "relationship_generation", accountId: "account_a", threadId: "thread_generation", contextTypeId: "type_generation", contextId: "context_generation", relationshipTypeId: "relationship_type_generation", direction: "thread_to_context", revision: 7, createdAt: "2026-08-24T06:00:00.000Z", updatedAt: "2026-08-24T06:00:00.000Z" }],
            threadRevisions: [{ accountId: "account_a", threadId: "thread_generation", revision: 7 }],
            threads: [{ accountId: "account_a", threadId: "thread_generation" }],
          },
        };
      },
    };
    const result = createOrganization(coherentRepository).query({
      scope: { ...ownerScope, accountIds: ["account_a"] },
      query: {
        threadId: "thread_generation",
        facetFilters: [{ facetId: "facet_generation", operator: "equals", value: "seven" }],
      },
    });
    assert.equal(legacyReadCount, 0);
    assert.deepEqual(snapshotFilter, { threadId: "thread_generation" });
    assert.equal(result.facetDefinitions?.[0]?.revision, 7);
    assert.equal(result.threads[0]?.organization.revision, 7);
    assert.equal(result.threads[0]?.organization.contextRelationships?.[0]?.relationshipId, "relationship_generation");
    assert.equal(result.contexts?.[0]?.revision, 7);
  });

  test("bounds mailbox Context projection to the requested Thread page", () => {
    const at = "2026-08-24T06:00:00.000Z";
    const records = Array.from({ length: 120 }, (_, index) => ({
      ...threadRecord(`thread_${String(index).padStart(3, "0")}`),
      organizationRevision: 7,
    }));
    const contexts = records.flatMap((record) => Array.from({ length: 20 }, (_, index) => ({
      id: `context_${record.id}_${index}`,
      contextTypeId: "type_project",
      name: `Project ${record.id} ${index}`,
      retiredAt: null,
      revision: 1,
      createdAt: at,
      updatedAt: at,
    })));
    const relationships = records.flatMap((record) => Array.from({ length: 20 }, (_, index) => ({
      id: `edge_${record.id}_${index}`,
      accountId: "account_a",
      threadId: record.id,
      contextTypeId: "type_project",
      contextId: `context_${record.id}_${index}`,
      relationshipTypeId: "rel_project",
      direction: "thread_to_context" as const,
      revision: 1,
      createdAt: at,
      updatedAt: at,
    })));
    const mailboxRepository: OrganizationRepository = {
      listAccountIds: () => ["account_a"],
      listThreads: () => { throw new Error("coherent snapshot required"); },
      readOrganizationSnapshot: () => ({
        facetWorkflow: { workspaceRevision: 7, facetDefinitions: [], workflowStates: [], threads: [] },
        contexts: {
          workspaceId: "workspace_owner", accountIds: ["account_a"], workspaceRevision: 7,
          contextTypes: [{ id: "type_project", name: "Project", position: 0, retiredAt: null, revision: 1, createdAt: at, updatedAt: at }],
          relationshipTypes: [{ id: "rel_project", contextTypeId: "type_project", name: "concerns", inverseName: "has thread", direction: "thread_to_context", position: 0, maximumPerThread: 20, retiredAt: null, revision: 1, createdAt: at, updatedAt: at }],
          contexts,
          relationships,
          threadRevisions: records.map((record) => ({ accountId: "account_a", threadId: record.id, revision: 7 })),
          threads: records.map((record) => ({ accountId: "account_a", threadId: record.id })),
        },
        threads: records,
      }),
    };
    const result = createOrganization(mailboxRepository).query({
      scope: { ...ownerScope, accountIds: ["account_a"] },
      query: { attention: "all", limit: 1 },
    });
    assert.equal(result.threads.length, 1);
    assert.equal(result.threads[0]?.organization.contextRelationships?.length, 20);
    assert.equal(result.contexts?.length, 20);
    assert.equal(result.contextTypes?.length, 1);
    assert.equal(result.contextRelationshipTypes?.length, 1);
    assert.equal(result.contexts?.length, new Set(result.threads[0]?.organization.contextRelationships?.map((item) => item.context.contextId)).size);
  });

  test("limits first-party apply to humans and binds every typed action field into authority", () => {
    const actionDigests: string[] = [];
    const writeRepository: OrganizationRepository = {
      listAccountIds: () => ["account_a"],
      listThreads: () => [],
      getFacetWorkflowAuthorityState: () => ({ workspaceRevision: 1, resourceRevisions: {}, reservedIdempotencyKeys: [] }),
      applyFacetWorkflow(input) {
        actionDigests.push(String(input.command.intents[0]?.changes?.typedActionsDigest));
        return { workspaceRevision: 2, facetDefinitions: [], workflowStates: [], threads: [] };
      },
    };
    const organization = createOrganization(writeRepository);
    assert.equal(organization.describe({ scope: { ...ownerScope, accountIds: ["account_a"] } }).capabilities.operations.apply, true);
    assert.equal(organization.describe({
      scope: { actor: { id: "agent_a", type: "agent" }, workspaceId: "workspace_owner", accountIds: ["account_a"] },
    }).capabilities.operations.apply, false);
    const command = (name: string, idempotencyKey: string) => ({
      id: "changeset_bound",
      idempotencyKey,
      expectedWorkspaceRevision: 1,
      actions: [{ kind: "define_workflow_state" as const, id: "workflow_bound", name, position: 0 }],
    });
    assert.throws(
      () => organization.apply({
        scope: { actor: { id: "agent_a", type: "agent" }, workspaceId: "workspace_owner", accountIds: ["account_a"] },
        command: command("Honest", "agent-attempt"),
      }),
      (error) => error instanceof OrganizationAuthorityError && error.code === "actor_operation_denied",
    );
    organization.apply({ scope: { ...ownerScope, accountIds: ["account_a"] }, command: command("First label", "bound-1") });
    organization.apply({ scope: { ...ownerScope, accountIds: ["account_a"] }, command: command("Different label", "bound-2") });
    assert.equal(actionDigests.length, 2);
    assert.match(actionDigests[0] ?? "", /^sha256:[0-9a-f]{64}$/);
    assert.notEqual(actionDigests[0], actionDigests[1]);
  });

  test("derives advertised agent mutations from the exact live persisted grant", () => {
    const actor = { id: "agent_a", type: "agent" as const };
    const scope = { actor, workspaceId: "workspace_owner", accountIds: ["account_a"] };
    const full: import("@orca/shared").OrganizationCapabilitySnapshot = {
      id: "grant_a", revision: 1, actor,
      scope: { workspaceId: scope.workspaceId, accountIds: scope.accountIds },
      operations: ["describe", "query", "simulate", "apply", "revert"],
      resourceFamilies: ["rule", "change_set", "facet", "workflow_state", "thread"],
      actionFamilies: ["organization_read", "organization_structure"],
    };
    let live: { snapshot: typeof full; revokedAt: string | null } | null = { snapshot: full, revokedAt: null };
    const writeRepository: OrganizationRepository = {
      listAccountIds: () => ["account_a"], listThreads: () => [],
      getFacetWorkflowAuthorityState: () => ({ workspaceRevision: 1, resourceRevisions: {}, reservedIdempotencyKeys: [] }),
      applyFacetWorkflow: () => ({ workspaceRevision: 2, facetDefinitions: [], workflowStates: [], threads: [] }),
    };
    const organization = createOrganization(writeRepository, { agentCapabilitySource: { load: () => live } });
    assert.deepEqual(organization.describe({ scope }).capabilities.operations, {
      describe: true, query: true, simulate: true, apply: true, revert: true,
    });
    live = { snapshot: { ...full, operations: ["describe", "query"], resourceFamilies: ["workspace_schema", "mail", "thread"], actionFamilies: ["organization_read"] }, revokedAt: null };
    assert.deepEqual(organization.describe({ scope }).capabilities.operations, {
      describe: true, query: true, simulate: false, apply: false, revert: false,
    });
    live = { snapshot: full, revokedAt: "2026-08-26T00:00:00.000Z" };
    assert.deepEqual(organization.describe({ scope }).capabilities.operations, {
      describe: true, query: true, simulate: false, apply: false, revert: false,
    });
  });

  test("fails closed when either authorization scope or filter names an unowned Account", () => {
    const organization = createOrganization(repository);

    assert.throws(
      () => organization.describe({
        scope: { ...ownerScope, accountIds: ["account_private"] },
      }),
      (error) => error instanceof OrganizationAccessError && error.code === "account_denied",
    );
    assert.throws(
      () => organization.query({
        scope: { ...ownerScope, accountIds: ["account_a", "account_private"] },
        query: { limit: 25 },
      }),
      (error) => error instanceof OrganizationAccessError && error.code === "account_denied",
    );
    assert.throws(
      () => organization.query({
        scope: ownerScope,
        query: { accountIds: ["account_private"], limit: 25 },
      }),
      (error) => error instanceof OrganizationAccessError && error.code === "account_denied",
    );
  });

  test("applies classification to the returned Thread aggregate, not older message evidence", () => {
    const mixed = threadRecord("thread_mixed");
    mixed.messages = [
      { ...mixed.messages[0]!, id: "latest", receivedAt: "2026-08-23T12:00:00.000Z", humanClassification: classification("automated_or_bulk") },
      { ...mixed.messages[0]!, id: "older", receivedAt: "2026-08-23T11:00:00.000Z", humanClassification: classification("likely_human") },
    ];
    mixed.messageCount = 2;
    const organization = createOrganization({
      listAccountIds: () => ["account_a"],
      listThreads: () => [mixed],
    });
    const scope = { ...ownerScope, accountIds: ["account_a"] };

    assert.deepEqual(organization.query({ scope, query: { classification: "human" } }).threads, []);
    const tideline = organization.query({ scope, query: { classification: "tideline" } });
    assert.equal(tideline.threads[0]?.organization.humanClassification?.effective.classification, "automated_or_bulk");
    assert.deepEqual(tideline.threads[0]?.messages.map((message) => message.id), ["latest", "older"]);
  });

  test("round-trips a bounded cursor for a many-Account scope", () => {
    const accountIds = Array.from({ length: 40 }, (_, index) => `account_${index.toString().padStart(28, "0")}`);
    const records = [threadRecord("thread_1", accountIds[0]), threadRecord("thread_2", accountIds[1], "2026-08-23T11:00:00.000Z")];
    const organization = createOrganization({
      listAccountIds: () => accountIds,
      listThreads: () => records,
    });
    const scope = { ...ownerScope, accountIds };

    const first = organization.query({ scope, query: { limit: 1 } });
    assert.ok(first.nextCursor);
    assert.ok(first.nextCursor.length <= 2_048);
    const second = organization.query({ scope, query: { limit: 1, cursor: first.nextCursor } });
    assert.deepEqual(second.threads.map((thread) => thread.id), ["thread_2"]);
  });

  test("reuses one ranked snapshot while a mailbox-sized result is paged", () => {
    let listCalls = 0;
    const records = Array.from({ length: 250 }, (_, index) => threadRecord(
      `thread_${index.toString().padStart(3, "0")}`,
      "account_a",
      new Date(Date.UTC(2026, 7, 23, 12, 0, 0) - index * 1_000).toISOString(),
    ));
    const organization = createOrganization({
      listAccountIds: () => ["account_a"],
      listThreads: () => {
        listCalls += 1;
        return records;
      },
    });
    const scope = { ...ownerScope, accountIds: ["account_a"] };
    let cursor: string | undefined;
    let seen = 0;
    do {
      const page = organization.query({ scope, query: { limit: 100, ...(cursor ? { cursor } : {}) } });
      seen += page.threads.length;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    assert.equal(seen, 250);
    assert.equal(listCalls, 1);
  });

  test("discovers implemented simulate, revert, and correction per REST/MCP surface without send or delete authority", () => {
    const organization = createOrganization(repository);

    for (const operation of ["simulate", "revert"] as const) {
      assert.throws(
        () => organization[operation]({ scope: ownerScope }),
        (error) => error instanceof OrganizationOperationDisabledError && error.operation === operation,
      );
    }
  });
});
