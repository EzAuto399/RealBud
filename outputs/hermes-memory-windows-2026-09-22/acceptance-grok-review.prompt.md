Review the supplied Windows-native acceptance harness against the supplied exact backend API. This is a source-only independent review. Return the requested structured JSON, concise actionable findings only. No tools, web, subagents, source edits, or execution. Focus on test correctness: false passes/failures, Windows sharing semantics, no-clobber/replace byte and identity assertions, ACL mutation/refusal evidence, inherited-file private-root binding, cleanup/owned handle lifetime, selected module no-fallback guarantee, unsupported non-Windows exit2, and truthful receipts. Production Windows memory review/proposals remain held. The backend is intentionally not yet admitted, and ancestor pinning belongs a separate portable protocol; this harness proves only leaf primitives and explicitly says so. No Windows tests have run. The same-handle stage readback is intentional because renameable handles request DELETE while every file open excludes FILE_SHARE_DELETE. Native read re-verifies ACL. Report backend defects only if they materially invalidate the harness or need coordination; don't demand unrelated feature implementation. Avoid broad best-practice checklists. If no concrete defects, approve.

## scripts/testing/hermes-memory-windows-native.py
SHA256 816f8e6e347ba3f1ebf0bb33e37109c5bcf7c7b056297c92aba3391b36242079
```python
#!/usr/bin/env python3
"""Windows-only primitive acceptance using a disposable fictional workspace.

This is not Hermes, model, customer-profile, installed GUI or power-loss proof.
Use --module with the exact installed helper to test a packaged copy. The chosen
module is never replaced by a source fallback. Non-Windows returns unsupported
and nonzero before importing the backend or creating a fixture.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tempfile
import time
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MODULE = ROOT / "server/helpers/hermes-memory-windows-native.py"
BEFORE = b"Fictional preference: concise updates.\n"
AFTER = "Fictional preference: detailed updates.\nUnicode: 中文🙂\n".encode("utf-8")


class AcceptanceFailure(Exception):
    pass


def require(value: Any, message: str) -> None:
    if not value:
        raise AcceptanceFailure(message)


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def powershell(script: str, values: dict[str, str]) -> str:
    import base64
    system_root = os.environ.get("SystemRoot")
    require(system_root and Path(system_root).is_absolute(), "Trusted Windows system directory is required.")
    executable = Path(system_root) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    env = {name: os.environ[name] for name in ("SystemRoot", "SYSTEMROOT", "WINDIR", "PATH", "TEMP", "TMP") if name in os.environ}
    env.update(values)
    result = subprocess.run(
        [str(executable), "-NoProfile", "-NonInteractive", "-EncodedCommand",
         base64.b64encode(script.encode("utf-16le")).decode("ascii")],
        env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, timeout=20, check=False,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    require(result.returncode == 0, "Disposable fixture ACL/junction operation failed.")
    require(len(result.stdout) <= 16384 and len(result.stderr) <= 16384, "Disposable fixture output exceeded its bound.")
    return result.stdout.decode("utf-8-sig", errors="strict").strip()


GET_ACL = r"""
$ErrorActionPreference = 'Stop'
$acl = Get-Acl -LiteralPath $env:REALBUD_ACCEPTANCE_PATH
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::Write($acl.Sddl)
"""
BROAD_GRANT = r"""
$ErrorActionPreference = 'Stop'
$acl = Get-Acl -LiteralPath $env:REALBUD_ACCEPTANCE_PATH
$users = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($users, 'ReadAndExecute', 'Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $env:REALBUD_ACCEPTANCE_PATH -AclObject $acl
"""
JUNCTION = r"""
$ErrorActionPreference = 'Stop'
New-Item -ItemType Junction -Path $env:REALBUD_ACCEPTANCE_LINK -Target $env:REALBUD_ACCEPTANCE_TARGET | Out-Null
"""


class Rig:
    def __init__(self, module: Any, parent: Path) -> None:
        self.module = module
        self.native = module.Win32Native()
        self.handles: list[Any] = []
        self.root = parent / "Fictional native memory 中文 workspace"
        self.volume: dict[str, Any] = {}

    def prepare(self) -> None:
        self.root_handle = self.own(self.native.create_private_directory(str(self.root)))
        self.native.verify_private(self.root_handle)
        self.native.close(self.root_handle)
        self.handles.remove(self.root_handle)
        self.root_handle = self.own(self.native.open_existing(str(self.root), directory=True))
        self.native.verify_private(self.root_handle)

    def own(self, handle: Any) -> Any:
        self.handles.append(handle)
        return handle

    def close(self, handle: Any) -> None:
        self.native.close(handle)
        self.handles.remove(handle)

    def drain(self) -> None:
        failures = 0
        for handle in list(reversed(self.handles)):
            try:
                self.close(handle)
            except Exception:
                failures += 1
        require(failures == 0 and not self.handles, "All owned native handles must close.")

    def file(self, name: str, value: bytes, *, renameable: bool = False) -> tuple[Path, Any]:
        path = self.root / name
        handle = self.own(self.native.create_private_file(str(path)))
        self.native.verify_private(handle)
        require(self.native.snapshot(handle).size == 0, "Private creation must return an empty file.")
        self.native.write(handle, value)
        self.native.flush(handle)
        self.close(handle)
        handle = self.own(self.native.open_existing(str(path), renameable=renameable))
        self.native.verify_private(handle)
        return path, handle

    def bytes(self, path: Path) -> bytes:
        handle = self.own(self.native.open_existing(str(path)))
        try:
            return self.native.read(handle, 65536)
        finally:
            self.close(handle)

    def refuses(self, work: Any) -> None:
        try:
            value = work()
        except self.module.NativeError:
            return
        # A surprisingly successful open must still be owned and closed.
        if value is not None and hasattr(value, "__class__"):
            try:
                self.native.close(value)
            except Exception:
                pass
        raise AcceptanceFailure("Expected native refusal did not occur.")


def identity(value: Any) -> tuple[Any, Any]:
    return value.volume_serial, value.file_index


def run_checks(rig: Rig, receipt: dict[str, Any]) -> None:
    native = rig.native

    def check(name: str, work: Any) -> None:
        receipt["active_check"] = name
        work()
        receipt["checks"].append(name)

    def empty_private_creation() -> None:
        path = rig.root / "private before content 中文.txt"
        handle = rig.own(native.create_private_file(str(path)))
        native.verify_private(handle)
        snapshot = native.snapshot(handle)
        require(snapshot.size == 0 and snapshot.links == 1, "New private file must be empty with one link.")
        require(identity(snapshot) != (0, 0), "Reliable native file identity is required.")
        native.write(handle, AFTER)
        native.flush(handle)
        require(identity(native.snapshot(handle)) == identity(snapshot), "Writing must preserve the opened identity.")
        rig.close(handle)
        reopened = rig.own(native.open_existing(str(path)))
        native.verify_private(reopened)
        require(identity(native.snapshot(reopened)) == identity(snapshot), "Reopen must preserve file identity.")
        require(native.read(reopened, 65536) == AFTER, "Exact Unicode bytes must survive reopen.")
        rig.volume = {name: getattr(snapshot, name) for name in ("filesystem", "volume_flags", "drive_type")}
        rig.close(reopened)

    check("Private empty creation precedes content; Unicode and spaced paths round-trip with stable identity", empty_private_creation)

    def missing_and_existing() -> None:
        missing = rig.root / "does not exist.txt"
        rig.refuses(lambda: native.open_existing(str(missing)))
        require(not missing.exists(), "Opening a missing path must not create it.")
        path, handle = rig.file("existing no clobber.txt", BEFORE)
        snapshot = native.snapshot(handle)
        rig.close(handle)
        rig.refuses(lambda: native.create_private_file(str(path)))
        require(rig.bytes(path) == BEFORE, "CREATE_NEW collision must preserve existing bytes.")
        reopened = rig.own(native.open_existing(str(path)))
        require(identity(native.snapshot(reopened)) == identity(snapshot), "CREATE_NEW collision must preserve existing identity.")
        rig.close(reopened)
        rig.refuses(lambda: native.create_private_directory(str(rig.root)))

    check("Missing opens and existing create collisions cannot create, replace or truncate data", missing_and_existing)

    def inherited_child() -> None:
        path = rig.root / "native inherited child.txt"
        with path.open("xb") as stream:
            stream.write(BEFORE)
            stream.flush()
            os.fsync(stream.fileno())
        descriptor_before = powershell(GET_ACL, {"REALBUD_ACCEPTANCE_PATH": str(path)})
        handle = rig.own(native.open_existing(str(path)))
        rig.refuses(lambda: native.verify_private(handle))
        native.verify_private(handle, private_root=rig.root_handle)
        require(native.read(handle, 65536) == BEFORE, "Root-bound inherited child must preserve its bytes.")
        require(powershell(GET_ACL, {"REALBUD_ACCEPTANCE_PATH": str(path)}) == descriptor_before, "Verification must not rewrite an inherited descriptor.")
        rig.close(handle)

    check("An inherited native child is admitted only with its protected private root and is never repaired", inherited_child)

    def broad_grant() -> None:
        path, handle = rig.file("explicit broad grant.txt", BEFORE)
        rig.close(handle)
        powershell(BROAD_GRANT, {"REALBUD_ACCEPTANCE_PATH": str(path)})
        descriptor_before = powershell(GET_ACL, {"REALBUD_ACCEPTANCE_PATH": str(path)})
        handle = rig.own(native.open_existing(str(path)))
        rig.refuses(lambda: native.verify_private(handle))
        rig.refuses(lambda: native.verify_private(handle, private_root=rig.root_handle))
        require(powershell(GET_ACL, {"REALBUD_ACCEPTANCE_PATH": str(path)}) == descriptor_before, "Rejected broad ACL must remain unchanged.")
        rig.refuses(lambda: native.read(handle, 65536))
        require(path.read_bytes() == BEFORE, "Privacy rejection must not rewrite fictional bytes.")
        rig.close(handle)

    check("An explicit broad grant is refused with or without a private root, without repair or data changes", broad_grant)

    def links() -> None:
        path, handle = rig.file("hard link source.txt", BEFORE)
        first = native.snapshot(handle)
        alias = rig.root / "hard link alias.txt"
        os.link(path, alias)
        try:
            # This backend deliberately rejects multiply linked ordinary files.
            # Either opening or snapshot validation may perform that refusal.
            rig.refuses(lambda: native.open_existing(str(alias)))
            rig.refuses(lambda: native.snapshot(handle))
            require(path.read_bytes() == BEFORE and alias.read_bytes() == BEFORE,
                    "Hard-link refusal must preserve both fictional names.")
        finally:
            alias.unlink()
        restored = native.snapshot(handle)
        require(restored.links == 1 and identity(restored) == identity(first),
                "Removing the owned alias must restore the original single-link identity.")
        require(native.read(handle, 65536) == BEFORE, "Link inspection must preserve source bytes.")
        rig.close(handle)

    check("Ordinary-file admission refuses multiple links and preserves the original identity after owned alias cleanup", links)

    def reparse() -> None:
        target = rig.root / "junction actual directory"
        target_handle = rig.own(native.create_private_directory(str(target)))
        native.verify_private(target_handle)
        rig.close(target_handle)
        child = target / "preserved.txt"
        child_handle = rig.own(native.create_private_file(str(child)))
        native.write(child_handle, BEFORE)
        native.flush(child_handle)
        rig.close(child_handle)
        junction = rig.root / "junction alias"
        powershell(JUNCTION, {"REALBUD_ACCEPTANCE_LINK": str(junction), "REALBUD_ACCEPTANCE_TARGET": str(target)})
        try:
            rig.refuses(lambda: native.open_existing(str(junction), directory=True))
            require(rig.bytes(child) == BEFORE, "Junction refusal must preserve target bytes.")
        finally:
            os.rmdir(junction)

    check("A target junction is refused without following or mutating its target", reparse)

    require(callable(getattr(native, "rename", None)), "Handle-bound rename must exist before acceptance can pass.")

    def publication() -> None:
        source, handle = rig.file("publish stage.txt", AFTER, renameable=True)
        snapshot = native.snapshot(handle)
        native.rename(handle, rig.root_handle, "published complete.txt", replace=False)
        destination = rig.root / "published complete.txt"
        require(not source.exists(), "No-clobber publication must move the owned stage.")
        require(native.read(handle, 65536) == AFTER, "Published bytes must match the whole stage.")
        require(identity(native.snapshot(handle)) == identity(snapshot), "Publication must preserve stage identity.")
        rig.close(handle)
        require(rig.bytes(destination) == AFTER, "Published bytes must survive closing the renameable handle.")

    check("Handle-bound same-volume no-clobber publication moves one complete file", publication)

    def collision() -> None:
        destination, destination_handle = rig.file("collision destination.txt", BEFORE)
        original_identity = identity(native.snapshot(destination_handle))
        rig.close(destination_handle)
        source, handle = rig.file("collision source.txt", AFTER, renameable=True)
        source_identity = identity(native.snapshot(handle))
        rig.refuses(lambda: native.rename(handle, rig.root_handle, destination.name, replace=False))
        require(native.read(handle, 65536) == AFTER and rig.bytes(destination) == BEFORE, "Collision must preserve both complete files.")
        reopened = rig.own(native.open_existing(str(destination)))
        require(identity(native.snapshot(reopened)) == original_identity, "Collision must not replace destination identity.")
        require(identity(native.snapshot(handle)) == source_identity, "Collision must preserve source identity.")
        rig.close(reopened)
        rig.close(handle)

    check("No-clobber publication collision preserves both identities and byte sequences", collision)

    def replacement() -> None:
        destination, existing = rig.file("whole replacement.txt", BEFORE)
        old_identity = identity(native.snapshot(existing))
        rig.close(existing)
        source, staged = rig.file("whole replacement stage.txt", AFTER, renameable=True)
        new_identity = identity(native.snapshot(staged))
        require(old_identity != new_identity, "Replacement fixture requires distinct objects.")
        native.rename(staged, rig.root_handle, destination.name, replace=True)
        require(not source.exists() and native.read(staged, 65536) == AFTER, "Successful replacement must publish the complete stage.")
        rig.close(staged)
        reopened = rig.own(native.open_existing(str(destination)))
        native.verify_private(reopened)
        require(identity(native.snapshot(reopened)) == new_identity, "Replacement must exchange identity rather than overwrite in place.")
        rig.close(reopened)

    check("Whole-file replacement preserves private ACL and uses the staged identity", replacement)

    def sharing_denial() -> None:
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
        kernel.CreateFileW.restype = wintypes.HANDLE
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.CloseHandle.restype = wintypes.BOOL
        destination, existing = rig.file("sharing denial target.txt", BEFORE)
        original_identity = identity(native.snapshot(existing))
        rig.close(existing)
        source, stage = rig.file("sharing denial stage.txt", AFTER, renameable=True)
        # Independent real handle permits reads/writes, deliberately not deletion.
        held = kernel.CreateFileW(str(destination), 0x80000000, 0x00000001 | 0x00000002, None, 3, 0x80, None)
        require(held not in (None, ctypes.c_void_p(-1).value), "The sharing fixture must acquire a real target handle.")
        try:
            rig.refuses(lambda: native.rename(stage, rig.root_handle, destination.name, replace=True))
            require(native.read(stage, 65536) == AFTER and rig.bytes(destination) == BEFORE, "Sharing denial must never fall back to in-place overwrite.")
            reopened = rig.own(native.open_existing(str(destination)))
            require(identity(native.snapshot(reopened)) == original_identity, "Sharing denial must preserve destination identity.")
            rig.close(reopened)
        finally:
            require(kernel.CloseHandle(held), "The independent sharing handle must close.")
        # A refusal is retryable only after the competing handle has gone away.
        native.rename(stage, rig.root_handle, destination.name, replace=True)
        require(not source.exists() and native.read(stage, 65536) == AFTER, "Retry after sharing release must publish the original complete stage.")
        rig.close(stage)
        require(rig.bytes(destination) == AFTER, "Retried complete replacement must survive handle close.")

    check("Real sharing denial preserves old and staged files without in-place fallback; retry succeeds after release", sharing_denial)
    receipt.pop("active_check", None)
    receipt["volume"] = rig.volume


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--module", type=Path, default=DEFAULT_MODULE, help="Exact owned native helper module; never falls back to source")
    parser.add_argument("--receipt", type=Path, required=True, help="Fresh JSON result path (existing evidence is never overwritten)")
    args = parser.parse_args()
    receipt_path = args.receipt.absolute()
    require(not receipt_path.exists(), "Use a fresh receipt path; earlier evidence is preserved.")
    receipt: dict[str, Any] = {
        "schema": 1, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "passed": False, "status": "pending", "platform": sys.platform,
        "python": platform.python_version(), "architecture": platform.machine(),
        "windows": platform.win32_ver(), "selected_module": str(args.module.absolute()),
        "script_sha256": digest(Path(__file__)), "checks": [], "cleanup": False,
        "native_validation": False,
        "limits": ["Primitive acceptance only; production platform holds remain unchanged.",
                   "No Hermes runtime, model/provider, customer profile or credential is used.",
                   "No full application, installed GUI, Windows 11 device or power-loss guarantee is implied.",
                   "Ancestor pinning and ancestor-junction refusal belong to the separate portable protocol and are not established by this leaf-primitive script."],
    }
    parent: Path | None = None
    rig: Rig | None = None
    exit_code = 1
    try:
        if os.name != "nt" or sys.platform != "win32":
            receipt.update(status="unsupported", reason="A real Windows process is required; no native checks were run.", cleanup=True)
            exit_code = 2
        else:
            selected = args.module.absolute()
            require(selected.is_file() and not selected.is_symlink(), "Exact selected native module must be a regular file.")
            receipt["module_sha256"] = digest(selected)
            spec = importlib.util.spec_from_file_location("realbud_windows_native_acceptance_subject", selected)
            require(spec is not None and spec.loader is not None, "Selected native module cannot be loaded.")
            module = importlib.util.module_from_spec(spec)
            sys.modules[spec.name] = module
            spec.loader.exec_module(module)
            require(isinstance(module.NativeError, type) and callable(module.Win32Native), "Selected native module contract is missing.")
            parent = Path(tempfile.mkdtemp(prefix="RealBud fictional native Windows ")).resolve()
            rig = Rig(module, parent)
            receipt["native_validation"] = True
            rig.prepare()
            run_checks(rig, receipt)
            require(digest(selected) == receipt["module_sha256"], "Selected native module changed during acceptance.")
            receipt["status"] = "checks-passed"
            exit_code = 0
    except Exception as error:
        receipt["status"] = "failed"
        receipt["failure_type"] = type(error).__name__
        if isinstance(error, AcceptanceFailure):
            receipt["failure"] = str(error)
        elif rig is not None and isinstance(error, rig.module.NativeError):
            receipt["native_failure"] = getattr(error, "code", "native-error")
        else:
            receipt["failure"] = "The acceptance fixture could not complete; native diagnostics are not exposed."
    finally:
        cleanup_failure = False
        if rig is not None:
            try:
                rig.drain()
                receipt["handles_drained"] = True
            except Exception:
                cleanup_failure = True
                receipt["handles_drained"] = False
        if parent is not None:
            try:
                shutil.rmtree(parent)
                receipt["cleanup"] = not parent.exists()
            except Exception:
                cleanup_failure = True
                receipt["cleanup"] = False
        if cleanup_failure:
            receipt["status"] = "cleanup-failed"
            exit_code = 1
        if exit_code == 0 and receipt["cleanup"]:
            receipt["passed"] = True
            receipt["status"] = "passed"
        receipt_path.parent.mkdir(parents=True, exist_ok=True)
        with receipt_path.open("x", encoding="utf-8") as stream:
            json.dump(receipt, stream, indent=2, ensure_ascii=True)
            stream.write("\n")
        print(json.dumps({"status": receipt["status"], "passed": receipt["passed"], "checks": len(receipt["checks"]), "cleanup": receipt["cleanup"], "receipt": str(receipt_path)}))
    return exit_code


if __name__ == "__main__":
    sys.exit(main())

```

