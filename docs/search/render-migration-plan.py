"""Render the source-backed v5 migration plan as a reviewable PDF.

Run from any directory with reportlab available. Optional --metadata JSON supplies
verified publication/evidence text; omitted fields stay explicitly pending.
"""
from pathlib import Path
import argparse
import json
import math
from xml.sax.saxutils import escape

from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import Paragraph, Table, TableStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

parser = argparse.ArgumentParser()
parser.add_argument('--output', required=True)
parser.add_argument('--metadata')
args = parser.parse_args()
meta = json.loads(Path(args.metadata).read_text()) if args.metadata else {}
out = Path(args.output)
out.parent.mkdir(parents=True, exist_ok=True)
for name, filename in [('Sans', 'DejaVuSans.ttf'), ('Sans-Bold', 'DejaVuSans-Bold.ttf'), ('Mono', 'DejaVuSansMono.ttf')]:
    pdfmetrics.registerFont(TTFont(name, '/usr/share/fonts/truetype/dejavu/' + filename))
pdfmetrics.registerFontFamily('Sans', normal='Sans', bold='Sans-Bold')
C = canvas.Canvas(str(out), pagesize=(612, 792))
C.setTitle('Orca stored mail search migration version 5')
C.setAuthor('Orca engineering')
INK = '#000000'
MUTED = '#53616C'
BLUE = '#246787'
GREEN = '#246B58'
AMBER = '#87540F'
RED = '#A33C36'
LINE = '#D9D9D9'
PALE = '#EFF5F7'
P = 0
W = 524
publication = meta.get('publication', 'Runtime checkpoint a825cef on settled main f0a9180; public cost edition')
verification = meta.get('verification', 'Replacement draft PR and hosted checks pending')
performance_status = meta.get('performance_status', 'Prior core snapshot; current HTTP and capability/auth costs unmeasured')
SOURCE_ROOT = meta.get('source_url', '')

def para(text, x, y, width, size=10, color=INK, bold=False, leading=None):
    q = Paragraph(text, ParagraphStyle('p', fontName='Sans-Bold' if bold else 'Sans', fontSize=size,
        leading=leading or size * 1.32, textColor=HexColor(color), spaceAfter=0))
    _, h = q.wrap(width, 792)
    if y + h > 737:
        raise ValueError(f'Page {P} overflow at {y+h:.1f}: {text[:80]}')
    q.drawOn(C, x, 792 - y - h)
    return h

def text(value, x, y, size=8, color=MUTED, bold=False):
    C.setFillColor(HexColor(color))
    C.setFont('Sans-Bold' if bold else 'Sans', size)
    C.drawString(x, 792-y-size, value)

def page(title, sub, source):
    global P
    if P:
        C.showPage()
    P += 1
    text('ORCA  /  STORED MAIL SEARCH', 44, 27, 8.2, MUTED, True)
    text('V5 PUBLIC PLAN  |  6 OCT 2026', 383, 27, 7.8, MUTED, True)
    title_size = 24
    while pdfmetrics.stringWidth(title, 'Sans-Bold', title_size) > W:
        title_size -= .25
    para(title, 44, 59, W, title_size, bold=True)
    para(sub, 44, 99, W, 10.3, MUTED)
    # Source text is short enough to remain an unobtrusive, useful locator.
    para('Source: ' + source, 44, 709, W, 7.4, MUTED)
    C.setStrokeColor(HexColor(LINE)); C.setLineWidth(.5); C.line(44, 46, 568, 46)
    text('Draft candidate  |  No merge or production activation', 44, 758, 7.4)
    text(f'{P:02d} / 09', 532, 758, 7.4)

def heading(title, y, x=44, width=W):
    return y + para(title, x, y, width, 12.3, bold=True) + 9

def section(title, body, y, size=10, x=44, width=W):
    y = heading(title, y, x, width)
    return y + para(body, x, y, width, size) + 13

def arrow(x1, y1, x2, y2, color=BLUE, dashed=False):
    C.setStrokeColor(HexColor(color)); C.setFillColor(HexColor(color)); C.setLineWidth(1.15)
    C.setDash(3, 3) if dashed else C.setDash()
    C.line(x1, 792-y1, x2, 792-y2); C.setDash()
    a = math.atan2(y2-y1, x2-x1)
    p = C.beginPath(); p.moveTo(x2, 792-y2)
    for k in [a-.5, a+.5]: p.lineTo(x2-5*math.cos(k), 792-y2+5*math.sin(k))
    p.close(); C.drawPath(p, stroke=0, fill=1)

