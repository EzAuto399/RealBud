"""Review probes only. Synthetic data, no Win32/native/profile execution."""
from pathlib import Path
import contextlib,importlib.util,json,types,hashlib
root=Path(__file__).resolve().parents[2]
path=root/'server/helpers/hermes-memory-windows.py'
spec=importlib.util.spec_from_file_location('review47_protocol_probe',path)
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class FixedError(Exception):
 def __init__(self,code): self.code=code;super().__init__(code)
@contextlib.contextmanager
def failing_native_lock():
 raise OSError('synthetic-private-lock-path')
 yield
storage=module.WindowsMemoryStorage(r'C:\Fictional\Profile',native=types.SimpleNamespace(error_type=FixedError),mutation_lock=failing_native_lock)
try:
 storage.write_new(r'C:\Fictional\Profile\stage.bin',b'fictional')
 result={'probe':'mutation_lock_exception_redaction','unexpectedSuccess':True}
except Exception as error:
 result={'probe':'mutation_lock_exception_redaction','errorClass':type(error).__name__,'isFixedError':isinstance(error,FixedError),'syntheticSentinelEscaped':str(error)=='synthetic-private-lock-path'}
result.update({'sourceSha256':hashlib.sha256(path.read_bytes()).hexdigest(),'WindowsExecuted':False,'realProfilesAccessed':False})
(root/'outputs/hermes-memory-windows-2026-09-22/review47-local-checks.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
