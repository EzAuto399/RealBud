Perform one independent focused implementation review. Use ONLY this supplied packet; no tools, web, shell, subagents, or additional turns. Return actual actionable defects with function/line evidence, trigger, impact and smallest correction. Separate proven defects from Windows execution questions. Do not return reasoning traces. A clean review is acceptable; no generic backlog.

Contract/scope: These two new owned modules implement Windows storage primitives and their checked protocol. Production Windows memory/review/proposal admission REMAINS HELD elsewhere; no release signoff is requested. Supported storage is local fixed NTFS with persistent ACLs only. The host supplies native sibling .lock/review lock context managers; concurrent writers are cooperative, except path/identity/reparse/ACL mistakes must fail closed. Do not demand arbitrary hostile same-SID or admin isolation, global target CAS, a new double-rename journal, or physical power-loss proof. Actual Windows runtime testing remains mandatory outside this review. Keep existing exact human review and signed-journal recovery contract; these modules are not the journal orchestrator.

Review checks: all ancestor objects pinned before descendant data access, leaf/ancestor reparse rejection, private protected root and per-child DACL checks before/after, same-object identity and bounded read/write behavior, correct typed Win32 ABI/access/share flags, source-HANDLE rename with RootDirectory, no-clobber vs intentional cooperative replacement, dispose and close cleanup, fixed errors/no paths or data leakage. No path copy/truncate fallback. Same-source-handle readback is chosen to avoid reopening a source that holds GENERIC_WRITE|DELETE; do not demand share flags broadened without an actual second-open call.

Prior documented review conclusions: public FileRenameInfo permits relative RootDirectory and ReplaceIfExists=false/true; replacement is not target object CAS. File source deny WRITE/DELETE sharing is compatible with its own handle-bound rename; parent pins allow READ|WRITE sharing and deny DELETE but do not freeze children. Existing unsafe child ACLs are not repaired by a protected parent. Protected DACL stops inbound inheritance, not safe OI/CI propagation. Write-through and checked file flushes request NTFS persistence but do not prove cross-file transaction or power-loss recovery. Native Hermes _write_file/atomic_replace/stage_write cannot be used for this strict path because of copy/in-place fallback and suppressed staging exceptions. Source handles must stay open through post-rename verification. An ambiguous result is reconciled by host journal, never blindly replayed. Error5 can mean ACL denial or sharing contention. No hardlink publication recommended. Review actual code rather than repeating these already-acknowledged limits.

Return at most6 concrete findings, ordered by impact, and short reviewed/untested scope. If a supposed defect depends on a Windows API fact not established by supplied code, label it uncertain, do not claim it proven. Exact source snapshots follow.