def node(x, y, width, height, title, body='', color=BLUE):
    C.setFillColor(HexColor('#FFFFFF')); C.setStrokeColor(HexColor(color)); C.setLineWidth(1)
    C.roundRect(x, 792-y-height, width, height, 5, stroke=1, fill=1)
    used = para(title, x+10, y+9, width-20, 10, color, True)
    if body:
        used += 5 + para(body, x+10, y+14+used, width-20, 8.7)
    if used > height-17:
        raise ValueError(f'Node overflow page {P}: {title} {used}/{height}')

def table(headers, rows, widths, y, size=9.1):
    def cell(s, header=False):
        return Paragraph(s, ParagraphStyle('cell', fontName='Sans-Bold' if header else 'Sans',
            fontSize=size, leading=size*1.28, textColor=HexColor('#FFFFFF' if header else INK)))
    data = [[cell(h, True) for h in headers]] + [[cell(s) for s in row] for row in rows]
    q = Table(data, colWidths=widths, repeatRows=1, hAlign='LEFT')
    q.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), HexColor('#304956')),
        ('ROWBACKGROUNDS', (0,1), (-1,-1), [HexColor('#FFFFFF'), HexColor('#F4F7F8')]),
        ('GRID', (0,0), (-1,-1), .45, HexColor(LINE)),
        ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
        ('LEFTPADDING', (0,0), (-1,-1), 8), ('RIGHTPADDING', (0,0), (-1,-1), 8),
        ('TOPPADDING', (0,0), (-1,-1), 7), ('BOTTOMPADDING', (0,0), (-1,-1), 7),
    ]))
    _, h = q.wrap(W, 792)
    if y+h > 699:
        raise ValueError(f'Table overflow page {P}: {y+h}')
    q.drawOn(C, 44, 792-y-h)
    return y+h

def steps(rows, y, size=9.5, gap=11):
    for i, (title, body) in enumerate(rows, 1):
        text(f'{i:02d}', 44, y, 11, BLUE, True)
        h = para('<b>'+title+'</b>  '+body, 77, y, 491, size)
        y += h + gap
    return y

page('Orca stored mail search migration',
     'Keep metadata search working during backfill. Activate full stored-mail search only after readiness and rollout gates.',
     '0051_queued_mail_search.sql; mode.ts; indexing/schema.ts; runtime.ts; shared/mail-search.ts')
y = 143
y += para('<b>'+escape(publication)+'</b><br/>'+escape(verification)+'. Document v5 retains index format 3 and .search-v3.sqlite.', 44, y, W, 9.4, MUTED) + 17
text('CANONICAL MAIL FILE', 44, y, 8.5, BLUE, True)
text('SEPARATE DERIVED FILE', 319, y, 8.5, GREEN, True)
y += 22
node(44, y, 249, 101, 'Mail and ID-only capture',
     '<b>emails + oauth_accounts</b> remain authoritative.<br/>control: source/build + mode/epoch<br/>activation audit; account revisions<br/>outbox: IDs + versions + retry state')
node(319, y, 249, 101, 'Search representation',
     '<b>index_control / index_accounts</b><br/>owner token + exact ready revision<br/><b>index_documents</b>: stable IDs + versions<br/><b>metadata_fts / full_fts</b>: private postings', GREEN)
database_mid = y+51
y += 123
node(44, y, 249, 68, 'API resident scheduler', 'Persisted worker opt-in; next poll 5 s after run.<br/>One bounded write child per job; no new service.')
node(319, y, 249, 68, 'Indexed read child after enable', 'Before enable: original metadata reader.<br/>After enable: exact snapshots or visible error.', GREEN)
arrow(168, y-22, 168, y)
arrow(443, y-22, 443, y, GREEN)
# Route the write child from the scheduler to the derived DB. The capture
# transaction never writes FTS directly.
C.setStrokeColor(HexColor(BLUE)); C.setLineWidth(1.15)
C.line(293, 792-y-34, 306, 792-y-34)
C.line(306, 792-y-34, 306, 792-database_mid)
arrow(306, database_mid, 319, database_mid)
y += 91
y = section('Existing search first then a deliberate switch',
     'During backfill, metadata-only substring search keeps its short queries, counts and mailbox order. After enable, web/iOS use stored-body literal search: first 10 by field relevance, then Load more. Indexed lag never silently returns metadata results.', y, 10)
