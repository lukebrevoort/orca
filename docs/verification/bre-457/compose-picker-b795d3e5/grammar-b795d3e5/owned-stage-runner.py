class GateInterrupted(BaseException):
 def __init__(self, signum): self.signum = signum
def run(name, command, stage_cap):
 remaining = cap - (time.monotonic()-start)
 if remaining <= 0: return 124
 stage = {'stage':name,'command':command,'exit':2,'timeout':False,'cleanup':'not-started'}
 receipt['stages'].append(stage)
 process = None; code = 2; phase = 'starting'; pending_signal = None
 previous = {sig:signal.getsignal(sig) for sig in (signal.SIGTERM,signal.SIGINT)}
 def interrupted(signum, frame):
  nonlocal pending_signal, phase
  if pending_signal is None: pending_signal = signum
  # A signal may arrive before Popen returns its handle or while cleanup
  # waits. Defer it until we own the handle; cleanup must never re-enter.
  if phase == 'waiting':
   phase = 'cleanup'
   raise GateInterrupted(pending_signal)
 try:
  for sig in previous: signal.signal(sig, interrupted)
  with (out/(name+'.log')).open('w') as log:
   # Retain the inherited slot descriptor until the recorded group is gone.
   process = subprocess.Popen(command, cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True, close_fds=False)
   stage['ownedPidAndPgid'] = process.pid
   phase = 'waiting'
   if pending_signal is not None:
    phase = 'cleanup'
    raise GateInterrupted(pending_signal)
   try: code = process.wait(timeout=min(stage_cap,remaining))
   except subprocess.TimeoutExpired:
    stage['timeout'] = True; code = 124
   finally: phase = 'cleanup'
 except GateInterrupted as error:
  phase = 'cleanup'; code = 128 + error.signum
  raise
 except BaseException as error:
  phase = 'cleanup'; stage['exception'] = type(error).__name__ + ': ' + str(error)
  raise
 finally:
  phase = 'cleanup'
  try:
   if process is not None:
    # Existing run.py/probe finally blocks get a cooperative cleanup window.
    try: os.killpg(process.pid, signal.SIGINT); stage['cleanup'] = 'interrupt-sent'
    except ProcessLookupError: stage['cleanup'] = 'already-terminal'
    try: process.wait(timeout=3)
    except subprocess.TimeoutExpired:
     try: os.killpg(process.pid, signal.SIGKILL)
     except ProcessLookupError: pass
     process.wait(timeout=1); stage['escalated'] = True
    try:
     os.killpg(process.pid, 0)
     os.killpg(process.pid, signal.SIGKILL)
     stage['cleanupFailure'] = 'Owned stage group remained after direct-child wait'
    except ProcessLookupError: stage['cleanup'] = 'terminal'
  except BaseException as error:
   stage['cleanupFailure'] = type(error).__name__ + ': ' + str(error)
   raise
  finally:
   if pending_signal is not None:
    code = 128 + pending_signal; stage['interruptedSignal'] = pending_signal
   stage['exit'] = code; stage['elapsedSeconds'] = time.monotonic()-start
   for sig, handler in previous.items(): signal.signal(sig, handler)
 # Also preserve cancellation that first arrived during normal/timeout cleanup.
 if pending_signal is not None: raise GateInterrupted(pending_signal)
 return code