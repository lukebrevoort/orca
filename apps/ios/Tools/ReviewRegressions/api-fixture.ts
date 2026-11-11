/** Own ephemeral loopback API and SQLite; no live credentials/provider calls. */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { createDatabaseClient } from '../../../api/src/db/client.ts';
import { createMobileSession } from '../../../api/src/auth/mobile/store.ts';
import { createApp } from '../../../api/src/index.ts';
const output = process.argv[2];
if (!output) throw Error('Need an owned connection output path');
process.env.SESSION_SECRET = 'synthetic-native-review-regressions-secret';
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 23).toString('base64');
const scratch = mkdtempSync(join(tmpdir(), 'bre457-native-review-api-'));
const path = join(scratch, 'fixture.sqlite'), { db, sqlite } = createDatabaseClient(path);
migrate(db, { migrationsFolder: resolve(import.meta.dir, '../../../api/drizzle') });
sqlite.exec(`INSERT INTO users(id,email) VALUES('owner','owner@example.com');
INSERT INTO oauth_accounts(id,user_id,provider,provider_id,provider_email) VALUES('account','owner','gmail','synthetic','owner@example.com');
INSERT INTO threads(id,account_id,provider_thread_id,subject) VALUES('thread','account','thread','Subject fixture');
INSERT INTO emails(id,account_id,thread_id,provider_message_id,from_address,subject,snippet,body_text,received_at) VALUES('mail','account','thread','mail','person@example.com','Subject fixture','Synthetic only','Synthetic only',1000);`);
const credential = createMobileSession(db, 'owner');
let providerCalls = 0, dropNext = false;
const ledger: unknown[] = [], requests: unknown[] = [];
const app = createApp({ dbFactory: () => createDatabaseClient(path), gmailClient: new Proxy({}, { get() { return () => { providerCalls++; throw Error('Provider forbidden'); }; } }) as never });
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const url = new URL(request.url);
  if (request.headers.get('authorization') !== `Bearer ${credential.accessToken}`) return new Response(null, { status: 401 });
  if (url.pathname === '/__bre457/drop-next-commit') { dropNext = true; return Response.json({ ok: true }); }
  if (url.pathname === '/__bre457/state') return Response.json({ count: (sqlite.query('SELECT count(*) n FROM organization_views').get() as { n: number }).n, views: sqlite.query('SELECT id,name,definition,revision FROM organization_views ORDER BY id').all(), providerCalls, ledger });
  const command = request.method === 'POST' && url.pathname === '/v1/organization/views/commit' ? await request.clone().json() : null;
  const response = await app.fetch(request);
  requests.push({ method: request.method, path: url.pathname, status: response.status, ...(response.status >= 400 ? { error: await response.clone().text() } : {}) });
  if (request.method === 'POST' && url.pathname === '/v1/organization/views/commit') {
    const payload = await response.clone().json();
    ledger.push({ path: url.pathname, actualStatus: response.status, deliveredStatus: dropNext && response.ok ? 503 : response.status, response: payload, command });
    if (dropNext && response.ok) { dropNext = false; return Response.json({ error: { code: 'synthetic_response_lost', message: 'Commit succeeded; acknowledgement deliberately replaced by HTTP503' } }, { status: 503 }); }
  }
  return response;
} });
writeFileSync(output, JSON.stringify({ baseURL: `http://127.0.0.1:${server.port}/`, token: credential.accessToken }), { mode: 0o600 });
function cleanup() { writeFileSync(output + '.evidence.json', JSON.stringify({ ledger, requests, providerCalls, views: sqlite.query('SELECT id,name,definition,revision FROM organization_views ORDER BY id').all() }, null, 2)); server.stop(true); sqlite.close(); rmSync(scratch, { recursive: true, force: true }); process.exit(0); }
process.on('SIGTERM', cleanup); process.on('SIGINT', cleanup);