y = section('What changed from the frozen predecessor',
     'PR 224 remains frozen at <b>3bc00823</b>. Its incomplete security review found synchronous FTS work inside email-write transactions. This candidate moves tokenization and posting writes to a derived file and child process. It <b>does not clear that finding or complete the review</b>. There is no external search vendor or queue broker.', y, 9.8)
para('The original emails schema is unchanged. Capture always records obligations, even with indexed reads/workers disabled. Canonical additions are capture/control tables and ID/scheduling indexes. Small claim/ack writes and shared CPU/disk costs remain.', 44, y, W, 9.3, MUTED)

page('A staged switch without a backfill outage',
     'The long preparation phase keeps existing metadata search available. Coverage changes only at an audited mode transition.',
     'search/mode.ts; indexing/admin.ts; index.ts capability route; web search-capabilities.ts; iOS APIClient.swift')
node(44,145,524,61,'1 Deploy compatible API and clients with enabled 0',
     'REST/MCP preserve original substring/short queries, counts and mailbox order.<br/>New web/iOS visibly label metadata-only coverage and use /v1/inbox.')
arrow(306,206,306,224)
node(44,224,524,66,'2 Initialize backfill and drain while metadata search continues',
     'Capture remains active. The ~3.8-hour 20k paced estimate is not a metadata-search outage.<br/>Before enable, every serving replica must support capability and expected mode/epoch.')
arrow(306,290,306,311,GREEN)
node(44,311,524,68,'3 Enable after readiness and rollout approval',
     'New epoch + audit reason. Web/iOS: full stored-body relevance, 10 then Load more.<br/>REST text adapter/MCP: indexed metadata semantics/counts. Old cursors restart.',GREEN)
arrow(168,379,168,401,RED);arrow(443,379,443,401,BLUE)
node(44,401,249,72,'Lag blocked or missing sidecar',
     'Remain indexed; return a visible error.<br/>No automatic metadata downgrade.<br/>Ordinary Inbox still works.',RED)
node(319,401,249,72,'Authorized operator disable',
     'New epoch + audited reason.<br/>200 capability confirms metadata mode.<br/>Label coverage; reset pagination.')
y=494
y=section('Bind the mode before parsing or running the query',
     'Authenticated capabilities return mode, epoch, owner, coverage and semantics from canonical control only; no sidecar scan. Clients send expected mode/epoch and verify response headers. Server snapshots, workers and signed text cursors bind the epoch. A transition race causes restart, not mixed pages.',y,9.4)
y=section('Old-server compatibility is narrow',
     'A 404 permits initial legacy mode only after authenticated-owner verification and before indexed mode has been observed for that owner/origin in the client session. Later 404/network/5xx cannot downgrade. A successful disabled capability is required for explicit rollback.',y,9.4)
para('Init/enable/disable persist activation audit entries; repeated no-op enable/disable does not advance epoch. Ordinary Inbox/MCP calls without text bypass search control. Activation changes indexed semantics; disclose short-only-query and cursor changes before rollout.',44,y,W,9.2,MUTED)

page('The write and recovery protocol',
     'Mail plus its indexing obligation commit together. The derived commit precedes the exact acknowledgment.',
     'indexing/queue.ts; worker-core.ts; supervisor.ts; schema.ts; db/client.ts')
# A real sequence diagram with four distinct write boundaries.
lanes = [(89, 'Mail writer'), (224, 'Canonical DB'), (373, 'Supervisor / child'), (522, 'Derived DB')]
for x, label in lanes:
    para(label, x-54, 145, 108, 8.5, BLUE if x<300 else GREEN, True)
    C.setStrokeColor(HexColor(LINE)); C.setDash(2,3); C.line(x, 792-169, x, 792-354); C.setDash()
