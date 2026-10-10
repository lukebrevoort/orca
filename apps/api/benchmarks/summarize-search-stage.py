#!/usr/bin/env python3
"""Recompute descriptive statistics from retained raw observations."""
import hashlib
import json
import math
import html
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DIRECTORY = ROOT / "docs/search/performance-evidence"
manifest = json.loads((DIRECTORY / "manifest.json").read_text())
assert manifest["harnessSha256"] == hashlib.sha256((ROOT / "apps/api/benchmarks/search-stage.ts").read_bytes()).hexdigest()
runs = [json.loads((DIRECTORY / item["file"]).read_text()) for item in manifest["runs"]]
assert len(runs) == 24 and all(run["passed"] for run in runs)


def summarize(values):
    ordered = sorted(values)
    return {"n": len(values), "min": min(values), "p50": ordered[math.ceil(len(values) * .5) - 1],
            "p95": ordered[math.ceil(len(values) * .95) - 1], "max": max(values)}


rows = []
storage = []
for size in [1000, 5000, 10000]:
    for mode in ["base", "head"]:
        selected = [run for run in runs if run["size"] == size and run["mode"] == mode]
        assert len(selected) == 4
        for workload in selected[0]["results"]:
            observations = [observation for run in selected for observation in run["results"][workload]["observations"]]
            metrics = [metric for observation in observations for metric in observation["metrics"]]
            row = {"size": size, "mode": mode, "workload": workload,
                   "ms": summarize([o["ms"] for o in observations]),
                   "cpuMs": summarize([o["cpuMs"] for o in observations]),
                   "rssMiB": summarize([o["rssBytes"] / 2**20 for o in observations]),
                   "prepareCalls": summarize([o["prepared"] for o in observations]),
                   "trialP50Ms": [run["results"][workload]["summaryMs"]["p50"] for run in selected]}
            if metrics:
                assert len(metrics) == 80
                row["work"] = {key: summarize([m[key] for m in metrics]) for key in
                               ["countDurationMs", "pageDurationMs", "pageRowsProjected", "maxPageRowsBound",
                                "accountPageQueries", "labelAssociationRowsLoaded", "returnedMessages"]}
                assert all(m["pageRowsProjected"] <= m["maxPageRowsBound"] for m in metrics)
            rows.append(row)
        storage.append({"size": size, "mode": mode, "trials": [run["disk"] for run in selected]})
output = {"manifest": manifest, "method": "nearest-rank pooled percentiles; 80 observations across four trials per cell; descriptive, not confidence intervals",
          "rows": rows, "storage": storage,
          "observedPeakRssMiB": {mode: max(row["rssMiB"]["max"] for row in rows if row["mode"] == mode) for mode in ["base", "head"]}}
(DIRECTORY / "summary.json").write_text(json.dumps(output, indent=2) + "\n")
print(json.dumps({"elapsedSeconds": manifest["elapsedSeconds"], "rows": len(rows), "observedPeakRssMiB": output["observedPeakRssMiB"]}, indent=2))


def row(size, mode, workload):
    return next(r for r in rows if (r["size"], r["mode"], r["workload"]) == (size, mode, workload))


def number(value):
    return f"{value:,.2f}"


def table(headers, body):
    return "<div class='scroll'><table><thead><tr>" + "".join(f"<th>{html.escape(h)}</th>" for h in headers) + "</tr></thead><tbody>" + "".join(
        "<tr>" + "".join(f"<td>{html.escape(str(cell))}</td>" for cell in cells) + "</tr>" for cells in body) + "</tbody></table></div>"


read_rows, write_rows, work_rows, disk_rows = [], [], [], []
for size in [1000, 5000, 10000]:
    for workload in ["inbox", "common", "selective", "absent", "body-only", "oversized", "account-a"]:
        base = row(size, "base", "legacy-" + workload)
        head = row(size, "head", "legacy-" + workload)
        explicit = row(size, "head", "metadata-" + workload)
        read_rows.append([size, workload, f'{number(base["ms"]["p50"])} / {number(base["ms"]["p95"])}',
                          f'{number(head["ms"]["p50"])} / {number(head["ms"]["p95"])}',
                          f'{number(explicit["ms"]["p50"])} / {number(explicit["ms"]["p95"])}',
                          f'{number(min(head["trialP50Ms"]))}–{number(max(head["trialP50Ms"]))}'])
    for workload in ["single-autocommit-update", "transaction-100-updates", "persist-25-new", "persist-25-replay"]:
        base, head = [row(size, mode, workload) for mode in ["base", "head"]]
        ratios = [h / b for h, b in zip(head["trialP50Ms"], base["trialP50Ms"])]
        write_rows.append([size, workload, f'{number(base["ms"]["p50"])} / {number(base["ms"]["p95"])}',
                           f'{number(head["ms"]["p50"])} / {number(head["ms"]["p95"])}',
                           f'{number(head["ms"]["p50"] - base["ms"]["p50"])}',
                           f'{number(min(ratios))}–{number(max(ratios))}×'])
    common = row(size, "head", "metadata-common")
    work_rows.append([size, number(common["cpuMs"]["p50"]), number(common["work"]["countDurationMs"]["p50"]),
                      number(common["work"]["pageDurationMs"]["p50"]), common["work"]["pageRowsProjected"]["max"],
                      common["work"]["accountPageQueries"]["max"], common["prepareCalls"]["max"]])
    d = next(s for s in storage if s["size"] == size and s["mode"] == "head")["trials"][0]
    disk_rows.append([size, number(d["seededDisk"]["databaseBytes"] / 2**20),
                      number(d["checkpointedDisk"]["databaseBytes"] / 2**20),
                      number((d["checkpointedDisk"]["databaseBytes"] - d["seededDisk"]["databaseBytes"]) / 2**20),
                      number(max(stage["walBytes"] for stage in d.values()) / 2**20)])