## server/helpers/hermes-memory-windows-native.py
SHA256 61ffd50da933fe09021b04616dc5c7d8161bc0edbd2c5e225d397c25c9e0a71a
```python
"""Owned, deliberately unadmitted Windows handle/storage primitives.

Only local fixed NTFS volumes with persistent ACLs are supported. Callers MUST
pin/recheck the entire ancestor chain and own the native lock, expected-digest
and recovery protocol. OPEN_REPARSE_POINT protects the leaf, not ancestors.
No production Windows hold is changed by this module. File flush/handle rename
are not a claim of durable directory metadata or physical power-loss safety.

Win32Native accepts explicit fake bindings for portable policy tests. The real
CtypesBindings loads DLLs only on Windows. No environment platform overrides,
PowerShell, path-based rename/delete, ACL repair, or copy/truncate fallback.
All public failures have fixed codes and suppress native exception details.
"""
from __future__ import annotations

import ctypes as C
from dataclasses import dataclass
from functools import wraps
import os
import re
import struct
from typing import Any

MAX_BYTES = 128 * 1024
MAX_PATH_UNITS = 32767
FILE_ALL_ACCESS = 0x001F01FF
FILE_ATTRIBUTE_DIRECTORY = 0x10
FILE_ATTRIBUTE_REPARSE_POINT = 0x400
FILE_PERSISTENT_ACLS = 0x8
DRIVE_FIXED = 3
SYSTEM_SID = "S-1-5-18"
ADMIN_SID = "S-1-5-32-544"
ERROR_CODES = frozenset({"platform-unverified", "unsafe-storage", "unavailable",
                         "capacity", "conflict", "invalid", "recovery-required"})


class NativeError(Exception):
    def __init__(self, code: str = "unavailable") -> None:
        self.code = code if isinstance(code, str) and code in ERROR_CODES else "unavailable"
        super().__init__(self.code)


def _fixed(fn):
    @wraps(fn)
    def call(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except NativeError as error:
            raise NativeError(error.code) from None
        except Exception:
            raise NativeError("unavailable") from None
    return call


@dataclass(frozen=True, repr=False)
class Ace:
    ace_type: int
    flags: int
    mask: int
    sid: str


@dataclass(frozen=True, repr=False)
class SecurityInfo:
    owner: str
    protected: bool
    dacl_present: bool
    aces: tuple[Ace, ...]


@dataclass(frozen=True, repr=False)
class FileIdentity:
    volume_serial: int
    file_index: int
    attributes: int
    links: int
    size: int
    creation_ticks: int
    last_write_ticks: int
    final_path: str
    filesystem: str
    volume_flags: int
    drive_type: int


def _sid(value: Any) -> str:
    if not isinstance(value, str) or len(value) > 184 or not re.fullmatch(r"S-1-\d{1,15}(?:-\d{1,10}){1,15}", value):
        raise NativeError("unsafe-storage")
    return value


def _leaf(value: Any) -> str:
    if not isinstance(value, str) or not value or value in (".", "..") or value[-1] in " .":
        raise NativeError("invalid")
    if any(ord(ch) < 32 or 0xD800 <= ord(ch) <= 0xDFFF or ch in '\\/:*?"<>|' for ch in value):
        raise NativeError("invalid")
    device = value.split(".", 1)[0].upper()
    if device in {"CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"} or re.fullmatch(r"(?:COM|LPT)[1-9¹²³]", device):
        raise NativeError("invalid")
    if len(value.encode("utf-16-le")) > 510:
        raise NativeError("capacity")
    return value


def _path(value: Any) -> str:
    if not isinstance(value, str):
        raise NativeError("invalid")
    if value.startswith("\\\\?\\"):
        value = value[4:]
    if not re.match(r"^[A-Za-z]:\\", value):
        raise NativeError("unsafe-storage")
    rest = value[3:]
    if rest:
        for component in rest.split("\\"):
            _leaf(component)
    result = "\\\\?\\" + value[0].upper() + value[1:]
    if len(result.encode("utf-16-le")) // 2 > MAX_PATH_UNITS:
        raise NativeError("capacity")
    return result


def _identity(value: FileIdentity) -> tuple[int, int, int]:
    return value.volume_serial, value.file_index, value.creation_ticks


def _grants(mask: int) -> int:
    if mask & 0x80000000:
        mask |= 0x00120089  # FILE_GENERIC_READ
    if mask & 0x40000000:
        mask |= 0x00120116  # FILE_GENERIC_WRITE
    if mask & 0x20000000:
        mask |= 0x001200A0  # FILE_GENERIC_EXECUTE
    if mask & 0x10000000:
        mask |= FILE_ALL_ACCESS
    return mask & 0x0FFFFFFF


class Handle:
    """Opaque owned handle; successful close alone marks it released."""
    __slots__ = ("_owner", "_raw", "_path", "_directory", "_writable", "_new",
                 "_renameable", "_initial", "_root", "_closed", "_write_attempted", "_deleted")

    def __init__(self, owner, raw, path, directory, writable, new, renameable):
        self._owner, self._raw, self._path = owner, raw, path
        self._directory, self._writable, self._new = directory, writable, new
        self._renameable = renameable
        self._initial = None
        self._root = None
        self._closed = self._write_attempted = self._deleted = False

    def __repr__(self):
        return "<WindowsMemoryHandle>"

    def __enter__(self):
        self._owner._handle(self)
        return self

    def __exit__(self, *_):
        self.close()

    def close(self) -> None:
        self._owner.close(self)


class Win32Native:
    """Handle-bound privacy/IO; injectable binding protocol is documented below.

    bindings: current_user_sid, open_file, create_directory, file_identity,
    security_info, seek_start, read, write, flush, close, rename, delete.
    open_file(path, *, directory, writable, create, security_sddl, renameable)
    returns an integer handle. Other IO calls take that integer. rename receives
    (source, parent, leaf, replace); delete receives source. Metadata methods
    return the immutable dataclasses above. Fakes never enable production use.
    """

    error_type = NativeError

    @_fixed
    def __init__(self, bindings=None):
        self._bindings = bindings if bindings is not None else CtypesBindings()
        self._sid = _sid(self._bindings.current_user_sid())
        self._handles: set[Handle] = set()

    def _handle(self, handle: Handle, *, deleted=False) -> Handle:
        if not isinstance(handle, Handle) or handle not in self._handles or handle._owner is not self or handle._closed or (handle._deleted and not deleted):
            raise NativeError("invalid")
        return handle

    def _wrap(self, raw, path, directory, writable, new, renameable):
        if type(raw) is not int or raw <= 0 or raw == C.c_void_p(-1).value:
            raise NativeError("unavailable")
        handle = Handle(self, raw, path, directory, writable, new, renameable)
        self._handles.add(handle)
        try:
            handle._initial = self.snapshot(handle)
            if new:
                self.verify_private(handle)
            return handle
        except Exception:
            self.close(handle)
            raise

    @_fixed
    def open_existing(self, path: str, *, directory: bool = False, writable: bool = False, renameable: bool = False) -> Handle:
        if any(type(v) is not bool for v in (directory, writable, renameable)) or directory and (writable or renameable):
            raise NativeError("invalid")
        path = _path(path)
        raw = self._bindings.open_file(path, directory=directory, writable=writable,
                                      create=False, security_sddl=None, renameable=renameable)
        return self._wrap(raw, path, directory, writable, False, renameable)

    def _sddl(self, directory=False):
        flags = "OICI" if directory else ""
        return "O:%sD:P(A;%s;FA;;;%s)(A;%s;FA;;;SY)" % (self._sid, flags, self._sid, flags)

    @_fixed
    def create_private_file(self, path: str) -> Handle:
        path = _path(path)
        if _sid(self._bindings.current_user_sid()) != self._sid:
            raise NativeError("unsafe-storage")
        raw = self._bindings.open_file(path, directory=False, writable=True, create=True,
                                      security_sddl=self._sddl(), renameable=True)
        return self._wrap(raw, path, False, True, True, True)

    @_fixed
    def create_private_directory(self, path: str) -> Handle:
        path = _path(path)
        if _sid(self._bindings.current_user_sid()) != self._sid:
            raise NativeError("unsafe-storage")
        self._bindings.create_directory(path, self._sddl(True))
        raw = self._bindings.open_file(path, directory=True, writable=False, create=False,
                                      security_sddl=None, renameable=False)
        return self._wrap(raw, path, True, False, True, False)

    @_fixed
    def snapshot(self, handle: Handle) -> FileIdentity:
        handle = self._handle(handle)
        value = self._bindings.file_identity(handle._raw)
        if not isinstance(value, FileIdentity):
            raise NativeError("unsafe-storage")
        numbers = (value.volume_serial, value.file_index, value.attributes, value.links,
                   value.size, value.creation_ticks, value.last_write_ticks, value.volume_flags, value.drive_type)
        if any(type(n) is not int or n < 0 for n in numbers) or not value.volume_serial or not value.file_index or not value.creation_ticks or value.links < 1:
            raise NativeError("unsafe-storage")
        if value.filesystem != "NTFS" or value.drive_type != DRIVE_FIXED or not value.volume_flags & FILE_PERSISTENT_ACLS:
            raise NativeError("unsafe-storage")
        if value.attributes & (FILE_ATTRIBUTE_REPARSE_POINT | 0x40 | 0x1000):
            raise NativeError("unsafe-storage")
        if bool(value.attributes & FILE_ATTRIBUTE_DIRECTORY) != handle._directory or not handle._directory and value.links != 1:
            raise NativeError("unsafe-storage")
        # Deliberately strict component case: aliases are held, not guessed.
        if _path(value.final_path) != handle._path:
            raise NativeError("conflict")
        if handle._initial is not None and _identity(value) != _identity(handle._initial):
            raise NativeError("conflict")
        return value

    def _security(self, handle: Handle, *, protected: bool) -> SecurityInfo:
        info = self._bindings.security_info(handle._raw)
        if not isinstance(info, SecurityInfo) or type(info.protected) is not bool or type(info.dacl_present) is not bool:
            raise NativeError("unsafe-storage")
        allowed = {self._sid, SYSTEM_SID, ADMIN_SID}
        if not info.dacl_present or protected and not info.protected or info.owner not in allowed:
            raise NativeError("unsafe-storage")
        if not isinstance(info.aces, tuple) or not 1 <= len(info.aces) <= 1024:
            raise NativeError("unsafe-storage")
        user_grants = 0
        for ace in info.aces:
            if not isinstance(ace, Ace) or any(type(n) is not int for n in (ace.ace_type, ace.flags, ace.mask)):
                raise NativeError("unsafe-storage")
            if ace.ace_type != 0 or not 0 <= ace.flags <= 0x1F or not 0 <= ace.mask <= 0xFFFFFFFF or ace.sid not in allowed:
                raise NativeError("unsafe-storage")
            if ace.sid == self._sid and not ace.flags & 0x8:
                user_grants |= _grants(ace.mask)
        if user_grants & FILE_ALL_ACCESS != FILE_ALL_ACCESS:
            raise NativeError("unsafe-storage")
        return info

    @_fixed
    def verify_private(self, handle: Handle, *, private_root: Handle | None = None) -> None:
        handle = self._handle(handle)
        before = self.snapshot(handle)
        if _sid(self._bindings.current_user_sid()) != self._sid:
            raise NativeError("unsafe-storage")
        root_before = None
        if private_root is not None:
            private_root = self._handle(private_root)
            if private_root is handle or not private_root._directory:
                raise NativeError("unsafe-storage")
            root_before = self.snapshot(private_root)
            self._security(private_root, protected=True)
            prefix = _path(root_before.final_path).rstrip("\\") + "\\"
            if before.volume_serial != root_before.volume_serial or not _path(before.final_path).startswith(prefix):
                raise NativeError("unsafe-storage")
        self._security(handle, protected=private_root is None or handle._new)
        if self.snapshot(handle) != before:
            raise NativeError("conflict")
        if root_before is not None:
            self._security(private_root, protected=True)
            if self.snapshot(private_root) != root_before:
                raise NativeError("conflict")
        handle._root = private_root

    @_fixed
    def read(self, handle: Handle, limit: int = MAX_BYTES) -> bytes:
        handle = self._handle(handle)
        if type(limit) is not int or not 0 <= limit <= MAX_BYTES or handle._directory:
            raise NativeError("invalid")
        self.verify_private(handle, private_root=handle._root)
        before = self.snapshot(handle)
        if before.size > limit:
            raise NativeError("capacity")
        self._bindings.seek_start(handle._raw)
        chunks = []
        count = 0
        while count <= limit:
            part = self._bindings.read(handle._raw, min(65536, limit + 1 - count))
            if not isinstance(part, bytes) or len(part) > min(65536, limit + 1 - count):
                raise NativeError("unavailable")
            if not part:
                break
            chunks.append(part)
            count += len(part)
        if count > limit:
            raise NativeError("capacity")
        self.verify_private(handle, private_root=handle._root)
        if self.snapshot(handle) != before or count != before.size:
            raise NativeError("conflict")
        return b"".join(chunks)

    @_fixed
    def write(self, handle: Handle, data: bytes) -> None:
        handle = self._handle(handle)
        if type(data) is not bytes or handle._directory or not handle._new or not handle._writable or handle._write_attempted:
            raise NativeError("invalid")
        if len(data) > MAX_BYTES:
            raise NativeError("capacity")
        self.verify_private(handle, private_root=handle._root)
        before = self.snapshot(handle)
        if before.size:
            raise NativeError("conflict")
        handle._write_attempted = True
        self._bindings.seek_start(handle._raw)
        offset = 0
        while offset < len(data):
            written = self._bindings.write(handle._raw, data[offset:])
            if type(written) is not int or not 0 < written <= len(data) - offset:
                raise NativeError("unavailable")
            offset += written
        self.verify_private(handle, private_root=handle._root)
        after = self.snapshot(handle)
        if after.size != len(data) or _identity(after) != _identity(before):
            raise NativeError("conflict")

    @_fixed
    def flush(self, handle: Handle) -> None:
        handle = self._handle(handle)
        if handle._directory or not handle._writable:
            raise NativeError("invalid")
        self.verify_private(handle, private_root=handle._root)
        before = self.snapshot(handle)
        self._bindings.flush(handle._raw)
        self.verify_private(handle, private_root=handle._root)
        if self.snapshot(handle) != before:
            raise NativeError("conflict")

    @_fixed
    def rename(self, handle: Handle, parent: Handle, leaf: str, replace: bool = False) -> None:
        handle, parent = self._handle(handle), self._handle(parent)
        leaf = _leaf(leaf)
        if type(replace) is not bool or handle._directory or not handle._renameable or not parent._directory:
            raise NativeError("invalid")
        self.verify_private(handle, private_root=handle._root)
        self.verify_private(parent, private_root=parent._root)
        before, folder = self.snapshot(handle), self.snapshot(parent)
        if before.volume_serial != folder.volume_serial:
            raise NativeError("unsafe-storage")
        path = _path(folder.final_path.rstrip("\\") + "\\" + leaf)
        self._bindings.rename(handle._raw, parent._raw, leaf, replace)
        handle._path = path
        self.verify_private(handle, private_root=handle._root)
        after = self.snapshot(handle)
        if _identity(after) != _identity(before) or after.size != before.size:
            raise NativeError("conflict")

    @_fixed
    def delete(self, handle: Handle) -> None:
        handle = self._handle(handle)
        if handle._directory or not handle._renameable:
            raise NativeError("invalid")
        self.verify_private(handle, private_root=handle._root)
        self._bindings.delete(handle._raw)
        handle._deleted = True

    @_fixed
    def close(self, handle: Handle) -> None:
        if not isinstance(handle, Handle) or handle._owner is not self:
            raise NativeError("invalid")
        if handle._closed:
            return
        self._handle(handle, deleted=True)
        self._bindings.close(handle._raw)
        handle._closed = True
        self._handles.remove(handle)


# Fixed-width Win32 ABI declarations remain importable on macOS/Linux.
DWORD, BOOL, WORD, BYTE = C.c_uint32, C.c_int32, C.c_uint16, C.c_ubyte
HANDLE, PVOID = C.c_void_p, C.c_void_p
PDWORD, PPVOID = C.POINTER(DWORD), C.POINTER(PVOID)


class FILETIME(C.Structure):
    _fields_ = [("low", DWORD), ("high", DWORD)]


class BY_HANDLE_FILE_INFORMATION(C.Structure):
    _fields_ = [("attributes", DWORD), ("creation", FILETIME), ("access", FILETIME),
                ("write", FILETIME), ("volume", DWORD), ("size_high", DWORD),
                ("size_low", DWORD), ("links", DWORD), ("index_high", DWORD), ("index_low", DWORD)]


class SECURITY_ATTRIBUTES(C.Structure):
    _fields_ = [("length", DWORD), ("descriptor", PVOID), ("inherit", BOOL)]


class SID_AND_ATTRIBUTES(C.Structure):
    _fields_ = [("sid", PVOID), ("attributes", DWORD)]


class _RENAME_FLAGS(C.Union):
    _fields_ = [("replace", BYTE), ("flags", DWORD)]


class FILE_RENAME_INFO(C.Structure):
    _fields_ = [("options", _RENAME_FLAGS), ("root", HANDLE), ("length", DWORD), ("name", WORD * 1)]


class FILE_DISPOSITION_INFO(C.Structure):
    _fields_ = [("delete", BYTE)]


class CtypesBindings:
    """Real typed Win32 calls; explicit fake DLL objects are a local test seam."""

    @_fixed
    def __init__(self, *, kernel32=None, advapi32=None):
        if (kernel32 is None) != (advapi32 is None):
            raise NativeError("invalid")
        fake = kernel32 is not None
        if not fake:
            if os.name != "nt" or not hasattr(C, "WinDLL"):
                raise NativeError("unavailable")
            kernel32 = C.WinDLL("kernel32", use_last_error=True)
            advapi32 = C.WinDLL("advapi32", use_last_error=True)
        self.k, self.a = kernel32, advapi32
        self._last_error = (lambda: int(self.k.GetLastError())) if fake else C.get_last_error
        signatures = {
            "GetLastError": ([], DWORD), "GetCurrentProcess": ([], HANDLE), "GetCurrentThread": ([], HANDLE),
            "CreateFileW": ([C.c_wchar_p, DWORD, DWORD, C.POINTER(SECURITY_ATTRIBUTES), DWORD, DWORD, HANDLE], HANDLE),
            "CreateDirectoryW": ([C.c_wchar_p, C.POINTER(SECURITY_ATTRIBUTES)], BOOL),
            "CloseHandle": ([HANDLE], BOOL), "LocalFree": ([PVOID], PVOID), "GetFileType": ([HANDLE], DWORD),
            "GetFileInformationByHandle": ([HANDLE, C.POINTER(BY_HANDLE_FILE_INFORMATION)], BOOL),
            "GetFinalPathNameByHandleW": ([HANDLE, C.c_wchar_p, DWORD, DWORD], DWORD),
            "GetVolumeInformationByHandleW": ([HANDLE, C.c_wchar_p, DWORD, PDWORD, PDWORD, PDWORD, C.c_wchar_p, DWORD], BOOL),
            "GetDriveTypeW": ([C.c_wchar_p], DWORD),
            "ReadFile": ([HANDLE, PVOID, DWORD, PDWORD, PVOID], BOOL),
            "WriteFile": ([HANDLE, PVOID, DWORD, PDWORD, PVOID], BOOL),
            "SetFilePointerEx": ([HANDLE, C.c_int64, C.POINTER(C.c_int64), DWORD], BOOL),
            "FlushFileBuffers": ([HANDLE], BOOL),
            "SetFileInformationByHandle": ([HANDLE, C.c_int32, PVOID, DWORD], BOOL),
        }
        security_signatures = {
            "OpenProcessToken": ([HANDLE, DWORD, C.POINTER(HANDLE)], BOOL),
            "OpenThreadToken": ([HANDLE, DWORD, BOOL, C.POINTER(HANDLE)], BOOL),
            "GetTokenInformation": ([HANDLE, C.c_int32, PVOID, DWORD, PDWORD], BOOL),
            "IsValidSid": ([PVOID], BOOL), "GetLengthSid": ([PVOID], DWORD),
            "ConvertSidToStringSidW": ([PVOID, PPVOID], BOOL),
            "ConvertStringSecurityDescriptorToSecurityDescriptorW": ([C.c_wchar_p, DWORD, PPVOID, PDWORD], BOOL),
            "GetSecurityInfo": ([HANDLE, C.c_int32, DWORD, PPVOID, PPVOID, PPVOID, PPVOID, PPVOID], DWORD),
            "IsValidSecurityDescriptor": ([PVOID], BOOL), "GetSecurityDescriptorLength": ([PVOID], DWORD),
            "GetSecurityDescriptorControl": ([PVOID, C.POINTER(WORD), PDWORD], BOOL),
            "IsValidAcl": ([PVOID], BOOL), "GetAce": ([PVOID, DWORD, PPVOID], BOOL),
        }
        for library, entries in ((self.k, signatures), (self.a, security_signatures)):
            for name, (args, result) in entries.items():
                fn = getattr(library, name)
                fn.argtypes, fn.restype = args, result

    def _fail(self, error=None):
        value = self._last_error() if error is None else error
        raise NativeError("conflict" if value in (80, 183) else "unavailable")

    def _check(self, result):
        if not result:
            self._fail()

    def _free(self, pointer):
        if pointer and self.k.LocalFree(pointer):
            raise NativeError("unavailable")

    def _sid_at(self, address: int, lower: int, upper: int) -> str:
        if not address or not lower <= address or address + 8 > upper:
            raise NativeError("unsafe-storage")
        header = C.string_at(address, 8)
        size = 8 + 4 * header[1]
        if header[0] != 1 or not 1 <= header[1] <= 15 or address + size > upper:
            raise NativeError("unsafe-storage")
        if not self.a.IsValidSid(PVOID(address)) or self.a.GetLengthSid(PVOID(address)) != size:
            raise NativeError("unsafe-storage")
        text = PVOID()
        self._check(self.a.ConvertSidToStringSidW(PVOID(address), C.byref(text)))
        try:
            return _sid(C.wstring_at(text.value))
        finally:
            self._free(text)

    @_fixed
    def current_user_sid(self) -> str:
        thread = HANDLE()
        if self.a.OpenThreadToken(self.k.GetCurrentThread(), 8, True, C.byref(thread)):
            self.close(thread.value)
            raise NativeError("unsafe-storage")
        if self._last_error() != 1008:  # ERROR_NO_TOKEN
            self._fail()
        token = HANDLE()
        self._check(self.a.OpenProcessToken(self.k.GetCurrentProcess(), 8, C.byref(token)))
        try:
            size = DWORD()
            result = self.a.GetTokenInformation(token, 1, None, 0, C.byref(size))
            if result or self._last_error() != 122 or not C.sizeof(SID_AND_ATTRIBUTES) <= size.value <= 65536:
                raise NativeError("unavailable")
            buffer = C.create_string_buffer(size.value)
            self._check(self.a.GetTokenInformation(token, 1, buffer, size.value, C.byref(size)))
            if not C.sizeof(SID_AND_ATTRIBUTES) <= size.value <= C.sizeof(buffer):
                raise NativeError("unsafe-storage")
            sid = C.cast(buffer, C.POINTER(SID_AND_ATTRIBUTES)).contents.sid
            return self._sid_at(sid, C.addressof(buffer), C.addressof(buffer) + size.value)
        finally:
            self.close(token.value)

    def _attributes(self, sddl: str):
        pointer = PVOID()
        try:
            self._check(self.a.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, C.byref(pointer), None))
            if not pointer:
                raise NativeError("unavailable")
            return pointer, SECURITY_ATTRIBUTES(C.sizeof(SECURITY_ATTRIBUTES), pointer, False)
        except Exception:
            self._free(pointer)
            raise

    @_fixed
    def open_file(self, path, *, directory, writable, create, security_sddl, renameable=False) -> int:
        pointer = None
        attributes = None
        raw = None
        if create:
            if directory or not security_sddl:
                raise NativeError("invalid")
            pointer, attributes = self._attributes(security_sddl)
        elif security_sddl is not None:
            raise NativeError("invalid")
        access = 0x20000 | 0x80  # READ_CONTROL | FILE_READ_ATTRIBUTES
        if not directory:
            access |= 0x80000000  # GENERIC_READ
        if writable:
            access |= 0x40000000
        if renameable:
            access |= 0x10000  # DELETE
        try:
            flags = 0x200000 | (0x2000000 if directory else 0)
            if writable or renameable:
                flags |= 0x80000000  # FILE_FLAG_WRITE_THROUGH; no durability admission.
            raw = self.k.CreateFileW(path, access, 3 if directory else 1,
                                     C.byref(attributes) if attributes is not None else None,
                                     1 if create else 3, flags, None)
            if raw is None or raw == C.c_void_p(-1).value:
                self._fail()
            return int(raw)
        finally:
            try:
                self._free(pointer)
            except Exception:
                if raw is not None and raw != C.c_void_p(-1).value:
                    self.close(raw)
                raise

    @_fixed
    def create_directory(self, path, security_sddl) -> None:
        pointer, attributes = self._attributes(security_sddl)
        try:
            self._check(self.k.CreateDirectoryW(path, C.byref(attributes)))
        finally:
            self._free(pointer)

    @_fixed
    def file_identity(self, raw_handle) -> FileIdentity:
        if self.k.GetFileType(raw_handle) != 1:
            raise NativeError("unsafe-storage")
        info = BY_HANDLE_FILE_INFORMATION()
        self._check(self.k.GetFileInformationByHandle(raw_handle, C.byref(info)))
        capacity = 512
        path = None
        for _ in range(3):
            buffer = C.create_unicode_buffer(capacity)
            count = self.k.GetFinalPathNameByHandleW(raw_handle, buffer, capacity, 0)
            if not count:
                self._fail()
            if count < capacity:
                path = _path(buffer.value)
                break
            capacity = int(count) + 1
            if capacity > MAX_PATH_UNITS + 1:
                raise NativeError("capacity")
        if path is None:
            raise NativeError("unavailable")
        volume, maximum, flags = DWORD(), DWORD(), DWORD()
        filesystem = C.create_unicode_buffer(64)
        self._check(self.k.GetVolumeInformationByHandleW(raw_handle, None, 0, C.byref(volume), C.byref(maximum), C.byref(flags), filesystem, 64))
        if volume.value != info.volume:
            raise NativeError("conflict")
        ticks = lambda value: (int(value.high) << 32) | int(value.low)
        return FileIdentity(int(info.volume), (int(info.index_high) << 32) | int(info.index_low),
                            int(info.attributes), int(info.links), (int(info.size_high) << 32) | int(info.size_low),
                            ticks(info.creation), ticks(info.write), path, filesystem.value,
                            int(flags.value), int(self.k.GetDriveTypeW(path[4:7])))

    @_fixed
    def security_info(self, raw_handle) -> SecurityInfo:
        descriptor, owner, dacl = PVOID(), PVOID(), PVOID()
        error = self.a.GetSecurityInfo(raw_handle, 1, 5, C.byref(owner), None, C.byref(dacl), None, C.byref(descriptor))
        try:
            if error:
                self._fail(error)
            if not descriptor or not self.a.IsValidSecurityDescriptor(descriptor):
                raise NativeError("unsafe-storage")
            size = int(self.a.GetSecurityDescriptorLength(descriptor))
            lower, upper = descriptor.value, descriptor.value + size
            control, revision = WORD(), DWORD()
            self._check(self.a.GetSecurityDescriptorControl(descriptor, C.byref(control), C.byref(revision)))
            if not 20 <= size <= 65536 or revision.value != 1 or not control.value & 0x8000:
                raise NativeError("unsafe-storage")
            owner_sid = self._sid_at(owner.value, lower, upper)
            if not control.value & 4 or not dacl or not lower <= dacl.value or dacl.value + 8 > upper:
                raise NativeError("unsafe-storage")
            acl_header = C.string_at(dacl.value, 8)
            acl_size, count = struct.unpack_from("<HH", acl_header, 2)
            if not 8 <= acl_size <= 65535 or dacl.value + acl_size > upper or not 1 <= count <= 1024 or not self.a.IsValidAcl(dacl):
                raise NativeError("unsafe-storage")
            aces = []
            previous = dacl.value + 8
            for index in range(count):
                pointer = PVOID()
                self._check(self.a.GetAce(dacl, index, C.byref(pointer)))
                address = pointer.value
                if not address or address < previous or address + 8 > dacl.value + acl_size:
                    raise NativeError("unsafe-storage")
                header = C.string_at(address, 8)
                ace_type, flags, length, mask = struct.unpack("<BBHI", header)
                if ace_type != 0 or length < 16 or length % 4 or address + length > dacl.value + acl_size:
                    raise NativeError("unsafe-storage")
                sid = self._sid_at(address + 8, address + 8, address + length)
                aces.append(Ace(ace_type, flags, mask, sid))
                previous = address + length
            return SecurityInfo(owner_sid, bool(control.value & 0x1000), True, tuple(aces))
        finally:
            self._free(descriptor)

    @_fixed
    def seek_start(self, raw_handle) -> None:
        position = C.c_int64()
        self._check(self.k.SetFilePointerEx(raw_handle, 0, C.byref(position), 0))
        if position.value != 0:
            raise NativeError("unavailable")

    @_fixed
    def read(self, raw_handle, count) -> bytes:
        if type(count) is not int or not 0 <= count <= MAX_BYTES + 1:
            raise NativeError("invalid")
        buffer = C.create_string_buffer(max(1, count))
        actual = DWORD()
        self._check(self.k.ReadFile(raw_handle, buffer, count, C.byref(actual), None))
        if actual.value > count:
            raise NativeError("unavailable")
        return buffer.raw[:actual.value]

    @_fixed
    def write(self, raw_handle, data) -> int:
        if type(data) is not bytes or len(data) > MAX_BYTES:
            raise NativeError("invalid")
        buffer, actual = C.create_string_buffer(data), DWORD()
        self._check(self.k.WriteFile(raw_handle, buffer, len(data), C.byref(actual), None))
        if actual.value > len(data):
            raise NativeError("unavailable")
        return int(actual.value)

    @_fixed
    def flush(self, raw_handle) -> None:
        self._check(self.k.FlushFileBuffers(raw_handle))

    @_fixed
    def rename(self, raw_source, raw_parent, leaf, replace) -> None:
        # Relative leaf + RootDirectory binds destination to an existing handle.
        # https://learn.microsoft.com/windows/win32/api/winbase/ns-winbase-file_rename_info
        encoded = _leaf(leaf).encode("utf-16-le")
        offset = FILE_RENAME_INFO.name.offset
        buffer = C.create_string_buffer(max(C.sizeof(FILE_RENAME_INFO), offset + len(encoded) + 2))
        info = C.cast(buffer, C.POINTER(FILE_RENAME_INFO)).contents
        info.options.replace, info.root, info.length = bool(replace), raw_parent, len(encoded)
        C.memmove(C.addressof(buffer) + offset, encoded, len(encoded))
        self._check(self.k.SetFileInformationByHandle(raw_source, 3, buffer, C.sizeof(buffer)))

    @_fixed
    def delete(self, raw_handle) -> None:
        # This marks the opened object for deletion; caller must also close.
        info = FILE_DISPOSITION_INFO(1)
        self._check(self.k.SetFileInformationByHandle(raw_handle, 4, C.byref(info), C.sizeof(info)))

    @_fixed
    def close(self, raw_handle) -> None:
        self._check(self.k.CloseHandle(raw_handle))

```

