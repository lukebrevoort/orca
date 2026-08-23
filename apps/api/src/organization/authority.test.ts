import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  organizationAuthorityTraceSchema,
  organizationExecutionContextSchema,
  type OrganizationCapabilitySnapshot,
  type OrganizationCommand,
  type OrganizationLiveAuthorityState,
  type OrganizationOperationRequest,
  type OrganizationScope,
} from "@orca/shared";

import {
  authorizeOrganizationOperation,
  organizationActorOperationMatrix,
} from "./authority.ts";

type RequestOverrides = Omit<Partial<OrganizationOperationRequest>, "capabilitySnapshot" | "scope"> & {
  capabilitySnapshot?: Omit<Partial<OrganizationCapabilitySnapshot>, "scope"> & {
    scope?: Partial<OrganizationScope>;
  };
  scope?: Partial<OrganizationScope>;
};

function defaultCommand(operation: OrganizationOperationRequest["operation"]): OrganizationCommand {
  if (operation === "describe") return { id: "command_describe", intents: [{ kind: "describe_workspace", resourceId: "workspace_1", mutation: null, changes: null }] };
  if (operation === "query") return { id: "command_query", intents: [{ kind: "query_mail", resourceId: "thread_1", mutation: null, changes: null }] };
  return { id: `command_${operation}`, intents: [{ kind: "mutate_lane", resourceId: "lane_1", mutation: "update", changes: { name: "Priority" } }] };
}

function request(overrides: RequestOverrides = {}): OrganizationOperationRequest {
  const actor = overrides.actor ?? { id: "actor_1", type: "agent" as const };
  const operation = overrides.operation ?? "query";
  const capabilityScope = {
    workspaceId: "workspace_1",
    accountIds: ["account_1", "account_2"],
    ...overrides.capabilitySnapshot?.scope,
  };
  const { scope: _capabilityScopeOverride, ...capabilityOverrides } = overrides.capabilitySnapshot ?? {};
  const isWrite = operation === "apply" || operation === "revert";
  return {
    actor,
    capabilitySnapshot: {
      id: "capability_1",
      revision: 3,
      actor,
      operations: ["describe", "query", "simulate", "apply", "revert"],
      resourceFamilies: ["workspace_schema", "mail", "thread", "lane", "rule", "trace", "audit", "change_set"],
      actionFamilies: ["organization_read", "organization_structure", "organization_thread", "organization_attention"],
      ...capabilityOverrides,
      scope: capabilityScope,
    },
    operation,
    scope: { workspaceId: "workspace_1", accountIds: ["account_1"], ...overrides.scope },
    command: overrides.command ?? defaultCommand(operation),
    expectedRevisions: overrides.expectedRevisions ?? {
      workspace: isWrite ? 7 : null,
      resources: isWrite ? { lane_1: 2 } : {},
    },
    idempotencyKey: overrides.idempotencyKey === undefined ? isWrite ? "idem_1" : null : overrides.idempotencyKey,
  };
}

type LiveOverrides = Omit<Partial<OrganizationLiveAuthorityState>, "capability" | "scope"> & {
  capability?: {
    snapshot?: OrganizationCapabilitySnapshot;
    revokedAt?: string | null;
  };
  scope?: Partial<OrganizationScope>;
};

function liveAuthority(
  candidate: OrganizationOperationRequest,
  overrides: LiveOverrides = {},
): OrganizationLiveAuthorityState {
  return {
    scope: { workspaceId: "workspace_1", accountIds: ["account_1", "account_2"], ...overrides.scope },
    capability: {
      snapshot: overrides.capability?.snapshot ?? candidate.capabilitySnapshot,
      revokedAt: overrides.capability?.revokedAt ?? null,
    },
    workspaceRevision: overrides.workspaceRevision ?? 7,
    resourceRevisions: overrides.resourceRevisions ?? { lane_1: 2, thread_1: 5 },
    reservedIdempotencyKeys: overrides.reservedIdempotencyKeys ?? [],
  };
}

function authorize(candidate: OrganizationOperationRequest, overrides: LiveOverrides = {}) {
  return authorizeOrganizationOperation(candidate, liveAuthority(candidate, overrides));
}

describe("G0 Actor identity and operation matrix", () => {
  test("keeps system revert ineligible while capability-gating all five human and agent operations", () => {
    assert.deepEqual(organizationActorOperationMatrix, {
      human: ["describe", "query", "simulate", "apply", "revert"],
      agent: ["describe", "query", "simulate", "apply", "revert"],
      system: ["describe", "query", "simulate", "apply"],
    });
    const candidate = request({ actor: { id: "system_1", type: "system" }, operation: "revert" });
    const decision = authorize(candidate);
    assert.equal(decision.allowed, false);
    if (!decision.allowed) assert.equal(decision.code, "actor_operation_denied");
  });

  test("binds Actor type as well as ID into the live Capability identity", () => {
    const candidate = request({
      actor: { id: "shared_id", type: "human" },
      operation: "revert",
      capabilitySnapshot: { actor: { id: "shared_id", type: "system" } },
    });
    const decision = authorize(candidate);
    assert.equal(decision.allowed, false);
    if (!decision.allowed) assert.equal(decision.code, "actor_mismatch");
  });
});

