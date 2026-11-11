"""Count actual SQLite VM instructions, including trigger work, without timing claims."""
import json
import sqlite3
import sys

source = sqlite3.connect('file:' + sys.argv[1] + '?mode=ro', uri=True)
workloads = json.load(sys.stdin)
for workload in workloads:
    for page_name in ('first', 'second'):
        page = workload[page_name]
        for statement in page['statements']:
            steps = [0]
            def tick():
                steps[0] += 1
                return 0
            source.set_progress_handler(tick, 1)
            rows = source.execute(statement['sql'], statement['bindings']).fetchall()
            source.set_progress_handler(None, 0)
            assert len(rows) == statement['returned'], 'VM replay disagreed with real reader'
            statement['vmInstructions'] = steps[0]
            statement['queryPlan'] = [row[3] for row in source.execute('EXPLAIN QUERY PLAN ' + statement['sql'], statement['bindings'])]
        page['selectQueries'] = len(page['statements'])
        page['vmInstructions'] = sum(s['vmInstructions'] for s in page['statements'])
    # Broad sender writes deliberately pay for all matching conversations at write time.
    copy = sqlite3.connect(':memory:')
    source.backup(copy)
    copy.execute('PRAGMA foreign_keys=ON')
    steps = [0]
    def write_tick():
        steps[0] += 1
        return 0
    copy.set_progress_handler(write_tick, 1)
    copy.execute("UPDATE importance_choices SET choice='not_important',revision=revision+1 WHERE account_id=? AND kind='sender' AND target='robot@example.com'", (workload['account'],))
    copy.set_progress_handler(None, 0)
    workload['broadSenderWrite'] = {'vmInstructionsIncludingTriggers': steps[0], 'affectedConversations': workload['conversations'], 'measuredOn': 'independent in-memory backup of identical synthetic database'}
    copy.close()
print(json.dumps({'sqliteVersion': sqlite3.sqlite_version, 'workloads': workloads}))
source.close()
