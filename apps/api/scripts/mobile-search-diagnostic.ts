/**
 * Failure-only diagnostic for mobile-fixture.ts. Run with that disposable
 * fixture's connection.json; never point this at a user database. This does not
 * change the real HTTP executor's deadline or turn a failed preflight green.
 */
import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const userId = "ios-fixture-user";
const accountId = "ios-fixture-account";
const diagnosticDeadlineMs = 15_000;
const echoDeadlineMs = 5_000;
const expectedMessageIds = ["ios-fixture-earlier-message", ...Array.from({ length: 5 }, (_, i) => `ios-fixture-message-${i + 1}`)].sort();
const startedAt = performance.now();
const elapsedMs = () => Math.round(performance.now() - startedAt);
function report(fields: Record<string, string | number | boolean | null>) {
  console.log(JSON.stringify({ syntheticSearchDiagnostic: true, ...fields }));
}
function requireCondition(condition: unknown): asserts condition {
  if (!condition) throw new Error("fixture_validation_failed");
}
function within(root: string, path: string) {
  const remainder = relative(root, path);
  return remainder !== "" && remainder !== ".." && !remainder.startsWith("../") && !isAbsolute(remainder);
}

function fixtureInput() {
  requireCondition(process.argv.length === 3);
  const connectionPath = resolve(process.argv[2]!);
  requireCondition(basename(connectionPath) === "connection.json" && !lstatSync(connectionPath).isSymbolicLink());
  requireCondition(statSync(connectionPath).isFile() && statSync(connectionPath).size <= 16 * 1024);
  const directory = realpathSync(dirname(connectionPath));
  requireCondition(/^orca-ios-fixture-[A-Za-z0-9]+$/.test(basename(directory)));
  const roots = [tmpdir(), process.env.RUNNER_TEMP].filter((value): value is string => Boolean(value)).map(root => realpathSync(root));
  requireCondition(roots.some(root => within(root, directory)));
  const connection: unknown = JSON.parse(readFileSync(connectionPath, "utf8"));
  requireCondition(connection !== null && typeof connection === "object" && !Array.isArray(connection));
  const metadata = connection as Record<string, unknown>;
  requireCondition(metadata.userId === userId && metadata.accountId === accountId && typeof metadata.readOnly === "boolean");
  requireCondition(typeof metadata.directory === "string" && realpathSync(metadata.directory) === directory);
  requireCondition(typeof metadata.apiURL === "string");
  const origin = new URL(metadata.apiURL);
  requireCondition(origin.protocol === "http:" && origin.hostname === "127.0.0.1" && origin.port
    && origin.href === `${origin.origin}/` && !origin.username && !origin.password);
  const databasePath = join(directory, "mail.sqlite");
  requireCondition(!lstatSync(databasePath).isSymbolicLink() && statSync(databasePath).isFile()
    && realpathSync(databasePath) === databasePath);
  return { databasePath };
}

function inspectSyntheticDatabase(databasePath: string) {
  const sqlite = new Database(databasePath, { readonly: true, create: false, strict: true });
  try {
    sqlite.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=100");
    return sqlite.transaction(() => {
      const users = sqlite.query("select id from users order by id limit 2").all() as Array<{ id: string }>;
      const accounts = sqlite.query("select id,user_id,provider,provider_id from oauth_accounts order by id limit 2").all() as Array<{ id: string; user_id: string; provider: string; provider_id: string }>;
      const messages = sqlite.query("select id,account_id from emails order by id limit 7").all() as Array<{ id: string; account_id: string }>;
      requireCondition(users.length === 1 && users[0]!.id === userId);
      requireCondition(accounts.length === 1 && accounts[0]!.id === accountId && accounts[0]!.user_id === userId
        && accounts[0]!.provider === "gmail" && accounts[0]!.provider_id === "ios-fixture-provider");
      requireCondition(messages.length === expectedMessageIds.length
        && messages.every((row, i) => row.id === expectedMessageIds[i] && row.account_id === accountId));
      const credentials = sqlite.query("select count(*) count from oauth_accounts where access_token_encrypted is not null or refresh_token_encrypted is not null").get() as { count: number };
      requireCondition(credentials.count === 0);
      const documents = sqlite.query("select metadata_octets,body_octets from mail_search_documents limit 7").all() as Array<{ metadata_octets: number; body_octets: number }>;
      requireCondition(documents.length === messages.length);
      const sizes = { documentRows: documents.length,
        metadataBytes: documents.reduce((total, row) => total + row.metadata_octets, 0),
        bodyBytes: documents.reduce((total, row) => total + row.body_octets, 0),
        maxBodyBytes: Math.max(0, ...documents.map(row => row.body_octets)) };
      const destination = sqlite.query("select destination_id from organization_destination_legacy where workspace_id=? and behavior='normal'").get(userId) as { destination_id: string } | null;
      report({ stage: "source", elapsedMs: elapsedMs(), messageRows: messages.length, ...sizes,
        estimatedComparisonsUpperBound: (sizes.metadataBytes + sizes.bodyBytes) * 15 });
      return destination?.destination_id;
    })();
  } finally { sqlite.close(); }
}