describe("G0 runtime validation", () => {
  test("fails closed instead of authorizing or throwing on malformed requests", () => {
    const valid = request();
    for (const malformed of [
      { ...valid, scope: { workspaceId: "workspace_1", accountIds: [] } },
      { ...valid, actor: { id: "actor_1", type: "administrator" } },
      null,
    ]) {
      const decision = authorizeOrganizationOperation(malformed, liveAuthority(valid));
      assert.deepEqual(decision, {
        allowed: false,
        code: "invalid_request",
        reason: "The Organization request failed runtime validation",
        trace: null,
      });
    }
  });

  test("fails closed on malformed trusted live state", () => {
    const candidate = request();
    const decision = authorizeOrganizationOperation(candidate, { ...liveAuthority(candidate), scope: { workspaceId: "workspace_1", accountIds: [] } });
    assert.equal(decision.allowed, false);
    if (!decision.allowed) assert.equal(decision.code, "invalid_live_authority");
  });
});

describe("G0 live Capability, Workspace, and Account isolation", () => {
  test("allows all and only explicitly requested live and granted Accounts", () => {
    const candidate = request({ scope: { workspaceId: "workspace_1", accountIds: ["account_2", "account_1"] } });
    const decision = authorize(candidate);
    assert.equal(decision.allowed, true);
    if (decision.allowed) assert.deepEqual(decision.executionContext.accountIds, ["account_2", "account_1"]);
  });

  test("denies guessed, stale, or cross-Workspace scope instead of narrowing silently", () => {
    const guessed = request({ scope: { workspaceId: "workspace_1", accountIds: ["account_3"] } });
    const crossWorkspace = request({ scope: { workspaceId: "workspace_2", accountIds: ["account_1"] } });
    for (const [candidate, code] of [[guessed, "account_denied"], [crossWorkspace, "workspace_denied"]] as const) {
      const decision = authorize(candidate);
      assert.equal(decision.allowed, false);
      if (!decision.allowed) assert.equal(decision.code, code);
    }
  });

  test("rejects stale and revoked Capability snapshot replay", () => {
    const candidate = request();
    const newerSnapshot = { ...candidate.capabilitySnapshot, revision: candidate.capabilitySnapshot.revision + 1 };
    const stale = authorize(candidate, { capability: { snapshot: newerSnapshot } });
    assert.equal(stale.allowed, false);
    if (!stale.allowed) assert.equal(stale.code, "capability_stale");

    const revoked = authorize(candidate, { capability: { revokedAt: "2026-08-23T21:00:00.000Z" } });
    assert.equal(revoked.allowed, false);
    if (!revoked.allowed) assert.equal(revoked.code, "capability_revoked");
  });
});

