import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, test } from "node:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { eq } from "drizzle-orm";

import { createDatabaseClient } from "../../db/client.ts";
import { collectionThreads, collections, oauthAccounts, organizationSavedQueries, pins, threads, users } from "../../db/schema.ts";
import {
  OrganizationCollectionsPinsAccessError,
  OrganizationCollectionsPinsConflictError,
  createOrganizationCollectionsPins,
} from "./module.ts";
import { createSqliteOrganizationCollectionsPinsRepository } from "./sqlite-repository.ts";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "orca-collections-pins-organization-"));
  tempDirectories.push(directory);
  const client = createDatabaseClient(join(directory, "organization.sqlite"));
  migrate(client.db, { migrationsFolder: resolve(import.meta.dir, "../../../drizzle") });
  client.db.insert(users).values([
    { id: "workspace_owner", email: "owner@example.com" },
    { id: "workspace_private", email: "private@example.com" },
  ]).run();
  client.db.insert(oauthAccounts).values([
    { id: "account_a", userId: "workspace_owner", provider: "gmail", providerEmail: "a@example.com", providerId: "provider-a" },
    { id: "account_b", userId: "workspace_owner", provider: "outlook", providerEmail: "b@example.com", providerId: "provider-b" },
    { id: "account_private", userId: "workspace_private", provider: "gmail", providerEmail: "private@example.com", providerId: "provider-private" },
  ]).run();
  client.db.insert(threads).values([
    { id: "thread_a", accountId: "account_a", providerThreadId: "provider-thread-a", subject: "A", latestReceivedAt: new Date(), messageCount: 1 },
    { id: "thread_b", accountId: "account_b", providerThreadId: "provider-thread-b", subject: "B", latestReceivedAt: new Date(), messageCount: 1 },
    { id: "thread_private", accountId: "account_private", providerThreadId: "provider-thread-private", subject: "Private", latestReceivedAt: new Date(), messageCount: 1 },
  ]).run();
  client.db.insert(collections).values([
    { id: "collection_a", accountId: "account_a", name: "Account A", color: "#70867d", position: 0 },
    { id: "collection_b", accountId: "account_b", name: "Account B", color: "#83728d", position: 0 },
    { id: "collection_private", accountId: "account_private", name: "Private", color: "#70867d", position: 0 },
  ]).run();
  client.db.insert(collectionThreads).values({ id: "membership_a", collectionId: "collection_a", threadId: "thread_a" }).run();

  let sequence = 0;
  let resourceSequence = 0;
  const organization = createOrganizationCollectionsPins(
    createSqliteOrganizationCollectionsPinsRepository(client.db),
    {
      now: () => new Date("2026-08-23T12:00:00.000Z"),
      newChangeId: () => `change_${++sequence}`,
      newResourceId: (kind) => `${kind}_${++resourceSequence}`,
    },
  );
  const scope = {
    actor: { id: "human_owner", type: "human" as const },
    workspaceId: "workspace_owner",
    accountIds: ["account_a", "account_b"],
  };
  return { ...client, organization, scope };
}

