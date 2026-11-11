/** Synthetic API → DB → authorized reads and deterministic SQL-work evidence. No server, provider or live credentials. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createDatabaseClient } from "../src/db/client.ts";
import { createSession } from "../src/auth/session-store.ts";
import { createApp } from "../src/index.ts";
import { readImportantPage } from "../src/importance/store.ts";

const output = process.argv[2];
if (!output) throw Error("Usage: bun apps/api/scripts/importance-fixture.ts <new-output-directory>");
mkdirSync(output, { recursive: false });
const scratch = mkdtempSync(join(tmpdir(), "orca-importance-evidence-"));
const path = join(scratch, "fixture.sqlite"), client = createDatabaseClient(path), { db, sqlite } = client;
process.env.SESSION_SECRET = "synthetic-bre454-session-secret-long-enough";
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 12).toString("base64");
const commit = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
const dirty = spawnSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).stdout.trim();
try {
  migrate(db, { migrationsFolder: resolve(import.meta.dir, "../drizzle") });
  sqlite.exec("INSERT INTO users(id,email) VALUES('demo-user','demo@example.com'); INSERT INTO oauth_accounts(id,user_id,provider,provider_id,provider_email) VALUES('demo-account','demo-user','gmail','demo','demo@example.com')");
  sqlite.exec("INSERT INTO threads(id,account_id,provider_thread_id,subject) VALUES('receipt','demo-account','receipt','Your receipt'); INSERT INTO emails(id,account_id,thread_id,provider_message_id,from_address,subject,snippet,body_text,received_at,human_signal,human_classification) VALUES('receipt-mail','demo-account','receipt','receipt-mail','robot@example.com','Your receipt','Receipt from a useful automated sender','synthetic receipt body',1000,0,'automated_or_bulk')");
  const session = await createSession(db, "demo-user");
  let providerCalls = 0;
  const app = createApp({ dbFactory: () => createDatabaseClient(path), gmailClient: new Proxy({}, { get() { return () => { providerCalls++; throw Error("Provider access forbidden"); }; } }) as never });
  async function request(url: string, body?: unknown) {
    const response = await app.request(url, { method: body ? "POST" : "GET", headers: { "x-orca-importance-version": "1", cookie: `orca_session=${session.token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json();
    if (response.status !== 200) throw Error(`Unexpected ${response.status}: ${JSON.stringify(value)}`);
    return value as any;
  }
  const beforeMail = sqlite.query("SELECT * FROM emails").all(), beforePlacement = sqlite.query("SELECT * FROM organization_effective_destinations").all();
  const before = await request("/v1/importance/conversations/receipt?accountId=demo-account");
  const mutation = await request("/v1/importance/choices", { accountId: "demo-account", target: { kind: "conversation", threadId: "receipt" }, choice: "important", expectedRevision: 0, operationId: randomUUID() });
  const independentDB = sqlite.query("SELECT account_id,kind,target,choice,revision FROM importance_choices").all();
  const reopened = createDatabaseClient(path);
  const persistedAfterReopen = reopened.sqlite.query("SELECT choice,revision FROM importance_choices").all(); reopened.sqlite.close();
  const mailbox = await request("/v1/inbox?accountId=demo-account&view=all");
  const important = await request("/v1/important?accountId=demo-account");
  const assertions = {
    initiallyUnreviewed: before.importance.effective === "unreviewed",
    dbImportant: (independentDB[0] as { choice: string }).choice === "important",
    persistedAfterReopen: (persistedAfterReopen[0] as { revision: number }).revision === 1,
    mailboxImportant: mailbox.messages[0].importance.effective === "important",
    importantMembership: important.items[0].threadId === "receipt",
    unchangedMail: JSON.stringify(beforeMail) === JSON.stringify(sqlite.query("SELECT * FROM emails").all()),
    unchangedPlacement: JSON.stringify(beforePlacement) === JSON.stringify(sqlite.query("SELECT * FROM organization_effective_destinations").all()),
    zeroProviderCalls: providerCalls === 0,
  };
  if (Object.values(assertions).some(x => !x)) throw Error("Synthetic demo assertion failed");
  writeFileSync(join(output, "demo.json"), JSON.stringify({ commit, dirty: Boolean(dirty), scope: "synthetic API and database only; no product UI", before, mutation, independentDB, persistedAfterReopen, mailbox, important, assertions, providerCalls }, null, 2) + "\n");

  // Same-account synthetic workloads. Five messages/conversation; two distinct inbound senders, duplicate messages do not multiply preference votes.
  const workloads = [];
  for (const count of [1_000, 5_000]) {
    const account = `work-${count}`;
    sqlite.query("INSERT INTO oauth_accounts(id,user_id,provider,provider_id,provider_email) VALUES(?,'demo-user','gmail',?,'demo@example.com')").run(account, account);
    const insertThread = sqlite.query("INSERT INTO threads(id,account_id,provider_thread_id,subject) VALUES(?,?,?,'Synthetic conversation')");
    const insertEmail = sqlite.query("INSERT INTO emails(id,account_id,thread_id,provider_message_id,from_address,snippet,received_at,is_read,body_text) VALUES(?,?,?,?,?,'Synthetic preview',?,1,'body never selected')");
    sqlite.transaction(() => {
      for (let i = 0; i < count; i++) {
        const thread = `${account}-t${String(i).padStart(6, "0")}`;
        insertThread.run(thread, account, thread);
        for (let m = 0; m < 5; m++) {
          const id = `${thread}-m${m}`;
          insertEmail.run(id, account, thread, id, m === 4 ? "second@example.com" : "robot@example.com", Math.floor(i / 10) * 1000);
        }
      }
      sqlite.query("INSERT INTO importance_choices VALUES(?,'sender','robot@example.com','important',1,1000)").run(account);
    }).immediate();
    const statements: { sql: string; bindings: unknown[]; returned: number }[] = [];
    const original = sqlite.query.bind(sqlite);
    // Observe actual calls made by the real reader, not a parallel benchmark implementation.
    sqlite.query = ((sql: string) => {
      const stmt = original(sql);
      return new Proxy(stmt, { get(target, prop) {
        if (prop === "get" || prop === "all") return (...bindings: any[]) => {
          const value = (target[prop] as (...args: any[]) => any).apply(target, bindings);
          statements.push({ sql, bindings, returned: Array.isArray(value) ? value.length : value ? 1 : 0 });
          return value;
        };
        const value = Reflect.get(target, prop); return typeof value === "function" ? value.bind(target) : value;
      } });
    }) as typeof sqlite.query;
    try {
      const first = readImportantPage(sqlite, { userId: "demo-user", accountId: account }, 50);
      const firstStatements = statements.splice(0);
      const second = readImportantPage(sqlite, { userId: "demo-user", accountId: account }, 50, first.nextCursor!);
      if (first.items.length !== 50 || second.items.length !== 50 || firstStatements.length !== 5 || statements.length !== 6) throw Error("Important page query/count regression");
      if ([...firstStatements, ...statements].some(statement => /body_(text|html)/i.test(statement.sql))) throw Error("Important lists selected a body column");
      workloads.push({ conversations: count, messages: count * 5, distinctParticipantRows: count * 2,
        first: { items: first.items.length, statements: firstStatements }, second: { items: second.items.length, statements: statements.splice(0) }, account });
    } finally { sqlite.query = original as typeof sqlite.query; }
  }
  sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  // Independent SQLite VM execution of captured real read statements on the same frozen fixture.
  // Count actual progress callbacks at interval one as a deterministic VM-work proxy; no timing/speedup claim.
  const measurement = spawnSync("python3", [resolve(import.meta.dir, "importance-query-work.py"), path], { input: JSON.stringify(workloads), encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (measurement.status !== 0) throw Error(measurement.stderr);
  writeFileSync(join(output, "query-work.json"), JSON.stringify({ commit, dirty: Boolean(dirty), bun: Bun.version, source: "actual Bun reader statements replayed on independent Python SQLite VM over identical synthetic database", measurements: JSON.parse(measurement.stdout) }, null, 2) + "\n");
  console.log(JSON.stringify({ commit, dirty: Boolean(dirty), assertions: Object.keys(assertions).length, providerCalls, workloads: workloads.map(w => ({ conversations: w.conversations, messages: w.messages, firstQueries: w.first.statements.length, nextQueries: w.second.statements.length })), cleanup: "owned temporary SQLite directory removed in finally" }));
} finally { sqlite.close(); rmSync(scratch, { recursive: true, force: true }); }
