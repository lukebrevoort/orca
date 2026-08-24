import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  organizationCollectionPinApplyRequestSchema,
  organizationCollectionPinQueryResponseSchema,
  organizationCollectionPinRevertRequestSchema,
  organizationPinTargetSchema,
} from "./organization-collections-pins.ts";
import { organizationCollectionPinDemoFixture } from "./organization-collections-pins-fixtures.ts";

describe("Organization Collections/Pins contract", () => {
  test("provides a clean-reset fixture with explicit membership and stable shortcut identity", () => {
    assert.deepEqual(organizationCollectionPinDemoFixture.collections[0]?.threadIds, ["thread_launch", "thread_research"]);
    assert.deepEqual(organizationCollectionPinDemoFixture.pins[0]?.target, { type: "query", queryId: "query_failed_deployments" });
  });

  test("keeps Collection membership distinct from live query shortcuts", () => {
    const result = organizationCollectionPinQueryResponseSchema.parse({
      workspaceId: "workspace_1",
      accountIds: ["account_a", "account_b"],
      collections: [{
        id: "collection_1",
        accountId: "account_a",
        name: "Launch",
        color: "#70867d",
        position: 0,
        threadIds: ["thread_1"],
        revision: 1,
        createdAt: "2026-08-23T12:00:00.000Z",
        updatedAt: "2026-08-23T12:00:00.000Z",
      }],
      pins: [{
        id: "pin_1",
        accountId: "account_b",
        label: "Launch view",
        icon: "grid",
        color: "#83728d",
        position: 0,
        target: { type: "query", queryId: "query_launch" },
        revision: 1,
        createdAt: "2026-08-23T12:00:00.000Z",
        updatedAt: "2026-08-23T12:00:00.000Z",
      }],
      queries: [{
        id: "query_launch",
        accountId: "account_b",
        name: "Launch view",
        definition: { revision: 1, filters: { text: "launch" } },
        revision: 1,
      }],
    });

    assert.deepEqual(result.collections[0]?.threadIds, ["thread_1"]);
    assert.deepEqual(result.pins[0]?.target, { type: "query", queryId: "query_launch" });
    assert.equal("query" in result.collections[0]!, false);
  });

  test("requires Pins to use stable resource or query identity", () => {
    assert.deepEqual(organizationPinTargetSchema.parse({
      type: "resource",
      resource: { family: "thread", id: "thread_1" },
    }), { type: "resource", resource: { family: "thread", id: "thread_1" } });
    assert.equal(organizationPinTargetSchema.safeParse({
      type: "query",
      serializedUiState: "{\"mailbox\":\"inbox\"}",
    }).success, false);
    assert.deepEqual(organizationPinTargetSchema.parse({
      type: "resource",
      resource: { family: "view", id: "focus" },
    }), { type: "resource", resource: { family: "view", id: "focus" } });
    assert.equal(organizationPinTargetSchema.safeParse({
      type: "resource",
      resource: { family: "view", id: "{\"mailbox\":\"focus\"}" },
    }).success, false);
  });

  test("expresses auditable membership and shortcut changes without mail authority", () => {
    const membership = organizationCollectionPinApplyRequestSchema.parse({
      idempotencyKey: "membership-1",
      change: {
        kind: "collection_membership",
        action: "add",
        accountId: "account_a",
        collectionId: "collection_1",
        threadId: "thread_1",
      },
    });
    const shortcut = organizationCollectionPinApplyRequestSchema.parse({
      idempotencyKey: "pin-1",
      change: {
        kind: "pin",
        action: "create",
        accountId: "account_a",
        pin: {
          label: "Launch",
          icon: "thread",
          color: "#70867d",
          target: { type: "resource", resource: { family: "thread", id: "thread_1" } },
        },
      },
    });

    assert.equal(membership.change.kind, "collection_membership");
    assert.equal(shortcut.change.kind, "pin");
    assert.equal(organizationCollectionPinApplyRequestSchema.safeParse({
      idempotencyKey: "caller-selected-id",
      change: {
        kind: "pin",
        action: "create",
        accountId: "account_a",
        pin: {
          id: "pin_in_another_workspace",
          label: "Launch",
          icon: "thread",
          color: "#70867d",
          target: { type: "resource", resource: { family: "thread", id: "thread_1" } },
        },
      },
    }).success, false);
    assert.equal(organizationCollectionPinApplyRequestSchema.safeParse({
      idempotencyKey: "delete-mail",
      change: { kind: "provider_delete", accountId: "account_a", messageId: "message_1" },
    }).success, false);
    assert.deepEqual(organizationCollectionPinRevertRequestSchema.parse({
      idempotencyKey: "revert-1",
      changeId: "change_1",
    }), { idempotencyKey: "revert-1", changeId: "change_1" });
  });
});