page = f'''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Search stage one · measured performance</title><style>
body{{font:16px/1.6 system-ui;max-width:1200px;margin:40px auto;padding:0 24px;background:#f7faf8;color:#15342d}}
h1{{font:46px/1.1 Georgia}}h2{{margin-top:40px}}a{{color:#11664f}}code{{overflow-wrap:anywhere}}.scroll{{overflow:auto}}
table{{border-collapse:collapse;width:100%;font-size:13px}}td,th{{padding:10px;border:1px solid #ccd9d3;text-align:left}}th{{background:#e7efe9}}
.note{{padding:20px;border-left:4px solid #267761;background:#e7efe9}}li{{margin-bottom:8px}}</style>
<h1>Availability preserved.<br>Count work still scales with mailbox size.</h1>
<p>PR #235 · October 9, 2026 · bounded synthetic comparison · no production activation</p>
<p class="note"><strong>Recommendation:</strong> retain the compatibility stage as a draft candidate for a separately approved staging rollout.
These local trials show comparable canonical search latency and measurable per-commit FULL cost. They do not establish production capacity.
Keep WAL/FULL. Do not activate capture, workers, indexed reads, or any migration from these results.</p>
<p>Measured baseline <code>{manifest['revisions']['base']}</code>; measured candidate <code>{manifest['revisions']['head']}</code>.
The later benchmark/report commit does not change runtime code. <a href="metadata-stage-one.html">Implementation, rollback plan and screenshots</a> ·
<a href="performance-evidence/manifest.json">Run manifest</a> · <a href="performance-evidence/summary.json">All descriptive statistics</a>.</p>
<h2>Method and boundaries</h2><ul>
<li>Four sequential paired trials at 1,000, 5,000 and 10,000 owned messages; base-first and head-first order alternate. Each workload has three warmups and 20 retained samples per trial (80 pooled observations per table cell). Nearest-rank p50/p95; trial medians expose variation. No confidence interval or significance claim.</li>
<li>Same deterministic mailbox: two owned accounts, ten foreign messages, one label per message, about 2 KiB ordinary bodies. Every 1,001st owned message has a 33 KiB subject followed by the search needle and a 257 KiB body. Common query matches all owned messages; selective query matches 10%; missing/body-only queries match none. One account filter and second-page pagination are included.</li>
<li>Authenticated in-process Hono request through fresh database connection, canonical reader, serialization, response parsing and assertions. No HTTP transport, browser rendering or provider network. Exact counts and ordered result signatures match across each pair; metadata receipt is checked on every candidate explicit request. Foreign scope returns 404 and full-body mode returns 503 without results.</li>
<li>Real <code>persistGmailMessages</code> calls: 25 new messages per operation, then unchanged replay of those messages. Organization propagation explicitly disabled. Single-row autocommit and 100-update transactions isolate small/batched write cost. Three warmup batches plus 20 measured batches insert 575 messages per database. No production mailbox or credentials.</li>
<li>Runtime factory unmodified: base WAL/NORMAL (synchronous=1), candidate WAL/FULL (2), asserted in each process. This measures local commit latency, not power-loss recovery or drive flush guarantees. Checkpoints remain at SQLite defaults; explicit truncate checkpoints bracket storage snapshots.</li>
<li>Bun 1.3.14, SQLite {html.escape(str(runs[0]['sqlite']['version']))}, Apple M1 Max / 10 logical CPUs / 32 GiB RAM, macOS Darwin {html.escape(runs[0]['host']['release'])}. Reader task reported no heavy builds/simulators and was doing lightweight static capture; shared desktop/background activity continued. Start/end load and free-memory observations are retained per run. No unrelated processes were stopped.</li>
<li>24 separate processes, one at a time; 90-second child timeout, 15-minute scheduling budget. Total elapsed {number(manifest['elapsedSeconds'])} seconds. Temporary synthetic databases and exported source trees are deleted on completion. Pilot runs were excluded.</li>
</ul>
<h2>Read latency</h2><p>Milliseconds, p50 / p95. The direct A/B comparison is legacy-to-legacy. Explicit candidate metadata adds the receipt and its validation; it is an additional series, not a baseline-supported mode.</p>
{table(['Messages','Workload','Base legacy','Head legacy','Head metadata','Head legacy trial p50 range'], read_rows)}
<p>Page-two latency, CPU, RSS, count/page timing, and raw observations for every case are in the linked summary and trial files. Fixed workload order and warm cache mean these are not cold-start measurements.</p>
<h2>Writes and local sync persistence</h2><p>Milliseconds per operation, p50 / p95. Delta is pooled head minus base p50. Paired ratios use each trial's median; ratios on sub-millisecond operations magnify small absolute differences. Head performs extra metadata workloads before the write phase, so GC/cache history is not perfectly matched.</p>
{table(['Messages','Operation','Base NORMAL','Head FULL','Delta p50 ms','Paired p50 ratio range'], write_rows)}
<p>New-message persistence includes normalization, classification, labels and database work. Replay exercises the unchanged-digest path. Neither measures provider fetch time, sync coordination, rule propagation or sustained queue drain. FULL remains required; a write regression would call for batching or deployment sizing, not silently weakening durability.</p>
<h2>CPU and query work</h2><p>Head explicit common query. CPU is process user+system time over the same request boundary; close CPU/wall values indicate roughly one busy core, not the percentage of the whole machine.</p>
{table(['Messages','CPU p50 ms','Count p50 ms','Page p50 ms','Max page rows','Page queries','Prepare calls'], work_rows)}
<p>The common query returns 50 messages and loads 50 label associations. Page projection is capped at 102 rows (51 per owned account).
The aggregate count still scans matching scope; page bounds do not bound rows visited by count/filter work.
<code>prepared</code> in raw data means calls to SQLite prepare, not executed statements or scanned rows: a preprepared update has zero prepare calls while executing once or 100 times. Trigger work and physical I/O are not counted.</p>
<h2>Memory and disk</h2><p>Largest observed in-process RSS: base {number(output['observedPeakRssMiB']['base'])} MiB; head {number(output['observedPeakRssMiB']['head'])} MiB.
These are heterogeneous whole-run high-water observations, not a matched memory regression: head performs seven extra metadata workload groups. Samples are taken after operations, so transient peaks can be missed. Per-workload RSS and raw process resource counters are retained; OS file cache, other processes and device memory are excluded.</p>
{table(['Owned messages','Seeded DB MiB','Final checkpointed MiB','Growth from updates + 575 sync inserts MiB','Largest sampled WAL MiB (trial 1)'], disk_rows)}
<p>Every paired seeded and final checkpointed database/WAL/SHM size matches exactly. Read-only workloads caused no file growth. WAL snapshots are checkpoints in time, not maximum transient disk usage. No index file is created.</p>
<h2>Deployment and rollback gates</h2><ol>
<li>Keep this draft unmerged until separate approval. Before deployment, repeat the bounded comparison on representative staging storage and real mailbox distributions, including many accounts, rule/override-heavy metadata, largest supported sizes, concurrent read/write activity and checkpoint behavior. Define operational p95, sync-throughput, memory and disk budgets there; this Mac supplies no production SLO.</li>
<li>Retain the reviewed authentication, ownership, legacy envelope, exact count/page and metadata receipt tests. The pre-existing account-incarnation test does not prove same-owner delete/recreate cursor fencing; that remains a future capture gate. No benchmark assertion substitutes for that missing case.</li>
<li>For an approved stage-one deployment, API precedes web. Verify older clients and explicit metadata at the deployment boundary. New web against old API must fail visibly. There is no schema migration, capture, worker or index activation in this stage.</li>
<li>Roll back web before API. Preserve the FULL connection setting even when reverting feature code; a wholesale revert to the baseline restores NORMAL and is not the approved rollback. Observe commit latency and sync throughput before expanding rollout.</li>
<li>Future capture/schema, worker and indexed-read changes need distinct activation controls, atomic account/epoch fencing, explicit capture-off invalidation and capture-on rebuild semantics, no silent queue pruning, and a tested rollback for each stage. Oversized metadata must retain an explicit canonical option. Segmented full-body/native helper/service work is deferred.</li>
</ol>
<h2>Reproduce and inspect</h2><p>Use a checkout containing the benchmark commit, both pinned Git objects and installed frozen-lockfile dependencies. Keep real environment files out of exported trees. No fetch or network is performed by this harness.</p>
<pre>python3 apps/api/benchmarks/run-search-stage.py
python3 apps/api/benchmarks/summarize-search-stage.py</pre>
<p>The runner refuses to overwrite retained trial files; move the evidence directory aside in a disposable checkout before rerunning.
Each archive resolves its own <code>@orca/shared</code>, API and web workspace sources; external installed dependencies are shared only after lockfile equality is verified.
The manifest records the exact harness SHA-256, revisions and run order. Any failed assertion or child timeout aborts instead of producing a successful manifest.</p>
<p>Limits: no unrestricted stress run, no denied #224 security-validation route, no production migration/activation, no browser/native build, no durability weakening. Independent review coverage is recorded in the draft PR; prior runtime review remains pinned to its reviewed source head.</p></html>'''
(ROOT / "docs/search/metadata-performance.html").write_text(page)