for y, a, b, label in [
    (183,89,224,'mail + revision + job commit'),
    (220,373,224,'persist exact claim + attempt'),
    (257,373,522,'apply version; clear ready; commit'),
    (294,373,224,'child exit; exact receipt; ack'),
    (337,373,522,'fresh completeness proof; seal at R'),
]:
    arrow(a,y,b,y)
    para(label, min(a,b)+3, y-20, max(abs(b-a)-6,160), 7.6, INK)
para('The child size-checks and copies source in a read-only snapshot, then closes it before tokenization.',44,357,W,8.1,MUTED)
y = table(['Interruption or race', 'Durable recovery'], [
    ('Before mail commit', 'Mail change and obligation roll back together.'),
    ('Mail saved, index not committed', 'Keep the job. Inbox and metadata mode work; enabled indexed search updates. Retry after confirmed exit.'),
    ('Index committed, ack missing', 'Applied version and job survive. Replay is idempotent; exact ack removes only the completed attempt.'),
    ('Ack done, ready not published', 'Obtain a new baseline / zero-obligation / source-revision proof. Temporary unavailability is safe.'),
    ('Version 19 arrives during 18', 'Old ack or failure matches no current job. Newer coalesced work survives.'),
], [159,365], 374, 8.8)
y += 14
para('<b>Readiness is a completeness claim.</b> Baseline complete, no pending/claimed/delayed/blocked jobs, exact source revision R and unchanged build/owner/mutation proof are all required. Any posting change clears ready in the same derived transaction.', 44, y, W, 9.2)
y += 55
para('<b>Durability gate.</b> All canonical and sidecar writers require WAL/FULL; synchronous is connection-local. Deployed power-loss durability is unproven. Lost sidecar or restored canonical data requires a fresh build and full baseline.', 44, y, W, 9.2, MUTED)

page('What an activated search page means',
     'After enable, literal relevance covers stored mail. Before enable, the original metadata reader remains in use.',
     'search/read.ts; cursor.ts; protocol.ts; shared/mail-search.ts; web global-search.tsx; iOS InboxView.swift')
node(44,145,249,65,'1 Check epoch pin and authorize','Expected activation epoch and ownership.<br/>Exact build, incarnation and published revision.')
node(319,145,249,65,'2 Traverse indexed candidates','Subject, sender, metadata, then body.<br/>Canonical filters and short-term verification.',GREEN)
arrow(293,177,319,177)
node(44,240,249,67,'Not ready for every selected account','Updating, blocked or unavailable.<br/>No silent account omission or partial success.',RED)
node(319,240,249,67,'3 Return 10 and an opaque cursor','No mandatory count. Same snapshot only.<br/>Public page size capped at 50.',GREEN)
arrow(168,210,168,240,RED); arrow(443,210,443,240,GREEN)
y = table(['Continuation', 'Meaning in web and iOS'], [
    ('matches', 'Another match is known; Load more requests the next page.'),
    ('scan', 'Index positions remain, not necessarily matches. Load more resumes safe progress; a page may contain fewer than 10 or zero matches.'),
    ('none', 'Traversal is exhausted. A null cursor is required.'),
], [108,416], 329, 9)
y += 16
y = section('Field relevance with a stable tie break',
     'All clauses in subject rank first, then all in sender, then across sender/subject/snippet, then matches requiring body. Immutable document ID breaks ties. No age cutoff, freshness ranking, fuzzy matching or semantic expansion.', y, 9.6)
y = section('Indexed syntax is an explicit product change',
     'AI update works: update anchors the trigram index; AI is checked literally. AI alone needs a longer clause after enable, although short queries keep working in metadata mode. <b>Disclose and accept this semantics change before activation.</b>', y, 9.6)
para('64 candidates per batch; 2,048 candidate positions and 4 MiB cumulative short-term body reads per public page. Soft scan limits preserve progress; the 2 s child deadline returns an error. Signed cursors bind user, query, filters, build, incarnations and exact revisions. Changed mail requires restart.', 44, y, W, 9.2)
y += 66
para('Activated MCP and count compatibility stay metadata-only with indexed semantics and a separate exact-count path under the hard deadline. No attachment, HTML-only-body or unsynced Gmail search is added.', 44, y, W, 9.2, MUTED)

