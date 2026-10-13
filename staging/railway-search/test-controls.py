"""Bounded Linux checks: strict gates and killing children after parent failure."""
import importlib.util
import copy
import gzip
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time

spec = importlib.util.spec_from_file_location("runner", Path(__file__).with_name("run.py"))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
with tempfile.TemporaryDirectory() as tmp:
    pidfile = Path(tmp) / "pid"
    source = "import subprocess,sys; p=subprocess.Popen([sys.executable,'-c','import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(30)']); open(sys.argv[1],'w').write(str(p.pid))"
    child = subprocess.Popen([sys.executable, "-c", source, str(pidfile)], start_new_session=True)
    child.wait(timeout=3)
    pid = int(pidfile.read_text())
    runner.terminate(child)
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        stat = Path(f"/proc/{pid}/stat")
        if not stat.exists() or stat.read_text().rsplit(")", 1)[1].split()[0] == "Z":
            break
        time.sleep(.05)
    else:
        raise AssertionError("Surviving grandchild after parent exit")
before = {"signatures": {}, "mixed": None, "results": {"legacy-common": {"summaryMs": {"p95": 100}}}}
after = {"signatures": {}, "mixed": None, "results": {"legacy-common": {"summaryMs": {"p95": 126}}}}
try:
    runner.paired(before, after)
except AssertionError:
    pass
else:
    raise AssertionError("Regression gate not enforced")
after["results"]["legacy-common"]["summaryMs"]["p95"] = 125
runner.paired(before, after)
print("PASS: orphan process group terminated; relative p95 bound enforced")

# Retained real same-revision evidence must prevent candidate admission.
evidence = Path(__file__).resolve().parents[2] / "docs/search/railway-preparation-20261013/diagnostics"
first = json.loads(gzip.decompress((evidence / "same-candidate-1.json.gz").read_bytes()))
repeat = json.loads(gzip.decompress((evidence / "same-candidate-2.json.gz").read_bytes()))
called = []
for a, b in [(first, repeat), (repeat, first)]:
    try:
        runner.admitted_candidate(a, lambda: b, lambda: called.append("candidate"))
    except runner.UnstableBaseline:
        pass
    else:
        raise AssertionError("Known unstable identical-source controls admitted candidate")
assert called == []

# Exact boundary passes in both directions; crossing it must still stop.
a = copy.deepcopy(first)
for item in a["results"].values():
    item["summaryMs"]["p95"] = 100
b = copy.deepcopy(a)
b["results"]["legacy-common"]["summaryMs"]["p95"] = 125
for before, after in [(a, b), (b, a)]:
    result, proof = runner.admitted_candidate(before, lambda: after, lambda: "ran")
    assert result == "ran" and proof["passed"]
b["results"]["legacy-common"]["summaryMs"]["p95"] = 125.01
for before, after in [(a, b), (b, a)]:
    try:
        runner.baseline_stability(before, after)
    except runner.UnstableBaseline:
        pass
    else:
        raise AssertionError("Symmetric boundary exceeded without rejection")

for key in ["revision", "signatures", "connections", "disk"]:
    mismatched = copy.deepcopy(a)
    mismatched[key] = None
    try:
        runner.baseline_stability(a, mismatched)
    except AssertionError:
        pass
    else:
        raise AssertionError(f"Mismatched {key} accepted")
mismatched = copy.deepcopy(a)
del mismatched["results"]["legacy-common"]
try:
    runner.baseline_stability(a, mismatched)
except AssertionError:
    pass
else:
    raise AssertionError("Missing workload accepted")
print("PASS: real A/A instability blocks candidate; symmetric boundaries and identity checks enforced")

# Preserve successful admission evidence even when the candidate fails.
recorded = []
def failing_candidate():
    assert recorded and recorded[0]["passed"]
    raise RuntimeError("candidate failed")
try:
    runner.admitted_candidate(a, lambda: a, failing_candidate, recorded.append)
except RuntimeError as error:
    assert str(error) == "candidate failed"
else:
    raise AssertionError("Candidate failure swallowed")
assert len(recorded) == 1
print("PASS: admission proof retained before candidate failure")
