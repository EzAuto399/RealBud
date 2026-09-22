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
                try:
                    handle = self._opened(stack, path, directory=True)
                except self.error as error:
                    # An absent ancestor never establishes an absent leaf.
                    raise self.error("unavailable" if error.code == "not-found" else error.code) from None
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
        try:
            with self.mutation_lock():
                yield
        except self.error as error:
            raise self.error(error.code) from None
        except Exception:
            # A host-owned lock can fail on enter or exit. Its native exception
            # may contain a private path; never expose it through this boundary.
            raise self.error("unavailable") from None

    def read(self, path, *, limit=MAX_BYTES, missing_ok=False):
        if type(missing_ok) is not bool or type(limit) is not int or not 0 <= limit <= MAX_BYTES:
            self._fail("invalid")
        with self._parents(path) as (stack, paths, _parents, root):
            try:
                handle = self._opened(stack, paths[0])
            except self.error as error:
                if missing_ok and error.code == "not-found":
                    return None
                raise
            return self._read_handle(handle, paths[0], root, limit)

    @contextmanager
    def _directory(self, path, *, create=False, missing_ok=False):
        candidate = _canonical(path)
        is_root = candidate is not None and _key(candidate) == _key(self.profile)
        # A synthetic child pins the existing profile itself. It is never opened.
        parent_target = self.profile + "\\.directory-probe" if is_root else path
        with self._parents(parent_target) as (stack, paths, _parents, root):
            if is_root:
                yield root, root
                return
            path = paths[0]
            try:
                handle = self._opened(stack, path, directory=True)
            except self.error as error:
                if error.code != "not-found":
                    raise
                if not create:
                    if missing_ok:
                        yield None, root
                        return
                    raise
                try:
                    handle = self.native.create_private_directory(path)
                    stack.callback(self.native.close, handle)
                    self._identity(handle, path, directory=True)
                except self.error as creation:
                    if creation.code != "conflict":
                        raise
                    handle = self._opened(stack, path, directory=True)
            self.native.verify_private(handle, private_root=root)
            yield handle, root

    def verify_directory(self, path):
        with self._directory(path):
            pass

    def ensure_directory(self, path):
        """Create one private child, or verify an existing directory unchanged."""
        with self._directory(path, create=True):
            pass

    def names(self, path, limit=2000, *, missing_ok=True):
        if type(limit) is not int or not 0 <= limit <= 10000 or type(missing_ok) is not bool:
            self._fail("invalid")
        with self._directory(path, missing_ok=missing_ok) as (handle, _root):
            return [] if handle is None else self.native.names(handle, limit)

    @contextmanager
    def lock(self, lock_path, timeout_ms=1000):
        """Pin and privately initialize the native-compatible byte-zero lock."""
        if type(timeout_ms) is not int or not 0 <= timeout_ms <= 10000:
            self._fail("invalid")
        body_error = None
        try:
            with self._parents(lock_path) as (stack, paths, _parents, root):
                path = paths[0]
                try:
                    handle = self.native.open_lock(path)
                except self.error as error:
                    if error.code != "not-found":
                        raise
                    try:
                        handle = self.native.open_lock(path, create=True)
                    except self.error as creation:
                        if creation.code != "conflict":
                            raise
                        handle = self.native.open_lock(path)
                stack.callback(self.native.close, handle)
                self._identity(handle, path)
                self.native.verify_private(handle, private_root=root)
                self.native.lock(handle, timeout_ms)
                try:
                    try:
                        yield
                    except BaseException as error:
                        # The caller owns its domain failures. Preserve them
                        # only if checked unlock and handle cleanup succeed.
                        body_error = error
                        raise
                finally:
                    self.native.unlock(handle)
        except self.error as error:
            if error is body_error:
                raise
            raise self.error(error.code) from None
        except Exception as error:
            if error is body_error:
                raise
            raise self.error("unavailable") from None

    def flush_file(self, path, expected_digest=None):
        if expected_digest is not None:
            self._digest(expected_digest)
        with self._mutation(), self._parents(path) as (stack, paths, _parents, root):
            handle = self._opened(stack, paths[0], writable=True)
            data = self._read_handle(handle, paths[0], root)
            if expected_digest is not None and hashlib.sha256(data).hexdigest() != expected_digest:
                self._fail("conflict")
            self.native.flush(handle)
            if self._read_handle(handle, paths[0], root) != data:
                self._fail("conflict")

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
            try:
                handle = self._opened(stack, paths[0], renameable=True)
            except self.error as error:
                if error.code == "not-found":
                    return "deleted"
                raise
            data = self._read_handle(handle, paths[0], root)
            if hashlib.sha256(data).hexdigest() != expected_digest:
                self._fail("conflict")
            # This binds disposition to the checked object. Other pre-existing
            # delete-sharing readers can defer removal beyond our owned close.
            # A checked close is necessary but not sufficient for namespace
            # absence: a delete-sharing reader may still hold the object.
            self.native.delete(handle)
            self.native.close(handle)
            try:
                self._opened(stack, paths[0])
            except self.error as error:
                if error.code == "not-found":
                    return "deleted"
                if error.code == "unavailable":
                    return "deletion-requested"
                raise
            return "deletion-requested"
