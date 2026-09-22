"""Additional guard checks using the independently authored fictional bindings."""
from dataclasses import replace
import importlib.util
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("fictional_windows_guard_fixture", ROOT / "scripts/testing/hermes-memory-windows-policy.py")
F = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = F
spec.loader.exec_module(F)


class AdditionalGuards(unittest.TestCase):
    def test_new_file_reported_nonempty_is_preserved_and_closed_without_write(self):
        bindings = F.Bindings()
        native = F.M.Win32Native(bindings)
        path = F.BASE + r"\nonempty-new-stage"
        events = []

        def unexpected_content(operation, handle):
            events.append(operation)
            entry = bindings.handles[handle]
            if operation == "identity" and entry["identity"].final_path == path:
                entry["data"] = b"Fictional unexpected existing content."
                entry["identity"] = replace(entry["identity"], size=len(entry["data"]))

        bindings.hook = unexpected_content
        with self.assertRaises(F.M.NativeError) as error:
            native.create_private_file(path)
        self.assertEqual(error.exception.code, "conflict")
        self.assertNotIn("write", events)
        self.assertFalse(native._handles)
        self.assertFalse(bindings.handles)
        self.assertEqual(bindings.entries[path]["data"], b"Fictional unexpected existing content.")

    def test_metadata_must_fit_its_native_integer_field(self):
        fields = {name: 1 << 32 for name in ("volume_serial", "attributes", "links", "volume_flags", "drive_type")}
        fields.update({name: 1 << 64 for name in ("file_index", "size", "creation_ticks", "last_write_ticks")})
        for name, value in fields.items():
            with self.subTest(field=name):
                bindings = F.Bindings()
                bindings.entries[F.FILE]["identity"] = replace(bindings.entries[F.FILE]["identity"], **{name: value})
                native = F.M.Win32Native(bindings)
                with self.assertRaises(F.M.NativeError) as error:
                    native.open_existing(F.FILE)
                self.assertEqual(error.exception.code, "unsafe-storage")
                self.assertFalse(native._handles)
                self.assertFalse(bindings.handles)


if __name__ == "__main__":
    unittest.main(verbosity=2)
