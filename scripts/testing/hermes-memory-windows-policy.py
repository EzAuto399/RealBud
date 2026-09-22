#!/usr/bin/env python3
"""Portable tests of the actual Windows policy against fictional bindings.

No Win32 API, NTFS ACL, process lock or installed-device evidence is produced.
"""
from dataclasses import replace
from contextlib import nullcontext
import hashlib
import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("realbud_windows_policy_subject", ROOT / "server/helpers/hermes-memory-windows-native.py")
M = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = M
SPEC.loader.exec_module(M)
USER = "S-1-5-21-123-456-789-1001"
BASE = r"\\?\C:\Office"
FILE = BASE + r"\fictional.txt"
PRIVATE = M.SecurityInfo(USER, True, True, (M.Ace(0, 0, M.FILE_ALL_ACCESS, USER), M.Ace(0, 0, M.FILE_ALL_ACCESS, M.SYSTEM_SID)))


class Bindings:
    def __init__(self):
        self.user = USER
        self.entries = {}
        self.handles = {}
        self.positions = {}
        self.log = []
        self.hook = lambda name, handle: None
        self.serial = 100
        self.add(BASE, directory=True)
        self.add(FILE, data=b"Fictional memory.")

    def add(self, path, *, directory=False, data=b"", security=PRIVATE):
        self.serial += 1
        identity = M.FileIdentity(1, self.serial, 0x10 if directory else 0x80, 1, len(data), 1, 1, path, "NTFS", 8, 3)
        self.entries[path] = {"identity": identity, "security": security, "data": data}

    def current_user_sid(self):
        return self.user

    def open_file(self, path, **options):
        self.log.append(("open", path, options))
        if options["create"]:
            if path in self.entries:
                raise M.NativeError("conflict")
            if not options["security_sddl"]:
                raise AssertionError("Creation must carry private security before bytes.")
            self.add(path)
        self.serial += 1
        handle = self.serial
        if path not in self.entries:
            raise M.NativeError("not-found")
        self.handles[handle] = self.entries[path]
        self.positions[handle] = 0
        return handle

    def create_directory(self, path, security_sddl):
        if path in self.entries:
            raise M.NativeError("conflict")
        assert security_sddl
        self.add(path, directory=True)

    def file_identity(self, handle):
        self.hook("identity", handle)
        return self.handles[handle]["identity"]

    def security_info(self, handle):
        self.hook("security", handle)
        return self.handles[handle]["security"]

    def seek_start(self, handle):
        self.positions[handle] = 0

    def read(self, handle, count):
        start = self.positions[handle]
        data = self.handles[handle]["data"][start:start + count]
        self.positions[handle] += len(data)
        self.hook("read", handle)
        return data

    def write(self, handle, data):
        self.hook("write", handle)
        entry = self.handles[handle]
        entry["data"] += data
        entry["identity"] = replace(entry["identity"], size=len(entry["data"]), last_write_ticks=entry["identity"].last_write_ticks + 1)
        return len(data)

    def flush(self, handle):
        self.hook("flush", handle)

    def close(self, handle):
        self.hook("close", handle)
        self.log.append(("close", handle))
        del self.handles[handle]

    def rename(self, source, parent, leaf, replace):
        self.hook("rename", source)
        path = self.handles[parent]["identity"].final_path + "\\" + leaf
        if path in self.entries and not replace:
            raise M.NativeError("conflict")
        entry = self.handles[source]
        del self.entries[entry["identity"].final_path]
        entry["identity"] = globals()["replace"](entry["identity"], final_path=path)
        self.entries[path] = entry

    def delete(self, handle):
        self.hook("delete", handle)
        del self.entries[self.handles[handle]["identity"].final_path]

    def lock(self, handle):
        self.hook("lock", handle)
        self.log.append(("lock", handle))
        return True

    def unlock(self, handle):
        self.hook("unlock", handle)
        self.log.append(("unlock", handle))

    def names(self, handle, limit):
        self.hook("names", handle)
        prefix = self.handles[handle]["identity"].final_path + "\\"
        return [path[len(prefix):] for path in self.entries if path.startswith(prefix) and "\\" not in path[len(prefix):]]