describe("Collections/Pins Organization module", { timeout: 20_000 }, () => {
  test("describes an empty connected-Account scope without inventing data", () => {
    const directory = mkdtempSync(join(tmpdir(), "orca-collections-pins-empty-"));
    tempDirectories.push(directory);
    const client = createDatabaseClient(join(directory, "organization.sqlite"));
    migrate(client.db, { migrationsFolder: resolve(import.meta.dir, "../../../drizzle") });
    try {
      client.db.insert(users).values({ id: "workspace_empty", email: "empty@example.com" }).run();
      const organization = createOrganizationCollectionsPins(createSqliteOrganizationCollectionsPinsRepository(client.db));
      const scope = { actor: { id: "human_empty", type: "human" as const }, workspaceId: "workspace_empty", accountIds: [] };
      assert.deepEqual(organization.describe({ scope }).accountIds, []);
      assert.deepEqual(organization.query({ scope, query: {} }), {
        workspaceId: "workspace_empty",
        accountIds: [],
        collections: [],
        pins: [],
        queries: [],
      });
      assert.deepEqual(organization.audit({ scope }), []);
    } finally {
      client.sqlite.close();
    }
  });

  test("queries explicit Collection membership across authorized Accounts with Account context", () => {
    const { organization, scope, sqlite } = fixture();
    try {
      const result = organization.query({ scope, query: {} });
      assert.deepEqual(result.collections.map((collection) => [collection.id, collection.accountId, collection.threadIds]), [
        ["collection_a", "account_a", ["thread_a"]],
        ["collection_b", "account_b", []],
      ]);
      assert.equal(JSON.stringify(result).includes("Private"), false);
      assert.equal(JSON.stringify(result).includes("gmail"), false);

      const account = organization.query({ scope, query: { accountIds: ["account_b"] } });
      assert.deepEqual(account.accountIds, ["account_b"]);
      assert.deepEqual(account.collections.map((collection) => collection.id), ["collection_b"]);
    } finally {
      sqlite.close();
    }
  });

  test("fails closed for unauthorized Account scope and cross-Account membership", () => {
    const { organization, scope, sqlite } = fixture();
    try {
      assert.throws(
        () => organization.query({ scope, query: { accountIds: ["account_private"] } }),
        (error) => error instanceof OrganizationCollectionsPinsAccessError && error.code === "account_denied",
      );
      assert.throws(
        () => organization.apply({
          scope,
          request: {
            idempotencyKey: "cross-account-membership",
            change: { kind: "collection_membership", action: "add", accountId: "account_a", collectionId: "collection_a", threadId: "thread_b" },
          },
        }),
        (error) => error instanceof OrganizationCollectionsPinsAccessError && error.code === "account_denied",
      );
    } finally {
      sqlite.close();
    }
  });

  test("applies and reverts membership changes with immutable audit entries", () => {
    const { organization, scope, sqlite } = fixture();
    try {
      const applied = organization.apply({
        scope,
        request: {
          idempotencyKey: "membership-add-b",
          change: { kind: "collection_membership", action: "add", accountId: "account_b", collectionId: "collection_b", threadId: "thread_b" },
        },
      });
      assert.equal(applied.change.operation, "apply");
      assert.equal(applied.change.changeKind, "collection_membership");
      assert.deepEqual(applied.state.collections.find((item) => item.id === "collection_b")?.threadIds, ["thread_b"]);

      const duplicate = organization.apply({
        scope,
        request: {
          idempotencyKey: "membership-add-b",
          change: { kind: "collection_membership", action: "add", accountId: "account_b", collectionId: "collection_b", threadId: "thread_b" },
        },
      });
      assert.equal(duplicate.change.id, applied.change.id);

      const reverted = organization.revert({
        scope,
        request: { idempotencyKey: "membership-revert-b", changeId: applied.change.id },
      });
      assert.equal(reverted.change.operation, "revert");
      assert.equal(reverted.change.revertsChangeId, applied.change.id);
      assert.deepEqual(reverted.state.collections.find((item) => item.id === "collection_b")?.threadIds, []);
      const audit = organization.audit({ scope });
      assert.equal(audit.length, 2);
      assert.equal(audit[0]?.revertedByChangeId, reverted.change.id);
    } finally {
      sqlite.close();
    }
  });

  test("creates a query Pin by stable identity and can compensate its removal", () => {
    const { organization, scope, sqlite } = fixture();
    try {
      const savedQuery = organization.apply({
        scope,
        request: {
          idempotencyKey: "query-create",
          change: {
            kind: "saved_query",
            action: "create",
            accountId: "account_a",
            query: { name: "Launch", definition: { revision: 1, filters: { text: "launch" } } },
          },
        },
      });
      const created = organization.apply({
        scope,
        request: {
          idempotencyKey: "pin-create",
          change: {
            kind: "pin",
            action: "create",
            accountId: "account_a",
            pin: {
              label: "Launch",
              icon: "search",
              color: "#70867d",
              target: { type: "query", queryId: savedQuery.change.resourceId },
            },
          },
        },
      });
      assert.deepEqual(created.state.pins[0]?.target, { type: "query", queryId: savedQuery.change.resourceId });
      assert.deepEqual(created.state.queries[0]?.definition, { revision: 1, filters: { text: "launch" } });

      const removed = organization.apply({
        scope,
        request: { idempotencyKey: "pin-remove", change: { kind: "pin", action: "remove", accountId: "account_a", pinId: created.change.resourceId } },
      });
      assert.deepEqual(removed.state.pins, []);
      const restored = organization.revert({ scope, request: { idempotencyKey: "pin-restore", changeId: removed.change.id } });
      assert.equal(restored.state.pins[0]?.id, created.change.resourceId);
    } finally {
      sqlite.close();
    }
  });

  test("preserves every legacy mailbox and attention shortcut meaning", () => {
    const { organization, scope, db, sqlite } = fixture();
    try {
      const cases = [
        { id: "focus-mailbox", mailbox: "focus", attention: "all", expected: "focus" },
        { id: "focus-attention", mailbox: "inbox", attention: "focus", expected: "focus" },
        { id: "notify-attention", mailbox: "inbox", attention: "notify", expected: "focus" },
        { id: "normal-attention", mailbox: "inbox", attention: "normal", expected: "normal" },
        { id: "quiet-mailbox", mailbox: "quiet", attention: "all", expected: "quiet" },
        { id: "hidden-mailbox", mailbox: "hidden", attention: "all", expected: "hidden" },
        { id: "all-mailbox", mailbox: "all", attention: "all", expected: "all" },
      ] as const;
      cases.forEach((item, position) => {
        const queryId = `query:${item.id}`;
        db.insert(organizationSavedQueries).values({
          id: queryId,
          accountId: "account_a",
          name: item.id,
          definitionJson: JSON.stringify({ mailbox: item.mailbox, attention: item.attention, query: "", person: null }),
        }).run();
        db.insert(pins).values({
          id: `pin:${item.id}`,
          accountId: "account_a",
          kind: "filter",
          targetId: JSON.stringify({ mailbox: item.mailbox, attention: item.attention, query: "", person: null }),
          targetType: "query",
          savedQueryId: queryId,
          label: item.id,
          icon: "search",
          color: "#70867d",
          position,
        }).run();
      });

      const result = organization.query({ scope, query: { accountIds: ["account_a"] } });
      for (const item of cases) {
        assert.equal(result.queries.find((query) => query.id === `query:${item.id}`)?.definition.filters.attention, item.expected);
      }
    } finally {
      sqlite.close();
    }
  });

  test("refuses to revert Collection changes after same-ID recreation", () => {
    const createdFixture = fixture();
    try {
      const created = createdFixture.organization.apply({
        scope: createdFixture.scope,
        request: {
          idempotencyKey: "collection-create-stale",
          change: { kind: "collection", action: "create", accountId: "account_a", collection: { name: "First", color: "#70867d" } },
        },
      });
      createdFixture.db.delete(collections).where(eq(collections.id, created.change.resourceId)).run();
      createdFixture.db.insert(collections).values({
        id: created.change.resourceId, accountId: "account_a", name: "Later", color: "#83728d", position: 1,
      }).run();
      assert.throws(
        () => createdFixture.organization.revert({ scope: createdFixture.scope, request: { idempotencyKey: "revert-stale-create", changeId: created.change.id } }),
        (error) => error instanceof OrganizationCollectionsPinsConflictError,
      );
    } finally {
      createdFixture.sqlite.close();
    }

    const removedFixture = fixture();
    try {
      const removed = removedFixture.organization.apply({
        scope: removedFixture.scope,
        request: { idempotencyKey: "collection-remove-stale", change: { kind: "collection", action: "remove", accountId: "account_b", collectionId: "collection_b" } },
      });
      removedFixture.db.insert(collections).values({
        id: "collection_b", accountId: "account_b", name: "Later", color: "#83728d", position: 0,
      }).run();
      assert.throws(
        () => removedFixture.organization.revert({ scope: removedFixture.scope, request: { idempotencyKey: "revert-stale-remove", changeId: removed.change.id } }),
        (error) => error instanceof OrganizationCollectionsPinsConflictError,
      );
    } finally {
      removedFixture.sqlite.close();
    }
  });

  test("refuses to revert membership after remove and re-add", () => {
    const { organization, scope, sqlite } = fixture();
    try {
      const first = organization.apply({
        scope,
        request: { idempotencyKey: "membership-first", change: { kind: "collection_membership", action: "add", accountId: "account_b", collectionId: "collection_b", threadId: "thread_b" } },
      });
      organization.apply({
        scope,
        request: { idempotencyKey: "membership-remove-later", change: { kind: "collection_membership", action: "remove", accountId: "account_b", collectionId: "collection_b", threadId: "thread_b" } },
      });
      organization.apply({
        scope,
        request: { idempotencyKey: "membership-add-later", change: { kind: "collection_membership", action: "add", accountId: "account_b", collectionId: "collection_b", threadId: "thread_b" } },
      });
      assert.throws(
        () => organization.revert({ scope, request: { idempotencyKey: "revert-stale-membership", changeId: first.change.id } }),
        (error) => error instanceof OrganizationCollectionsPinsConflictError,
      );
    } finally {
      sqlite.close();
    }
  });

  test("refuses to revert saved-query changes after same-ID recreation", () => {
    const createdFixture = fixture();
    try {
      const created = createdFixture.organization.apply({
        scope: createdFixture.scope,
        request: {
          idempotencyKey: "query-create-stale",
          change: { kind: "saved_query", action: "create", accountId: "account_a", query: { name: "First", definition: { revision: 1, filters: { text: "first" } } } },
        },
      });
      createdFixture.db.delete(organizationSavedQueries).where(eq(organizationSavedQueries.id, created.change.resourceId)).run();
      createdFixture.db.insert(organizationSavedQueries).values({
        id: created.change.resourceId, accountId: "account_a", name: "Later", definitionJson: JSON.stringify({ revision: 1, filters: { text: "later" } }),
      }).run();
      assert.throws(
        () => createdFixture.organization.revert({ scope: createdFixture.scope, request: { idempotencyKey: "revert-stale-query-create", changeId: created.change.id } }),
        (error) => error instanceof OrganizationCollectionsPinsConflictError,
      );
    } finally {
      createdFixture.sqlite.close();
    }

    const removedFixture = fixture();
    try {
      removedFixture.db.insert(organizationSavedQueries).values({
        id: "query_seed", accountId: "account_a", name: "Seed", definitionJson: JSON.stringify({ revision: 1, filters: { text: "seed" } }),
      }).run();
      const removed = removedFixture.organization.apply({
        scope: removedFixture.scope,
        request: { idempotencyKey: "query-remove-stale", change: { kind: "saved_query", action: "remove", accountId: "account_a", queryId: "query_seed" } },
      });
      removedFixture.db.insert(organizationSavedQueries).values({
        id: "query_seed", accountId: "account_a", name: "Later", definitionJson: JSON.stringify({ revision: 1, filters: { text: "later" } }),
      }).run();
      assert.throws(
        () => removedFixture.organization.revert({ scope: removedFixture.scope, request: { idempotencyKey: "revert-stale-query-remove", changeId: removed.change.id } }),
        (error) => error instanceof OrganizationCollectionsPinsConflictError,
      );
    } finally {
      removedFixture.sqlite.close();
    }
  });

  test("refuses to revert Pin changes after same-ID recreation", () => {
    const createdFixture = fixture();
    try {
      const created = createdFixture.organization.apply({
        scope: createdFixture.scope,
        request: {
          idempotencyKey: "pin-create-stale",
          change: { kind: "pin", action: "create", accountId: "account_a", pin: { label: "First", icon: "thread", color: "#70867d", target: { type: "resource", resource: { family: "thread", id: "thread_a" } } } },
        },
      });
      createdFixture.db.delete(pins).where(eq(pins.id, created.change.resourceId)).run();
      createdFixture.db.insert(pins).values({
        id: created.change.resourceId, accountId: "account_a", kind: "thread", targetId: "thread_a", targetType: "resource", resourceFamily: "thread",
        label: "Later", icon: "thread", color: "#83728d", position: 0,
      }).run();
      assert.throws(
        () => createdFixture.organization.revert({ scope: createdFixture.scope, request: { idempotencyKey: "revert-stale-pin-create", changeId: created.change.id } }),
        (error) => error instanceof OrganizationCollectionsPinsConflictError,
      );
    } finally {
      createdFixture.sqlite.close();
    }

    const removedFixture = fixture();
    try {
      removedFixture.db.insert(pins).values({
        id: "pin_seed", accountId: "account_a", kind: "thread", targetId: "thread_a", targetType: "resource", resourceFamily: "thread",
        label: "Seed", icon: "thread", color: "#70867d", position: 0,
      }).run();
      const removed = removedFixture.organization.apply({
        scope: removedFixture.scope,
        request: { idempotencyKey: "pin-remove-stale", change: { kind: "pin", action: "remove", accountId: "account_a", pinId: "pin_seed" } },
      });
      removedFixture.db.insert(pins).values({
        id: "pin_seed", accountId: "account_a", kind: "thread", targetId: "thread_a", targetType: "resource", resourceFamily: "thread",
        label: "Later", icon: "thread", color: "#83728d", position: 0,
      }).run();
      assert.throws(
        () => removedFixture.organization.revert({ scope: removedFixture.scope, request: { idempotencyKey: "revert-stale-pin-remove", changeId: removed.change.id } }),
        (error) => error instanceof OrganizationCollectionsPinsConflictError,
      );
    } finally {
      removedFixture.sqlite.close();
    }
  });

  test("describes only Organization authority and distinct meanings", () => {
    const { organization, scope, sqlite } = fixture();
    try {
      assert.deepEqual(organization.describe({ scope }), {
        workspaceId: "workspace_owner",
        accountIds: ["account_a", "account_b"],
        semantics: { collections: "explicit_thread_membership", pins: "stable_shortcut_identity" },
        operations: { describe: true, query: true, apply: true, revert: true, simulate: false },
        authority: { sendMail: false, deleteProviderMail: false },
      });
    } finally {
      sqlite.close();
    }
  });
});
