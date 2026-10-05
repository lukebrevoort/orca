/** Synthetic-only before/after check. See docs/verification/thread-validation.md. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { threadDetailSchema, type ThreadDetail } from "@orca/shared";
import { createSession } from "../src/auth/session-store.ts";
import { createDatabaseClient } from "../src/db/client.ts";
import * as schema from "../src/db/schema.ts";
import { createApp } from "../src/index.ts";

const baselinePath = Bun.env.THREAD_BASELINE_MODULE;
if (!baselinePath) throw new Error("Set THREAD_BASELINE_MODULE to the published base's index.ts copy");
const baseline = await import(pathToFileURL(resolve(baselinePath)).href) as { createApp: typeof createApp };
const directory = mkdtempSync(join(tmpdir(), "orca-thread-validation-benchmark-"));
const dbPath = join(directory, "fixture.sqlite");
const { db, sqlite } = createDatabaseClient(dbPath);
const previousSecret = process.env.SESSION_SECRET;
const previousEncryptionKey = process.env.TOKEN_ENCRYPTION_KEY;
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.SESSION_SECRET = "synthetic-thread-validation-benchmark-secret";
const parse = threadDetailSchema.parse;
let parseCalls = 0;
let messagesValidated = 0;
let firstInput: unknown;
threadDetailSchema.parse = (value, options) => {
  parseCalls += 1;
  messagesValidated += (value as ThreadDetail).messages.length;
  firstInput ??= value;
  return parse(value, options);
};
try {
  migrate(db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });
  db.insert(schema.users).values([{ id: "owner", email: "owner@example.com" }, { id: "other", email: "other@example.com" }]).run();
  db.insert(schema.oauthAccounts).values([
    { id: "account", userId: "owner", provider: "gmail", providerId: "account", providerEmail: "owner@example.com" },
    { id: "foreign", userId: "other", provider: "gmail", providerId: "foreign", providerEmail: "other@example.com" },
  ]).run();
  const session = await createSession(db, "owner");
  const headers = { cookie: `orca_session=${session.token}` };
  const options = { dbFactory: () => createDatabaseClient(dbPath) };
  const before = baseline.createApp(options);
  const after = createApp(options);
  const results: unknown[] = [];
  async function sample(app: ReturnType<typeof createApp>, url: string, authenticated = true) {
    parseCalls = 0;
    messagesValidated = 0;
    firstInput = undefined;
    const response = await app.request(url, authenticated ? { headers } : {});
    return { status: response.status, headers: [...response.headers], body: await response.text(), parseCalls, messagesValidated, input: firstInput };
  }
  async function compare(name: string, url: string, expectedStatus: number, authenticated = true) {
    const a = await sample(before, url, authenticated);
    const b = await sample(after, url, authenticated);
    assert.equal(a.status, expectedStatus, `${name}: baseline status`);
    assert.equal(b.status, a.status, name);
    assert.deepEqual(b.headers, a.headers, name);
    assert.equal(b.body, a.body, `${name}: exact serialized bytes`);
    assert.equal(a.parseCalls, expectedStatus === 200 ? 2 : expectedStatus === 500 ? 1 : 0, `${name}: baseline parses`);
    assert.equal(b.parseCalls, expectedStatus === 200 || expectedStatus === 500 ? 1 : 0, `${name}: optimized parses`);
    results.push({ name, status: b.status, responseBytes: Buffer.byteLength(b.body), parseCalls: [a.parseCalls, b.parseCalls], messagesValidated: [a.messagesValidated, b.messagesValidated] });
    return b.input;
  }
  for (const count of [0, 4, 50, 250]) {
    const id = `thread-${count}`;
    db.insert(schema.threads).values({ id, accountId: "account", providerThreadId: id, messageCount: count }).run();
    if (count > 0) db.insert(schema.emails).values(Array.from({ length: count }, (_, index) => ({
      id: `${id}-${index}`, accountId: "account", threadId: id, providerMessageId: `${id}-${index}`,
      fromAddress: "sender@example.com", fromName: "Synthetic sender", toRecipients: JSON.stringify([{ name: null, email: "owner@example.com" }]),
      bodyText: "Synthetic body. ".repeat(128), bodyHtml: `<p onclick="unsafe()">${"Synthetic body. ".repeat(128)}</p><script>unsafe()</script>`,
      references: JSON.stringify(["<synthetic@example.com>"]),
      receivedAt: new Date(1_000 + index), createdAt: new Date(1_000 + index),
      humanClassification: "likely_human" as const, humanSignal: 8, humanClassificationReasons: JSON.stringify(["direct_recipient"]), humanClassifierVersion: " fixture-v1 ",
    }))).run();
    const raw = await compare(`${count} messages`, `/v1/threads/${id}?accountId=account`, 200);
    const detail = parse(raw);
    assert.equal(detail.messages.length, count);
    for (const message of detail.messages) {
      assert.equal(message.bodyHtml, `<p>${"Synthetic body. ".repeat(128)}</p>`);
      assert.equal(message.humanClassification?.effective.classifierVersion, "fixture-v1");
    }
    // Isolate only the removed schema work; this is not an end-to-end latency benchmark.
    const repetitions = 200;
    const samples = { twice: [] as number[], once: [] as number[] };
    for (let round = 0; round < 8; round += 1) {
      for (const mode of round % 2 ? ["once", "twice"] as const : ["twice", "once"] as const) {
        const start = performance.now();
        for (let iteration = 0; iteration < repetitions; iteration += 1) {
          const detail = parse(raw);
          if (mode === "twice") parse(detail);
        }
        if (round > 0) samples[mode].push((performance.now() - start) / repetitions);
      }
    }
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
    results.push({ name: `${count} messages schema-only`, repetitionsPerSample: repetitions, samplesMsPerOperation: samples, medianMs: { twice: median(samples.twice), once: median(samples.once) } });
  }
  await compare("unauthenticated", "/v1/threads/thread-4?accountId=account", 401, false);
  await compare("missing query", "/v1/threads/thread-4", 400);
  await compare("foreign account", "/v1/threads/thread-4?accountId=foreign", 404);
  await compare("missing thread", "/v1/threads/absent?accountId=account", 404);
  const invalidCases = [
    { name: "negative thread count", update: "update threads set message_count = -1 where id = 'thread-4'", restore: "update threads set message_count = 4 where id = 'thread-4'" },
    { name: "invalid references", update: `update emails set "references" = '[42]' where id = 'thread-4-0'`, restore: `update emails set "references" = '[]' where id = 'thread-4-0'` },
    { name: "unknown contact field", update: `update emails set to_recipients = '[{"name":null,"email":"owner@example.com","extra":"reject"}]' where id = 'thread-4-0'`, restore: `update emails set to_recipients = '[]' where id = 'thread-4-0'` },
  ];
  for (const invalid of invalidCases) {
    sqlite.run(invalid.update);
    await compare(invalid.name, "/v1/threads/thread-4?accountId=account", 500);
    sqlite.run(invalid.restore);
  }
  console.log(JSON.stringify({ fixture: "synthetic SQLite only; byte-identical status, headers and body", results }, null, 2));
} finally {
  threadDetailSchema.parse = parse;
  sqlite.close();
  rmSync(directory, { recursive: true, force: true });
  if (previousEncryptionKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
  else process.env.TOKEN_ENCRYPTION_KEY = previousEncryptionKey;
  if (previousSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = previousSecret;
}
