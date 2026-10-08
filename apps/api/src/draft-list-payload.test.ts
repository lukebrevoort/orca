import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createSession } from "./auth/session-store.ts";
import { createDatabaseClient } from "./db/client.ts";
import { messageDrafts, oauthAccounts, users } from "./db/schema.ts";
import { createApp } from "./index.ts";

test("draft list can omit sent content without losing delivery reconciliation or unresolved writing", async () => {
  const previousSecret = process.env.SESSION_SECRET;
  const previousEncryption = process.env.TOKEN_ENCRYPTION_KEY;
  process.env.SESSION_SECRET = "draft-list-payload-test-secret-at-least-32-characters";
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 42).toString("base64");
  const dir = mkdtempSync(join(tmpdir(), "orca-draft-list-payload-"));
  const path = join(dir, "test.sqlite");
  const { db, sqlite } = createDatabaseClient(path);
  migrate(db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });
  let selectedRows = 0;
  let selectedBytes = 0;
  let selectCount = 0;
  let observeSelections = true;
  try {
    db.insert(users).values([{ id: "owner", email: "owner@example.com" }, { id: "other", email: "other@example.com" }]).run();
    db.insert(oauthAccounts).values([
      { id: "account", userId: "owner", provider: "gmail", providerId: "account", providerEmail: "owner@example.com" },
      { id: "second", userId: "owner", provider: "gmail", providerId: "second", providerEmail: "second@example.com" },
      { id: "foreign", userId: "other", provider: "gmail", providerId: "foreign", providerEmail: "other@example.com" },
    ]).run();
    const content = {
      toRecipients: JSON.stringify([{ name: "Fixture recipient", email: "recipient@example.com" }]),
      ccRecipients: "[]", bccRecipients: "[]", subject: "Synthetic writing",
      bodyText: "t".repeat(16 * 1024), bodyHtml: `<p>${"h".repeat(8 * 1024)}</p>`,
      attachments: JSON.stringify([{ id: "attachment", filename: "fixture.txt", mimeType: "text/plain", size: 48 * 1024, contentBase64: Buffer.alloc(48 * 1024, 65).toString("base64") }]),
      providerSyncStatus: "synced", providerDraftId: "provider-draft", providerMessageId: "provider-message", providerThreadId: "provider-thread",
      revision: 7, createdAt: new Date("2026-01-01T00:00:00Z"), updatedAt: new Date("2026-01-02T00:00:00Z"),
    };
    const unresolved = ["draft", "queued", "sending", "rejected", "ambiguous"];
    db.transaction(() => {
      for (let i = 0; i < 200; i++) db.insert(messageDrafts).values({ ...content, id: `sent-${String(i).padStart(3, "0")}`, accountId: "account", deliveryStatus: "sent" }).run();
      for (const status of unresolved) db.insert(messageDrafts).values({ ...content, id: status, accountId: "account", deliveryStatus: status }).run();
      for (const accountId of ["second", "foreign"]) db.insert(messageDrafts).values({ ...content, id: `${accountId}-draft`, accountId }).run();
    });
    const app = createApp({ dbFactory: () => {
      const connection = createDatabaseClient(path);
      const prepare = connection.sqlite.prepare;
      // Observe actual values crossing SQLite -> Drizzle, rather than estimating
      // savings from a separately implemented serializer or timing disk I/O.
      Object.defineProperty(connection.sqlite, "prepare", { value(...args: unknown[]) {
        const statement = Reflect.apply(prepare, connection.sqlite, args);
        if (/^select .* from "message_drafts"/i.test(String(args[0]))) {
          const values = statement.values;
          statement.values = (...params: unknown[]) => {
            const rows = Reflect.apply(values, statement, params) as unknown[][];
            if (observeSelections) {
              selectedRows += rows.length;
              selectedBytes += Buffer.byteLength(JSON.stringify(rows));
              selectCount++;
            }
            return rows;
          };
        }
        return statement;
      } });
      return connection;
    } });
    const session = await createSession(db, "owner");
    const headers = { cookie: `orca_session=${session.token}` };
    async function readList(suffix = "") {
      selectedRows = selectedBytes = selectCount = 0;
      const start = performance.now();
      const response = await app.request(`/v1/drafts?accountId=account${suffix}`, { headers });
      const text = await response.text();
      const elapsedMs = performance.now() - start;
      assert.equal(response.status, 200);
      return { drafts: JSON.parse(text), metrics: { responseBytes: Buffer.byteLength(text), selectedRows, selectedBytes, selectCount, elapsedMs: Number(elapsedMs.toFixed(2)) } };
    }
    const legacy = await readList();
    const projected = await readList("&omitSentContent=true");
    console.log("draft-list synthetic fixture: 200 sent + 5 unresolved; 16 KiB text + 8 KiB HTML + 48 KiB attachment per record", JSON.stringify({ legacy: legacy.metrics, projected: projected.metrics }));
    if (process.env.ORCA_BENCHMARK_DRAFT_LIST === "1") {
      observeSelections = false;
      const samples: Record<string, number[]> = { legacy: [], projected: [] };
      // Warm both paths, then alternate requests without row-size instrumentation.
      await readList(); await readList("&omitSentContent=true");
      for (let i = 0; i < 7; i++) {
        samples.legacy!.push((await readList()).metrics.elapsedMs);
        samples.projected!.push((await readList("&omitSentContent=true")).metrics.elapsedMs);
      }
      console.log("draft-list warmed request milliseconds (no row-size instrumentation)", JSON.stringify(samples));
      observeSelections = true;
    }
    assert.equal(legacy.drafts.length, 205);
    assert.equal(legacy.metrics.selectedRows, 205, "instrumentation observes the actual list query");
    assert.equal(projected.metrics.selectCount, 1, "projection must not add per-draft queries");
    assert.deepEqual(projected.drafts.map((draft: { id: string }) => draft.id), legacy.drafts.map((draft: { id: string }) => draft.id), "sent IDs remain available for local delivery reconciliation, with stable ordering");
    const legacyByID = new Map(legacy.drafts.map((draft: { id: string }) => [draft.id, draft]));
    for (const draft of projected.drafts) {
      const original = legacyByID.get(draft.id) as typeof draft;
      if (draft.deliveryStatus === "sent") {
        assert.equal(draft.body.text.length, 0, "opt-in list must omit sent text");
        assert.equal(draft.body.html, null, "opt-in list must omit sent HTML");
        assert.deepEqual(draft.attachments, [], "opt-in list must omit sent attachments");
        assert.deepEqual({ ...draft, body: original.body, attachments: original.attachments }, original, "sent identity, revision, recipients and delivery metadata must remain complete");
      } else {
        assert.deepEqual(draft, original, `${draft.deliveryStatus} content must remain complete`);
      }
    }
    assert.ok(projected.metrics.responseBytes < legacy.metrics.responseBytes / 20, "sent-heavy response payload should shrink by more than 95%");
    assert.ok(projected.metrics.selectedBytes < legacy.metrics.selectedBytes / 20, "projection must happen in SQLite, before materializing the discarded content");
    assert.equal(projected.metrics.selectedRows, 205, "this optimization does not paginate or drop reconciliation records");
    assert.deepEqual((await readList("&omitSentContent=false")).drafts, legacy.drafts, "explicit false preserves the original list contract");
    for (const suffix of ["", "&omitSentContent=true"]) {
      const detail = await app.request(`/v1/drafts/sent-000?accountId=account${suffix}`, { headers });
      assert.equal(detail.status, 200);
      assert.deepEqual(await detail.json(), legacyByID.get("sent-000"), "detail reads always return complete content");
    }
    const stored = db.select().from(messageDrafts).where(eq(messageDrafts.id, "sent-000")).get()!;
    assert.equal(stored.bodyText, content.bodyText);
    assert.equal(stored.bodyHtml, content.bodyHtml);
    assert.equal(stored.attachments, content.attachments, "list reads never rewrite stored content");
    for (const account of ["foreign", "missing", ""]) {
      assert.equal((await app.request(`/v1/drafts?accountId=${account}&omitSentContent=true`, { headers })).status, 404);
    }
    const second = await app.request("/v1/drafts?accountId=second&omitSentContent=true", { headers });
    assert.deepEqual((await second.json()).map((draft: { id: string }) => draft.id), ["second-draft"]);
    assert.equal((await app.request("/v1/drafts?accountId=account&omitSentContent=true")).status, 401);
  } finally {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
    if (previousSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSecret;
    if (previousEncryption === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = previousEncryption;
  }
});