page('Work bounds and writer ownership',
     'The limits are defensive defaults. Production capacity, hard resource isolation and whole-container shutdown remain gates.',
     'search/protocol.ts; executor.ts; indexing/queue.ts; supervisor.ts; ownership.ts; runtime.ts')
y = table(['Boundary', 'Current default', 'Practical consequence'], [
    ('Indexed read process', '1 active; 8 queued;<br/>1 pending per user', 'Shared indexed API/MCP queue. Original metadata reader remains unchanged before enable.'),
    ('Read time', '2 s child; 1 s queue', 'Kill and await close before slot reuse. No main-thread query fallback.'),
    ('Write drain', '16 jobs; 20 s scheduling', 'One child per job, then bounded seals. An in-flight job can end after 20 s.'),
    ('Write attempt', '5 s; 3 persisted attempts', 'Backoff, then explicit blocked state. Known child killed and reaped.'),
    ('Write memory', '192 MiB, sampled 20 ms', 'Linux watchdog may overshoot. Not a hard memory limit.'),
    ('Source text', '32 KiB metadata;<br/>256 KiB full total', 'Provisional; oversize is blocked, never truncated or acknowledged complete.'),
], [106,142,276], 145, 8.8)
y += 20
text('ACTIVE DRAIN OWNERSHIP LIVES IN THE EXISTING API',44,y,8.5,BLUE,True); y += 23
node(44,y,112,64,'Idle','No token or lock<br/>held while idle')
node(186,y,162,64,'Existing API process','Owns lock directory +<br/>random sidecar token')
node(378,y,190,64,'Confirmed exit','Reap child; clear recorded PID;<br/>then release token + directory',GREEN)
arrow(156,y+32,186,y+32); arrow(348,y+32,378,y+32,GREEN)
y += 83
y = section('Crash recovery may interrupt the existing API',
     'There is no separate indexing service to stop. A whole-supervisor crash may require stopping/restarting the existing API/container and proving every associated child exited. <b>Inbox may have a planned maintenance interruption.</b> Retain the owner record; only then clear matching state. Never kill an unowned PID or blindly unlock.',y,9.6)
para('Ordinary blocked indexing or disable alone preserves Inbox. Every apply/seal checks ownership; symlinks resolve and hard-linked DB files are refused. No automatic unlock exists. Local checks do not prove Railway teardown; hard memory, CPU/I/O and disk isolation remain gates.',44,y,W,9.3,MUTED)

page('Backfill deletion and rebuild',
     'Historical mail and live edits share a versioned queue. Existing metadata search keeps working before activation.',
     '0051 capture triggers; indexing/queue.ts; worker-core.ts; schema.ts; admin.ts; README.md')
node(44,145,249,91,'Historical baseline','Read IDs in stable order, 64 per batch.<br/>Enqueue baseline version 0 and checkpoint<br/>in one short canonical transaction.')
node(319,145,249,91,'Live capture','Mail write + revision + latest ID obligation.<br/>Conflict coalescing preserves live versions.<br/>Inserts behind the scan cursor are captured.')
arrow(168,236,168,265);arrow(443,236,443,265)
node(44,265,524,70,'One version-aware derived apply path','NULL means unapplied, so first version 0 applies. Newer applied versions and retained tombstones win.<br/>Baseline completion alone is not ready; all account/mode obligations must finish.',GREEN)
arrow(306,335,306,363,GREEN)
node(44,363,524,58,'Publish only a fresh proof at exact revision R','Complete baseline + no obligations + unchanged owner/build/mutation proof; then reader equality checks.',GREEN)
y = 441
y = section('Deletes and reused accounts cannot resurrect old mail',
     'Message deletion records a versioned tombstone in the mail transaction. Account disconnect immediately revokes canonical access and leaves incarnation-specific cleanup jobs outside cascades. Cleanup removes at most 8 posting rows per attempt; version maps remain until rebuild. Reused IDs get a new incarnation.',y,9.7)
y = section('Poison and oversized jobs stay visible',
     'One blocked full-text job prevents complete full search for that account. Before activation, original metadata search still works. After activation, full search reports the block; it never downgrades silently. Canonical mail is retained and retry is explicit after resolving the cause.',y,9.7)
