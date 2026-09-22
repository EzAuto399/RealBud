"""Windows IO for the owned memory journals. Public platform admission is held.

Only the request dispatcher constructs this facade. Native locks cooperate
with Hermes, while handle-bound publication avoids its in-place write fallback.
Deterministic private stages make interrupted writes inspectable and bounded;
the signed higher-level journals remain the authority for replay decisions.
"""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
import importlib.util
import ntpath
from pathlib import Path
import sys

MAX_BYTES = 128 * 1024
MAX_DIR = 2000


def _load_storage():
    path = Path(__file__).with_name("hermes-memory-windows.py")
    spec = importlib.util.spec_from_file_location("realbud_memory_windows_storage", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Windows memory storage is unavailable.")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    try:
        spec.loader.exec_module(module)
    except Exception:
        sys.modules.pop(spec.name, None)
        raise RuntimeError("Windows memory storage is unavailable.") from None
    return module.WindowsMemoryStorage


class WindowsJournalIO:
    def __init__(self, profile, *, storage=None):
        self._held = set()
        self.storage = storage if storage is not None else _load_storage()(
            profile, mutation_lock=self._require_lock,
        )
        self.profile = self.storage.profile
        self.error_type = self.storage.error

    def _fail(self, code):
        raise self.error_type(code)

    @contextmanager
    def _require_lock(self):
        review_lock = ntpath.normcase(ntpath.join(self.profile, ".realbud-memory-reviews", "review.lock"))
        if review_lock not in self._held:
            self._fail("unavailable")
        yield

    @contextmanager
    def lock(self, path):
        key = ntpath.normcase(path)
        if key in self._held:
            self._fail("conflict")
        with self.storage.lock(path):
            self._held.add(key)
            try:
                yield
            finally:
                self._held.remove(key)

    def read(self, path, *, limit=MAX_BYTES, missing_ok=False):
        return self.storage.read(path, limit=limit, missing_ok=missing_ok)

    def names(self, path, *, limit=MAX_DIR, missing_ok=True):
        return self.storage.names(path, limit=limit, missing_ok=missing_ok)

    def ensure_directory(self, path):
        # Private, exclusive creation is allowed before acquiring review.lock.
        # Existing directories must pass the same ACL and identity checks.
        return self.storage.ensure_directory(path)

    def verify_directory(self, path):
        return self.storage.verify_directory(path)

    def flush_file(self, path, *, expected_digest=None):
        return self.storage.flush_file(path, expected_digest=expected_digest)

    def write_new(self, path, data):
        with self._require_lock():
            return self.storage.write_new(path, data)

    def move_new(self, source, target, expected_digest):
        with self._require_lock():
            return self.storage.move_new(source, target, expected_digest)

    def delete_exact(self, path, expected_digest):
        with self._require_lock():
            return self.storage.delete_exact(path, expected_digest)

    def atomic_write(self, path, data):
        if not isinstance(data, bytes) or len(data) > MAX_BYTES:
            self._fail("capacity" if isinstance(data, bytes) else "invalid")
        with self._require_lock():
            # The memory lock has the exact filename used by native Hermes.
            memory_dir = ntpath.normcase(ntpath.join(self.profile, "memories"))
            if ntpath.normcase(ntpath.dirname(path)) == memory_dir:
                if ntpath.normcase(path + ".lock") not in self._held:
                    self._fail("unavailable")
            before = self.read(path, missing_ok=True)
            digest = hashlib.sha256(data).hexdigest()
            stage_key = hashlib.sha256(path.encode("utf-8") + b"\0" + data).hexdigest()
            stage = ntpath.join(ntpath.dirname(path), ".realbud-write-" + stage_key + ".stage")
            staged = self.read(stage, missing_ok=True)
            if staged is not None and staged != data:
                self._fail("conflict")
            if before == data:
                if staged is not None:
                    # Both names cannot result from our rename protocol. Never
                    # adopt/delete an unexpected leftover just because it fits.
                    self._fail("recovery-required")
                self.flush_file(path, expected_digest=digest)
                return
            if staged is None:
                if len(self.names(ntpath.dirname(path), limit=MAX_DIR, missing_ok=False)) >= MAX_DIR:
                    self._fail("capacity")
                self.write_new(stage, data)
            if before is None:
                self.move_new(stage, path, digest)
            else:
                self.storage.replace_from_stage(stage, path, digest, hashlib.sha256(before).hexdigest())
            if self.read(path) != data or self.read(stage, missing_ok=True) is not None:
                self._fail("recovery-required")
