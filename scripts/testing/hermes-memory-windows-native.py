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
from contextlib import contextmanager
import platform
import re
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
# A cold CI runner pays PowerShell/interpreter start-up on the first fixture
# command, so each disposable helper process gets a bounded but realistic
# budget; the per-check and whole-run budgets keep a stall from running away.
FIXTURE_TIMEOUT_SECONDS = 120
CHECK_BUDGET_SECONDS = 300
RUN_BUDGET_SECONDS = 480
# Short fixed labels only: never command output, and no path beyond the
# disposable root.
ACTIVE_STEP: dict[str, Any] = {}
RUN_STARTED = time.monotonic()


class AcceptanceFailure(Exception):
    pass


def require(value: Any, message: str) -> None:
    if not value:
        raise AcceptanceFailure(message)


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def native_detail(error: Any) -> dict[str, Any] | None:
    """Receipt-safe {code, primitive, flags} from a NativeError, or None.

    The module bounds these three fields; this re-checks them so an older or
    packaged helper can never put a path, a name or file bytes in the receipt.
    """
    detail = getattr(error, "native_detail", None)
    if not isinstance(detail, dict):
        return None
    code = detail.get("code")
    primitive = detail.get("primitive")
    flags = detail.get("flags")
    safe: dict[str, Any] = {
        "code": code if type(code) is int and 0 <= code <= 0xFFFFFFFF else None,
        "primitive": primitive if isinstance(primitive, str) and re.fullmatch(r"[A-Za-z0-9_()]{1,96}", primitive) else None,
        "flags": flags if isinstance(flags, str) and re.fullmatch(r"[A-Za-z0-9_=|]{1,96}", flags) else None,
    }
    return safe if any(value is not None for value in safe.values()) else None


def require_namespace_absent(path: Path) -> None:
    try:
        path.stat()
    except FileNotFoundError as error:
        require(getattr(error, "winerror", None) == 2,
                "Deletion absence requires ERROR_FILE_NOT_FOUND, not an inaccessible or missing parent.")
        return
    raise AcceptanceFailure("The selected name must be absent after the final handle closes.")


@contextmanager
def fixture_step(label: str, timeout_seconds: float):
    """Name the running fixture command so a timeout receipt can say which one."""
    ACTIVE_STEP.update(active_step=label, active_step_timeout_seconds=timeout_seconds)
    yield
    # Deliberately no finally: a propagating failure keeps its own label.
    ACTIVE_STEP.clear()