describe("G0 command binding and bounded authority", () => {
  test("derives resource, action, and risk from the exact command instead of caller metadata", () => {
    const candidate = request({
      operation: "apply",
      command: { id: "command_lane", intents: [{ kind: "mutate_lane", resourceId: "lane_1", mutation: "update", changes: { name: "Priority" } }] },
      capabilitySnapshot: { actionFamilies: ["organization_read"] },
    });
    const decision = authorize(candidate);
    assert.equal(decision.allowed, false);
    if (!decision.allowed) {
      assert.equal(decision.code, "action_family_denied");
      assert.deepEqual(decision.trace?.requestedResourceFamilies, ["lane"]);
      assert.deepEqual(decision.trace?.requestedActionFamilies, ["organization_structure"]);
      assert.equal(decision.trace?.risk, "medium");
    }
  });

  test("binds the allowed execution context to a server-computed command digest", () => {
    const candidate = request({ operation: "apply" });
    const decision = authorize(candidate);
    assert.equal(decision.allowed, true);
    if (!decision.allowed) return;
    assert.match(decision.executionContext.command.digest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(decision.executionContext.command.id, candidate.command.id);
    assert.deepEqual(decision.executionContext.actor, candidate.actor);
    assert.equal(decision.executionContext.workspaceId, candidate.scope.workspaceId);
    assert.equal(decision.executionContext.requiresAtomicIdempotencyReservation, true);
    assert.equal(organizationExecutionContextSchema.safeParse(decision.executionContext).success, true);

    const changed = authorize(request({ operation: "apply", command: { id: "command_apply", intents: [{ kind: "mutate_lane", resourceId: "lane_1", mutation: "update", changes: { name: "Escalations" } }] } }));
    assert.equal(changed.allowed, true);
    if (changed.allowed) assert.notEqual(changed.executionContext.command.digest, decision.executionContext.command.digest);
  });

  test("rejects operation/intent mismatch and hard-excludes send or provider deletion", () => {
    const mismatched = authorize(request({ command: { id: "smuggled", intents: [{ kind: "mutate_lane", resourceId: "lane_1", mutation: "update", changes: { name: "Smuggled" } }] } }));
    assert.equal(mismatched.allowed, false);
    if (!mismatched.allowed) assert.equal(mismatched.code, "operation_intent_mismatch");

    for (const kind of ["send_mail", "delete_provider_mail"] as const) {
      const candidate = request({
        operation: "apply",
        command: { id: `forbidden_${kind}`, intents: [{ kind, resourceId: "mail_1", mutation: "update", changes: { state: "forbidden" } }] },
        expectedRevisions: { workspace: 7, resources: {} },
        capabilitySnapshot: {
          actionFamilies: ["organization_read", kind === "send_mail" ? "mail_send" : "provider_delete"],
        },
      });
      const decision = authorize(candidate, { resourceRevisions: {} });
      assert.equal(decision.allowed, false);
      if (!decision.allowed) assert.equal(decision.code, "send_delete_forbidden");
    }
  });
});

describe("G0 revision and idempotency execution preconditions", () => {
  test("rejects stale or missing Workspace and resource revisions", () => {
    const staleWorkspace = authorize(request({ operation: "apply", expectedRevisions: { workspace: 6, resources: { lane_1: 2 } } }));
    assert.equal(staleWorkspace.allowed, false);
    if (!staleWorkspace.allowed) assert.equal(staleWorkspace.code, "revision_conflict");

    const resourceCases: Array<Record<string, number>> = [{}, { lane_1: 1 }, { lane_1: 2, unrelated: 1 }];
    for (const resources of resourceCases) {
      const decision = authorize(request({ operation: "apply", expectedRevisions: { workspace: 7, resources } }));
      assert.equal(decision.allowed, false);
      if (!decision.allowed) assert.equal(decision.code, "revision_conflict");
    }

    const missingUpdate = authorize(request({
      operation: "apply",
      command: { id: "missing_update", intents: [{ kind: "mutate_rule", resourceId: "rule_1", mutation: "update", changes: { enabled: true } }] },
      expectedRevisions: { workspace: 7, resources: {} },
    }), { resourceRevisions: {} });
    assert.equal(missingUpdate.allowed, false);
    if (!missingUpdate.allowed) assert.equal(missingUpdate.code, "revision_conflict");

    const create = authorize(request({
      operation: "apply",
      command: { id: "create_rule", intents: [{ kind: "mutate_rule", resourceId: "rule_1", mutation: "create", changes: { enabled: true } }] },
      expectedRevisions: { workspace: 7, resources: {} },
    }), { resourceRevisions: {} });
    assert.equal(create.allowed, true);

    const createOverExisting = authorize(request({
      operation: "apply",
      command: { id: "create_lane", intents: [{ kind: "mutate_lane", resourceId: "lane_1", mutation: "create", changes: { name: "Duplicate" } }] },
      expectedRevisions: { workspace: 7, resources: {} },
    }));
    assert.equal(createOverExisting.allowed, false);
    if (!createOverExisting.allowed) assert.equal(createOverExisting.code, "revision_conflict");
  });

  test("rejects missing or already-reserved idempotency keys", () => {
    const missing = authorize(request({ operation: "apply", idempotencyKey: null }));
    assert.equal(missing.allowed, false);
    if (!missing.allowed) assert.equal(missing.code, "idempotency_key_required");

    const duplicate = authorize(request({ operation: "apply" }), { reservedIdempotencyKeys: ["idem_1"] });
    assert.equal(duplicate.allowed, false);
    if (!duplicate.allowed) assert.equal(duplicate.code, "duplicate_idempotency_key");
  });
});

describe("G0 Trace evidence", () => {
  test("records the bound command and requested families on allow and deny", () => {
    const allowed = authorize(request({ operation: "apply" }));
    assert.equal(allowed.allowed, true);
    assert.equal(organizationAuthorityTraceSchema.safeParse(allowed.trace).success, true);
    assert.deepEqual(allowed.trace.requestedResourceFamilies, ["lane"]);
    assert.deepEqual(allowed.trace.requestedActionFamilies, ["organization_structure"]);
    assert.deepEqual(allowed.trace.requestedResourceIds, ["lane_1"]);
    assert.equal(allowed.trace.command.id, "command_apply");

    const denied = authorize(request({
      operation: "apply",
      command: { id: "command_rule", intents: [{ kind: "mutate_rule", resourceId: "rule_1", mutation: "create", changes: { source: "when sender matches" } }] },
      expectedRevisions: { workspace: 7, resources: {} },
      capabilitySnapshot: { resourceFamilies: ["lane"] },
    }), { resourceRevisions: {} });
    assert.equal(denied.allowed, false);
    if (!denied.allowed) {
      assert.equal(denied.code, "resource_family_denied");
      assert.equal(organizationAuthorityTraceSchema.safeParse(denied.trace).success, true);
      assert.deepEqual(denied.trace?.requestedResourceFamilies, ["rule"]);
      assert.deepEqual(denied.trace?.requestedActionFamilies, ["organization_structure"]);
      assert.deepEqual(denied.trace?.requestedResourceIds, ["rule_1"]);
    }
  });
});
