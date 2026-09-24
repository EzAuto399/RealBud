"""Portable raw ctypes fixture checks; these do not execute Windows APIs."""
import ctypes as C
import importlib.util
from pathlib import Path
import struct
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("fictional_windows_native_abi", ROOT / "server/helpers/hermes-memory-windows-native.py")
N = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = N
spec.loader.exec_module(N)
SID = "S-1-5-21-1001"


def put(pointer, value, kind=N.DWORD):
    C.cast(pointer, C.POINTER(kind))[0] = value


class Function:
    def __init__(self, name, fn):
        self.name, self.fn, self.calls = name, fn, []

    def __call__(self, *args):
        self.calls.append(args)
        return self.fn(*args)


class Library:
    def __init__(self):
        self.functions = {}

    def add(self, name, fn):
        self.functions[name] = Function(name, fn)

    def __getattr__(self, name):
        if name not in self.functions:
            self.add(name, lambda *_: 1)
        return self.functions[name]


class Fixture:
    def __init__(self):
        self.k, self.a = Library(), Library()
        self.allocations, self.freed, self.closed = [], [], []
        self.last_error = 0
        self.sid = b"\x01\x02" + (5).to_bytes(6, "big") + struct.pack("<II", 21, 1001)
        ace = struct.pack("<BBHI", 0, 0, 8 + len(self.sid), N.FILE_ALL_ACCESS) + self.sid
        acl = struct.pack("<BBHHH", 2, 0, 8 + len(ace), 1, 0) + ace
        self.dacl_offset = 20 + len(self.sid)
        self.descriptor = C.create_string_buffer(struct.pack("<BBHIIII", 1, 0, 0x9004, 20, 0, 0, self.dacl_offset) + self.sid + acl)
        self.base = C.addressof(self.descriptor)
        self.k.add("GetLastError", lambda: self.last_error)
        self.k.add("LocalFree", self.free)
        self.k.add("CloseHandle", lambda handle: self.closed.append(handle) or 1)
        self.k.add("GetCurrentProcess", lambda: -1)
        self.k.add("GetCurrentThread", lambda: -2)
        self.a.add("GetSecurityInfo", self.security)
        self.a.add("GetSecurityDescriptorLength", lambda *_: C.sizeof(self.descriptor) - 1)
        self.a.add("GetSecurityDescriptorControl", self.control)
        self.a.add("GetAce", self.ace)
        self.a.add("GetLengthSid", lambda *_: len(self.sid))
        self.a.add("ConvertSidToStringSidW", self.convert_sid)
        self.a.add("ConvertStringSecurityDescriptorToSecurityDescriptorW", self.convert_sd)
        self.a.add("OpenThreadToken", self.thread_token)
        self.a.add("OpenProcessToken", lambda _p, _a, out: put(out, 200, C.c_void_p) or 1)
        self.a.add("GetTokenInformation", self.token_info)
        self.k.add("CreateFileW", lambda *_: 123)
        self.native = N.CtypesBindings(kernel32=self.k, advapi32=self.a)

    def free(self, pointer):
        self.freed.append(pointer.value if isinstance(pointer, C.c_void_p) else pointer)
        return None

    def security(self, _handle, kind, flags, owner, _group, dacl, _sacl, descriptor):
        assert (kind, flags) == (1, 5)
        put(owner, self.base + 20, C.c_void_p)
        put(dacl, self.base + self.dacl_offset, C.c_void_p)
        put(descriptor, self.base, C.c_void_p)
        return 0

    def control(self, _sd, control, revision):
        put(control, 0x9004, N.WORD)
        put(revision, 1)
        return 1

    def ace(self, _acl, index, pointer):
        assert index == 0
        put(pointer, self.base + self.dacl_offset + 8, C.c_void_p)
        return 1

    def convert_sid(self, _sid, out):
        value = C.create_unicode_buffer(SID)
        self.allocations.append(value)
        put(out, C.addressof(value), C.c_void_p)
        return 1

    def convert_sd(self, _text, _revision, out, _size):
        put(out, self.base, C.c_void_p)
        return 1

    def thread_token(self, *_):
        self.last_error = 1008
        return 0

    def token_info(self, _token, kind, buffer, _capacity, needed):
        assert kind == 1
        size = C.sizeof(N.SID_AND_ATTRIBUTES) + len(self.sid)
        put(needed, size)
        if buffer is None:
            self.last_error = 122
            return 0
        address = C.addressof(buffer)
        token = C.cast(buffer, C.POINTER(N.SID_AND_ATTRIBUTES)).contents
        token.sid = address + C.sizeof(N.SID_AND_ATTRIBUTES)
        C.memmove(token.sid, self.sid, len(self.sid))
        return 1


