"""Bounded Linux checks: strict gates and killing children after parent failure."""
import importlib.util
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
