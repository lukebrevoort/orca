/** Native-owned synthetic data/probes only; no production route/evaluator changes. */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Database } from 'bun:sqlite';
import { createDatabaseClient } from '../../../api/src/db/client.ts';
import { createDestinations } from '../../../api/src/destinations/service.ts';

type RequestProbe = { path: string; method: string; phase: string; connections: number };
export function createNavigationProbe(sqlite: Database, db: ReturnType<typeof createDatabaseClient>["db"]) {
  const context = new AsyncLocalStorage<RequestProbe>();
  const connections: Array<{ path: string; method: string; phase: string; ordinal: number; totalChanges: number }> = [];
  const requests: Array<{ path: string; method: string; phase: string; status: number }> = [];
  const senderTransport: Array<{ rawPercentEncodedQuery: string; sender: string; accountId: string; view: string; status: number; rowIds: string[]; otherRowCount: number; decodeFailed: boolean }> = [];
  let seeded = false, sealed = false, seedDML = 0, providerClientCalls = 0;
  const originalFetch = globalThis.fetch;
  let outboundNetworkCalls = 0;
  const changes = () => (sqlite.query('SELECT total_changes() n').get() as { n: number }).n;
  function dbFactory(path: string) {
    const connection = createDatabaseClient(path), request = context.getStore();
    const ordinal = request ? ++request.connections : 0;
    const close = connection.sqlite.close.bind(connection.sqlite);
    connection.sqlite.close = (throwOnError?: boolean) => {
      const totalChanges = (connection.sqlite.query('SELECT total_changes() n').get() as { n: number }).n;
      connections.push({ path: request?.path ?? 'fixture-unscoped', method: request?.method ?? '', phase: request?.phase ?? 'prior-journeys', ordinal, totalChanges });
      close(throwOnError);
    };
    return connection;
  }
  async function dispatch(request: Request, invoke: () => Response | Promise<Response>) {
    const url = new URL(request.url);
    const probe = { path: url.pathname, method: request.method, phase: sealed ? 'navigation-reads' : seeded ? 'navigation-bootstrap' : 'prior-journeys', connections: 0 };
    return context.run(probe, async () => {
      const response = await invoke();
      requests.push({ path: probe.path, method: probe.method, phase: probe.phase, status: response.status });
      // Fixed synthetic sender controls ONLY. Never inspect arbitrary request
      // headers/body, mail content, or query strings from another journey.
      const sender = url.searchParams.get('sender');
      const allowedSenders = ['needle+nav@example.com', 'needle nav@example.com', 'neighbor@example.com', 'needle%2Bnav@example.com'];
      const keys = [...url.searchParams.keys()].sort();
      if (sealed && request.method === 'GET' && url.pathname === '/v1/inbox'
        && url.hostname === '127.0.0.1' && keys.join(',') === 'accountId,sender,view'
        && url.searchParams.get('accountId') === 'account' && url.searchParams.get('view') === 'all'
        && sender !== null && allowedSenders.includes(sender) && senderTransport.length < 8) {
        let rowIds: string[] = [], otherRowCount = 0, decodeFailed = false;
        try {
          const payload = await response.clone().json() as { messages?: Array<{ id?: unknown }> };
          if (!Array.isArray(payload.messages)) decodeFailed = true;
          else for (const row of payload.messages) {
            if (typeof row.id === 'string' && /^nav-mail-(archived|quiet|inbox|focus)$/.test(row.id)) rowIds.push(row.id);
            else otherRowCount++;
          }
        } catch { decodeFailed = true; }
        senderTransport.push({ rawPercentEncodedQuery: url.search.slice(1), sender, accountId: 'account', view: 'all', status: response.status, rowIds, otherRowCount, decodeFailed });
      }
      return response;
    });
  }
  function seed() {
    if (seeded) throw Error('Native navigation seed is single-use');
    const before = changes();
    sqlite.transaction(() => {
      const thread = sqlite.query("INSERT INTO threads(id,account_id,provider_thread_id,subject,latest_received_at,message_count) VALUES(?,'account',?,?,?,1)");
      const mail = sqlite.query("INSERT INTO emails(id,account_id,thread_id,provider_message_id,from_name,from_address,subject,snippet,body_text,received_at,human_classification) VALUES(?,'account',?,?,?,?,'Navigation fixture','Native owned only','Native owned only',?,'likely_human')");
      for (const [suffix, address, name, received] of [
        ['archived', 'needle+nav@example.com', 'Équipe', 3000],
        ['quiet', 'needle+nav@example.com', 'Équipe', 4000],
        ['inbox', 'neighbor@example.com', 'Neighbor', 5000],
        ['focus', 'nav-focus@example.com', 'Focus control', 6000],
      ] as const) {
        const id = 'nav-thread-' + suffix;
        thread.run(id, id, 'Navigation fixture', received);
        mail.run('nav-mail-' + suffix, id, 'nav-provider-' + suffix, name, address, received);
      }
      sqlite.exec("INSERT INTO thread_attention_overrides(account_id,thread_id,behavior) VALUES('account','nav-thread-quiet','quiet')");
      sqlite.exec("INSERT INTO sender_attention_rules(id,account_id,scope,value,behavior,source) VALUES('nav-focus-rule','account','address','nav-focus@example.com','focus','user_choice')");
      // Reuse an existing INBOX label if prior journeys introduced one.
      const label = sqlite.query("SELECT id FROM labels WHERE account_id='account' AND provider_label_id='INBOX'").get() as { id: string } | null;
      if (!label) sqlite.exec("INSERT INTO labels(id,account_id,provider_label_id,name,type) VALUES('nav-label-inbox','account','INBOX','INBOX','system')");
      const labelId = label?.id ?? 'nav-label-inbox';
      for (const suffix of ['inbox', 'focus']) sqlite.query('INSERT INTO email_labels(id,email_id,label_id) VALUES(?,?,?)').run('nav-label-' + suffix, 'nav-mail-' + suffix, labelId);
      sqlite.exec("INSERT INTO collections(id,account_id,name,color,position,revision) VALUES('nav-collection','account','Équipe / retained collection','#70867d',0,4)");
      for (const suffix of ['archived', 'quiet']) sqlite.query("INSERT INTO collection_threads(id,collection_id,thread_id) VALUES(?,'nav-collection',?)").run('nav-member-' + suffix, 'nav-thread-' + suffix);
      const query = sqlite.query("INSERT INTO organization_saved_queries(id,account_id,name,definition_json,revision) VALUES(?,'account',?,?,?)");
      for (const [id, revision, stored] of [['nav-query-legacy', 7, false], ['nav-query-stored', 9, true]] as const) {
        query.run(id, 'Keep ' + id, JSON.stringify({ revision: 1, filters: { mailbox: 'all', attention: 'all', classification: 'all', text: 'Navigation', accountId: 'account', collectionId: 'nav-collection', ...(stored ? { dataSource: 'stored_mail' } : {}) } }), revision);
      }
      const targets: Array<{ family?: string; id: string; label: string }> = [
        { family: 'thread', id: 'nav-thread-archived', label: 'Keep thread pin' },
        ...['inbox', 'focus', 'quiet', 'hidden', 'all'].map(id => ({ family: 'view', id, label: 'Keep legacy ' + id })),
        { family: 'collection', id: 'nav-collection', label: 'Keep collection pin' },
        { family: 'sender', id: 'needle+nav@example.com', label: 'Keep sender pin' },
        { id: 'nav-query-legacy', label: 'Keep legacy query pin' },
        { id: 'nav-query-stored', label: 'Keep stored query pin' },
      ];
      const pin = sqlite.query("INSERT INTO pins(id,account_id,kind,target_id,target_type,resource_family,saved_query_id,label,position,revision) VALUES(?,'account',?,?,?,?,?,?,?,3)");
      targets.forEach((target, position) => pin.run('nav-pin-' + position, target.family ?? 'filter', target.id, target.family ? 'resource' : 'query', target.family ?? null, target.family ? null : target.id, target.label, position));
    })();
    // Fresh workspaces have Inbox only. Create a real named Focus through the
    // production service instead of asserting that legacy defaults supplied one.
    const destinations = createDestinations(db, 'owner');
    const current = destinations.list();
    if (!current.destinations.some(item => item.name === 'Focus' && item.retiredAt === null)) {
      destinations.create({ expectedRevision: current.revision, name: 'Focus' });
    }
    seedDML = changes() - before; seeded = true;
    return { seeded, seedDML };
  }
  function snapshot() {
    const reads = connections.filter(item => item.phase === 'navigation-reads');
    const scalar = (sql: string) => (sqlite.query(sql).get() as { n: number }).n;
    return { seeded, sealed, seedDML, providerClientCalls, outboundNetworkCalls,
      membershipCount: scalar("SELECT count(*) n FROM collection_threads WHERE collection_id='nav-collection'"),
      queryCount: scalar("SELECT count(*) n FROM organization_saved_queries WHERE id IN ('nav-query-legacy','nav-query-stored')"),
      pinCount: scalar("SELECT count(*) n FROM pins WHERE id LIKE 'nav-pin-%'"),
      readRequests: requests.filter(item => item.phase === 'navigation-reads').length,
      // requireAuth opens the first connection; keep renewal distinct from route DML.
      readAuthDML: reads.filter(item => item.ordinal === 1).reduce((n, item) => n + item.totalChanges, 0),
      readDomainDML: reads.filter(item => item.ordinal > 1).reduce((n, item) => n + item.totalChanges, 0),
      expectedExactSenderRows: sqlite.query("SELECT id FROM emails WHERE account_id='account' AND from_address='needle+nav@example.com' ORDER BY id").all().map(row => (row as { id: string }).id),
      expectedNoPlusSenderRows: sqlite.query("SELECT id FROM emails WHERE account_id='account' AND from_address='neighbor@example.com' ORDER BY id").all().map(row => (row as { id: string }).id),
      senderTransport, connections, requests };
  }
  return { dbFactory, dispatch, seed, snapshot, restore() { globalThis.fetch = originalFetch; }, recordProviderClientCall() { providerClientCalls++; }, seal() {
    if (!seeded || sealed) throw Error('Native navigation bootstrap must precede single seal');
    // Swift URLSession owns the loopback requests. These GET controls must not
    // initiate any Bun fetch, including a provider read outside GmailClient.
    globalThis.fetch = Object.assign(async () => { outboundNetworkCalls++; throw Error('Native navigation controls forbid outbound network'); }, { preconnect: originalFetch.preconnect }) as typeof fetch;
    sealed = true; return { sealed };
  } };
}
