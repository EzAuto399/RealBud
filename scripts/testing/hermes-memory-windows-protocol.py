#!/usr/bin/env python3
"""Portable protocol/failure tests. These do not exercise any Windows API."""
from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import importlib.util
import io
import ntpath
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("realbud_windows_protocol_test_subject", ROOT / "server/helpers/hermes-memory-windows.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
PROFILE = r"C:\RealBud\Office"
MEMORY = PROFILE + r"\memories\MEMORY.md"
STAGE = PROFILE + r"\reviews\prepared.stage"
sha = lambda data: hashlib.sha256(data).hexdigest()


class FixedError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class Snapshot:
    volume_serial: int
    file_index: int
    attributes: int
    links: int
    size: int
    creation_ticks: int
    last_write_ticks: int
    final_path: str


@dataclass
class Node:
    path: str
    identity: int
    directory: bool = False
    content: bytes = b""
    private: bool = True
    links: int = 1
    tick: int = 1
    final_path: str = ""


@dataclass
class Handle:
    node: Node
    writable: bool = False
    renameable: bool = False
    closed: bool = False
    locked: bool = False


class FakeNative:
    error_type = FixedError

    def __init__(self):
        self.nodes = {}
        self.handles = []
        self.log = []
        self.hook = lambda op, handle: None
        for path in ["C:\\", r"C:\RealBud", PROFILE, PROFILE + r"\memories", PROFILE + r"\reviews"]:
            self.add(path, directory=True)
        self.add(MEMORY, content=b"Old fictional preference.")

    def add(self, path, **kwargs):
        node = Node(path, len(self.nodes) + 1, **kwargs)
        self.nodes[ntpath.normcase(path)] = node
        return node

    def open_existing(self, path, *, directory=False, writable=False, renameable=False):
        self.log.append(("open", path, directory, writable, renameable))
        node = self.nodes.get(ntpath.normcase(path))
        if node is None:
            raise FixedError("not-found" if ntpath.normcase(ntpath.dirname(path)) in self.nodes else "unavailable")
        if node.directory != directory:
            raise FixedError("unsafe-storage")
        handle = Handle(node, writable, renameable)
        self.handles.append(handle)
        return handle

    def create_private_file(self, path):
        self.log.append(("create", path))
        if ntpath.normcase(path) in self.nodes:
            raise FixedError("conflict")
        self.add(path)
        return self.open_existing(path, writable=True, renameable=True)

    def create_private_directory(self, path):
        self.log.append(("mkdir", path))
        if ntpath.normcase(path) in self.nodes:
            raise FixedError("conflict")
        self.add(path, directory=True)
        return self.open_existing(path, directory=True)

    def names(self, handle, limit):
        self.log.append(("names", handle.node.path))
        self.hook("names", handle)
        names = [ntpath.basename(n.path) for n in self.nodes.values() if ntpath.normcase(ntpath.dirname(n.path)) == ntpath.normcase(handle.node.path) and n is not handle.node]
        if len(names) > limit:
            raise FixedError("capacity")
        return names

    def open_lock(self, path, *, create=False):
        self.log.append(("open-lock", path, create))
        if create:
            if ntpath.normcase(path) in self.nodes:
                raise FixedError("conflict")
            self.add(path)
        return self.open_existing(path, writable=True)

    def lock(self, handle, timeout_ms):
        self.log.append(("lock", handle.node.path, timeout_ms))
        self.hook("lock", handle)
        handle.locked = True

    def unlock(self, handle):
        self.log.append(("unlock", handle.node.path))
        self.hook("unlock", handle)
        handle.locked = False

    def verify_private(self, handle, *, private_root=None):
        self.log.append(("privacy", handle.node.path, private_root.node.path if private_root else None))
        self.hook("privacy", handle)
        if not handle.node.private:
            raise FixedError("unsafe-storage")

    def snapshot(self, handle):
        self.hook("snapshot", handle)
        n = handle.node
        return Snapshot(1, n.identity, 0x10 if n.directory else 0x80, n.links, len(n.content), 1, n.tick, n.final_path or n.path)

    def read(self, handle, limit):
        self.log.append(("read", handle.node.path))
        data = handle.node.content
        if len(data) > limit:
            raise FixedError("capacity")
        self.hook("read", handle)
        return data

    def write(self, handle, data):
        self.log.append(("write", handle.node.path))
        self.hook("write", handle)
        assert handle.writable
        handle.node.content = data
        handle.node.tick += 1

    def flush(self, handle):
        self.log.append(("flush", handle.node.path))
        self.hook("flush", handle)

    def rename(self, handle, parent, leaf, *, replace=False):
        destination = ntpath.join(parent.node.path, leaf)
        self.log.append(("rename", handle.node.path, destination, replace))
        self.hook("rename", handle)
        assert handle.renameable and not parent.closed
        if not replace and ntpath.normcase(destination) in self.nodes:
            raise FixedError("conflict")
        # Model the Windows sharing prerequisite; the target read handle must
        # have been closed, while source and ancestors must still be pinned.
        assert not any(not other.closed and ntpath.normcase(other.node.path) == ntpath.normcase(destination) for other in self.handles)
        del self.nodes[ntpath.normcase(handle.node.path)]
        handle.node.path = destination
        self.nodes[ntpath.normcase(destination)] = handle.node

    def delete(self, handle):
        self.log.append(("delete", handle.node.path))
        self.hook("delete", handle)
        assert handle.renameable
        del self.nodes[ntpath.normcase(handle.node.path)]

    def close(self, handle):
        if handle.closed:
            return
        self.log.append(("close", handle.node.path))
        self.hook("close", handle)
        handle.closed = True


class WindowsProtocol(unittest.TestCase):
    def setUp(self):
        self.native = FakeNative()
        self.locked = False

        @contextmanager
        def lock():
            self.assertFalse(self.locked)
            self.locked = True
            try:
                yield
            finally:
                self.locked = False

        self.store = MODULE.WindowsMemoryStorage(PROFILE, native=self.native, mutation_lock=lock)

    def tearDown(self):
        self.assertFalse(self.locked)

    def stage(self, data=b"New fictional preference."):
        self.native.add(STAGE, content=data)
        return data

    def test_binds_private_children_and_pins_every_ancestor(self):
        self.assertEqual(self.store.read(MEMORY), b"Old fictional preference.")
        opened = [event[1] for event in self.native.log if event[0] == "open"]
        self.assertEqual(opened, ["C:\\", r"C:\RealBud", PROFILE, PROFILE + r"\memories", MEMORY])
        privacy = [event for event in self.native.log if event[0] == "privacy"]
        self.assertIn(("privacy", PROFILE, None), privacy)
        self.assertIn(("privacy", MEMORY, PROFILE), privacy)
        self.assertTrue(all(h.closed for h in self.native.handles))

    def test_missing_read_only_accepts_leaf_absence_with_every_parent_pinned(self):
        target = PROFILE + r"\reviews\missing.json"
        self.assertIsNone(self.store.read(target, missing_ok=True))
        with self.assertRaisesRegex(FixedError, "^not-found$"):
            self.store.read(target)
        del self.native.nodes[ntpath.normcase(PROFILE + r"\reviews")]
        with self.assertRaisesRegex(FixedError, "^unavailable$"):
            self.store.read(target, missing_ok=True)
        self.assertTrue(all(h.closed for h in self.native.handles))

    def test_access_failure_is_not_missing_and_invalid_missing_options_are_rejected(self):
        opened = self.native.open_existing
        def denied(path, **options):
            if path == STAGE:
                raise FixedError("unavailable")
            return opened(path, **options)
        self.native.open_existing = denied
        with self.assertRaisesRegex(FixedError, "^unavailable$"):
            self.store.read(STAGE, missing_ok=True)
        for options in [{"missing_ok": 1}, {"limit": True}, {"limit": -1}]:
            with self.assertRaisesRegex(FixedError, "^invalid$"):
                self.store.read(STAGE, **options)

    def test_directories_create_private_one_level_or_verify_without_repair(self):
        target = PROFILE + r"\new-journal"
        self.store.ensure_directory(target)
        self.assertTrue(self.native.nodes[ntpath.normcase(target)].private)
        self.store.ensure_directory(target)
        self.store.verify_directory(target)
        self.store.verify_directory(PROFILE)
        self.assertEqual(len([event for event in self.native.log if event[0] == "mkdir"]), 1)
        self.native.nodes[ntpath.normcase(target)].private = False
        with self.assertRaisesRegex(FixedError, "^unsafe-storage$"):
            self.store.ensure_directory(target)
        self.assertFalse(self.native.nodes[ntpath.normcase(target)].private)
        with self.assertRaisesRegex(FixedError, "^unavailable$"):
            self.store.ensure_directory(PROFILE + r"\absent-parent\child")

    def test_directory_creation_collision_verifies_winner_without_repair(self):
        target = PROFILE + r"\new-journal"
        def racing(path):
            self.native.add(path, directory=True, private=False)
            raise FixedError("conflict")
        self.native.create_private_directory = racing
        with self.assertRaisesRegex(FixedError, "^unsafe-storage$"):
            self.store.ensure_directory(target)
        self.assertFalse(self.native.nodes[ntpath.normcase(target)].private)
        self.assertTrue(all(h.closed for h in self.native.handles))

    def test_names_pin_private_directory_and_ancestors_and_enforce_limits(self):
        directory = PROFILE + r"\reviews"
        self.stage()
        def check(op, handle):
            if op == "names":
                self.assertFalse(handle.closed)
                self.assertTrue(any(h.node.path == PROFILE and not h.closed for h in self.native.handles))
        self.native.hook = check
        self.assertEqual(self.store.names(directory, 1), ["prepared.stage"])
        with self.assertRaisesRegex(FixedError, "^capacity$"):
            self.store.names(directory, 0)
        self.assertEqual(self.store.names(PROFILE + r"\missing-dir"), [])
        with self.assertRaisesRegex(FixedError, "^unavailable$"):
            self.store.names(PROFILE + r"\missing-parent\missing-dir")
        self.native.nodes[ntpath.normcase(directory)].private = False
        with self.assertRaisesRegex(FixedError, "^unsafe-storage$"):
            self.store.names(directory)

    def test_native_lock_bootstraps_without_host_mutation_lock_and_holds_ancestry(self):
        store = MODULE.WindowsMemoryStorage(PROFILE, native=self.native)
        lock_path = MEMORY + ".lock"
        for _ in range(2):
            with store.lock(lock_path, timeout_ms=0):
                handle = next(h for h in reversed(self.native.handles) if h.node.path == lock_path)
                self.assertTrue(handle.locked)
                self.assertFalse(handle.closed)
                self.assertTrue(any(h.node.path == PROFILE and not h.closed for h in self.native.handles))
            self.assertFalse(handle.locked)
            self.assertTrue(handle.closed)
        self.assertEqual(len([event for event in self.native.log if event[0] == "open-lock" and event[2]]), 1)
        self.assertEqual(self.native.nodes[ntpath.normcase(lock_path)].content, b"")

    def test_lock_release_errors_are_fixed_and_other_handles_close(self):
        lock_path = MEMORY + ".lock"
        def fail(op, _handle):
            if op == "unlock":
                raise OSError("fictional-private-release-details")
        self.native.hook = fail
        with self.assertRaisesRegex(FixedError, "^unavailable$"):
            with self.store.lock(lock_path):
                pass
        self.assertTrue(all(h.closed for h in self.native.handles))

    def test_caller_domain_failure_survives_successful_unlock_and_cleanup(self):
        class CallerError(Exception):
            def __init__(self, code):
                self.code = code
                super().__init__(code)
        for code in ["stale-review", "disabled", "conflict"]:
            expected = CallerError(code)
            with self.subTest(code=code), self.assertRaises(CallerError) as raised:
                with self.store.lock(MEMORY + ".lock"):
                    raise expected
            self.assertIs(raised.exception, expected)
            self.assertEqual(raised.exception.code, code)
            self.assertTrue(all(h.closed for h in self.native.handles))
            self.assertEqual(self.native.log[-1][0], "close")

    def test_unlock_failure_overrides_body_failure_with_fixed_recovery_error(self):
        def fail(op, _handle):
            if op == "unlock":
                raise OSError("fictional-private-release-details")
        self.native.hook = fail
        with self.assertRaisesRegex(FixedError, "^unavailable$"):
            with self.store.lock(MEMORY + ".lock"):
                raise ValueError("caller failure")

    def test_flush_checks_exact_bytes_and_preserves_file_on_mismatch(self):
        data = self.native.nodes[ntpath.normcase(MEMORY)].content
        with self.assertRaisesRegex(FixedError, "^conflict$"):
            self.store.flush_file(MEMORY, "0" * 64)
        self.assertFalse(any(event[0] == "flush" for event in self.native.log))
        self.store.flush_file(MEMORY, sha(data))
        self.assertEqual(self.native.nodes[ntpath.normcase(MEMORY)].content, data)
        self.assertFalse(any(event[0] in ("write", "delete", "rename") for event in self.native.log))
        def drift(op, handle):
            if op == "flush":
                handle.node.content = b"Changed while flushing."
                handle.node.tick += 1
        self.native.hook = drift
        with self.assertRaisesRegex(FixedError, "^conflict$"):
            self.store.flush_file(MEMORY)

    def test_rejects_escape_device_ads_alias_and_sibling_paths_before_open(self):
        for path in [r"C:\RealBud\Other\memory", r"C:\RealBud\Office2\memory", r"C:\RealBud\Office\..\other", r"C:\RealBud\Office\memory:secret", r"\\?\C:\RealBud\Office\memory", r"\\server\share\memory", r"C:memory", PROFILE + "\\file. ", PROFILE + r"\NUL.txt", PROFILE + r"\COM¹"]:
            with self.subTest(path=path), self.assertRaises(FixedError):
                self.store.read(path)
        self.assertEqual(self.native.log, [])

    def test_preserves_captured_profile_spelling_for_case_variant_input(self):
        self.store.read(r"c:\realbud\office\memories\MEMORY.md")
        self.assertEqual([event[1] for event in self.native.log if event[0] == "open"][-1], MEMORY)

    def test_changed_handle_path_or_multiple_links_refused_without_read(self):
        for patch in [{"links": 2}, {"final_path": r"C:\Other\MEMORY.md"}]:
            with self.subTest(patch=patch):
                self.setUp()
                node = self.native.nodes[ntpath.normcase(MEMORY)]
                for key, value in patch.items():
                    setattr(node, key, value)
                with self.assertRaises(FixedError):
                    self.store.read(MEMORY)
                self.assertFalse(any(event[0] == "read" for event in self.native.log))
                self.assertTrue(all(h.closed for h in self.native.handles))

    def test_read_drift_or_acl_change_never_returns_unverified_bytes(self):
        for kind in ["bytes", "privacy"]:
            with self.subTest(kind=kind):
                self.setUp()
                def change(op, handle):
                    if op == "read":
                        if kind == "bytes":
                            handle.node.content += b"Changed."
                            handle.node.tick += 1
                        else:
                            handle.node.private = False
                self.native.hook = change
                with self.assertRaises(FixedError):
                    self.store.read(MEMORY)
                self.assertTrue(all(h.closed for h in self.native.handles))

    def test_native_lock_required_before_any_mutation(self):
        store = MODULE.WindowsMemoryStorage(PROFILE, native=self.native)
        with self.assertRaises(FixedError):
            store.write_new(STAGE, b"Fictional.")
        self.assertEqual(self.native.log, [])

    def test_host_lock_enter_failure_hides_private_native_details_before_io(self):
        @contextmanager
        def broken_lock():
            raise OSError("fictional-private-lock-path")
            yield
        self.store.mutation_lock = broken_lock
        with self.assertRaises(FixedError) as result:
            self.store.write_new(STAGE, b"Fictional.")
        self.assertEqual(str(result.exception), "unavailable")
        self.assertEqual(self.native.log, [])

    def test_lock_exit_failure_is_fixed_and_leaves_prepared_bytes_for_recovery(self):
        @contextmanager
        def broken_exit():
            yield
            raise OSError("fictional-private-lock-path")
        self.store.mutation_lock = broken_exit
        with self.assertRaises(FixedError) as result:
            self.store.write_new(STAGE, b"Fictional.")
        self.assertEqual(str(result.exception), "unavailable")
        self.assertEqual(self.native.nodes[ntpath.normcase(STAGE)].content, b"Fictional.")
        self.assertTrue(all(h.closed for h in self.native.handles))

    def test_new_file_is_private_empty_and_locked_before_content(self):
        def inspect(op, handle):
            if op == "write":
                self.assertTrue(self.locked)
                self.assertTrue(handle.node.private)
                self.assertEqual(handle.node.content, b"")
                self.assertTrue(any(event[0] == "privacy" and event[1] == STAGE for event in self.native.log))
        self.native.hook = inspect
        self.store.write_new(STAGE, b"Fictional.")
        self.assertEqual(self.native.nodes[ntpath.normcase(STAGE)].content, b"Fictional.")
        self.assertTrue(all(h.closed for h in self.native.handles))

    def test_new_write_never_overwrites_existing_and_uncertain_flush_keeps_stage(self):
        before = self.native.nodes[ntpath.normcase(MEMORY)].content
        with self.assertRaises(FixedError):
            self.store.write_new(MEMORY, b"Must not overwrite.")
        self.assertEqual(self.native.nodes[ntpath.normcase(MEMORY)].content, before)
        def fail(op, _handle):
            if op == "flush":
                raise FixedError("unavailable")
        self.native.hook = fail
        with self.assertRaises(FixedError):
            self.store.write_new(STAGE, b"Recovery stage.")
        self.assertEqual(self.native.nodes[ntpath.normcase(STAGE)].content, b"Recovery stage.")
        self.assertFalse(any(event[0] == "delete" for event in self.native.log))

    def test_bounded_reads_and_writes(self):
        for size in [-1, 131073, True]:
            with self.subTest(limit=size), self.assertRaises(FixedError):
                self.store.read(MEMORY, limit=size)
        with self.assertRaises(FixedError):
            self.store.write_new(STAGE, b"a" * 131073)
        self.assertNotIn(ntpath.normcase(STAGE), self.native.nodes)

    def test_no_clobber_publication_and_handle_identity_preservation(self):
        data = self.stage()
        original = self.native.nodes[ntpath.normcase(STAGE)].identity
        target = PROFILE + r"\memories\proposal.json"
        self.store.move_new(STAGE, target, sha(data))
        self.assertNotIn(ntpath.normcase(STAGE), self.native.nodes)
        self.assertEqual(self.native.nodes[ntpath.normcase(target)].identity, original)
        self.assertEqual(self.native.nodes[ntpath.normcase(target)].content, data)

    def test_existing_publication_target_keeps_both_files(self):
        data = self.stage()
        old = self.native.nodes[ntpath.normcase(MEMORY)].content
        with self.assertRaises(FixedError):
            self.store.move_new(STAGE, MEMORY, sha(data))
        self.assertEqual(self.native.nodes[ntpath.normcase(STAGE)].content, data)
        self.assertEqual(self.native.nodes[ntpath.normcase(MEMORY)].content, old)

    def test_exact_whole_file_replacement_closes_target_but_pins_ancestry(self):
        data = self.stage()
        before = self.native.nodes[ntpath.normcase(MEMORY)].content
        def check(op, _handle):
            if op == "rename":
                self.assertTrue(self.locked)
                self.assertTrue(any(h.node.path == PROFILE and not h.closed for h in self.native.handles))
        self.native.hook = check
        self.store.replace_from_stage(STAGE, MEMORY, sha(data), sha(before))
        self.assertEqual(self.native.nodes[ntpath.normcase(MEMORY)].content, data)
        self.assertFalse(any(event[0] == "write" for event in self.native.log))
        self.assertTrue(all(h.closed for h in self.native.handles))

    def test_changed_target_or_stage_never_renames(self):
        data = self.stage()
        for old_hash, staged_hash in [("0" * 64, sha(data)), (sha(self.native.nodes[ntpath.normcase(MEMORY)].content), "0" * 64)]:
            with self.subTest(old=old_hash), self.assertRaises(FixedError):
                self.store.replace_from_stage(STAGE, MEMORY, staged_hash, old_hash)
        self.assertFalse(any(event[0] == "rename" for event in self.native.log))
        self.assertIn(ntpath.normcase(STAGE), self.native.nodes)

    def test_sharing_failure_has_no_copy_truncate_or_delete_fallback(self):
        data = self.stage()
        before = self.native.nodes[ntpath.normcase(MEMORY)].content
        def fail(op, _handle):
            if op == "rename":
                raise FixedError("unavailable")
        self.native.hook = fail
        with self.assertRaises(FixedError):
            self.store.replace_from_stage(STAGE, MEMORY, sha(data), sha(before))
        self.assertEqual(self.native.nodes[ntpath.normcase(MEMORY)].content, before)
        self.assertEqual(self.native.nodes[ntpath.normcase(STAGE)].content, data)
        self.assertFalse(any(event[0] in ("write", "delete") for event in self.native.log))

    def test_cleanup_requires_matching_bytes_and_delete_capable_handle(self):
        data = self.stage()
        with self.assertRaises(FixedError):
            self.store.delete_exact(STAGE, "0" * 64)
        self.assertIn(ntpath.normcase(STAGE), self.native.nodes)
        self.assertEqual(self.store.delete_exact(STAGE, sha(data)), "deleted")
        self.assertNotIn(ntpath.normcase(STAGE), self.native.nodes)
        self.assertEqual(self.store.delete_exact(STAGE, sha(data)), "deleted")

    def test_pending_delete_is_not_a_terminal_absence_receipt(self):
        data = self.stage()
        # Model another process's delete-sharing reader retaining the object.
        # Requested disposition alone cannot prove namespace absence.
        self.native.delete = lambda _handle: None
        self.assertEqual(self.store.delete_exact(STAGE, sha(data)), "deletion-requested")
        self.assertIn(ntpath.normcase(STAGE), self.native.nodes)
        self.assertTrue(all(h.closed for h in self.native.handles))

    def test_delete_probe_retains_parent_pins_and_cannot_consume_replacement(self):
        data = self.stage()
        original_close = self.native.close
        def replace_after_close(handle):
            original_close(handle)
            if handle.node.path == STAGE and ntpath.normcase(STAGE) not in self.native.nodes:
                self.assertTrue(any(h.node.path == PROFILE and not h.closed for h in self.native.handles))
                self.native.add(STAGE, content=b"Foreign replacement.")
        self.native.close = replace_after_close
        self.assertEqual(self.store.delete_exact(STAGE, sha(data)), "deletion-requested")
        self.assertEqual(self.native.nodes[ntpath.normcase(STAGE)].content, b"Foreign replacement.")
        self.assertEqual(len([event for event in self.native.log if event[0] == "delete"]), 1)

    def test_delete_access_denied_after_disposition_is_never_terminal_absence(self):
        data = self.stage()
        original_open = self.native.open_existing
        def retained_reader(path, **options):
            if path == STAGE and ntpath.normcase(STAGE) not in self.native.nodes:
                raise FixedError("unavailable")
            return original_open(path, **options)
        self.native.open_existing = retained_reader
        self.assertEqual(self.store.delete_exact(STAGE, sha(data)), "deletion-requested")

    def test_close_failure_does_not_report_completion_and_other_handles_drain(self):
        data = self.stage()
        def fail(op, handle):
            if op == "close" and handle.node.path == STAGE:
                raise FixedError("unavailable")
        self.native.hook = fail
        with self.assertRaises(FixedError):
            self.store.delete_exact(STAGE, sha(data))
        self.assertTrue(all(h.closed for h in self.native.handles if h.node.path != STAGE))


class ProductionHold(unittest.TestCase):
    def test_stdin_helper_refuses_windows_before_request_path_metadata(self):
        spec = importlib.util.spec_from_file_location("realbud_windows_held_main", ROOT / "server/helpers/hermes-memory-review.py")
        review = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(review)
        review.POSIX = False
        def forbidden(_request):
            self.fail("Held Windows stdin entry must not inspect request paths")
        review._parse_request = forbidden
        output = []
        review._emit = output.append
        before = review.sys.stdin
        try:
            review.sys.stdin = type("Input", (), {"buffer": io.BytesIO(b'{}')})()
            self.assertEqual(review.main(), 0)
            self.assertEqual(output, [{"ok": False, "code": "platform-unverified"}])
        finally:
            review.sys.stdin = before

    def test_direct_helper_dispatch_cannot_bypass_windows_hold(self):
        spec = importlib.util.spec_from_file_location("realbud_windows_held_review", ROOT / "server/helpers/hermes-memory-review.py")
        review = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(review)
        review.POSIX = False
        def forbidden(_context):
            self.fail("Held Windows helper must not import the native runtime or access memory")
        review._import_native = forbidden
        for command in ["list", "preview", "decide", "propose"]:
            with self.subTest(command=command):
                context = type("Context", (), {"command": command})()
                with self.assertRaises(review.ReviewError) as raised:
                    review._dispatch(context)
                self.assertEqual(raised.exception.code, "platform-unverified")


if __name__ == "__main__":
    unittest.main(verbosity=2)
