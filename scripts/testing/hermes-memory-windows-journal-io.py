#!/usr/bin/env python3
"""Portable facade fault tests. Dictionary storage is not native Win32 proof."""
from contextlib import contextmanager
import hashlib
import importlib.util
import ntpath
from pathlib import Path
import sys
import unittest

SOURCE = Path(__file__).resolve().parents[2] / "server/helpers/hermes-memory-windows-journal.py"
spec = importlib.util.spec_from_file_location("journal_io_under_test", SOURCE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
ROOT = r"C:\Fictional\Profile"
REVIEW = ntpath.join(ROOT, ".realbud-memory-reviews", "review.lock")
MEMORY = ntpath.join(ROOT, "memories", "MEMORY.md")
RECEIPT = ntpath.join(ROOT, ".realbud-memory-reviews", "1234abcd.json")


def digest(data):
    return hashlib.sha256(data).hexdigest()


class FixedError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


class Storage:
    error = FixedError
    profile = ROOT

    def __init__(self):
        self.files, self.calls, self.held = {}, [], set()
        self.fail = None
        self.delete_result = "deleted"

    def point(self, name):
        self.calls.append(name)
        if self.fail == name:
            raise FixedError("unavailable")

    @contextmanager
    def lock(self, path):
        self.point("lock")
        self.held.add(path)
        try:
            yield
        finally:
            self.held.remove(path)
            self.point("unlock")

    def read(self, path, *, limit=module.MAX_BYTES, missing_ok=False):
        self.point("read")
        if path not in self.files:
            if missing_ok:
                return None
            raise FixedError("not-found")
        data = self.files[path]
        if len(data) > limit:
            raise FixedError("capacity")
        return data

    def names(self, path, *, limit=module.MAX_DIR, missing_ok=True):
        self.point("names")
        names = [ntpath.basename(name) for name in self.files if ntpath.dirname(name) == path]
        if len(names) > limit:
            raise FixedError("capacity")
        return names

    def ensure_directory(self, path): self.point("ensure-directory")
    def verify_directory(self, path): self.point("verify-directory")

    def flush_file(self, path, *, expected_digest=None):
        self.point("flush")
        if expected_digest is not None and digest(self.files[path]) != expected_digest:
            raise FixedError("conflict")

    def write_new(self, path, data):
        self.point("write-new-before")
        if path in self.files:
            raise FixedError("conflict")
        self.files[path] = data
        self.point("write-new-after")

    def _move(self, source, target, staged_digest, target_digest=None):
        self.point("move-before")
        if digest(self.files[source]) != staged_digest:
            raise FixedError("conflict")
        if target_digest is None:
            if target in self.files:
                raise FixedError("conflict")
        elif digest(self.files[target]) != target_digest:
            raise FixedError("conflict")
        self.files[target] = self.files.pop(source)
        self.point("move-after")

    def move_new(self, source, target, expected_digest):
        return self._move(source, target, expected_digest)

    def replace_from_stage(self, source, target, staged_digest, target_digest):
        return self._move(source, target, staged_digest, target_digest)

    def delete_exact(self, path, expected_digest):
        if digest(self.files[path]) != expected_digest:
            raise FixedError("conflict")
        if self.delete_result == "deleted":
            del self.files[path]
        return self.delete_result


class FacadeTests(unittest.TestCase):
    def setUp(self):
        self.storage = Storage()
        self.io = module.WindowsJournalIO(ROOT, storage=self.storage)

    def assert_code(self, code, fn):
        with self.assertRaises(FixedError) as raised:
            fn()
        self.assertEqual(raised.exception.code, code)

    def stage(self, target=RECEIPT, data=b"new"):
        key = digest(target.encode() + b"\0" + data)
        return ntpath.join(ntpath.dirname(target), ".realbud-write-" + key + ".stage")

    def test_mutations_require_the_review_lock(self):
        for fn in (lambda: self.io.atomic_write(RECEIPT, b"new"),
                   lambda: self.io.write_new(RECEIPT, b"new"),
                   lambda: self.io.move_new(RECEIPT, MEMORY, digest(b"new")),
                   lambda: self.io.delete_exact(RECEIPT, digest(b"new"))):
            self.assert_code("unavailable", fn)
        self.assertEqual(self.storage.files, {})

    def test_memory_also_requires_its_native_target_lock(self):
        with self.io.lock(REVIEW):
            self.assert_code("unavailable", lambda: self.io.atomic_write(MEMORY, b"new"))
            with self.io.lock(MEMORY + ".lock"):
                self.io.atomic_write(MEMORY, b"new")
        self.assertEqual(self.storage.files, {MEMORY: b"new"})

    def test_new_receipt_publishes_whole_file(self):
        with self.io.lock(REVIEW):
            self.io.atomic_write(RECEIPT, b"new")
        self.assertEqual(self.storage.files, {RECEIPT: b"new"})

    def test_receipt_replacement_checks_old_bytes(self):
        self.storage.files[RECEIPT] = b"old"
        with self.io.lock(REVIEW):
            self.io.atomic_write(RECEIPT, b"new")
        self.assertEqual(self.storage.files, {RECEIPT: b"new"})

    def test_write_failure_preserves_old_and_retries_exact_stage(self):
        self.storage.files[RECEIPT] = b"old"
        with self.io.lock(REVIEW):
            self.storage.fail = "write-new-after"
            self.assert_code("unavailable", lambda: self.io.atomic_write(RECEIPT, b"new"))
            self.assertEqual(self.storage.files[RECEIPT], b"old")
            self.storage.fail = None
            self.io.atomic_write(RECEIPT, b"new")
        self.assertEqual(self.storage.files, {RECEIPT: b"new"})
        self.assertEqual(self.storage.calls.count("write-new-before"), 1)

    def test_uncertain_move_replay_flushes_without_rewrite(self):
        with self.io.lock(REVIEW):
            self.storage.fail = "move-after"
            self.assert_code("unavailable", lambda: self.io.atomic_write(RECEIPT, b"new"))
            self.storage.fail = None
            self.io.atomic_write(RECEIPT, b"new")
        self.assertEqual(self.storage.files, {RECEIPT: b"new"})
        self.assertEqual(self.storage.calls.count("move-before"), 1)
        self.assertEqual(self.storage.calls.count("flush"), 1)

    def test_partial_stage_preserves_every_byte(self):
        self.storage.files = {RECEIPT: b"old", self.stage(): b"partial"}
        before = dict(self.storage.files)
        with self.io.lock(REVIEW):
            self.assert_code("conflict", lambda: self.io.atomic_write(RECEIPT, b"new"))
        self.assertEqual(self.storage.files, before)

    def test_both_equal_names_are_held(self):
        self.storage.files = {RECEIPT: b"new", self.stage(): b"new"}
        with self.io.lock(REVIEW):
            self.assert_code("recovery-required", lambda: self.io.atomic_write(RECEIPT, b"new"))
        self.assertEqual(len(self.storage.files), 2)

    def test_collision_between_read_and_move_does_not_clobber(self):
        original = self.storage.move_new
        def collided(source, target, expected_digest):
            self.storage.files[target] = b"foreign"
            return original(source, target, expected_digest)
        self.storage.move_new = collided
        with self.io.lock(REVIEW):
            self.assert_code("conflict", lambda: self.io.atomic_write(RECEIPT, b"new"))
        self.assertEqual(self.storage.files[RECEIPT], b"foreign")
        self.assertEqual(self.storage.files[self.stage()], b"new")

    def test_changed_destination_does_not_replace(self):
        self.storage.files[RECEIPT] = b"old"
        original = self.storage.replace_from_stage
        def changed(source, target, staged_digest, target_digest):
            self.storage.files[target] = b"foreign"
            return original(source, target, staged_digest, target_digest)
        self.storage.replace_from_stage = changed
        with self.io.lock(REVIEW):
            self.assert_code("conflict", lambda: self.io.atomic_write(RECEIPT, b"new"))
        self.assertEqual(self.storage.files[RECEIPT], b"foreign")

    def test_capacity_counts_unrelated_names_before_new_stage(self):
        self.storage.files = {ntpath.join(ntpath.dirname(RECEIPT), str(i)): b"" for i in range(module.MAX_DIR)}
        with self.io.lock(REVIEW):
            self.assert_code("capacity", lambda: self.io.atomic_write(RECEIPT, b"new"))
        self.assertEqual(len(self.storage.files), module.MAX_DIR)

    def test_delete_pending_is_not_promoted_to_deleted(self):
        self.storage.files[RECEIPT] = b"new"
        self.storage.delete_result = "deletion-requested"
        with self.io.lock(REVIEW):
            self.assertEqual(self.io.delete_exact(RECEIPT, digest(b"new")), "deletion-requested")
        self.assertEqual(self.storage.files[RECEIPT], b"new")

    def test_unlock_failure_still_clears_facade_lock_ownership(self):
        self.storage.fail = "unlock"
        def operation():
            with self.io.lock(REVIEW):
                pass
        self.assert_code("unavailable", operation)
        self.assertEqual(self.io._held, set())
        self.assert_code("unavailable", lambda: self.io.atomic_write(RECEIPT, b"new"))

    def test_nested_duplicate_lock_is_refused(self):
        with self.io.lock(REVIEW):
            def operation():
                with self.io.lock(REVIEW):
                    pass
            self.assert_code("conflict", operation)
        self.assertEqual(self.io._held, set())


class CombinedProtocolTests(unittest.TestCase):
    """Real facade + real storage protocol; only native handles are fictional."""
    def setUp(self):
        fixture_spec = importlib.util.spec_from_file_location(
            "combined_journal_protocol_fixture", Path(__file__).with_name("hermes-memory-windows-protocol.py"),
        )
        self.fixture = importlib.util.module_from_spec(fixture_spec)
        sys.modules[fixture_spec.name] = self.fixture
        fixture_spec.loader.exec_module(self.fixture)
        self.native = self.fixture.FakeNative()
        self.storage = self.fixture.MODULE.WindowsMemoryStorage(self.fixture.PROFILE, native=self.native)
        self.io = module.WindowsJournalIO(self.fixture.PROFILE, storage=self.storage)
        self.storage.mutation_lock = self.io._require_lock
        directory = ntpath.join(self.fixture.PROFILE, ".realbud-memory-reviews")
        self.io.ensure_directory(directory)
        self.review = ntpath.join(directory, "review.lock")
        self.receipt = ntpath.join(directory, "1234abcd.json")

    def tearDown(self):
        self.assertTrue(all(handle.closed for handle in self.native.handles))
        self.assertEqual(self.io._held, set())

    def test_facade_and_protocol_publish_replace_and_replay(self):
        with self.io.lock(self.review):
            self.io.atomic_write(self.receipt, b"intent")
            self.io.atomic_write(self.receipt, b"final")
            self.io.atomic_write(self.receipt, b"final")
            self.assertEqual(self.io.read(self.receipt), b"final")
            self.assertEqual(set(self.io.names(ntpath.dirname(self.receipt))), {"review.lock", "1234abcd.json"})

    def test_target_lock_routes_to_whole_file_protocol(self):
        with self.io.lock(self.review), self.io.lock(self.fixture.MEMORY + ".lock"):
            self.io.atomic_write(self.fixture.MEMORY, b"New fictional preference.")
            self.assertEqual(self.io.read(self.fixture.MEMORY), b"New fictional preference.")

    def test_domain_failure_survives_both_context_layers(self):
        class CallerError(Exception):
            pass
        error = CallerError("stale-review")
        with self.assertRaises(CallerError) as raised:
            with self.io.lock(self.review):
                raise error
        self.assertIs(raised.exception, error)

    def test_protocol_missing_ancestor_is_not_empty_data(self):
        with self.assertRaises(self.fixture.FixedError) as raised:
            self.io.read(ntpath.join(self.fixture.PROFILE, "missing-parent", "absent.json"), missing_ok=True)
        self.assertEqual(raised.exception.code, "unavailable")


if __name__ == "__main__":
    unittest.main(verbosity=2)
