// Separate OS processes: two readers (one each second, offset 500ms) and one writer.
import assert from "node:assert/strict";
import { renameSync } from "node:fs";
import { pathToFileURL } from "node:url";
const arg = (name: string) => Bun.argv.find((v) => v.startsWith(`--${name}=`))!.slice(name.length + 3);
const source = (file: string) => pathToFileURL(`${arg("root")}/apps/api/src/${file}`).href;
const { createDatabaseClient } = await import(source("db/client.ts"));
const { createApp } = await import(source("index.ts"));
const { persistGmailMessages } = await import(source("providers/gmail/sync.ts"));
const seconds = Number(arg("seconds")), start = Number(arg("start")), role = arg("role");
assert([2, 60].includes(seconds));
assert(["reader-0", "reader-1", "writer"].includes(role));
const settings: unknown[] = [];
function open() {
  const c = createDatabaseClient(arg("db"));
  const s = c.sqlite.query("PRAGMA synchronous").get().synchronous;
  const journal = c.sqlite.query("PRAGMA journal_mode").get().journal_mode;
  assert(arg("mode") === "head" ? s === 2 : [1, 2].includes(s));
  assert.equal(journal, "wal");
  const item = { synchronous: s, journal };
  if (!settings.length) settings.push(item); else assert.deepEqual(item, settings[0]);
  return c;
}
const client = open();
const app = createApp({ dbFactory: open });
const { getSessionFromToken } = await import(source("auth/session-store.ts"));
assert(await getSessionFromToken(client.db, arg("session")), "Synthetic session must verify before mixed start");
const report = { role, planned: seconds, offered: 0, completed: 0, observations: [] as { ms: number; lagMs: number; rss: number }[], settings, passed: false, error: null as string | null };
async function save() {
  await Bun.write(arg("output") + ".next", JSON.stringify(report));
  renameSync(arg("output") + ".next", arg("output"));
}
await save();
try {
  for (let tick = 0; tick < seconds; tick++) {
    const target = start + tick * 1000 + (role === "reader-1" ? 500 : 0);
    await Bun.sleep(Math.max(0, target - Date.now()));
    report.offered++;
    const lagMs = Date.now() - target;
    assert(lagMs < 500, `Offered work backlog: ${lagMs}ms`);
    const begin = performance.now();
    if (role === "writer") {
      const result = await persistGmailMessages(client.db, {
        accountId: "a", accountEmail: "a@example.test", labelList: [{ id: "INBOX", name: "Inbox" }],
        now: new Date("2026-09-02T00:00:00Z"), propagationTrigger: "sync", propagationOptions: { enabled: false },
        gmailMessages: Array.from({ length: 25 }, (_, i) => ({
          id: `mixed-${tick}-${i}`, threadId: `mixed-thread-${tick}-${i}`, internalDate: String(1788307200000 + i), labelIds: ["INBOX"], snippet: "sync preview",
          payload: { mimeType: "text/plain", headers: [{ name: "From", value: "sender@example.test" }, { name: "To", value: "a@example.test" }, { name: "Subject", value: `Mixed ${i}` }], body: { data: Buffer.from("Synthetic body. ".repeat(100)).toString("base64") } },
        })),
      });
      assert.equal(result.changedEmailCount, 25);
    } else {
      const response = await app.request("/v1/inbox?view=all&classification=all&limit=50&query=common", { headers: { cookie: `orca_session=${arg("session")}` } });
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.counts.attention.all, Number(arg("size")));
      assert.deepEqual(data.messages.map((m: { id: string }) => m.id), Array.from({ length: 50 }, (_, i) => `message-${i * 4}`));
      assert(data.messages.every((m: { bodyText?: string }) => m.bodyText === undefined));
    }
    const ms = performance.now() - begin, rss = process.memoryUsage().rss;
    assert(rss <= 512 * 1024 ** 2, "Process RSS gate");
    assert(Date.now() <= start + seconds * 1000, "Mixed phase exceeded deadline");
    report.observations.push({ ms, lagMs, rss }); report.completed++;
    await save();
  }
  report.passed = true;
} catch (error) { report.error = String(error); process.exitCode = 1; }
finally { client.sqlite.close(); await save(); }