para('<b>Rebuild after source/index loss.</b> Disable reads, pause, stop/reap supervisors and readers, then archive derived file/WAL/SHM consistently. Proving stop may require existing API/container maintenance and an Inbox interruption. Keep mail and capture; create a fresh build, backfill, drain and verify. No live-file deletion, old-build reuse or zero-downtime dual index is assumed.',44,y,W,9.6)

page('The operator sequence and rollback',
     'Implemented commands for an explicitly selected database. This plan does not execute or authorize production changes.',
     'indexing/admin.ts; README.md; 0051 migration guard; db/client.ts; index.ts startup/shutdown')
para('From the repository root, each command below has this exact prefix. Replace the database path only after selecting the reviewed target.',44,145,W,9.7)
para('<font name="Mono">bun apps/api/src/search/indexing/admin.ts</font>',44,183,W,8.8)
para('<font name="Mono">COMMAND /absolute/path/orca.sqlite [SCOPE OR REASON]</font>',44,202,W,8.8)
y = steps([
    ('status then init', 'Inspect state, initialize a fresh disabled build and audit a new epoch. Init refuses existing sidecar/owner. Original metadata search continues.'),
    ('repeat backfill', 'Run until each account/mode baseline is complete. Optional ACCOUNT_ID and metadata|full scope one invocation. Each batch is at most 64 IDs per account/mode.'),
    ('resume then drain', 'Resume persists worker opt-in. The API scheduler or repeated explicit drain runs advance bounded work. Status shows oldest work, retries and account progress.'),
    ('verify', 'Run FTS integrity maintenance and require exact ready revisions plus zero outstanding obligations. It can take time on large data; it is not startup work.'),
    ('enable after release gates', 'All replicas must understand capabilities and epochs. Enable checks readiness, advances epoch and audits a reason. Optional quoted reason follows the DB path.'),
    ('disable for deliberate metadata rollback', 'Authorized disable audits reason/epoch and restores labeled metadata in this API; pagination restarts. Pause separately stops new work. Keep mail/capture intact.'),
    ('retry ACCOUNT_ID MODE only after review', 'Example: retry /absolute/path/orca.sqlite ACCOUNT_ID full. Reset blocked attempts after resolving the cause; never use blind unlock as recovery.'),
], 235, 9.3, 10)
y += 3
y = section('Before a rolling deployment',
     'Deploy the mode/epoch contract to every serving replica before enable; test old/new clients and intentional syntax/cursor changes. Check whether 0051 or experimental PR 224 tables ran on the target; never rewrite a deployed migration. Back up mail, reserve WAL/queue/rebuild storage and require WAL/FULL writers.',y,9.3)
para('Crash/rebuild recovery may still require stopping the existing API/container, proving child exit and a planned Inbox interruption. Ordinary lag or disable alone preserves Inbox. Hard isolation, security review, durability and explicit production approval remain gates.',44,y,W,9.3,MUTED)

page('Blast radius and verification',
     'The new search folder is only part of the review. Entry points, account filters and client continuation also change.',
     'Replacement working tree; the final published head and evidence manifest remain the review authority')
y = table(['Surface', 'Files and changes', 'Review focus'], [
    ('Canonical storage', '0051 capture schema / triggers / ID index; db/client.ts FULL', 'Writer cost, migration timing, durability for every writer'),
    ('Maintenance', 'indexing schema, queue, worker-core, supervisor, ownership, admin', 'Commit/ack/seal; owner recovery; versions; byte admission'),
    ('Read API', 'mode, read, cursor, protocol, executor; index.ts', 'Capabilities, expected epoch, authority, legacy/indexed transition'),
    ('Contracts and views', 'shared/mail-search; mailbox hydration; MCP; view predicates', 'Literal scope; public bounds; metadata-only counts; saved filters'),
    ('Web', 'search-capabilities, global-search, App entry points', 'Visible metadata/full labels; owner-scoped 404 and epoch resets'),
    ('iOS', 'APIClient, Models, InboxView; unit/UI tests', 'Same contract; explicit Load more; invalidation and error states'),
], [94,231,199], 145, 8.7)
y += 17
y = heading('Evidence required at the final replacement head', y)
y += para(escape(verification)+'. Publication and final-head evidence must remain factual; missing runtime checks must stay explicit.',44,y,W,9.5,AMBER)+12
y += para('<b>Data and execution:</b> atomic capture, coalescing, commit/ack/readiness races, deletes/reused accounts, loss/rebuild, blocked work, kill/reap, owner refusal and account authorization.',44,y,W,9.5)+10
y += para('<b>Staged compatibility:</b> preserve disabled substring/short queries/counts/order; verify audit and epoch changes, capability-before-parser checks, cursor races, initial authenticated 404 compatibility and no later error downgrade.',44,y,W,9.5)+10
y += para('<b>User surfaces:</b> labeled modes, explicit 200-confirmed metadata rollback with pagination reset, no-text Inbox/MCP bypass, relevance/Load more/scan states, web evidence and actual iOS runtime results.',44,y,W,9.5)+12
para('<b>Security status remains incomplete.</b> No blocked PR 224 candidate security scan, exploit test or stress sequence was resumed. Deterministic correctness checks and green CI do not establish security clearance, power-loss durability or deployment isolation. Sidecar postings and backups remain private mail data.',44,y,W,9.4,AMBER)

