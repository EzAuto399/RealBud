#!/usr/bin/env python3
"""Fault tests for the owned helper against an explicitly supplied Hermes runtime.

REALBUD_TEST_HERMES_RUNTIME must point at the admitted hermes-agent directory.
Run with that runtime's venv Python. All state is fictional and temporary; the
runtime is only imported. Fault hooks live in this test subprocess, never in the
helper's serialized request contract.
"""

from __future__ import annotations

import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "server" / "helpers" / "hermes-memory-review.py"
SCRIPT = Path(__file__).resolve()
ITEM = "a1b2c3d4"
OTHER_ITEM = "b1c2d3e4"
PROFILE = "property-fictional-faults"
WORKSPACE = "11111111-2222-4333-8444-555555555555"
RUNTIME_ID = "345cd2b057a452236de401d3534b8502a7465e8d-cfb3f08a9ee7"
KEY = base64.b64encode(b"f" * 32).decode("ascii")
BEFORE = "Fictional Office sends routine updates on Monday."
AFTER = "Fictional Office sends routine updates on Tuesday."
COLLISION = b'{"fictional":"replacement proposal must survive cleanup"}'
CONFIG = "memory:\n  write_approval: true\n  memory_enabled: true\n  user_profile_enabled: true\n  memory_char_limit: 2200\n  user_char_limit: 1375\n"


