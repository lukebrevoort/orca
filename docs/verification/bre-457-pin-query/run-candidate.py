#!/usr/bin/env python3
"""A single ROOT-allocated candidate gate; no install, retries, or full-repo checks."""
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[3]
BASELINE = "1f9bbc979681c8bf5e5c3c10fd8704a26a8f1e2b"
BUN = "/opt/homebrew/bin/bun"
NODE_BIN = "/Users/lbrevoort/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin"
TYPE_SHA = "b5a907deaba678e5083ccdd7cc063a3a8c3413c688098f6de29d6e4cefabc85f"


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True, timeout=10).strip()


def typecheck_command(workspace):
    if workspace not in ("packages/shared", "apps/api"):
        raise ValueError("Unknown typecheck workspace")
    # Invoke the pinned installed compiler directly. Bun's alternate --cwd/run
    # order can print usage and return0 without running the package script.
    return [f"{NODE_BIN}/node", str(ROOT / "node_modules/typescript/bin/tsc"),
            "--project", str(ROOT / workspace / "tsconfig.json"), "--pretty", "false"]


def checked_type_exit(code, output):
    # Preserve real compiler failures; usage-only0 is never a typecheck pass.
    usage = "Usage: bun" in output or "tsc: The TypeScript Compiler" in output
    return 2 if code == 0 and usage else code


def main():
    type_only = len(sys.argv) == 4 and sys.argv[3] == "--types-only"
    if len(sys.argv) != 3 and not type_only:
        raise SystemExit("ROOT allocation required: run-candidate.py NEW_EVIDENCE_DIRECTORY EXACT_HEAD_SHA [--types-only]")
    evidence = Path(sys.argv[1]).resolve()
    head = git("rev-parse", "HEAD")
    if head != sys.argv[2] or git("status", "--porcelain"):
        raise SystemExit("Candidate must be the requested exact clean committed SHA")
    subprocess.run(["git", "merge-base", "--is-ancestor", BASELINE, head], cwd=ROOT, check=True, timeout=10)
    allowed = (
        "apps/api/src/organization/collections-pins/", "apps/api/src/mailbox/read.ts",
        "packages/shared/src/organization-saved-query-results", "packages/shared/src/index.ts",
        "docs/verification/bre-457-pin-query/",
    )
    changed = git("diff", "--name-only", BASELINE, head).splitlines()
    if not changed or any(not path.startswith(allowed) for path in changed):
        raise SystemExit("Candidate changes exceed the assigned API/shared/evidence ownership")
    if evidence.exists() or ROOT in evidence.parents or evidence == ROOT:
        raise SystemExit("Evidence must be a new directory outside the checkout")
    for directory in [ROOT, ROOT / "apps/api"]:
        for name in [".env", ".env.local", ".env.test", ".env.test.local"]:
            if (directory / name).exists():
                raise SystemExit(f"Refusing automatic environment-file loading: {directory / name}")
    evidence.mkdir(parents=True)
    manifest = {"testedHead": head, "endpointAbsenceBaseline": BASELINE,
                "kind": "actual type-only correction; no semantic/demo repeat" if type_only else "first executed candidate semantics; not semantic red-to-green",
                "startedAt": time.time(), "stages": []}
    env = {key: os.environ[key] for key in ["HOME", "USER", "LOGNAME", "SHELL", "TERM"] if key in os.environ}
    env.update({"PATH": f"{NODE_BIN}:/opt/homebrew/bin:/usr/bin:/bin", "TMPDIR": "/private/tmp", "LANG": "en_US.UTF-8", "CI": "true", "BRE457_QUERY_STAGE": "candidate"})

    def stage(name, command, timeout, extra=None):
        print(f"BRE457 starting {name}; timeout={timeout}s", flush=True)
        started = time.monotonic()
        with (evidence / f"{name}.log").open("w") as output:
            child = subprocess.Popen(command, cwd=ROOT, env={**env, **(extra or {})}, stdout=output, stderr=subprocess.STDOUT, start_new_session=True, close_fds=False)
            try:
                code = child.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                code = 124
            finally:
                if child.poll() is None:
                    os.killpg(child.pid, signal.SIGTERM)
                    try:
                        child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        os.killpg(child.pid, signal.SIGKILL)
                        child.wait(timeout=5)
        if name.endswith("-types"):
            checked = checked_type_exit(code, (evidence / f"{name}.log").read_text())
            if checked != code:
                with (evidence / f"{name}.log").open("a") as output:
                    output.write("\nType gate rejected usage-only0: compiler execution was not established.\n")
                code = checked
        manifest["stages"].append({"name": name, "command": command, "exitCode": code, "seconds": time.monotonic() - started})
        (evidence / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        print(f"BRE457 finished {name}; exit={code}", flush=True)
        return code

    try:
        manifest["bun"] = subprocess.check_output([BUN, "--version"], cwd=ROOT, env=env, text=True, timeout=10).strip()
        manifest["node"] = subprocess.check_output([f"{NODE_BIN}/node", "--version"], cwd=ROOT, env=env, text=True, timeout=10).strip()
        types = ROOT / "node_modules/bun-types/sqlite.d.ts"
        manifest["sqliteTypeProof"] = {"path": str(types), "sha256": hashlib.sha256(types.read_bytes()).hexdigest(), "packageVersion": json.loads((types.parent / "package.json").read_text())["version"]}
        if manifest["bun"] != "1.3.14" or manifest["sqliteTypeProof"]["sha256"] != TYPE_SHA:
            raise RuntimeError("Pinned runtime/local SQLite type proof changed; inspect before execution")
        compiler = ROOT / "node_modules/typescript/bin/tsc"
        manifest["compiler"] = {"entry": str(compiler), "sha256": hashlib.sha256(compiler.read_bytes()).hexdigest(),
                                "version": json.loads((compiler.parent.parent / "package.json").read_text())["version"]}
        stages = [
            ("focused-tests", [BUN, "test", "apps/api/src/organization/collections-pins/query-results.test.ts", "apps/api/src/mailbox/read.test.ts", "packages/shared/src/organization-saved-query-results.test.ts", "packages/shared/src/organization-collections-pins.test.ts"], 90, {"BRE457_RECEIPTS": str(evidence / "candidate.jsonl")}),
            ("shared-types", typecheck_command("packages/shared"), 60, None),
            ("api-types", typecheck_command("apps/api"), 90, None),
            ("http-sqlite-demo", [BUN, "docs/verification/bre-457-pin-query/candidate-demo.ts", str(evidence / "demo-work.json")], 60, {"BRE457_RECEIPTS": str(evidence / "demo.jsonl")}),
        ]
        if type_only:
            stages = [stage for stage in stages if stage[0].endswith("-types")]
        for name, command, timeout, extra in stages:
            code = stage(name, command, timeout, extra)
            if code:
                return code
        return 0
    finally:
        manifest["finishedAt"] = time.time()
        manifest["finalHead"] = git("rev-parse", "HEAD")
        manifest["finalStatus"] = git("status", "--porcelain")
        manifest["sourceStateMatched"] = manifest["finalHead"] == head and not manifest["finalStatus"]
        manifest["sourceStateExit"] = 0 if manifest["sourceStateMatched"] else 2
        (evidence / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        print(f"BRE457 raw candidate evidence: {evidence}", flush=True)
        if not manifest["sourceStateMatched"]:
            raise SystemExit(2)


if __name__ == "__main__":
    def interrupted(signum, frame):
        raise InterruptedError(f"Candidate runner interrupted by signal {signum}")
    signal.signal(signal.SIGTERM, interrupted)
    raise SystemExit(main())