page('Measurements costs and the decision',
     'Earlier child measurements guide a provisional model. They do not measure the staged HTTP or capability path.',
     meta.get('performance_source', 'Prior source-hashed read/write reports; current queued-search-costs.md; <link href="https://docs.railway.com/pricing/plans#resource-usage-pricing" color="#246787">Railway rates</link>. Staged benchmark and PR checks pending.'))
para(escape(performance_status),44,145,W,9.7,AMBER,True)
y = table(['Measurement', 'Observed value', 'Interpretation'], meta.get('performance_rows', [
    ('Prior ordinary executor<br/>20,000 short messages', '118-121 ms lifecycle;<br/>9.8-13.7 ms core', 'Case means before staged epoch changes. Excludes HTTP/auth/capability round trips.'),
    ('Prior metadata count<br/>one sample', '1,039 ms lifecycle;<br/>927 ms core', '19,499 matches, 25 returned; 103.2 MiB VmHWM. Not a capacity guarantee.'),
    ('Prior fixture storage', '40.83 MiB canonical;<br/>37.57 MiB sidecar', 'Indexed text is 3.77 MiB. Canonical WAL was 40.26 MiB before checkpoint.'),
    ('Earlier explicit drains', '32 jobs + 2 seals<br/>0.949 s', 'Write child 27.4-27.8 ms and about 42.7 MiB. Excludes API 5 s inter-drain pause.'),
    ('Earlier capture only', '+26 / 20 / 10 us', 'Added local insert / metadata / body latency with worker disabled.'),
]), [158,133,233], 174, 8.5)
y += 15
y = heading('Hypothetical compute estimate with major unknowns',y)
y += para('At hypothetical <b>1,000 / 10,000 / 100,000 ordinary pages per month</b>, prior child coefficients model about <b>$0.0015 / $0.0151 / $0.1512</b>. The public model states update-volume and storage assumptions separately. These exclude exact-count CPU, real index/WAL storage, permanent API RAM, capability/auth and polling overhead. An extra 100 MB resident RAM alone is $1/month. Production traffic and billing observations are excluded from this public edition. This is not a total or invoice forecast.',44,y,W,9.2)+13
y += para('<b>Backfill keeps existing search available.</b> A 20k both-mode baseline means about 40k jobs and 2,500 drains. Tiny-job extrapolation with 5 s pauses is <b>about 3.8 hours</b>; enabled=0 keeps metadata search working. The measured 0.949 s is only 32 jobs plus 2 seals in explicit drains. Real bodies, retries and contention add uncertainty.',44,y,W,9.2)+14
y = heading('Why this architecture and what it costs in complexity',y)
y += para('<b>Separate file + queue:</b> removes FTS from the canonical writer lock, adding two-file readiness/recovery and disk. <b>Same-file background writes:</b> simpler, but FTS still holds that lock. <b>Defer body search:</b> smaller scope, without the requested body coverage. <b>Per-job children:</b> simple failure isolation; persistent reuse could reduce startup but needs a separate lifecycle/recovery design.',44,y,W,9.2)+11
para('Warm-cache local overlayfs and tiny bodies do not prove Railway capacity. Storage expansion, both WALs/backups, shared CPU/I/O and all review/rollout gates remain open.',44,y,W,9.1,MUTED)

assert P == 9
C.save()
print(str(out))
