/** Own ephemeral loopback API and SQLite; no live credentials/provider calls. */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { createDatabaseClient } from '../../../api/src/db/client.ts';
import { createMobileSession } from '../../../api/src/auth/mobile/store.ts';
import { createApp } from '../../../api/src/index.ts';
import { createNavigationProbe } from './navigation-fixture.ts';
import { queryGoldenVectors } from './query-golden.ts';
const output = process.argv[2];
if (!output) throw Error('Need an owned connection output path');
process.env.SESSION_SECRET = 'synthetic-native-review-regressions-secret';
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 23).toString('base64');
const scratch = mkdtempSync(join(tmpdir(), 'bre457-native-review-api-'));
const path = join(scratch, 'fixture.sqlite'), { db, sqlite } = createDatabaseClient(path);
const navigation = createNavigationProbe(sqlite);
migrate(db, { migrationsFolder: resolve(import.meta.dir, '../../../api/drizzle') });
sqlite.exec(`INSERT INTO users(id,email) VALUES('owner','owner@example.com');
INSERT INTO users(id,email) VALUES('owner-b','owner-b@example.com');
INSERT INTO user_preferences(user_id,signature) VALUES('owner','Owner A original'),('owner-b','Owner B original');
INSERT INTO oauth_accounts(id,user_id,provider,provider_id,provider_email) VALUES('account','owner','gmail','synthetic','owner@example.com');
INSERT INTO oauth_accounts(id,user_id,provider,provider_id,provider_email) VALUES('other-account','owner','gmail','synthetic-other','owner-alt@example.com');
INSERT INTO threads(id,account_id,provider_thread_id,subject) VALUES('thread','account','thread','Subject fixture');
INSERT INTO emails(id,account_id,thread_id,provider_message_id,from_address,subject,snippet,body_text,received_at) VALUES('mail','account','thread','mail','person@example.com','Subject fixture','Synthetic only','Synthetic only',1000);`);
sqlite.exec(`CREATE TABLE bre457_preference_write_probe(user_id TEXT NOT NULL, operation TEXT NOT NULL);
CREATE TRIGGER bre457_preference_insert_probe AFTER INSERT ON user_preferences BEGIN INSERT INTO bre457_preference_write_probe VALUES(new.user_id,'insert'); END;
CREATE TRIGGER bre457_preference_update_probe AFTER UPDATE ON user_preferences BEGIN INSERT INTO bre457_preference_write_probe VALUES(new.user_id,'update'); END;
CREATE TRIGGER bre457_preference_delete_probe AFTER DELETE ON user_preferences BEGIN INSERT INTO bre457_preference_write_probe VALUES(old.user_id,'delete'); END;`);
sqlite.exec(`CREATE TABLE bre457_draft_delete_probe(id TEXT NOT NULL, account_id TEXT NOT NULL);
CREATE TRIGGER bre457_draft_delete_probe_trigger AFTER DELETE ON message_drafts BEGIN INSERT INTO bre457_draft_delete_probe VALUES(old.id,old.account_id); END;`);
const credential = createMobileSession(db, 'owner'), otherCredential = createMobileSession(db, 'owner-b');
let providerCalls = 0, dropNext = false, dropAnyNext = false;
const ledger: unknown[] = [], requests: unknown[] = [];
let holdNext = false, heldRequest: Request | null = null, heldCommand: unknown = null;
let savedPrepareFailures = 0;
let nextStatusResponse: { status: number; body: unknown } | null = null;
const app = createApp({ dbFactory: () => navigation.dbFactory(path), gmailClient: new Proxy({}, { get() { return () => { providerCalls++; navigation.recordProviderClientCall(); throw Error('Provider forbidden'); }; } }) as never });
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const url = new URL(request.url);
  const fixtureOwner = request.headers.get('authorization') === `Bearer ${credential.accessToken}` ? 'owner' : request.headers.get('authorization') === `Bearer ${otherCredential.accessToken}` ? 'owner-b' : null;
  if (url.pathname.startsWith('/__bre457/') && fixtureOwner !== 'owner') return new Response(null, { status: 401 });
  if (url.pathname === '/__bre457/navigation/golden' && request.method === 'GET') return Response.json(queryGoldenVectors());
  if (url.pathname === '/__bre457/navigation/seed' && request.method === 'POST') return Response.json(navigation.seed());
  if (url.pathname === '/__bre457/navigation/seal' && request.method === 'POST') return Response.json(navigation.seal());
  if (url.pathname === '/__bre457/navigation/state' && request.method === 'GET') return Response.json(navigation.snapshot());
  if (url.pathname === '/__bre457/add-account') { const body = await request.json() as { id?: string }; const id = body.id ?? 'added-account'; if (!/^[a-z0-9-]{1,80}$/.test(id)) throw Error('Invalid owned fixture account'); sqlite.query("INSERT INTO oauth_accounts(id,user_id,provider,provider_id,provider_email) VALUES(?,'owner','gmail',?,?)").run(id, 'synthetic-' + id, id + '@example.com'); return Response.json({ ok: true }); }
  if (url.pathname === '/__bre457/saved-prepare-failures') { const body = await request.json() as { count: number }; if (!Number.isInteger(body.count) || body.count < 0 || body.count > 20) throw Error('Invalid fixture failure count'); savedPrepareFailures = body.count; return Response.json({ ok: true }); }
  if (url.pathname === '/__bre457/hold-next-commit') { if (heldRequest) throw Error('Own held request must be released first'); holdNext = true; return Response.json({ ok: true }); }
  if (url.pathname === '/__bre457/status-response') { nextStatusResponse = await request.json() as { status: number; body: unknown }; return Response.json({ ok: true }); }
  if (url.pathname === '/__bre457/release-held') {
    if (!heldRequest) throw Error('No owned held request');
    const original = heldRequest; heldRequest = null;
    const response = await app.fetch(original), payload = await response.clone().json();
    ledger.push({ path: '/v1/organization/views/commit', actualStatus: response.status, deliveredStatus: null, response: payload, command: heldCommand, lateOriginal: true });
    heldCommand = null; return Response.json({ status: response.status });
  }
  if (url.pathname === '/__bre457/drop-next-commit-response') { dropAnyNext = true; return Response.json({ ok: true }); }
  if (url.pathname === '/__bre457/drop-next-commit') { dropNext = true; return Response.json({ ok: true }); }
  if (url.pathname === '/__bre457/state') return Response.json({ count: (sqlite.query('SELECT count(*) n FROM organization_views').get() as { n: number }).n, views: sqlite.query('SELECT id,name,definition,revision FROM organization_views ORDER BY id').all(), drafts: sqlite.query('SELECT id,account_id,delivery_status,send_idempotency_key FROM message_drafts ORDER BY id').all(), draftDeletes: sqlite.query('SELECT id,account_id FROM bre457_draft_delete_probe').all(), providerCalls, ledger, requests, heldCommand, preferences: sqlite.query('SELECT * FROM user_preferences ORDER BY user_id').all(), preferenceWrites: sqlite.query('SELECT user_id,operation FROM bre457_preference_write_probe').all() });
  const command = request.method === 'POST' && url.pathname === '/v1/organization/views/commit' ? await request.clone().json() : null;
  if (command && holdNext) { holdNext = false; heldRequest = request.clone(); heldCommand = command; ledger.push({ path: url.pathname, actualStatus: null, deliveredStatus: 503, command, held: true }); return Response.json({ error: { code: 'synthetic_held_original', message: 'Original request deliberately delayed before API dispatch' } }, { status: 503 }); }
  const prepareBody = request.method === 'POST' && url.pathname === '/v1/organization/views/prepare' ? await request.clone().json() as { kind?: string; viewId?: string } : null;
  const response = await navigation.dispatch(request, () => app.fetch(request));
  if (prepareBody?.kind === 'saved_view' && response.ok && savedPrepareFailures > 0) { savedPrepareFailures--; requests.push({ method: request.method, path: url.pathname, status: response.status, deliveredStatus: 503, fixtureOwner, kind: prepareBody.kind, viewId: prepareBody.viewId }); return Response.json({ error: { code: 'synthetic_saved_prepare_unavailable', message: 'Owned API read succeeded; acknowledgement deliberately replaced503' } }, { status: 503 }); }
  requests.push({ method: request.method, path: url.pathname, status: response.status, ...(url.pathname === "/v1/inbox" ? { query: url.searchParams.get("query"), cursor: url.searchParams.get("cursor"), accountId: url.searchParams.get("accountId") } : {}), ...(prepareBody ? { kind: prepareBody.kind, viewId: prepareBody.viewId } : {}), fixtureOwner, expectedOwner: request.headers.get('x-orca-expected-user-id'), ...(response.status >= 400 ? { error: await response.clone().text() } : {}) });
  if (url.pathname === '/v1/organization/views/commit-status' && nextStatusResponse) { const substitute = nextStatusResponse; nextStatusResponse = null; return Response.json(substitute.body, { status: substitute.status }); }
  if (request.method === 'POST' && url.pathname === '/v1/organization/views/commit') {
    const payload = await response.clone().json();
    ledger.push({ path: url.pathname, actualStatus: response.status, deliveredStatus: dropAnyNext || (dropNext && response.ok) ? 503 : response.status, response: payload, command });
    if (dropAnyNext || (dropNext && response.ok)) { dropNext = false; dropAnyNext = false; return Response.json({ error: { code: 'synthetic_response_lost', message: 'Original API acknowledgement deliberately replaced by HTTP503' } }, { status: 503 }); }
  }
  return response;
} });
writeFileSync(output, JSON.stringify({ baseURL: `http://127.0.0.1:${server.port}/`, token: credential.accessToken, otherToken: otherCredential.accessToken }), { mode: 0o600 });
function cleanup() { navigation.restore(); writeFileSync(output + '.evidence.json', JSON.stringify({ ledger, requests, providerCalls, navigation: navigation.snapshot(), preferences: sqlite.query('SELECT * FROM user_preferences ORDER BY user_id').all(), preferenceWrites: sqlite.query('SELECT user_id,operation FROM bre457_preference_write_probe').all(), views: sqlite.query('SELECT id,name,definition,revision FROM organization_views ORDER BY id').all(), drafts: sqlite.query('SELECT id,account_id,delivery_status,send_idempotency_key FROM message_drafts ORDER BY id').all(), draftDeletes: sqlite.query('SELECT id,account_id FROM bre457_draft_delete_probe').all() }, null, 2)); server.stop(true); sqlite.close(); rmSync(scratch, { recursive: true, force: true }); process.exit(0); }
process.on('SIGTERM', cleanup); process.on('SIGINT', cleanup);
