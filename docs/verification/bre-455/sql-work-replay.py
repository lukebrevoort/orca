"""Replay captured synthetic claim SQL from its exact pre-claim SQLite snapshot.
Use only trusted fixture output; executes its recorded SQL, including writes.
No server, provider, credentials, bodies, performance speedup or OS proof.
"""
import json, sqlite3, sys
from pathlib import Path
folder = Path(sys.argv[1])
source = sqlite3.connect(str(folder / 'before.sqlite'))
db = sqlite3.connect(':memory:')
source.backup(db)
source.close()
db.execute('PRAGMA foreign_keys=ON')
record = json.loads((folder / 'statements.json').read_text())
work = [0]
def progress():
    work[0] += 1
    return 0
db.set_progress_handler(progress, 1)
results = []
db.execute('BEGIN IMMEDIATE')
for statement in record['statements']:
    before = work[0]
    cursor = db.execute(statement['sql'], statement['args'])
    count = len(cursor.fetchall()) if statement['method'] != 'run' else cursor.rowcount
    results.append({'method': statement['method'], 'sql': statement['sql'], 'rows': count, 'vmSteps': work[0] - before})
db.commit()
db.close()
result = {'sqliteVersion': sqlite3.sqlite_version, 'statements': len(results), 'reads': record['reads'], 'scanRows': record['scanRows'], 'envelopes': record['envelopes'], 'returnedRows': record['returnedRows'], 'vmSteps': work[0], 'plan': record['plan'], 'details': results, 'scope': 'deterministic actual captured SQL replay including writes on Python SQLite; no timing speedup claim'}
(folder / 'replay.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({key: value for key, value in result.items() if key != 'details'}))
