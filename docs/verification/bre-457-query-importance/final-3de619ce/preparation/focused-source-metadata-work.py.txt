"""Allocated-demo helper: actual read-only Python SQLite replay of source-pinned batch SQL.

This is not Bun VM instrumentation or a second importance resolver/evaluator.
"""
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import time

database, input_path, output_path = map(Path, sys.argv[1:])
spec = json.loads(input_path.read_text())
assert len(spec["statements"]) == 2 and 0 < spec["targetCount"] <= 100
connection = sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)
connection.execute("PRAGMA query_only=ON")
traces = []
connection.set_trace_callback(traces.append)
results = []
try:
    connection.execute("BEGIN")
    for sql in spec["statements"]:
        callbacks = [0]

        def progress():
            callbacks[0] += 1
            return 0

        connection.set_progress_handler(progress, 1)
        start = time.perf_counter()
        rows = connection.execute(sql, spec["params"]).fetchall()
        elapsed = time.perf_counter() - start
        connection.set_progress_handler(None, 0)
        results.append({"sqlSha256": hashlib.sha256(sql.encode()).hexdigest(), "rows": len(rows),
            "progressCallbacksInterval1": callbacks[0], "seconds": elapsed})
    assert results[0]["rows"] == spec["targetCount"]
    assert results[1]["rows"] <= 20 * spec["targetCount"]
    assert connection.total_changes == 0
    connection.rollback()
    selects = [sql for sql in traces if sql.lstrip().startswith("WITH wanted")]
    assert len(selects) == 2
    Path(output_path).write_text(json.dumps({"engine": "Python sqlite3 SQL replay, not Bun VM observations",
        "sqliteVersion": sqlite3.sqlite_version, "productionSourceSha256": spec["productionSourceSha256"],
        "targetCount": spec["targetCount"], "actualBatchSelects": len(selects), "statements": results,
        "connectionTotalChanges": connection.total_changes, "queryOnly": 1,
        "limits": "Finite source-pinned metadata statements only; preference window visits may exceed output20/thread; no whole-request SQL/VM/memory or speedup claim"}, indent=2) + "\n")
finally:
    connection.close()
