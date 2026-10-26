#!/usr/bin/env python3
"""Synthetic-only supervisor. No Railway API calls, retries, provider I/O or setting writes."""
import argparse
import base64
import datetime as dt
import gzip
import hashlib
import json
import math
import os
from pathlib import Path
import re
import resource
import signal
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
PINS = {"base": "0e6805131a9c8386107bf70f598e2b61b0cf6a0b", "head": "fdc78bce2d4e3169f870aaaffd62da20d9f46f30"}
TREE = "87c2ea4907c287f20852c0a4bc5d242ded2bd16b"
MIB = 1024 ** 2


def terminate(child):
    # The direct child may already have crashed while grandchildren survive.
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    if child.poll() is None:
        try:
            child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            pass
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    child.wait(timeout=2)


def group_rss(group):
    result = []
    for path in Path("/proc").glob("[0-9]*/stat"):
        try:
            fields = path.read_text().rsplit(")", 1)[1].split()
            if int(fields[2]) == group:
                result.append(int(fields[21]) * os.sysconf("SC_PAGE_SIZE"))
        except (OSError, ValueError, IndexError):
            continue
    return result


def net_tx():
    return sum(int(line.split(":", 1)[1].split()[8]) for line in Path("/proc/net/dev").read_text().splitlines()[2:])


def cgroup_memory():
    for name in ["/sys/fs/cgroup/memory.current", "/sys/fs/cgroup/memory/memory.usage_in_bytes"]:
        if Path(name).exists():
            return int(Path(name).read_text())
    raise RuntimeError("Cannot observe service memory")


def p95(values):
    assert values
    return sorted(values)[math.ceil(len(values) * .95) - 1]


def gates(report):
    assert report["passed"]
    if report["mixed"]:
        for worker in report["mixed"]:
            assert worker["passed"] and worker["planned"] == worker["offered"] == worker["completed"]
            assert p95([v["ms"] for v in worker["observations"]]) <= 1000
    else:
        limit = 500 if report["size"] == 1000 else 1000
        assert report["results"]["legacy-common"]["summaryMs"]["p95"] <= limit
        assert report["results"]["persist-25-new"]["summaryMs"]["p95"] <= 1000
        if report["mode"] == "head":
            assert report["results"]["metadata-common"]["summaryMs"]["p95"] <= limit
    for disk in report["disk"].values():
        assert sum(disk.values()) <= 256 * MIB
    assert report["disk"]["checkpointedDisk"]["walBytes"] <= 64 * MIB


def paired(base, head):
    assert base["signatures"] == head["signatures"]
    if base["mixed"]:
        for before, after in zip(base["mixed"], head["mixed"]):
            assert before["role"] == after["role"]
            assert p95([v["ms"] for v in after["observations"]]) <= 1.25 * p95([v["ms"] for v in before["observations"]])
    else:
        for name, before in base["results"].items():
            if name.startswith("legacy-") or name == "persist-25-new":
                assert head["results"][name]["summaryMs"]["p95"] <= 1.25 * before["summaryMs"]["p95"], f"Relative p95 gate: {name}"


class UnstableBaseline(AssertionError):
    """The comparison cannot distinguish code impact from run variability."""


def baseline_stability(first, repeat):
    for key in ["revision", "mode", "size", "samples", "warmups", "fixture", "connections", "signatures", "disk"]:
        assert first[key] == repeat[key], f"Self-comparison mismatch: {key}"
    assert first["passed"] and repeat["passed"]
    assert first["mixed"] is None and repeat["mixed"] is None
    assert first["results"].keys() == repeat["results"].keys(), "Self-comparison workload mismatch"
    spreads = {}
    for name, before in first["results"].items():
        if name.startswith("legacy-") or name == "persist-25-new":
            after = repeat["results"][name]
            assert before["summaryMs"]["n"] == after["summaryMs"]["n"] == first["samples"]
            a, b = before["summaryMs"]["p95"], after["summaryMs"]["p95"]
            assert a > 0 and b > 0
            spreads[name] = max(a, b) / min(a, b)
    assert "legacy-common" in spreads and "persist-25-new" in spreads
    failed = {name: ratio for name, ratio in spreads.items() if ratio > 1.25}
    if failed:
        raise UnstableBaseline(f"Unstable baseline p95 spread; candidate not started: {json.dumps(failed, sort_keys=True)}")
    return {"passed": True, "maximumAllowedSpread": 1.25, "symmetricSpreads": spreads}