class RawWin32Contract(unittest.TestCase):
    def setUp(self):
        self.f = Fixture()

    def test_structures_are_windows_width_on_non_windows(self):
        self.assertEqual(C.sizeof(N.DWORD), 4)
        self.assertEqual(C.sizeof(N.BOOL), 4)
        self.assertEqual(C.sizeof(N.BY_HANDLE_FILE_INFORMATION), 52)
        self.assertEqual(N.FILE_RENAME_INFO.name.offset, 20 if C.sizeof(C.c_void_p) == 8 else 12)

    def test_every_bound_entry_has_explicit_signature(self):
        for lib in (self.f.k, self.f.a):
            for fn in lib.functions.values():
                self.assertTrue(hasattr(fn, "argtypes"), fn.name)
                self.assertTrue(hasattr(fn, "restype"), fn.name)

    def test_descriptor_and_simple_ace_parse_by_handle_and_free_allocations(self):
        value = self.f.native.security_info(91)
        self.assertEqual(value, N.SecurityInfo(SID, True, True, (N.Ace(0, 0, N.FILE_ALL_ACCESS, SID),)))
        self.assertEqual(self.f.k.LocalFree.calls[-1][0].value, self.f.base)
        self.assertEqual(len(self.f.k.LocalFree.calls), 3)  # Owner SID, ACE SID, SD.

    def test_foreign_ace_pointer_is_refused_before_sid_dereference(self):
        self.f.a.GetAce.fn = lambda _a, _i, out: put(out, self.f.base - 4, C.c_void_p) or 1
        with self.assertRaisesRegex(N.NativeError, "^unsafe-storage$"):
            self.f.native.security_info(91)
        self.assertEqual(len(self.f.a.ConvertSidToStringSidW.calls), 1)  # Owner only.
        self.assertIn(self.f.base, self.f.freed)

    def test_sid_length_cannot_cross_ace_boundary(self):
        self.f.descriptor[self.f.dacl_offset + 8 + 8 + 1] = b"\x0f"
        with self.assertRaisesRegex(N.NativeError, "^unsafe-storage$"):
            self.f.native.security_info(91)
        self.assertEqual(len(self.f.a.ConvertSidToStringSidW.calls), 1)

    def test_unknown_ace_is_refused_before_its_sid_is_decoded(self):
        self.f.descriptor[self.f.dacl_offset + 8] = b"\x05"
        with self.assertRaisesRegex(N.NativeError, "^unsafe-storage$"):
            self.f.native.security_info(91)
        self.assertEqual(len(self.f.a.ConvertSidToStringSidW.calls), 1)

    def test_token_buffer_sid_is_bounded_and_token_is_closed(self):
        self.assertEqual(self.f.native.current_user_sid(), SID)
        self.assertEqual(self.f.closed, [200])

    def test_private_create_attributes_precede_content_and_handle_is_not_inheritable(self):
        def create(_path, access, share, attrs, disposition, flags, template):
            self.assertEqual(disposition, 1)
            self.assertEqual(share, 1)
            self.assertTrue(access & 0x10000)
            self.assertTrue(flags & 0x80000000)
            actual = C.cast(attrs, C.POINTER(N.SECURITY_ATTRIBUTES)).contents
            self.assertEqual(actual.inherit, 0)
            self.assertEqual(actual.descriptor, self.f.base)
            self.assertEqual(self.f.k.WriteFile.calls, [])
            return 123
        self.f.k.CreateFileW.fn = create
        self.assertEqual(self.f.native.open_file("fictional", directory=False, writable=True, create=True, security_sddl="fictional", renameable=True), 123)
        self.assertIn(self.f.base, self.f.freed)

    def test_create_collision_is_fixed_conflict_and_security_allocation_is_freed(self):
        self.f.last_error = 80
        self.f.k.CreateFileW.fn = lambda *_: C.c_void_p(-1).value
        with self.assertRaisesRegex(N.NativeError, "^conflict$"):
            self.f.native.open_file("fictional", directory=False, writable=True, create=True, security_sddl="fictional", renameable=True)
        self.assertIn(self.f.base, self.f.freed)

    def test_descriptor_free_failure_after_open_closes_unreturned_handle(self):
        self.f.k.LocalFree.fn = lambda *_: self.f.base
        with self.assertRaisesRegex(N.NativeError, "^unavailable$"):
            self.f.native.open_file("fictional", directory=False, writable=True, create=True, security_sddl="fictional", renameable=True)
        self.assertEqual(self.f.closed, [123])

    def test_rename_uses_handle_parent_and_utf16_byte_count(self):
        leaf = "fictional-中文.txt"
        def rename(source, kind, buffer, size):
            self.assertEqual((source, kind), (123, 3))
            actual = C.cast(buffer, C.POINTER(N.FILE_RENAME_INFO)).contents
            self.assertEqual(actual.root, 456)
            self.assertEqual(actual.options.replace, 0)
            self.assertEqual(actual.length, len(leaf.encode("utf-16-le")))
            self.assertEqual(C.string_at(C.addressof(buffer) + N.FILE_RENAME_INFO.name.offset, actual.length), leaf.encode("utf-16-le"))
            self.assertGreaterEqual(size, N.FILE_RENAME_INFO.name.offset + actual.length)
            return 1
        self.f.k.SetFileInformationByHandle.fn = rename
        self.f.native.rename(123, 456, leaf, False)

    def test_delete_is_source_handle_disposition_not_path_deletion(self):
        self.f.native.delete(123)
        args = self.f.k.SetFileInformationByHandle.calls[-1]
        self.assertEqual(args[:2], (123, 4))
        self.assertEqual(C.cast(args[2], C.POINTER(N.FILE_DISPOSITION_INFO)).contents.delete, 1)
        self.assertEqual(args[3], 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