def sha(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def child_main(mode: str) -> int:
    """Run the actual helper with process-local fault hooks and native write log."""
    spec = importlib.util.spec_from_file_location("realbud_fault_subject", HELPER)
    assert spec is not None and spec.loader is not None
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    event_file = Path(os.environ["REALBUD_TEST_EVENT_LOG"])

    def event(name: str) -> None:
        with event_file.open("ab") as output:
            output.write((name + "\n").encode("ascii"))
            output.flush()
            os.fsync(output.fileno())

    import_native = helper._import_native

    def counted_native(ctx):
        import_native(ctx)
        native_write = ctx.MemoryStore._write_file

        def counted_write(path, entries):
            native_write(path, entries)
            event("native-memory-write")

        ctx.MemoryStore._write_file = staticmethod(counted_write)

    helper._import_native = counted_native

    if mode == "crash-after-memory-fsync":
        original = helper._write_memory

        def crash_after_write(*args, **kwargs):
            original(*args, **kwargs)
            event("crash-after-memory-fsync")
            os._exit(71)

        helper._write_memory = crash_after_write
    elif mode == "crash-before-memory-fsync":
        original = helper._fsync_path

        def crash_before_fsync(path, profile):
            if Path(path).name == "MEMORY.md":
                event("crash-before-memory-fsync")
                os._exit(72)
            return original(path, profile)

        helper._fsync_path = crash_before_fsync
    elif mode == "crash-before-cleanup":
        def crash_before_cleanup(*args, **kwargs):
            event("crash-before-cleanup")
            os._exit(73)

        helper._finish_remove_pending = crash_before_cleanup
    elif mode == "crash-after-intent":
        original = helper._write_receipt

        def crash_after_intent(ctx, receipt):
            result = original(ctx, receipt)
            if receipt["phase"] == "intent":
                event("crash-after-intent")
                os._exit(74)
            return result

        helper._write_receipt = crash_after_intent
    elif mode in ("collision-before-claim", "crash-after-claim-rename"):
        original = helper.os.rename

        def interrupted_claim(source, destination, *args, **kwargs):
            if Path(destination).parent.name == "claims":
                if mode == "collision-before-claim":
                    Path(source).write_bytes(COLLISION)
                    event("replacement-before-claim")
                result = original(source, destination, *args, **kwargs)
                if mode == "crash-after-claim-rename":
                    event("crash-after-claim-rename")
                    os._exit(75)
                return result
            return original(source, destination, *args, **kwargs)

        helper.os.rename = interrupted_claim
    elif mode == "audit-recovery-fsync":
        original_fsync = helper._fsync_path
        original_dir = helper._fsync_dir
        original_receipt = helper._write_receipt

        def record_fsync(path, profile):
            result = original_fsync(path, profile)
            if Path(path).name == "MEMORY.md":
                event("recovery-memory-fsync")
            return result

        def record_dir(path, profile):
            result = original_dir(path, profile)
            if Path(path).name == "memories":
                event("recovery-memory-directory-fsync")
            return result

        def record_receipt(ctx, receipt):
            if receipt["phase"] == "final":
                event("recovery-final-receipt")
            return original_receipt(ctx, receipt)

        helper._fsync_path = record_fsync
        helper._fsync_dir = record_dir
        helper._write_receipt = record_receipt
    elif mode != "normal":
        raise RuntimeError("Unknown test fault mode")
    return helper.main()


class HermesMemoryReviewFaults(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        supplied = os.environ.get("REALBUD_TEST_HERMES_RUNTIME")
        if not supplied:
            raise unittest.SkipTest("REALBUD_TEST_HERMES_RUNTIME must explicitly select the admitted runtime")
        cls.runtime = Path(supplied).expanduser().resolve()
        cls.python = cls.runtime / "venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        if not cls.python.is_file() or not (cls.runtime / "tools/memory_tool_store.py").is_file():
            raise RuntimeError("The supplied Hermes runtime and its venv Python are required")

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="realbud-fictional-memory-fault-")
        # Resolve /var -> /private/var on macOS before the helper's ancestor checks.
        self.base = Path(self.temporary.name).resolve()
        self.addCleanup(self.temporary.cleanup)
        self.profile = self.base / PROFILE
        self.profile.mkdir(mode=0o700)
        (self.profile / "memories").mkdir(mode=0o700)
        (self.profile / "pending").mkdir(mode=0o700)
        (self.profile / "pending/memory").mkdir(mode=0o700)
        self.memory = self.profile / "memories/MEMORY.md"
        self.config = self.profile / "config.yaml"
        self.pending = self.profile / "pending/memory" / (ITEM + ".json")
        self.receipt = self.profile / ".realbud-memory-reviews" / (ITEM + ".json")
        self.claim = self.profile / ".realbud-memory-reviews/claims" / (ITEM + ".json")
        self.event_log = self.base / "test-events.log"
        self.write_private(self.memory, BEFORE.encode())
        self.write_private(self.config, CONFIG.encode())
        self.record = {
            "id": ITEM, "subsystem": "memory", "action": "replace",
            "summary": "Fictional office schedule correction", "origin": "background_review",
            "created_at": 1800000000.25,
            "payload": {"action": "replace", "target": "memory", "old_text": "Monday", "content": AFTER},
        }
        self.pending_bytes = json.dumps(self.record, sort_keys=True).encode()
        self.write_private(self.pending, self.pending_bytes)

    @staticmethod
    def write_private(path: Path, contents: bytes):
        path.write_bytes(contents)
        path.chmod(0o600)

    def request(self, command, **fields):
        request = {
            "version": 1, "command": command, "profileDirectory": str(self.profile),
            "runtimeDirectory": str(self.runtime), "workspaceId": WORKSPACE,
            "profileId": PROFILE, "runtimeId": RUNTIME_ID, "key": KEY,
        }
        if command != "list":
            request["id"] = ITEM
        request.update(fields)
        return request

    def call(self, request, *, mode="normal", crash=None):
        env = {key: value for key, value in os.environ.items() if key in (
            "PATH", "HOME", "USERPROFILE", "SystemRoot", "WINDIR", "TMP", "TEMP", "TMPDIR", "LANG",
        )}
        env.update(HERMES_HOME=str(self.profile), HERMES_SKIP_DOTENV="1", PYTHONDONTWRITEBYTECODE="1",
                   REALBUD_TEST_EVENT_LOG=str(self.event_log))
        completed = subprocess.run(
            [str(self.python), "-I", "-B", str(SCRIPT), "--child", mode],
            input=json.dumps(request).encode(), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=env, cwd=str(self.runtime), timeout=30,
        )
        if crash is not None:
            self.assertEqual(completed.returncode, crash, completed.stderr.decode(errors="replace"))
            self.assertEqual(completed.stdout, b"")
            return None
        self.assertEqual(completed.returncode, 0, completed.stderr.decode(errors="replace"))
        self.assertEqual(completed.stderr, b"")
        return json.loads(completed.stdout)

    def preview(self, **fields):
        response = self.call(self.request("preview", **fields))
        self.assertTrue(response["ok"], response)
        self.assertEqual(response["result"]["before"], BEFORE)
        self.assertEqual(response["result"]["after"], AFTER)
        return response["result"]

    def approval(self, preview, **fields):
        return self.request("decide", expectedDigest=preview["reviewDigest"], decision="approve", **fields)

    def assert_applied(self, response, preview):
        self.assertTrue(response["ok"], response)
        self.assertEqual(response["result"]["state"], "applied")
        self.assertEqual(response["result"]["reviewDigest"], preview["reviewDigest"])
        self.assertEqual(self.memory.read_text(), AFTER)
        self.assertFalse(self.pending.exists())
        self.assertFalse(self.claim.exists())
        self.assertEqual(json.loads(self.receipt.read_text())["phase"], "final")

    def events(self):
        return self.event_log.read_text().splitlines() if self.event_log.exists() else []

    def test_crash_after_memory_fsync_resumes_recorded_approval_once(self):
        preview = self.preview()
        self.call(self.approval(preview), mode="crash-after-memory-fsync", crash=71)
        self.assertEqual(self.memory.read_text(), AFTER)
        self.assertEqual(json.loads(self.receipt.read_text())["phase"], "intent")
        listing = self.call(self.request("list"))["result"]["items"][0]
        self.assertEqual((listing["state"], listing["decision"], listing["reviewDigest"]),
                         ("recovery-required", "approve", preview["reviewDigest"]))
        self.assert_applied(self.call(self.approval(preview)), preview)
        self.assert_applied(self.call(self.approval(preview)), preview)
        self.assertEqual(self.events().count("native-memory-write"), 1)

    def test_crash_after_rename_before_fsync_redurabilizes_before_final_receipt(self):
        preview = self.preview()
        self.call(self.approval(preview), mode="crash-before-memory-fsync", crash=72)
        self.assertEqual(self.memory.read_text(), AFTER)
        self.assert_applied(self.call(self.approval(preview), mode="audit-recovery-fsync"), preview)
        events = self.events()
        self.assertEqual(events.count("native-memory-write"), 1)
        self.assertLess(events.index("recovery-memory-fsync"), events.index("recovery-final-receipt"))
        self.assertLess(events.index("recovery-memory-directory-fsync"), events.index("recovery-final-receipt"))

    def test_final_receipt_before_cleanup_retries_without_memory_write(self):
        preview = self.preview()
        self.call(self.approval(preview), mode="crash-before-cleanup", crash=73)
        self.assertTrue(self.pending.exists())
        self.assertEqual(json.loads(self.receipt.read_text())["phase"], "final")
        item = self.call(self.request("list"))["result"]["items"][0]
        self.assertEqual(item["state"], "recovery-required")
        self.assertEqual(item["reviewDigest"], preview["reviewDigest"])
        self.assert_applied(self.call(self.approval(preview)), preview)
        self.assertEqual(self.events().count("native-memory-write"), 1)

    def test_rejected_receipt_before_cleanup_resumes_without_memory_changes(self):
        preview = self.preview()
        rejection = self.approval(preview)
        rejection["decision"] = "reject"
        self.call(rejection, mode="crash-before-cleanup", crash=73)
        self.assertEqual(self.memory.read_text(), BEFORE)
        self.assertTrue(self.pending.exists())
        item = self.call(self.request("list"))["result"]["items"][0]
        self.assertEqual((item["state"], item["decision"], item["reviewDigest"]),
                         ("recovery-required", "reject", preview["reviewDigest"]))
        resumed = self.call(rejection)
        self.assertTrue(resumed["ok"], resumed)
        self.assertEqual(resumed["result"]["state"], "rejected")
        self.assertFalse(resumed["result"]["changed"])
        self.assertFalse(self.pending.exists())
        self.assertEqual(self.memory.read_text(), BEFORE)
        self.assertEqual(self.call(self.approval(preview)), {"ok": False, "code": "conflict"})
        self.assertEqual(self.events().count("native-memory-write"), 0)

    def test_crash_after_cleanup_claim_rename_finishes_saved_claim(self):
        preview = self.preview()
        self.call(self.approval(preview), mode="crash-after-claim-rename", crash=75)
        self.assertFalse(self.pending.exists())
        self.assertEqual(self.claim.read_bytes(), self.pending_bytes)
        self.assertEqual(self.call(self.request("list"))["result"]["items"][0]["state"], "recovery-required")
        self.assert_applied(self.call(self.approval(preview)), preview)
        self.assertEqual(self.events().count("native-memory-write"), 1)

    def test_cleanup_collision_preserves_unreviewed_replacement(self):
        preview = self.preview()
        response = self.call(self.approval(preview), mode="collision-before-claim")
        self.assertEqual(response, {"ok": False, "code": "conflict"})
        self.assertEqual(self.claim.read_bytes(), COLLISION)
        self.assertEqual(self.memory.read_text(), AFTER)
        self.assertEqual(self.call(self.request("list"))["result"]["items"][0]["state"], "recovery-required")
        self.assertEqual(self.call(self.approval(preview)), {"ok": False, "code": "conflict"})
        self.assertEqual(self.claim.read_bytes(), COLLISION)
        self.assertEqual(self.events().count("native-memory-write"), 1)

    def test_new_native_proposal_beside_saved_claim_is_never_deleted(self):
        preview = self.preview()
        self.call(self.approval(preview), mode="crash-after-claim-rename", crash=75)
        replacement_record = dict(self.record)
        replacement_record["summary"] = "A different fictional native proposal"
        replacement_record["payload"] = {
            "action": "replace", "target": "memory", "old_text": "Tuesday",
            "content": "Fictional Office sends routine updates on Wednesday.",
        }
        replacement = json.dumps(replacement_record, sort_keys=True).encode()
        self.write_private(self.pending, replacement)
        self.assertEqual(self.call(self.approval(preview)), {"ok": False, "code": "conflict"})
        self.assertEqual(self.pending.read_bytes(), replacement)
        self.assertEqual(self.claim.read_bytes(), self.pending_bytes)
        self.assertEqual(self.memory.read_text(), AFTER)
        self.assertEqual(self.events().count("native-memory-write"), 1)

    def test_copied_receipt_is_invalid_for_another_pending_id(self):
        preview = self.preview()
        self.assert_applied(self.call(self.approval(preview)), preview)
        copy = self.receipt.with_name(OTHER_ITEM + ".json")
        self.write_private(copy, self.receipt.read_bytes())
        response = self.call(self.approval(preview, id=OTHER_ITEM))
        self.assertEqual(response, {"ok": False, "code": "recovery-required"})
        items = {item["id"]: item for item in self.call(self.request("list"))["result"]["items"]}
        self.assertEqual(items[OTHER_ITEM]["state"], "recovery-required")
        self.assertIsNone(items[OTHER_ITEM]["reviewDigest"])
        self.assertEqual(self.events().count("native-memory-write"), 1)

    def test_altered_current_memory_holds_intent_and_preserves_new_content(self):
        preview = self.preview()
        self.call(self.approval(preview), mode="crash-after-memory-fsync", crash=71)
        different = "Fictional Office now sends updates on Friday."
        self.write_private(self.memory, different.encode())
        self.assertEqual(self.call(self.approval(preview)), {"ok": False, "code": "conflict"})
        self.assertEqual(self.memory.read_text(), different)
        self.assertTrue(self.pending.exists())
        self.assertEqual(json.loads(self.receipt.read_text())["phase"], "intent")
        self.assertEqual(self.events().count("native-memory-write"), 1)

    def test_changed_config_holds_saved_intent_without_applying(self):
        preview = self.preview()
        self.call(self.approval(preview), mode="crash-after-intent", crash=74)
        self.write_private(self.config, (CONFIG + "# Changed fictional policy version\n").encode())
        self.assertEqual(self.call(self.approval(preview)), {"ok": False, "code": "recovery-required"})
        self.assertEqual(self.memory.read_text(), BEFORE)
        self.assertTrue(self.pending.exists())
        self.assertEqual(self.events().count("native-memory-write"), 0)

    def test_changed_runtime_binding_holds_saved_intent(self):
        preview = self.preview()
        self.call(self.approval(preview), mode="crash-after-intent", crash=74)
        response = self.call(self.approval(preview, runtimeId=RUNTIME_ID + "-changed"))
        self.assertEqual(response, {"ok": False, "code": "recovery-required"})
        self.assertEqual(self.memory.read_text(), BEFORE)
        self.assertEqual(self.events().count("native-memory-write"), 0)

    def test_saved_intent_before_write_requires_original_decision_and_digest(self):
        preview = self.preview()
        self.call(self.approval(preview), mode="crash-after-intent", crash=74)
        rejection = self.approval(preview)
        rejection["decision"] = "reject"
        self.assertEqual(self.call(rejection), {"ok": False, "code": "conflict"})
        stale = self.approval(preview)
        stale["expectedDigest"] = "0" * 64
        self.assertEqual(self.call(stale), {"ok": False, "code": "stale-review"})
        self.assert_applied(self.call(self.approval(preview)), preview)
        self.assertEqual(self.events().count("native-memory-write"), 1)

    def test_public_snapshot_hash_is_not_approval_authority(self):
        preview = self.preview()
        other_key = base64.b64encode(b"x" * 32).decode("ascii")
        different_key_preview = self.preview(key=other_key)
        self.assertNotEqual(preview["reviewDigest"], different_key_preview["reviewDigest"])
        public_binding = {
            "version": 1, "id": ITEM, "workspaceId": WORKSPACE, "profileId": PROFILE,
            "runtimeId": RUNTIME_ID, "action": "replace", "target": "memory", "origin": "background_review",
            "createdAt": self.record["created_at"] * 1000, "operationCount": 1, "charLimit": 2200,
            "configDigest": sha(self.config.read_bytes()), "pendingDigest": sha(self.pending_bytes),
            "beforeDigest": sha(BEFORE.encode()), "afterDigest": sha(AFTER.encode()),
        }
        public_digest = sha(json.dumps(public_binding, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode("ascii"))
        request = self.approval(preview)
        request["expectedDigest"] = public_digest
        self.assertEqual(self.call(request), {"ok": False, "code": "stale-review"})
        self.assertFalse(self.receipt.exists())
        self.assertEqual(self.memory.read_text(), BEFORE)
        self.assertEqual(self.events().count("native-memory-write"), 0)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--child":
        raise SystemExit(child_main(sys.argv[2]))
    unittest.main(verbosity=2)