class NativePolicy(unittest.TestCase):
    def setUp(self):
        self.b = Bindings()
        self.n = M.Win32Native(self.b)

    def tearDown(self):
        self.b.hook = lambda *_: None
        for handle in list(self.n._handles):
            self.n.close(handle)

    def error(self, code, call):
        with self.assertRaises(M.NativeError) as result:
            call()
        self.assertEqual(result.exception.code, code)
        self.assertEqual(str(result.exception), code)

    def test_fixed_errors_do_not_expose_native_details(self):
        self.error("not-found", lambda: self.n.open_existing(BASE + r"\secret-account"))
        self.assertEqual(M.NativeError("password=fake").code, "unavailable")
        h = self.n.open_existing(FILE)
        self.assertNotIn("fictional", repr(h))

    def test_paths_refused_before_io(self):
        for path in [r"\\host\share", r"C:relative", BASE + r"\..\other", BASE + r"\memory:ads", BASE + r"\CONIN$", BASE + r"\file.", BASE + r"\LPT².txt"]:
            with self.subTest(path=path), self.assertRaises(M.NativeError):
                self.n.open_existing(path)
        self.assertEqual(self.b.log, [])

    def test_lock_initialization_is_private_empty_and_has_no_content_authority(self):
        path = BASE + r"\memory.lock"
        handle = self.n.open_lock(path, create=True)
        self.assertEqual(self.b.entries[path]["data"], b"")
        options = next(event[2] for event in self.b.log if event[0] == "open")
        self.assertTrue(options["lock_file"])
        self.assertFalse(options["renameable"])
        self.assertTrue(options["security_sddl"])
        self.error("invalid", lambda: self.n.write(handle, b"never"))
        self.n.lock(handle, 0)
        self.assertTrue(handle._locked)
        self.error("invalid", lambda: self.n.lock(handle, 0))
        self.n.unlock(handle)
        self.assertFalse(handle._locked)

    def test_lock_timeout_is_bounded_and_rechecks_privacy_after_acquiring(self):
        handle = self.n.open_lock(BASE + r"\memory.lock", create=True)
        self.b.lock = lambda _handle: False
        with patch.object(M.time, "monotonic", side_effect=[0, 0.02, 0.04, 0.06]), patch.object(M.time, "sleep") as sleep:
            self.error("conflict", lambda: self.n.lock(handle, 50))
            self.assertEqual(sleep.call_count, 2)
        self.assertFalse(handle._locked)
        def lock_then_drift(raw):
            self.b.handles[raw]["security"] = replace(PRIVATE, protected=False)
            return True
        self.b.lock = lock_then_drift
        self.error("unsafe-storage", lambda: self.n.lock(handle, 0))
        self.assertFalse(handle._locked)
        self.assertTrue(any(event[0] == "unlock" for event in self.b.log))

    def test_lock_release_failure_is_visible_and_handle_remains_owned(self):
        handle = self.n.open_lock(BASE + r"\memory.lock", create=True)
        self.n.lock(handle, 0)
        self.b.unlock = lambda _handle: (_ for _ in ()).throw(OSError("fictional-private-lock"))
        self.error("unavailable", lambda: self.n.unlock(handle))
        self.assertTrue(handle._locked)
        self.assertIn(handle, self.n._handles)

    def test_nonempty_lock_and_invalid_timeout_do_not_attempt_acquisition(self):
        handle = self.n.open_lock(FILE)
        self.error("unsafe-storage", lambda: self.n.lock(handle, 0))
        for timeout in [-1, True, 10001, "1"]:
            self.error("invalid", lambda: self.n.lock(handle, timeout))
        self.assertFalse(any(event[0] == "lock" for event in self.b.log))

    def test_names_reverify_metadata_acl_bounds_and_names(self):
        handle = self.n.open_existing(BASE, directory=True)
        self.assertEqual(self.n.names(handle, 1), ["fictional.txt"])
        self.error("capacity", lambda: self.n.names(handle, 0))
        def drift(op, raw):
            if op == "names":
                item = self.b.handles[raw]
                item["identity"] = replace(item["identity"], last_write_ticks=2)
        self.b.hook = drift
        self.error("conflict", lambda: self.n.names(handle, 1))

    def test_admission_requires_local_ntfs_unique_identity(self):
        for change in [{"filesystem": "ReFS"}, {"drive_type": 4}, {"volume_flags": 0}, {"file_index": 0}, {"volume_serial": 0}, {"links": 2}, {"attributes": 0x480}, {"attributes": 0x1080}, {"final_path": BASE + r"\alias"}, {"size": 2 ** 64}, {"creation_ticks": 2 ** 64}, {"volume_serial": 2 ** 32}, {"attributes": 2 ** 32}]:
            with self.subTest(change=change):
                original = self.b.entries[FILE]["identity"]
                self.b.entries[FILE]["identity"] = replace(original, **change)
                with self.assertRaises(M.NativeError):
                    self.n.open_existing(FILE)
                self.assertFalse(self.n._handles)
                self.assertFalse(self.b.handles)
                self.b.entries[FILE]["identity"] = original

    def test_created_file_must_be_empty_before_handle_is_returned(self):
        open_file = self.b.open_file
        def nonempty(path, **options):
            raw = open_file(path, **options)
            self.b.handles[raw]["identity"] = replace(self.b.handles[raw]["identity"], size=1)
            self.b.handles[raw]["data"] = b"x"
            return raw
        self.b.open_file = nonempty
        self.error("conflict", lambda: self.n.create_private_file(BASE + r"\new.stage"))
        self.assertFalse(self.b.handles)
        self.assertFalse(self.n._handles)

    def test_acl_unknown_deny_foreign_owner_null_or_inherit_only_refused(self):
        cases = [replace(PRIVATE, owner="S-1-1-0"), replace(PRIVATE, protected=False), replace(PRIVATE, dacl_present=False), replace(PRIVATE, aces=()), replace(PRIVATE, aces=(M.Ace(0, 0, M.FILE_ALL_ACCESS, "S-1-1-0"),)), replace(PRIVATE, aces=PRIVATE.aces + (M.Ace(1, 0, 1, USER),)), replace(PRIVATE, aces=PRIVATE.aces + (M.Ace(5, 0, 1, USER),)), replace(PRIVATE, aces=(M.Ace(0, 8, M.FILE_ALL_ACCESS, USER),)), replace(PRIVATE, aces=(M.Ace(0, 0, 0x120089, USER),))]
        h = self.n.open_existing(FILE)
        for info in cases:
            with self.subTest(info=info):
                self.b.entries[FILE]["security"] = info
                self.error("unsafe-storage", lambda: self.n.verify_private(h))

    def test_inherited_child_requires_private_current_root_and_actual_allowlist(self):
        self.b.entries[FILE]["security"] = replace(PRIVATE, protected=False, aces=(M.Ace(0, 16, M.FILE_ALL_ACCESS, USER),))
        root, h = self.n.open_existing(BASE, directory=True), self.n.open_existing(FILE)
        self.error("unsafe-storage", lambda: self.n.verify_private(h))
        self.n.verify_private(h, private_root=root)
        self.assertEqual(self.n.read(h), b"Fictional memory.")
        self.b.entries[BASE]["security"] = replace(PRIVATE, protected=False)
        self.error("unsafe-storage", lambda: self.n.read(h))

    def test_generic_and_split_full_control_grants_are_effective(self):
        h = self.n.open_existing(FILE)
        for aces in [(M.Ace(0, 0, 0x10000000, USER),), (M.Ace(0, 0, 0xF0000, USER), M.Ace(0, 0, 0x1001FF, USER))]:
            self.b.entries[FILE]["security"] = replace(PRIVATE, aces=aces)
            self.n.verify_private(h)

    def test_identity_acl_or_principal_drift_refused(self):
        h = self.n.open_existing(FILE)
        self.b.user = "S-1-5-21-123-456-789-1002"
        self.error("unsafe-storage", lambda: self.n.read(h))
        self.b.user = USER
        self.b.entries[FILE]["identity"] = replace(self.b.entries[FILE]["identity"], file_index=999)
        self.error("conflict", lambda: self.n.read(h))

    def test_change_during_read_never_returns_bytes(self):
        h = self.n.open_existing(FILE)
        def change(name, raw):
            if name == "read":
                self.b.entries[FILE]["security"] = replace(PRIVATE, dacl_present=False)
        self.b.hook = change
        self.error("unsafe-storage", lambda: self.n.read(h))

    def test_bounded_read_and_new_file_only_writes(self):
        old = self.n.open_existing(FILE, writable=True)
        self.error("invalid", lambda: self.n.write(old, b"Replacement"))
        self.error("capacity", lambda: self.n.read(old, 2))
        for limit in [-1, True, M.MAX_BYTES + 1]:
            self.error("invalid", lambda: self.n.read(old, limit))
        new = self.n.create_private_file(BASE + r"\new.stage")
        self.n.write(new, b"Fictional private bytes.")
        self.n.flush(new)
        self.assertEqual(self.n.read(new), b"Fictional private bytes.")
        self.error("invalid", lambda: self.n.write(new, b"Retry"))

    def test_uncertain_write_cannot_be_replayed_on_same_handle(self):
        new = self.n.create_private_file(BASE + r"\new.stage")
        def fail(name, raw):
            if name == "write":
                raise OSError("fictional secret native message")
        self.b.hook = fail
        self.error("unavailable", lambda: self.n.write(new, b"Fictional"))
        self.b.hook = lambda *_: None
        self.error("invalid", lambda: self.n.write(new, b"Retry"))

    def test_foreign_handles_rejected_and_close_failure_remains_owned(self):
        h = self.n.open_existing(FILE)
        other = M.Win32Native(Bindings())
        self.error("invalid", lambda: other.read(h))
        def fail(name, raw):
            if name == "close":
                raise OSError("fictional close failure")
        self.b.hook = fail
        self.error("unavailable", lambda: self.n.close(h))
        self.assertIn(h, self.n._handles)
        self.assertFalse(h._closed)
        self.b.hook = lambda *_: None
        self.n.close(h)
        self.n.close(h)
        self.error("invalid", lambda: self.n.read(h))

    def test_no_clobber_rename_preserves_object_and_delete_is_handle_bound(self):
        root = self.n.open_existing(BASE, directory=True)
        h = self.n.open_existing(FILE, writable=True, renameable=True)
        old = self.n.snapshot(h)
        self.n.rename(h, root, "moved.stage")
        self.assertEqual(self.n.snapshot(h).file_index, old.file_index)
        self.assertEqual(self.n.read(h), b"Fictional memory.")
        self.b.add(BASE + r"\collision")
        self.error("conflict", lambda: self.n.rename(h, root, "collision"))
        self.n.delete(h)
        self.error("invalid", lambda: self.n.read(h))
        self.n.close(h)