def powershell(script: str, values: dict[str, str], *, label: str) -> str:
    import base64
    system_root = os.environ.get("SystemRoot")
    require(system_root and Path(system_root).is_absolute(), "Trusted Windows system directory is required.")
    executable = Path(system_root) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    env = {name: os.environ[name] for name in ("SystemRoot", "SYSTEMROOT", "WINDIR", "PATH", "TEMP", "TMP") if name in os.environ}
    env.update(values)
    with fixture_step(label, FIXTURE_TIMEOUT_SECONDS):
        result = subprocess.run(
            [str(executable), "-NoProfile", "-NonInteractive", "-EncodedCommand",
             base64.b64encode(script.encode("utf-16le")).decode("ascii")],
            env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, timeout=FIXTURE_TIMEOUT_SECONDS, check=False,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
    require(result.returncode == 0, "Disposable fixture ACL/junction operation failed.")
    require(len(result.stdout) <= 16384 and len(result.stderr) <= 16384, "Disposable fixture output exceeded its bound.")
    return result.stdout.decode("utf-8-sig", errors="strict").strip()


GET_ACL = r"""
$ErrorActionPreference = 'Stop'
$item = if ([System.IO.Directory]::Exists($env:REALBUD_ACCEPTANCE_PATH)) { New-Object System.IO.DirectoryInfo($env:REALBUD_ACCEPTANCE_PATH) } else { New-Object System.IO.FileInfo($env:REALBUD_ACCEPTANCE_PATH) }
$acl = $item.GetAccessControl()
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::Write($acl.Sddl)
"""
BROAD_GRANT = r"""
$ErrorActionPreference = 'Stop'
$item = if ([System.IO.Directory]::Exists($env:REALBUD_ACCEPTANCE_PATH)) { New-Object System.IO.DirectoryInfo($env:REALBUD_ACCEPTANCE_PATH) } else { New-Object System.IO.FileInfo($env:REALBUD_ACCEPTANCE_PATH) }
$acl = $item.GetAccessControl()
$users = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($users, 'ReadAndExecute', 'Allow')
$acl.AddAccessRule($rule)
$item.SetAccessControl($acl)
"""
JUNCTION = r"""
$ErrorActionPreference = 'Stop'
New-Item -ItemType Junction -Path $env:REALBUD_ACCEPTANCE_LINK -Target $env:REALBUD_ACCEPTANCE_TARGET | Out-Null
"""


@contextmanager
def independent_reader(path: Path, *, share_delete: bool):
    """Own one real Win32 reader, independent of the backend under test."""
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    kernel.CreateFileW.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    kernel.SetFilePointerEx.argtypes = [wintypes.HANDLE, ctypes.c_int64, ctypes.POINTER(ctypes.c_int64), wintypes.DWORD]
    kernel.SetFilePointerEx.restype = wintypes.BOOL
    kernel.ReadFile.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
    kernel.ReadFile.restype = wintypes.BOOL
    sharing = 0x00000001 | 0x00000002 | (0x00000004 if share_delete else 0)
    held = kernel.CreateFileW(str(path), 0x80000000, sharing, None, 3, 0x80, None)
    require(held not in (None, 0, ctypes.c_void_p(-1).value), "The sharing fixture must acquire a real target handle.")
    try:
        def read() -> bytes:
            position = ctypes.c_int64()
            require(kernel.SetFilePointerEx(held, 0, ctypes.byref(position), 0) and position.value == 0,
                    "The independent reader must reset its own file position.")
            buffer, count = ctypes.create_string_buffer(65536), wintypes.DWORD()
            require(kernel.ReadFile(held, buffer, len(buffer), ctypes.byref(count), None),
                    "The independent reader must read its held file object.")
            require(count.value <= len(buffer), "The independent read must remain bounded.")
            return buffer.raw[:count.value]
        yield read
    finally:
        body_error = sys.exc_info()[1]
        try:
            closed = bool(kernel.CloseHandle(held))
        except Exception:
            closed = False
        if not closed:
            if body_error is not None:
                # Preserve the primary failure and carry only a fixed cleanup
                # marker; never replace it with a CloseHandle diagnostic.
                body_error.acceptance_independent_reader_cleanup_failed = True
            else:
                error = AcceptanceFailure("The independent sharing handle must close.")
                error.acceptance_independent_reader_cleanup_failed = True
                raise error


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
        handle = self.own(self.native.open_existing(str(path), writable=renameable, renameable=renameable))
        self.native.verify_private(handle)
        return path, handle

    def bytes(self, path: Path) -> bytes:
        handle = self.own(self.native.open_existing(str(path)))
        try:
            return self.native.read(handle, 65536)
        finally:
            self.close(handle)

    def refuses(self, work: Any, *, code: str | None = None) -> None:
        try:
            value = work()
        except self.module.NativeError as error:
            if code is not None:
                require(error.code == code, "Native refusal must have the expected fixed category.")
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
        # Progress on stderr so an outer kill still names the running check.
        print("check: " + name, file=sys.stderr, flush=True)
        started = time.monotonic()
        work()
        elapsed = time.monotonic() - started
        receipt["check_seconds"].append(round(elapsed, 1))
        require(elapsed <= CHECK_BUDGET_SECONDS, "A single acceptance check exceeded its bounded time budget.")
        require(time.monotonic() - RUN_STARTED <= RUN_BUDGET_SECONDS, "Acceptance exceeded its bounded total time budget.")
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
        rig.refuses(lambda: native.open_existing(str(missing)), code="not-found")
        rig.refuses(lambda: native.open_existing(str(missing / "missing ancestor.txt")), code="unavailable")
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
        descriptor_before = powershell(GET_ACL, {"REALBUD_ACCEPTANCE_PATH": str(path)}, label="fixture: inherited child descriptor read")
        handle = rig.own(native.open_existing(str(path)))
        rig.refuses(lambda: native.verify_private(handle), code="unsafe-storage")
        unrelated = rig.own(native.create_private_directory(str(rig.root.parent / "Unrelated private sibling")))
        native.verify_private(unrelated)
        rig.refuses(lambda: native.verify_private(handle, private_root=unrelated), code="unsafe-storage")
        native.verify_private(handle, private_root=rig.root_handle)
        # A previous valid root cannot make a later unrelated binding succeed.
        rig.refuses(lambda: native.verify_private(handle, private_root=unrelated), code="unsafe-storage")
        rig.close(unrelated)
        require(native.read(handle, 65536) == BEFORE, "Root-bound inherited child must preserve its bytes.")
        require(powershell(GET_ACL, {"REALBUD_ACCEPTANCE_PATH": str(path)}, label="fixture: inherited child descriptor recheck") == descriptor_before, "Verification must not rewrite an inherited descriptor.")
        rig.close(handle)

    check("An inherited child requires its containing protected root; absent and unrelated roots are refused without repair", inherited_child)

    def broad_grant() -> None:
        path, handle = rig.file("explicit broad grant.txt", BEFORE)
        rig.close(handle)
        powershell(BROAD_GRANT, {"REALBUD_ACCEPTANCE_PATH": str(path)}, label="fixture: broad grant ACL write")
        descriptor_before = powershell(GET_ACL, {"REALBUD_ACCEPTANCE_PATH": str(path)}, label="fixture: broad grant descriptor read")
        handle = rig.own(native.open_existing(str(path)))
        rig.refuses(lambda: native.verify_private(handle), code="unsafe-storage")
        rig.refuses(lambda: native.verify_private(handle, private_root=rig.root_handle), code="unsafe-storage")
        require(powershell(GET_ACL, {"REALBUD_ACCEPTANCE_PATH": str(path)}, label="fixture: broad grant descriptor recheck") == descriptor_before, "Rejected broad ACL must remain unchanged.")
        rig.refuses(lambda: native.read(handle, 65536))
        require(path.read_bytes() == BEFORE, "Privacy rejection must not rewrite fictional bytes.")
        rig.close(handle)

    check("An explicit broad grant is refused with or without a private root, without repair or data changes", broad_grant)

    def links() -> None:
        path, handle = rig.file("hard link source.txt", BEFORE)
        first = native.snapshot(handle)
        rig.close(handle)
        alias = rig.root / "hard link alias.txt"
        os.link(path, alias)
        try:
            # This backend deliberately rejects multiply linked ordinary files.
            # Either opening or snapshot validation may perform that refusal.
            require(path.stat().st_nlink == 2 and alias.stat().st_nlink == 2,
                    "The disposable hard-link fixture must have exactly two links.")
            rig.refuses(lambda: native.open_existing(str(alias)), code="unsafe-storage")
            rig.refuses(lambda: native.open_existing(str(path)), code="unsafe-storage")
            require(path.read_bytes() == BEFORE and alias.read_bytes() == BEFORE,
                    "Hard-link refusal must preserve both fictional names.")
        finally:
            # No source handle remains open: the backend deliberately excludes
            # FILE_SHARE_DELETE for every opened name of the same file object.
            alias.unlink()
        reopened = rig.own(native.open_existing(str(path)))
        restored = native.snapshot(reopened)
        require(restored.links == 1 and identity(restored) == identity(first),
                "Removing the owned alias must restore the original single-link identity.")
        require(native.read(reopened, 65536) == BEFORE, "Link inspection must preserve source bytes.")
        rig.close(reopened)

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
        powershell(JUNCTION, {"REALBUD_ACCEPTANCE_LINK": str(junction), "REALBUD_ACCEPTANCE_TARGET": str(target)}, label="fixture: junction creation")
        try:
            rig.refuses(lambda: native.open_existing(str(junction), directory=True), code="unsafe-storage")
            require(rig.bytes(child) == BEFORE, "Junction refusal must preserve target bytes.")
        finally:
            os.rmdir(junction)

    check("A target junction is refused without following or mutating its target", reparse)

    require(callable(getattr(native, "rename", None)), "Handle-bound rename must exist before acceptance can pass.")

    def publication() -> None:
        source, handle = rig.file("publish stage.txt", AFTER, renameable=True)
        snapshot = native.snapshot(handle)
        native.flush(handle)
        native.rename(handle, rig.root_handle, "published complete.txt", replace=False)
        native.flush(handle)
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
        native.flush(handle)
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
        native.flush(staged)
        native.rename(staged, rig.root_handle, destination.name, replace=True)
        native.flush(staged)
        require(not source.exists() and native.read(staged, 65536) == AFTER, "Successful replacement must publish the complete stage.")
        rig.close(staged)
        reopened = rig.own(native.open_existing(str(destination)))
        native.verify_private(reopened)
        require(identity(native.snapshot(reopened)) == new_identity, "Replacement must exchange identity rather than overwrite in place.")
        rig.close(reopened)

    check("Whole-file replacement preserves private ACL and uses the staged identity", replacement)

    def sharing_denial() -> None:
        destination, existing = rig.file("sharing denial target.txt", BEFORE)
        original_identity = identity(native.snapshot(existing))
        rig.close(existing)
        source, stage = rig.file("sharing denial stage.txt", AFTER, renameable=True)
        native.flush(stage)
        with independent_reader(destination, share_delete=False):
            rig.refuses(lambda: native.rename(stage, rig.root_handle, destination.name, replace=True))
            require(native.read(stage, 65536) == AFTER and rig.bytes(destination) == BEFORE,
                    "Sharing denial must never fall back to in-place overwrite.")
            reopened = rig.own(native.open_existing(str(destination)))
            require(identity(native.snapshot(reopened)) == original_identity,
                    "Sharing denial must preserve destination identity.")
            rig.close(reopened)
        # A refusal is retryable only after the competing handle has gone away.
        native.rename(stage, rig.root_handle, destination.name, replace=True)
        native.flush(stage)
        require(not source.exists() and native.read(stage, 65536) == AFTER,
                "Retry after sharing release must publish the original complete stage.")
        rig.close(stage)
        require(rig.bytes(destination) == AFTER, "Retried complete replacement must survive handle close.")

    check("Real sharing denial preserves old and staged files without fallback; retry is flushed after release", sharing_denial)
    require(callable(getattr(native, "delete", None)), "Handle-bound delete must exist before acceptance can pass.")

    def exact_delete() -> None:
        source, handle = rig.file("exact handle delete.txt", BEFORE, renameable=True)
        unrelated, other = rig.file("delete must preserve sibling.txt", AFTER)
        sibling_identity = identity(native.snapshot(other))
        rig.close(other)
        native.delete(handle)
        rig.refuses(lambda: native.read(handle, 65536), code="invalid")
        rig.close(handle)
        require_namespace_absent(source)
        rig.refuses(lambda: native.open_existing(str(source)))
        other = rig.own(native.open_existing(str(unrelated)))
        require(identity(native.snapshot(other)) == sibling_identity and native.read(other, 65536) == AFTER,
                "Exact-handle deletion must preserve an unrelated file's identity and bytes.")
        rig.close(other)

    check("Exact-handle deletion invalidates that handle and preserves an unrelated sibling", exact_delete)

    def deferred_delete() -> None:
        source, seed = rig.file("deferred deletion.txt", BEFORE)
        rig.close(seed)
        # This reader exists before the delete-capable handle; it shares delete.
        with independent_reader(source, share_delete=True) as held_read:
            require(held_read() == BEFORE, "The independent reader must first read the complete original bytes.")
            handle = rig.own(native.open_existing(str(source), renameable=True))
            native.verify_private(handle)
            native.delete(handle)
            rig.close(handle)
            require(held_read() == BEFORE,
                    "A deletion request must leave the original bytes readable through the pre-existing reader.")
            # Deliberately do not equate pathname lookup with physical removal
            # while another reader still owns the object. Journal completion
            # requires the separate protocol's namespace reconciliation.
        require_namespace_absent(source)
        rig.refuses(lambda: native.open_existing(str(source)))

    check("Delete-sharing reader proves deferred deletion until final close; no journal completion is inferred", deferred_delete)

    def pinned_inventory() -> None:
        directory = rig.root / "bounded inventory"
        held = rig.own(native.create_private_directory(str(directory)))
        for name in ("first.json", "Unicode 中文🙂.stage"):
            file_handle = rig.own(native.create_private_file(str(directory / name)))
            native.write(file_handle, BEFORE)
            native.flush(file_handle)
            rig.close(file_handle)
        require(set(native.names(held, 2)) == {"first.json", "Unicode 中文🙂.stage"},
                "Pinned inventory must contain every exact Unicode leaf.")
        rig.refuses(lambda: native.names(held, 1), code="capacity")
        require(len(native.names(held, 2)) == 2, "A fresh bounded inventory must restart after capacity refusal.")
        rig.close(held)

    check("Pinned directory inventory is bounded, preserves Unicode and restarts after refusal", pinned_inventory)

    def interoperable_lock() -> None:
        path = rig.root / "native byte zero.lock"
        lock = rig.own(native.open_lock(str(path), create=True))
        native.verify_private(lock)
        require(native.snapshot(lock).size == 0, "Private native locks remain empty.")
        other = rig.own(native.open_lock(str(path)))
        # This child uses the same CRT byte-zero primitive as upstream Hermes.
        child = """import msvcrt, os, sys
fd = os.open(sys.argv[1], os.O_RDWR | os.O_BINARY)
try:
    os.lseek(fd, 0, os.SEEK_SET)
    try:
        msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
    except OSError:
        print('blocked')
    else:
        msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
        print('locked')
finally:
    os.close(fd)
"""
        def crt_probe(expected: bytes) -> None:
            with fixture_step("fixture: independent CRT byte-zero lock probe", FIXTURE_TIMEOUT_SECONDS):
                result = subprocess.run([sys.executable, "-B", "-c", child, str(path)],
                                        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                        timeout=FIXTURE_TIMEOUT_SECONDS, check=False,
                                        creationflags=subprocess.CREATE_NO_WINDOW)
            require(result.returncode == 0 and result.stdout.strip() == expected and not result.stderr,
                    "The independent CRT process must observe the expected byte-zero lock state.")
        native.lock(lock, timeout_ms=0)
        try:
            rig.refuses(lambda: native.lock(other, timeout_ms=0), code="conflict")
            crt_probe(b"blocked")
            rig.refuses(lambda: native.open_existing(str(path), renameable=True), code="unavailable")
        finally:
            native.unlock(lock)
        crt_probe(b"locked")
        native.lock(other, timeout_ms=0)
        native.unlock(other)
        require(native.snapshot(lock).size == 0, "Locking must not write sentinel bytes.")
        rig.close(other)
        rig.close(lock)

    check("Private byte-zero locks contend with another handle and an independent Hermes-compatible CRT process", interoperable_lock)

    def nonempty_lock_refused() -> None:
        path, regular = rig.file("nonempty lock.lock", BEFORE)
        rig.close(regular)
        lock = rig.own(native.open_lock(str(path)))
        rig.refuses(lambda: native.lock(lock, timeout_ms=0), code="unsafe-storage")
        rig.close(lock)
        require(rig.bytes(path) == BEFORE, "A nonempty lock must be held without repairing or truncating it.")

    check("A nonempty pre-existing lock is refused and preserved", nonempty_lock_refused)
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
        "native_validation": False, "check_seconds": [],
        "timeouts": {"fixture_seconds": FIXTURE_TIMEOUT_SECONDS,
                     "check_seconds": CHECK_BUDGET_SECONDS,
                     "run_seconds": RUN_BUDGET_SECONDS},
        "limits": ["Primitive acceptance only; production platform holds remain unchanged.",
                   "No Hermes runtime, model/provider, customer profile or credential is used.",
                   "No full application, installed GUI, Windows 11 device or power-loss guarantee is implied.",
                   "Ancestor pinning and ancestor-junction refusal belong to the separate portable protocol and are not established by this leaf-primitive script.",
                   "Successful deletion requests are not journal completion; namespace/journal reconciliation requires the separate protocol."],
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
            # Package acceptance must not create bytecode beside installed inputs.
            sys.dont_write_bytecode = True
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
        if getattr(error, "acceptance_independent_reader_cleanup_failed", False):
            receipt["independent_reader_cleanup_failure"] = True
        # A fixed label and its configured budget only; never command output.
        receipt.update(ACTIVE_STEP)
        if isinstance(error, AcceptanceFailure):
            receipt["failure"] = str(error)
        elif rig is not None and isinstance(error, rig.module.NativeError):
            receipt["native_failure"] = getattr(error, "code", "native-error")
            # Bounded native diagnostics only: the numeric Win32 code, the fixed
            # primitive label and its fixed flag summary. Never a path or bytes.
            detail = native_detail(error)
            if detail is not None:
                receipt["native_error"] = detail
        elif isinstance(error, subprocess.TimeoutExpired):
            receipt["failure"] = "A disposable fixture command exceeded its configured timeout; see active_step."
        else:
            receipt["failure"] = "The acceptance fixture could not complete; native diagnostics are not exposed."
    finally:
        cleanup_failure = bool(receipt.get("independent_reader_cleanup_failure"))
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
            if receipt["status"] != "failed":
                receipt["status"] = "cleanup-failed"
            receipt["cleanup_failure"] = True
            receipt["cleanup"] = False
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
