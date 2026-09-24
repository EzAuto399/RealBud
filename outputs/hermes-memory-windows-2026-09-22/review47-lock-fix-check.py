"""Synthetic verification of the owner's narrow lock-redaction fix."""
from pathlib import Path
import contextlib,importlib.util,json,types,hashlib
root=Path(__file__).resolve().parents[2]; path=root/'server/helpers/hermes-memory-windows.py'
spec=importlib.util.spec_from_file_location('review47_lock_fix',path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class FixedError(Exception):
 def __init__(self,code): self.code=code;super().__init__(code)
def storage(lock): return module.WindowsMemoryStorage(r'C:\Fictional\Profile',native=types.SimpleNamespace(error_type=FixedError),mutation_lock=lock)
@contextlib.contextmanager
def fail_enter():
 raise OSError('synthetic-private-lock-path')
 yield
@contextlib.contextmanager
def fail_exit():
 yield
 raise OSError('synthetic-private-lock-path')
@contextlib.contextmanager
def native_conflict():
 raise FixedError('conflict')
 yield
checks=[]
for label,lock,expected in [('enter',fail_enter,'unavailable'),('exit',fail_exit,'unavailable'),('recognized-code',native_conflict,'conflict')]:
 try:
  with storage(lock)._mutation(): pass
  raise AssertionError('lock unexpectedly succeeded')
 except FixedError as error:
  assert error.code==expected and str(error)==expected and error.__suppress_context__
  checks.append({'case':label,'passed':True,'fixedCode':error.code,'contextSuppressed':True})
try: storage(fail_enter).write_new(r'C:\Fictional\Profile\stage.bin',b'fictional')
except FixedError as error:
 assert error.code=='unavailable';checks.append({'case':'public-write-entry','passed':True,'fixedCode':error.code})
else: raise AssertionError('public write unexpectedly succeeded')
receipt={'sourceSha256':hashlib.sha256(path.read_bytes()).hexdigest(),'checks':checks,'passed':len(checks),'WindowsExecuted':False,'realProfilesAccessed':False}
(root/'outputs/hermes-memory-windows-2026-09-22/review47-lock-fix-check.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt))