class OwnedProtocolIntegration(unittest.TestCase):
    setUp = NativePolicy.setUp
    tearDown = NativePolicy.tearDown

    def test_real_policy_and_protocol_publish_replace_and_request_delete(self):
        spec = importlib.util.spec_from_file_location("realbud_windows_policy_protocol", ROOT / "server/helpers/hermes-memory-windows.py")
        protocol = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(protocol)
        self.b.add("\\\\?\\C:\\", directory=True)
        store = protocol.WindowsMemoryStorage(r"C:\Office", native=self.n, mutation_lock=nullcontext)
        digest = lambda data: hashlib.sha256(data).hexdigest()
        stage, target = r"C:\Office\prepared.stage", r"C:\Office\fictional.txt"
        before = store.read(target)
        store.write_new(stage, b"New fictional preference.")
        store.replace_from_stage(stage, target, digest(b"New fictional preference."), digest(before))
        self.assertEqual(store.read(target), b"New fictional preference.")
        second = r"C:\Office\published.txt"
        store.move_new(target, second, digest(b"New fictional preference."))
        self.assertEqual(store.read(second), b"New fictional preference.")
        self.assertEqual(store.delete_exact(second, digest(b"New fictional preference.")), "deleted")
        self.assertFalse(self.n._handles)
        self.assertFalse(self.b.handles)


if __name__ == "__main__":
    unittest.main(verbosity=2)