FILE server/helpers/hermes-memory-windows.py SHA256 46ae82871600ce6a0003092b05dad3557ebbad7c4e601ef77b57fac21021d695
```python
"""Owned Windows memory-storage protocol; production admission remains disabled.

The native layer owns Win32 handles, ACLs and sharing. This layer pins every
ancestor, binds child paths to one protected profile and checks exact bytes.
Mutations require a host-supplied context manager using the native memory lock
(or the review lock for pending/journal files). It is never a serialized option.
No operation copies through, truncates or repairs an existing destination.
Flushes and handle-bound renames are not a claim of physical power-loss proof.
"""
from __future__ import annotations

from contextlib import ExitStack, contextmanager
import hashlib
import importlib.util
import ntpath
from pathlib import Path
import re
import sys

MAX_BYTES = 128 * 1024
MAX_DEPTH = 64
_NATIVE_NAME = "realbud_memory_windows_native"
_native_module = None


def _native():
    global _native_module
    if _native_module is None:
        path = Path(__file__).with_name("hermes-memory-windows-native.py")
        spec = importlib.util.spec_from_file_location(_NATIVE_NAME, path)
        if spec is None or spec.loader is None:
            raise RuntimeError("Windows memory storage is unavailable.")
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        try:
            spec.loader.exec_module(module)
        except Exception:
            sys.modules.pop(spec.name, None)
            raise RuntimeError("Windows memory storage is unavailable.") from None
        _native_module = module
    return _native_module


def _canonical(path):
    """Accept ordinary absolute local paths, never device paths, ADS or aliases."""
    if not isinstance(path, str) or not path or len(path) > 32700:
        return None
    path = path.replace("/", "\\")
    if not re.fullmatch(r"[A-Za-z]:\\.*", path):
        return None
    if any(ord(char) < 32 or 0xD800 <= ord(char) <= 0xDFFF for char in path):
        return None
    tail = path[3:]
    if not tail:
        return path[0].upper() + ":\\"
    parts = tail.split("\\")
    if len(parts) > MAX_DEPTH or any(
        not part or part in (".", "..") or part[-1] in " ."
        or any(char in part for char in ':*?"<>|')
        or re.fullmatch(r"(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\..*)?", part, re.I)
        for part in parts
    ):
        return None
    return path[0].upper() + ":\\" + "\\".join(parts)


def _key(path):
    return ntpath.normcase(path)


def _final_path(path):
    # Only trusted handle results may carry the Win32 extended drive prefix.
    if isinstance(path, str) and path.startswith("\\\\?\\"):
        path = path[4:]
    return _canonical(path)


class WindowsMemoryStorage:
    def __init__(self, profile, *, native=None, mutation_lock=None):
        self.native = native if native is not None else _native().Win32Native()
        self.error = self.native.error_type
        self.profile = _canonical(profile)
        if self.profile is None or len(self.profile) <= 3:
            self._fail("unsafe-storage")
        self.mutation_lock = mutation_lock

    def _fail(self, code):
        raise self.error(code)

    def _child(self, path):
        candidate = _canonical(path)
        prefix = self.profile + "\\"
        if candidate is None or not _key(candidate).startswith(_key(prefix)):
            self._fail("unsafe-storage")
        # Always use the captured root's spelling, including on a volume with
        # case-sensitive directories. A caller cannot substitute a sibling root.
        return prefix + candidate[len(prefix):]

    def _digest(self, digest):
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            self._fail("invalid")
        return digest

    def _opened(self, stack, path, *, directory=False, writable=False, renameable=False):
        handle = self.native.open_existing(path, directory=directory, writable=writable, renameable=renameable)
        stack.callback(self.native.close, handle)
        self._identity(handle, path, directory=directory)
        return handle

    def _identity(self, handle, path, *, directory=False):
        identity = self.native.snapshot(handle)
        final = _final_path(identity.final_path)
        if final is None or _key(final) != _key(path) or bool(identity.attributes & 0x10) != directory:
            self._fail("unsafe-storage")
        if not directory and identity.links != 1:
            self._fail("unsafe-storage")
        return identity

    @contextmanager
    def _parents(self, *paths):
        paths = tuple(self._child(path) for path in paths)
        directories = {}
        for path in paths:
            parent = ntpath.dirname(path)
            while True:
                directories.setdefault(_key(parent), parent)
                if len(parent) <= 3:
                    break
                parent = ntpath.dirname(parent)
        with ExitStack() as stack:
            handles = {}
            root = None
            # Parent handles deny delete sharing, so every verified ancestor
            # remains pinned until the operation and all checks have finished.
            for key, path in sorted(directories.items(), key=lambda pair: (pair[0].count("\\"), pair[0])):
                handle = self._opened(stack, path, directory=True)
                handles[key] = handle
                if key == _key(self.profile):
                    self.native.verify_private(handle)
                    root = handle
                elif key.startswith(_key(self.profile + "\\")):
                    if root is None:
                        self._fail("unsafe-storage")
                    self.native.verify_private(handle, private_root=root)
            if root is None:
                self._fail("unsafe-storage")
            yield stack, paths, handles, root

    def _read_handle(self, handle, path, root, limit=MAX_BYTES):
        if type(limit) is not int or not 0 <= limit <= MAX_BYTES:
            self._fail("invalid")
        self.native.verify_private(handle, private_root=root)
        before = self._identity(handle, path)
        if before.size > limit:
            self._fail("capacity")
        data = self.native.read(handle, limit)
        self.native.verify_private(handle, private_root=root)
        after = self._identity(handle, path)
        if before != after or not isinstance(data, bytes) or len(data) != before.size:
            self._fail("conflict")
        return data

    @contextmanager
    def _mutation(self):
        if not callable(self.mutation_lock):
            self._fail("unavailable")
        with self.mutation_lock():
            yield

    def read(self, path, *, limit=MAX_BYTES):
        with self._parents(path) as (stack, paths, _parents, root):
            handle = self._opened(stack, paths[0])
            return self._read_handle(handle, paths[0], root, limit)

    def write_new(self, path, data):
        if not isinstance(data, bytes) or len(data) > MAX_BYTES:
            self._fail("capacity" if isinstance(data, bytes) else "invalid")
        with self._mutation(), self._parents(path) as (stack, paths, _parents, root):
            handle = self.native.create_private_file(paths[0])
            stack.callback(self.native.close, handle)
            self.native.verify_private(handle, private_root=root)
            before = self._identity(handle, paths[0])
            if before.size != 0:
                self._fail("conflict")
            self.native.write(handle, data)
            self.native.flush(handle)
            if self._read_handle(handle, paths[0], root) != data:
                self._fail("recovery-required")
        # Failure leaves the exclusively created private stage for its owner's
        # journal recovery. Never unlink an uncertain pathname as cleanup.

    def move_new(self, source, target, expected_digest):
        """Publish/claim one verified file without replacing any destination."""
        return self._move(source, target, expected_digest, None)

    def replace_from_stage(self, source, target, staged_digest, target_digest):
        """Replace only under the caller's native target lock and exact old bytes."""
        self._digest(target_digest)
        return self._move(source, target, staged_digest, target_digest)

    def _move(self, source, target, staged_digest, target_digest):
        self._digest(staged_digest)
        if _key(self._child(source)) == _key(self._child(target)):
            self._fail("invalid")
        with self._mutation(), self._parents(source, target) as (stack, paths, parents, root):
            source, target = paths
            source_handle = self._opened(stack, source, writable=True, renameable=True)
            data = self._read_handle(source_handle, source, root)
            if hashlib.sha256(data).hexdigest() != staged_digest:
                self._fail("conflict")
            original = self._identity(source_handle, source)
            self.native.flush(source_handle)
            if target_digest is not None:
                # Source-handle rename is not an arbitrary-writer destination
                # CAS. Private ancestry and the native cooperative lock matter.
                with ExitStack() as target_stack:
                    target_handle = self._opened(target_stack, target)
                    before = self._read_handle(target_handle, target, root)
                    if hashlib.sha256(before).hexdigest() != target_digest:
                        self._fail("conflict")
            parent = parents[_key(ntpath.dirname(target))]
            self.native.rename(source_handle, parent, ntpath.basename(target), replace=target_digest is not None)
            self.native.flush(source_handle)
            current = self._identity(source_handle, target)
            if (original.volume_serial, original.file_index) != (current.volume_serial, current.file_index):
                self._fail("recovery-required")
            if self._read_handle(source_handle, target, root) != data:
                self._fail("recovery-required")

    def delete_exact(self, path, expected_digest):
        self._digest(expected_digest)
        with self._mutation(), self._parents(path) as (stack, paths, _parents, root):
            handle = self._opened(stack, paths[0], renameable=True)
            data = self._read_handle(handle, paths[0], root)
            if hashlib.sha256(data).hexdigest() != expected_digest:
                self._fail("conflict")
            # Deletion binds to the open object, then completes when its owned
            # handle closes. A close error propagates instead of claiming done.
            self.native.delete(handle)

```

FILE server/helpers/hermes-memory-windows-native.py SHA256 61ffd50da933fe09021b04616dc5c7d8161bc0edbd2c5e225d397c25c9e0a71a
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
