import { describe, expect, test } from "bun:test";

import type { OrganizationCollectionPinMutationResponse, OrganizationCollectionPinQueryResponse } from "@orca/shared";

import {
  buildCollectionMembershipMutation,
  toCollectionPinMutationResult,
  toCollectionPinViewModels,
} from "./collections-pins.ts";

const state: OrganizationCollectionPinQueryResponse = {
  workspaceId: "workspace_1",
  accountIds: ["account_a", "account_b"],
  collections: [{
    id: "collection_a",
    accountId: "account_a",
    name: "Launch",
    color: "#70867d",
    position: 0,
    threadIds: ["thread_a", "thread_b"],
    revision: 1,
    createdAt: "2026-08-23T12:00:00.000Z",
    updatedAt: "2026-08-23T12:00:00.000Z",
  }],
  pins: [{
    id: "pin_b",
    accountId: "account_b",
    label: "Launch view",
    icon: "search",
    color: "#83728d",
    position: 0,
    target: { type: "query", queryId: "query_b" },
    revision: 1,
    createdAt: "2026-08-23T12:00:00.000Z",
    updatedAt: "2026-08-23T12:00:00.000Z",
  }],
  queries: [{
    id: "query_b",
    accountId: "account_b",
    name: "Launch view",
    definition: { revision: 1, filters: { text: "launch" } },
    revision: 1,
  }],
};

describe("Collections/Pins frontend seam", () => {
  test("preserves distinct meanings and visible Account context", () => {
    const models = toCollectionPinViewModels(state, [
      { id: "account_a", label: "Personal · a@example.com" },
      { id: "account_b", label: "Work · b@example.com" },
    ]);

    expect(models).toEqual([
      {
        kind: "collection",
        id: "collection_a",
        accountId: "account_a",
        accountLabel: "Personal · a@example.com",
        label: "Launch",
        color: "#70867d",
        position: 0,
        membership: { type: "explicit_threads", threadIds: ["thread_a", "thread_b"], count: 2 },
      },
      {
        kind: "pin",
        id: "pin_b",
        accountId: "account_b",
        accountLabel: "Work · b@example.com",
        label: "Launch view",
        color: "#83728d",
        icon: "search",
        position: 0,
        shortcut: { type: "query", queryId: "query_b", summary: "Text: launch" },
      },
    ]);
  });

  test("builds only typed Organization membership mutations", () => {
    expect(buildCollectionMembershipMutation({
      idempotencyKey: "membership-1",
      action: "add",
      accountId: "account_a",
      collectionId: "collection_a",
      threadId: "thread_a",
    })).toEqual({
      idempotencyKey: "membership-1",
      change: {
        kind: "collection_membership",
        action: "add",
        accountId: "account_a",
        collectionId: "collection_a",
        threadId: "thread_a",
      },
    });
  });

  test("normalizes typed success and recoverable operation errors", () => {
    const response: OrganizationCollectionPinMutationResponse = {
      change: {
        id: "change_1",
        workspaceId: "workspace_1",
        accountId: "account_a",
        actor: { id: "human_1", type: "human" },
        operation: "apply",
        changeKind: "collection_membership",
        resourceId: "collection_a:thread_a",
        before: { member: false },
        after: { member: true },
        reason: "Added explicit Thread membership",
        revertsChangeId: null,
        revertedByChangeId: null,
        createdAt: "2026-08-23T12:00:00.000Z",
      },
      state,
    };
    expect(toCollectionPinMutationResult(response)).toEqual({ ok: true, value: response });
    expect(toCollectionPinMutationResult({ error: { code: "conflict", message: "Try again" } })).toEqual({
      ok: false,
      error: { code: "conflict", message: "Try again", retryable: true },
    });
  });
});