def admitted_candidate(original_baseline, repeat_baseline, candidate, record_evidence=None):
    # Keep the original baseline; never select a favorable repeat for comparison.
    evidence = baseline_stability(original_baseline, repeat_baseline())
    if record_evidence is not None:
        record_evidence(evidence)
    return candidate(), evidence


def child_limits():
    resource.setrlimit(resource.RLIMIT_FSIZE, (256 * MIB, 256 * MIB))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--local", action="store_true")
    parser.add_argument("--quick", action="store_true")
    parser.add_argument("--base", default="/sources/base")
    parser.add_argument("--head", default="/sources/head")
    parser.add_argument("--output")
    args = parser.parse_args()
    assert sys.platform == "linux"
    assert not (args.local and os.environ.get("RAILWAY_PROJECT_ID")), "Local bypass prohibited on Railway"
    assert not args.quick or args.local
    now = time.time()
    if args.local:
        lifecycle = now + 1500
    else:
        assert os.environ.get("RAILWAY_SERVICE_ID") == "c39760aa-ad0a-4f40-a8d4-44a6328c534e"
        assert os.environ.get("RAILWAY_ENVIRONMENT_ID") == "33d450ee-d1d7-4d4b-96bc-b46580fc230d"
        lifecycle = dt.datetime.fromisoformat(os.environ["PERF_RESOURCE_DEADLINE"].replace("Z", "+00:00")).timestamp()
        assert 1260 <= lifecycle - now <= 2700, "Expired, late or unbounded lifecycle"
        assert Path("/data").is_mount(), "Expected dedicated staging volume mount"
        cgroup_memory()
    end = min(time.monotonic() + 1200, time.monotonic() + lifecycle - now - 60)
    run_id = os.environ.get("PERF_RUN_ID", "")
    assert args.local or re.fullmatch(r"pr235-[0-9T-]{8,32}", run_id)
    output = Path(args.output) if args.local and args.output else Path("/data") / run_id
    assert not output.exists(), "Never reuse or overwrite previous run"
    output.mkdir(parents=True)
    scratch = output / "scratch"
    scratch.mkdir()
    roots = {"base": Path(args.base).resolve(), "head": Path(args.head).resolve()}
    bun = os.environ.get("BUN", "bun")
    assert subprocess.check_output([bun, "--version"], text=True).strip() == "1.3.14"
    for mode, root in roots.items():
        assert subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip() == PINS[mode]
        assert not subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=no"], cwd=root)
    assert subprocess.check_output(["git", "rev-parse", "HEAD^{tree}"], cwd=roots["head"], text=True).strip() == TREE
    manifest = {"protocol": "railway-replacement-v2-self-comparison", "pins": PINS, "tree": TREE, "localOnly": args.local, "quick": args.quick,
                "startedAt": dt.datetime.now(dt.timezone.utc).isoformat(), "lifecycleDeadline": lifecycle,
                "measurementMaxSeconds": 1200, "processMaxSeconds": 90, "maxChildren": 11, "maxChildBudgetSeconds": 990, "passed": False,
                "harnessHashes": {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in HERE.glob("*") if p.is_file()},
                "mounts": Path("/proc/mounts").read_text(), "runs": []}
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2))
    initial_tx = net_tx()
    active = None
    emitted = 0
    def emit(path):
        nonlocal emitted
        data = base64.b64encode(gzip.compress(path.read_bytes(), mtime=0)).decode()
        emitted += len(data)
        assert emitted <= 8 * MIB, "Evidence log egress bound"
        for i in range(0, len(data), 3000):
            print(json.dumps({"artifact": path.name, "offset": i, "gzipBase64": data[i:i+3000]}), flush=True)
    def interrupt(signum, frame):
        raise RuntimeError(f"Supervisor interrupted: {signum}")
    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGINT, interrupt)
    def run(mode, size, trial, mixed_seconds=0):
        nonlocal active
        assert time.monotonic() + 90 < end, "Insufficient measurement budget"
        name = f"{trial}-{size}-{mode}{'-mixed' if mixed_seconds else ''}"
        path = output / f"{name}.json"
        command = [bun, str(HERE / "benchmark.ts"), f"--root={roots[mode]}", f"--revision={PINS[mode]}", f"--mode={mode}", f"--size={size}", f"--samples={5 if args.quick else 20}", f"--mixed-seconds={mixed_seconds}", f"--output={path}"]
        deadline = min(end, time.monotonic() + 90)
        with (output / f"{name}.log").open("w") as log, (output / f"{name}-resources.jsonl").open("w") as telemetry:
            active = subprocess.Popen(command, cwd=roots[mode], stdout=log, stderr=subprocess.STDOUT, start_new_session=True, preexec_fn=child_limits, env={**os.environ, "TMPDIR": str(scratch)})
            try:
                while active.poll() is None:
                    assert time.monotonic() < deadline, "Process tree timeout"
                    rss = group_rss(active.pid)
                    memory = cgroup_memory()
                    disk = sum(p.stat().st_size for p in scratch.rglob("*") if p.is_file())
                    tx = net_tx() - initial_tx
                    telemetry.write(json.dumps({"at": time.time(), "rss": rss, "serviceMemory": memory, "scratchBytes": disk, "txBytes": tx}) + "\n")
                    telemetry.flush()
                    assert all(v <= 512 * MIB for v in rss), "Sampled process RSS gate"
                    assert args.local or memory <= 1024 * MIB, "Sampled service memory gate"
                    assert disk <= 256 * MIB, "Synthetic disk growth gate"
                    assert (output / f"{name}.log").stat().st_size <= 8 * MIB, "Child log bound"
                    assert args.local or tx <= 1024 * MIB, "Network growth gate"
                    time.sleep(.2)
                assert active.returncode == 0, f"Child failed: {name}; see retained log"
            finally:
                terminate(active)
                active = None
                if path.exists(): emit(path)
                emit(output / f"{name}.log")
                emit(output / f"{name}-resources.jsonl")
        report = json.loads(path.read_text())
        gates(report)
        manifest["runs"].append(path.name)
        return report
    try:
        for trial in range(1, (1 if args.quick else 2) + 1):
            for size in ([1000] if args.quick else [1000, 10000]):
                pair = {}
                if trial == 1 and size == 10000:
                    pair["base"] = run("base", size, trial)
                    pair["head"], manifest["baselineStability"] = admitted_candidate(
                        pair["base"], lambda: run("base", size, "stability"), lambda: run("head", size, trial),
                        lambda proof: manifest.__setitem__("baselineStability", proof))
                else:
                    for mode in (["base", "head"] if trial % 2 else ["head", "base"]):
                        pair[mode] = run(mode, size, trial)
                paired(pair["base"], pair["head"])
        pair = {mode: run(mode, 10000, "mixed", 2 if args.quick else 60) for mode in ["base", "head"]}
        paired(pair["base"], pair["head"])
        manifest["passed"] = True
    except BaseException as error:
        manifest["error"] = str(error)
        manifest["failureKind"] = "unstable_baseline" if isinstance(error, UnstableBaseline) else "failed_check"
        raise
    finally:
        if active: terminate(active)
        manifest["finishedAt"] = dt.datetime.now(dt.timezone.utc).isoformat()
        (output / "manifest.json").write_text(json.dumps(manifest, indent=2))
        emit(output / "manifest.json")


if __name__ == "__main__":
    main()
