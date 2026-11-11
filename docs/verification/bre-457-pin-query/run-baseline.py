#!/usr/bin/env python3
"""Run ONLY under the ROOT-allocated heavy wrapper; preserve expected-red exits."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

BASE = "a6a8567e81dab98d7ee50b6ec263d94266ac3009"
ROOT = Path(__file__).resolve().parents[3]
TEST = "apps/api/src/organization/collections-pins/query-results.test.ts"
NODE_BIN = "/Users/lbrevoort/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin"
BUN = "/opt/homebrew/bin/bun"
ALLOWED = {
    TEST,
    "apps/api/src/organization/collections-pins/query-results.fixture.ts",
    "docs/verification/bre-457-pin-query/README.md",
    "docs/verification/bre-457-pin-query/run-baseline.py",
}


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True, timeout=10).strip()


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage (ROOT allocation required): run-baseline.py NEW_EVIDENCE_DIRECTORY")
    evidence = Path(sys.argv[1]).resolve()
    if evidence.exists() or ROOT in evidence.parents or evidence == ROOT:
        raise SystemExit("Evidence must be a new directory outside this checkout")
    if git("status", "--porcelain"):
        raise SystemExit("Baseline execution requires a clean committed checkout")
    head = git("rev-parse", "HEAD")
    if git("rev-parse", "HEAD^") != BASE:
        raise SystemExit("The immutable test-only baseline must be a direct child of exact a6a8567")
    changed = set(git("diff", "--name-only", BASE, head).splitlines())
    if not changed or not changed <= ALLOWED:
        raise SystemExit(f"Unexpected baseline patch paths: {sorted(changed - ALLOWED)}")
    for directory in [ROOT, ROOT / "apps/api"]:
        for filename in [".env", ".env.local", ".env.test", ".env.test.local"]:
            if (directory / filename).exists():
                raise SystemExit(f"Refusing automatic environment-file loading: {directory / filename}")
    evidence.mkdir(parents=True)
    manifest = {"base": BASE, "testedHead": head, "kind": "test-only missing-route baseline", "stages": [], "startedAt": time.time()}
    # Do not inherit provider/OAuth credentials. Sessions/crypto are synthetic in the fixture.
    env = {key: os.environ[key] for key in ["HOME", "USER", "LOGNAME", "SHELL", "TERM"] if key in os.environ}
    env.update({"PATH": f"{NODE_BIN}:/opt/homebrew/bin:/usr/bin:/bin", "TMPDIR": "/private/tmp", "LANG": "en_US.UTF-8", "CI": "true"})

    def stage(name, command, timeout, extra=None):
        started = time.monotonic()
        print(f"BRE457 starting {name}; timeout={timeout}s", flush=True)
        with (evidence / f"{name}.log").open("w") as output:
            child = subprocess.Popen(command, cwd=ROOT, env={**env, **(extra or {})}, stdout=output, stderr=subprocess.STDOUT, start_new_session=True, close_fds=False)
            try:
                code = child.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                code = 124
            finally:
                # Only this stage's newly owned process group. Preserve the outer
                # wrapper lock FD in children so an interruption cannot free the
                # slot while an install/test process is still alive.
                if child.poll() is None:
                    os.killpg(child.pid, signal.SIGTERM)
                    try:
                        child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        os.killpg(child.pid, signal.SIGKILL)
                        child.wait(timeout=5)
        manifest["stages"].append({"name": name, "command": command, "exitCode": code, "seconds": time.monotonic() - started})
        (evidence / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        print(f"BRE457 finished {name}; exit={code}", flush=True)
        return code

    try:
        version = subprocess.check_output([BUN, "--version"], cwd=ROOT, env=env, text=True, timeout=10).strip()
        manifest["bun"] = version
        manifest["node"] = subprocess.check_output([f"{NODE_BIN}/node", "--version"], cwd=ROOT, env=env, text=True, timeout=10).strip()
        if version != "1.3.14":
            raise RuntimeError(f"Required Bun 1.3.14; found {version}")
        code = stage("frozen-install", [BUN, "install", "--frozen-lockfile"], 180)
        if code:
            return code
        if git("status", "--porcelain"):
            raise RuntimeError("Frozen installation changed tracked/unignored checkout state")
        code = stage("baseline", [BUN, "test", TEST], 60, {
            "BRE457_QUERY_STAGE": "baseline", "BRE457_RECEIPTS": str(evidence / "baseline.jsonl"),
        })
        if code:
            return code
        code = stage("candidate-red", [BUN, "test", TEST], 90, {
            "BRE457_QUERY_STAGE": "candidate", "BRE457_RECEIPTS": str(evidence / "candidate-red.jsonl"),
        })
        records_path = evidence / "candidate-red.jsonl"
        records = [json.loads(line) for line in records_path.read_text().splitlines()] if records_path.exists() else []
        manifest["candidateRoute404Receipts"] = sum(record.get("expectedStatus") == 200 and record.get("actualStatus") == 404 for record in records)
        manifest["candidateSemanticExecutions"] = sum(record.get("semanticsExecuted") is True for record in records)
        manifest["interpretation"] = (
            "Authenticated missing-route baseline established; candidate tests failed before semantic evaluation."
            if code == 1 and manifest["candidateRoute404Receipts"] > 0 and manifest["candidateSemanticExecutions"] == 0
            else "Inspect raw logs/receipts; do not infer expected-red evidence from the exit code alone."
        )
        # An expected red remains a nonzero run, never a green usage/status exit.
        return code if code else 2
    finally:
        manifest["finishedAt"] = time.time()
        manifest["finalHead"] = git("rev-parse", "HEAD")
        manifest["finalStatus"] = git("status", "--porcelain")
        (evidence / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        print(f"BRE457 raw evidence: {evidence}", flush=True)


if __name__ == "__main__":
    def interrupted(signum, frame):
        raise InterruptedError(f"Baseline runner interrupted by signal {signum}")
    signal.signal(signal.SIGTERM, interrupted)
    raise SystemExit(main())
