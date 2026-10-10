#!/usr/bin/env python3
"""Offline, bounded paired benchmark; requires installed lockfile dependencies.

Does not fetch, activate services, migrate a real mailbox, or change durability.
Archives immutable sources and gives each its own @orca workspace resolution.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[3]
HARNESS = ROOT / "apps/api/benchmarks/search-stage.ts"
REVISIONS = {
    "base": "6ac83d1ae1bed08dd5d380774667b03d5dffe55b",
    "head": "067cceea7b826ba47872660732acef6bf5dfe1f3",
}
OUTPUT = ROOT / "docs/search/performance-evidence"


def main():
    OUTPUT.mkdir(exist_ok=True)
    if list(OUTPUT.glob("trial-*.json")):
        raise SystemExit("Refusing to overwrite existing trial evidence; use a fresh checkout")
    bun = shutil.which("bun")
    assert bun, "Bun 1.3.14 required"
    assert subprocess.check_output([bun, "--version"], text=True).strip() == "1.3.14"
    dependencies = ROOT / "node_modules"
    assert dependencies.is_dir(), "Install dependencies using bun install --frozen-lockfile first"
    runs = []
    start = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="orca-search-comparison-") as temporary:
        for mode, revision in REVISIONS.items():
            exported = Path(temporary) / mode
            exported.mkdir()
            archive = subprocess.run(["git", "archive", revision], cwd=ROOT, check=True, capture_output=True).stdout
            subprocess.run(["tar", "-x", "-C", str(exported)], input=archive, check=True)
            assert (exported / "bun.lock").read_bytes() == (ROOT / "bun.lock").read_bytes()
            modules = exported / "node_modules"
            modules.mkdir()
            for entry in dependencies.iterdir():
                if entry.name != "@orca":
                    (modules / entry.name).symlink_to(entry, target_is_directory=entry.is_dir())
            scope = modules / "@orca"
            scope.mkdir()
            for name, relative in [("shared", "packages/shared"), ("api", "apps/api"), ("web", "apps/web")]:
                (scope / name).symlink_to(exported / relative, target_is_directory=True)
        for trial in range(1, 5):
            for size in [1000, 5000, 10000]:
                pair = {}
                for mode in (["base", "head"] if trial % 2 else ["head", "base"]):
                    if time.monotonic() - start > 900:
                        raise TimeoutError("15-minute total budget exhausted")
                    output = OUTPUT / f"trial-{trial}-{size}-{mode}.json"
                    command = [bun, str(HARNESS), f"--root={Path(temporary) / mode}",
                               f"--revision={REVISIONS[mode]}", f"--mode={mode}",
                               f"--size={size}", "--samples=20", f"--output={output}"]
                    print(f"Trial {trial}/4 · {size} messages · {mode}", flush=True)
                    subprocess.run(command, cwd=Path(temporary) / mode, check=True, timeout=90,
                                   env={**os.environ, "TMPDIR": temporary})
                    pair[mode] = json.loads(output.read_text())
                    runs.append({"trial": trial, "size": size, "mode": mode, "file": output.name})
                assert pair["base"]["signatures"] == pair["head"]["signatures"], "Results differ between revisions"
                for stage in ["seededDisk", "checkpointedDisk"]:
                    assert pair["base"]["disk"][stage] == pair["head"]["disk"][stage], "Unexpected storage difference"
    (OUTPUT / "manifest.json").write_text(json.dumps({
        "revisions": REVISIONS, "harnessSha256": hashlib.sha256(HARNESS.read_bytes()).hexdigest(),
        "trials": 4, "samplesPerWorkloadPerTrial": 20, "warmups": 3,
        "maxChildSeconds": 90, "maxSchedulingSeconds": 900,
        "elapsedSeconds": time.monotonic() - start, "runs": runs,
        "allResultSignaturesEqual": True, "allSeededAndCheckpointedDiskSizesEqual": True,
    }, indent=2) + "\n")


if __name__ == "__main__":
    main()