/** Same Bun binary, flags, minimal env and stdin EOF loop as the actual worker;
 * no project imports, database, dynamic request, or sensitive output. */
async function echoControl() {
  const start = performance.now();
  const program = `
    let bytes=0;
    const reader=Bun.stdin.stream().getReader();
    while(true){const {value,done}=await reader.read();if(done)break;bytes+=value.byteLength;}
    await Bun.write(Bun.stdout,JSON.stringify({echo:true,stdinBytes:bytes}));
  `;
  const child = spawn(process.execPath, ["--no-env-file", "--smol", "--eval", program], {
    stdio: ["pipe", "pipe", "pipe"], env: { TZ: "UTC", LANG: "C.UTF-8" },
  });
  let failure = "";
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const chunks: Buffer[] = [];
  const terminate = (code: string) => {
    if (failure) return;
    failure = code;
    child.kill("SIGKILL");
  };
  const timer = setTimeout(() => terminate("diagnostic_deadline"), echoDeadlineMs);
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.byteLength;
    if (stdoutBytes > 1024) terminate("diagnostic_output_limit");
    else if (!failure) chunks.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => { stderrBytes = Math.min(8192, stderrBytes + chunk.byteLength); });
  const ioError = () => terminate("diagnostic_io_error");
  child.on("error", ioError);
  child.stdin.on("error", ioError);
  child.stdout.on("error", ioError);
  child.stderr.on("error", ioError);
  const exitCode = await new Promise<number | null>(resolveExit => {
    child.once("close", code => resolveExit(code));
    child.stdin.end("echo");
  });
  clearTimeout(timer);
  let valid = false;
  try {
    const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    valid = JSON.stringify(result) === '{"echo":true,"stdinBytes":4}';
  } catch { /* Only sanitized scalar status is logged below. */ }
  report({ stage: "echo", elapsedMs: Math.round(performance.now() - start), deadlineMs: echoDeadlineMs,
    ok: !failure && exitCode === 0 && valid, exitCode, stdoutBytes, stderrBytes,
    errorCode: failure || (exitCode === 0 && valid ? null : "diagnostic_invalid_echo") });
}

const publicCodes = new Set(["search_query_too_broad", "search_index_not_ready", "invalid_cursor", "no_accounts",
  "search_busy", "search_aborted", "search_invalid_request", "search_database_unavailable", "search_failed"]);
async function main() {
  const { databasePath } = fixtureInput();
  const destinationId = inspectSyntheticDatabase(databasePath);
  report({ stage: "runtime", elapsedMs: elapsedMs(), platform: process.platform, architecture: process.arch,
    bunVersion: Bun.version, diagnosticDeadlineMs });
  await echoControl();
  const importStarted = performance.now();
  const { createMailSearchExecutorForTests } = await import("../src/mailbox/search-executor.ts");
  report({ stage: "parent_executor_import", elapsedMs: Math.round(performance.now() - importStarted) });
  const probeStarted = performance.now();
  const executor = createMailSearchExecutorForTests({
    deadlineMs: diagnosticDeadlineMs,
    onLifecycle: event => report({ stage: "worker_lifecycle", event: event.event,
      elapsedMs: Math.round(performance.now() - probeStarted), active: event.active }),
  });
  try {
    const result = await executor.read({
      databasePath, authorization: { userId, accountIds: [accountId] }, searchBodyText: true,
      query: { query: "Jordan confirmed", view: "normal", limit: 30, ...(destinationId ? { destinationId } : {}) },
    }, {
      observe: sample => report({ stage: "worker_observation", elapsedMs: Math.round(performance.now() - probeStarted),
        queueWaitMs: Math.round(sample.queueWaitMs), processDurationMs: Math.round(sample.processDurationMs),
        readerDurationMs: sample.readerDurationMs === null ? null : Math.round(sample.readerDurationMs), peakRssBytes: sample.peakRssBytes }),
    });
    report({ stage: "worker_result", elapsedMs: Math.round(performance.now() - probeStarted), ok: true,
      returnedMessages: result.response.messages.length, totalMatches: result.response.counts.attention.all,
      responseBytes: Buffer.byteLength(JSON.stringify(result.response)),
      expectedMessageMatched: result.response.messages.length === 1 && result.response.messages[0]!.id === "ios-fixture-message-2" });
  } catch (error) {
    const code = error !== null && typeof error === "object" && "code" in error ? String(error.code) : "";
    report({ stage: "worker_result", elapsedMs: Math.round(performance.now() - probeStarted), ok: false,
      errorCode: publicCodes.has(code) ? code : "diagnostic_failed" });
    process.exitCode = 1;
  } finally {
    await executor.shutdown();
    report({ stage: "shutdown", elapsedMs: Math.round(performance.now() - probeStarted), complete: true });
  }
}

try { await main(); }
catch {
  // A path, malformed metadata, SQL error, or stack must never reach artifacts.
  report({ stage: "guard", elapsedMs: elapsedMs(), ok: false, errorCode: "diagnostic_guard_failed" });
  process.exitCode = 1;
}
