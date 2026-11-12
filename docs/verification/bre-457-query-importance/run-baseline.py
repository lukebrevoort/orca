#!/usr/bin/env python3
"""Prepared only. Run once after ROOT allocates the inherited heavy-wrapper slot."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import time
import shutil

BASE = "7c97193688599e5996bb657c34227a63927c384c"
BRANCH = "t3/bre-457-query-importance-read"
ROOT = Path(__file__).resolve().parents[3]
TEST = "apps/api/src/organization/collections-pins/query-importance-baseline.test.ts"
FIXTURE = "apps/api/src/organization/collections-pins/query-importance-baseline.fixture.ts"
DOCS = "docs/verification/bre-457-query-importance/"
BUN = "/opt/homebrew/bin/bun"
NODE_BIN = "/Users/lbrevoort/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin"
STAGE_CAP = 30
WORK_CAP = 90


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT, timeout=5).decode().strip()


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def interrupted(signum, _frame):
    raise InterruptedError(f"Owned baseline interrupted by signal {signum}")


def summary(log):
    import re
    # Direct bun test, not workspace-prefixed output. Require exactly one complete summary.
    found = {}
    for label in ["pass", "fail", "expect() calls"]:
        values = re.findall(r"^\s*(\d+) " + re.escape(label) + r"\s*$", log, re.MULTILINE)
        if len(values) == 1:
            found[label] = int(values[0])
    return found


def validate_receipts(records):
    pre = [r for r in records if r.get("name") == "preconditions-complete"]
    controls = [r for r in records if r.get("name") == "request-control"]
    readonly = [r for r in records if r.get("name") == "actual-query-read-only-control"]
    cleanup = [r for r in records if r.get("name") == "owned-fixture-cleanup"]
    if len(pre) != 1 or pre[0].get("complete") is not True or not pre[0].get("cookieAndMobileBOwnScopePositive"):
        raise RuntimeError("SETUP/CONTROL FAILURE: real authenticated/query/source preconditions incomplete")
    if sorted(row["effective"] for row in pre[0]["sourceStates"]) != ["important", "not_important", "unreviewed"]:
        raise RuntimeError("SETUP/CONTROL FAILURE: actual importance source witnesses absent")
    if len(controls) < 12 or any(not r.get("noCommittedWrites") or not r.get("stateUnchanged") or any(r.get("providerCalls", {}).values()) for r in controls):
        raise RuntimeError("SETUP/CONTROL FAILURE: committed-write/source/provider controls incomplete")
    if len(readonly) != 1 or readonly[0].get("queryOnly") != 1 or readonly[0].get("connectionTotalChanges") != 0 or not readonly[0].get("rejectedUpdate"):
        raise RuntimeError("SETUP/CONTROL FAILURE: actual query-only transaction control missing")
    if len(cleanup) != 1 or cleanup[0].get("removed") is not True:
        raise RuntimeError("SETUP/CONTROL FAILURE: fixture cleanup receipt absent")
    return pre[0]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--head", required=True, help="ROOT-inspected exact clean frozen test-only SHA")
    parser.add_argument("output", type=Path, help="fresh external evidence directory")
    args = parser.parse_args()
    evidence = args.output.resolve()
    if evidence.exists() or evidence == ROOT or ROOT in evidence.parents:
        raise SystemExit("A fresh evidence path outside the checkout is required")
    # Require the lock descriptor passed by the actual shared wrapper, not a guessed environment flag.
    slot = Path("/tmp/orca-ui-heavy-slot.lock").stat()
    inherited = []
    for entry in Path("/dev/fd").iterdir():
        try:
            fd = int(entry.name)
            info = os.fstat(fd)
            if fd > 2 and (info.st_dev, info.st_ino) == (slot.st_dev, slot.st_ino):
                inherited.append(fd)
        except (ValueError, OSError):
            pass
    if not inherited:
        raise SystemExit("NOT STARTED: must run beneath /tmp/orca-ui-heavy-slot.py with inherited lock FD")
    if git("rev-parse", "HEAD") != args.head or git("status", "--porcelain"):
        raise SystemExit("NOT STARTED: exact frozen clean HEAD required")
    if git("branch", "--show-current") != BRANCH or git("merge-base", BASE, args.head) != BASE:
        raise SystemExit("NOT STARTED: this test-only branch must descend from exact main7c")
    changed = git("diff", "--name-only", BASE, args.head).splitlines()
    if not changed or any(path not in [TEST, FIXTURE] and not path.startswith(DOCS) for path in changed):
        raise SystemExit("NOT STARTED: unexpected baseline patch path")
    for directory in [ROOT, ROOT / "apps/api"]:
        if any((directory / name).exists() for name in [".env", ".env.local", ".env.test", ".env.test.local"]):
            raise SystemExit("NOT STARTED: refusing implicit environment-file loading")
    evidence.mkdir()
    scratch = evidence / "owned-scratch"
    scratch.mkdir()
    started = time.monotonic()
    manifest = {
        "base": BASE, "testedHead": args.head, "branch": BRANCH, "sourceCleanBefore": True,
        "kind": "TEST-ONLY additive importance/owner-precondition baseline; no endpoint absence or old UI bug claim",
        "driverSha256": sha(Path(__file__)), "wrapperSha256": sha(Path("/tmp/orca-ui-heavy-slot.py")),
        "inheritedWrapperLockFds": inherited, "stageCapSeconds": STAGE_CAP, "workCapSeconds": WORK_CAP,
        "plannedCounts": {"controls": {"pass": 1, "fail": 0}, "extension": {"pass": 0, "fail": 5}},
        "stages": [], "overallExit": 2, "classification": "NOT CLASSIFIED", "startedAt": time.time(),
    }
    env = {key: os.environ[key] for key in ["HOME", "USER", "LOGNAME", "SHELL", "TERM"] if key in os.environ}
    env.update({"PATH": f"{NODE_BIN}:/opt/homebrew/bin:/usr/bin:/bin", "TMPDIR": str(scratch), "LANG": "en_US.UTF-8", "CI": "true"})

    def save():
        (evidence / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")

    def stage(name):
        elapsed = time.monotonic() - started
        remaining = min(STAGE_CAP, WORK_CAP - elapsed)
        if remaining <= 0:
            raise TimeoutError("Work budget exhausted; not a regression result")
        log_path, receipts_path = evidence / f"{name}.log", evidence / f"{name}.jsonl"
        stage_scratch = scratch / name
        stage_scratch.mkdir()
        command = [BUN, "test", TEST, "--timeout", "15000"]
        manifest["stageInProgress"] = {"name": name, "command": command, "hardCapSeconds": remaining,
            "log": str(log_path), "receipts": str(receipts_path)}
        save()
        print(f"BRE457_IMPORTANCE starting {name}; hardcap={remaining:.1f}s; no install/types/build", flush=True)
        begin = time.monotonic()
        child = None
        try:
            with log_path.open("w") as log:
                child = subprocess.Popen(command, cwd=ROOT, env={**env,
                    "BRE457_IMPORTANCE_STAGE": name, "BRE457_IMPORTANCE_RECEIPTS": str(receipts_path),
                    "BRE457_IMPORTANCE_SCRATCH": str(stage_scratch)}, stdout=log, stderr=subprocess.STDOUT,
                    start_new_session=True, close_fds=False)
                while True:
                    left = remaining - (time.monotonic() - begin)
                    if left <= 0:
                        raise TimeoutError(f"{name} hard cap reached; not a regression result")
                    try:
                        code = child.wait(timeout=min(15, left))
                        break
                    except subprocess.TimeoutExpired:
                        print(f"BRE457_IMPORTANCE {name} elapsed={time.monotonic() - begin:.1f}s; owned pid={child.pid}", flush=True)
        finally:
            if child is not None and child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait(timeout=5)
        record = {"name": name, "command": command, "rawExit": code, "seconds": time.monotonic() - begin,
            "logSha256": sha(log_path), "summary": summary(log_path.read_text(errors="replace")),
            "receiptsSha256": sha(receipts_path) if receipts_path.exists() else None}
        manifest["stages"].append(record)
        manifest.pop("stageInProgress", None)
        save()
        print(f"BRE457_IMPORTANCE finished {name}; rawExit={code}; actualSeconds={record['seconds']:.3f}", flush=True)
        records = [json.loads(line) for line in receipts_path.read_text().splitlines()] if receipts_path.exists() else []
        preconditions = validate_receipts(records)
        if list(stage_scratch.iterdir()):
            raise RuntimeError("Owned fixture left scratch files; inspect before any result claim")
        return code, record["summary"], records, preconditions

    try:
        manifest["bun"] = subprocess.check_output([BUN, "--version"], cwd=ROOT, env=env, text=True, timeout=5).strip()
        manifest["node"] = subprocess.check_output([f"{NODE_BIN}/node", "--version"], cwd=ROOT, env=env, text=True, timeout=5).strip()
        if manifest["bun"] != "1.3.14" or manifest["node"] != "v24.22.1":
            raise RuntimeError("SETUP FAILURE: pinned runtime mismatch")
        code, counts, records, _ = stage("controls")
        if code != 0 or counts.get("pass") != 1 or counts.get("fail") != 0 or counts.get("expect() calls", 0) != 0:
            raise RuntimeError("CONTROL FAILURE/usage output: inspect raw controls; no extension run")
        if len([r for r in records if r.get("name") == "controls-test-complete"]) != 1:
            raise RuntimeError("CONTROL FAILURE: named control test did not complete")
        if git("rev-parse", "HEAD") != args.head or git("status", "--porcelain"):
            raise RuntimeError("SOURCE DRIFT: do not run extension stage")
        code, counts, records, pre = stage("extension")
        projections = [r for r in records if r.get("name") == "extension-projection"]
        fences = [r for r in records if r.get("name") == "extension-owner-fence"]
        projection_red = len(projections) == 1 and projections[0].get("actualStatus") == 200 and projections[0].get("actualRows") == 3 and len(projections[0].get("missingImportanceThreads", [])) == 3 and projections[0].get("queryId") == pre["queryU"]["id"]
        scopes = {(r.get("kind"), r.get("surface")) for r in fences}
        fence_red = len(fences) == 4 and scopes == {(kind, surface) for kind in ["cookie", "mobile"] for surface in ["catalog", "results"]}
        for record in fences:
            scope = record.get("observedScope", {})
            is_b = scope.get("workspaceId") == "bre457-importance-user-B" if record.get("surface") == "catalog" else scope.get("query", {}).get("id") == pre["queryB"]["id"] and scope.get("query", {}).get("accountId") == pre["queryB"]["accountId"]
            fence_red = fence_red and record.get("actualStatus") == 200 and is_b
        if code == 1 and counts.get("pass") == 0 and counts.get("fail") == 5 and projection_red and fence_red:
            manifest.update({"overallExit": 1, "classification": "ACTUAL EXPECTED EXTENSION RED: one missing importance projection + four absent original-owner preconditions", "semanticComparisonCount": 5})
        else:
            manifest.update({"overallExit": 2, "classification": "INCONCLUSIVE/UNEXPECTED: raw failures or green/mixed outcome do not match the planned baseline"})
    except BaseException as error:
        manifest.update({"overallExit": 2, "classification": "SETUP/CONTROL/TIMEOUT/INTERRUPTION FAILURE, NOT REGRESSION RED", "error": f"{type(error).__name__}: {error}"})
    finally:
        # Only this fresh evidence directory's own fixture scratch; never shared data/processes.
        try:
            shutil.rmtree(scratch)
        except OSError as error:
            manifest.update({"overallExit": 2, "classification": "OWNED CLEANUP FAILURE: no baseline verdict", "cleanupError": str(error)})
        manifest["ownedScratchRemoved"] = not scratch.exists()
        try:
            manifest["finalHead"] = git("rev-parse", "HEAD")
            manifest["finalStatus"] = git("status", "--porcelain")
        except (OSError, subprocess.SubprocessError) as error:
            manifest["finalHead"], manifest["finalStatus"] = None, "UNOBSERVED"
            manifest["finalGitError"] = str(error)
        manifest["wallSeconds"] = time.monotonic() - started
        if manifest["finalHead"] != args.head or manifest["finalStatus"]:
            manifest.update({"overallExit": 2, "classification": "SOURCE DRIFT: no baseline verdict"})
        manifest["rawArtifacts"] = [{"path": path.name, "bytes": path.stat().st_size, "sha256": sha(path)}
            for path in sorted(evidence.iterdir()) if path.is_file() and path.name != "manifest.json"]
        save()
        print(f"BRE457_IMPORTANCE terminal exit={manifest['overallExit']} classification={manifest['classification']}; evidence={evidence}", flush=True)
    return manifest["overallExit"]


if __name__ == "__main__":
    for sig in [signal.SIGTERM, signal.SIGINT]:
        signal.signal(sig, interrupted)
    raise SystemExit(main())
