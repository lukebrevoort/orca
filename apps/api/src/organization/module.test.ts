import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  OrganizationAccessError,
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
  test("describes one provider-neutral Thread workspace with only read operations enabled", () => {
    const organization = createOrganization(repository);

    const result = organization.describe({ scope: ownerScope });

    assert.deepEqual(result.workspaceSchema, {
      revision: 1,
      aggregate: "thread",
      resources: ["account", "thread"],
      filters: ["account", "thread", "attention", "classification", "sender", "text", "received_at"],
    });
    assert.deepEqual(result.capabilities.operations, {
      describe: true,
      query: true,
      simulate: false,
      apply: false,
      revert: false,
    });
    assert.deepEqual(result.capabilities.authority, { sendMail: false, deleteProviderMail: false });
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

  test("exposes mutation operations as explicitly disabled", () => {
    const organization = createOrganization(repository);

    for (const operation of ["simulate", "apply", "revert"] as const) {
      assert.throws(
        () => organization[operation]({ scope: ownerScope }),
        (error) => error instanceof OrganizationOperationDisabledError && error.operation === operation,
      );
    }
  });
});
