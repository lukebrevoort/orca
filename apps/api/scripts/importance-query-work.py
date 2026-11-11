"""Count SQLite progress callbacks at interval one, including trigger work, without timing claims."""
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
            statement['vmProgressCallbacks'] = steps[0]
            statement['queryPlan'] = [row[3] for row in source.execute('EXPLAIN QUERY PLAN ' + statement['sql'], statement['bindings'])]
            if 'FROM importance_thread_state s JOIN threads' in statement['sql']:
                assert any('importance_thread_page_idx' in detail for detail in statement['queryPlan']), 'Important page missed its index'
                assert not any('TEMP B-TREE' in detail for detail in statement['queryPlan']), 'Important page sorted unbounded candidates'
        page['selectQueries'] = len(page['statements'])
        page['vmProgressCallbacks'] = sum(s['vmProgressCallbacks'] for s in page['statements'])
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
    assert copy.execute("SELECT count(*) FROM importance_thread_state WHERE account_id=? AND effective='unreviewed'", (workload['account'],)).fetchone()[0] == workload['conversations']
    workload['broadSenderWrite'] = {'vmProgressCallbacksIncludingTriggers': steps[0], 'affectedConversations': workload['conversations'], 'measuredOn': 'independent in-memory backup of identical synthetic database'}
    copy.close()
print(json.dumps({'sqliteVersion': sqlite3.sqlite_version, 'workloads': workloads}))
source.close()
