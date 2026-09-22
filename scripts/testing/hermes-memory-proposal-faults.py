#!/usr/bin/env python3
"""Crash/replay tests for typed proposal publication in fictional profiles only.

Select the admitted hermes-agent directory with REALBUD_TEST_HERMES_RUNTIME.
The subprocess imports the owned review dispatcher and actual native store.
Faults patch filesystem operations inside the test child; no production fault
flags, extra request fields, provider calls, or real profile reads are used.
"""
from __future__ import annotations

import base64
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = Path(__file__).resolve()
REVIEW = ROOT / "server/helpers/hermes-memory-review.py"
PROPOSALS = ROOT / "server/helpers/hermes-memory-proposals.py"
PROFILE = "property-fictional-proposal-faults"
WORKSPACE = "77777777-8888-4999-aaaa-bbbbbbbbbbbb"
SCOPE = "c" * 64
KEY = base64.b64encode(b"p" * 32).decode("ascii")
BEFORE = "Fictional Office sends routine updates on Monday."
AFTER = "Fictional Office sends routine updates on Tuesday."
FOREIGN = b'{"fictional":"a foreign proposal must remain intact"}'
CONFIG = "memory:\n  write_approval: true\n  memory_enabled: true\n  user_profile_enabled: true\n  memory_char_limit: 2200\n  user_char_limit: 1375\n"
CRASHES = {
    "intent": 81,
    "stage": 82,
    "link": 83,
    "unlink": 84,
    "published": 85,
}


def child_main(mode: str) -> int:
    spec = importlib.util.spec_from_file_location("realbud_proposal_fault_subject", REVIEW)
    assert spec is not None and spec.loader is not None
    review = importlib.util.module_from_spec(spec)
    # The dispatcher gives its own registered module to the proposal helper.
    sys.modules[spec.name] = review
    spec.loader.exec_module(review)
    event_path = Path(os.environ["REALBUD_TEST_EVENT_LOG"])

    def event(name: str) -> None:
        with event_path.open("ab") as output:
            output.write((name + "\n").encode("ascii"))
            output.flush()
            os.fsync(output.fileno())

    def crash(checkpoint: str) -> None:
        if mode == checkpoint:
            event("crash-" + checkpoint)
            os._exit(CRASHES[checkpoint])

    original_import = review._import_native

    def counted_native(ctx):
        original_import(ctx)
        original_write = ctx.MemoryStore._write_file

        def counted_write(path, entries):
            original_write(path, entries)
            event("native-memory-write")

        ctx.MemoryStore._write_file = staticmethod(counted_write)

    review._import_native = counted_native
    atomic_write = review._atomic_write

    def interrupted_atomic(profile, path, data, *args, **kwargs):
        result = atomic_write(profile, path, data, *args, **kwargs)
        target = Path(path)
        if target.parent.name == "proposals":
            if target.suffix == ".stage":
                event("durable-stage")
                crash("stage")
            elif target.suffix == ".json":
                state = json.loads(data).get("state")
                if state == "prepared":
                    event("durable-intent")
                    crash("intent")
                elif state == "published":
                    event("durable-published")
                    crash("published")
        return result

    review._atomic_write = interrupted_atomic
    original_link = os.link
    original_unlink = os.unlink

    def interrupted_link(source, destination, *args, **kwargs):
        if Path(source).suffix == ".stage":
            if mode == "foreign-before-link":
                fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, "wb") as output:
                    output.write(FOREIGN)
                    output.flush()
                    os.fsync(output.fileno())
                event("foreign-created-before-link")
            result = original_link(source, destination, *args, **kwargs)
            event("native-pending-published-by-link")
            crash("link")
            return result
        return original_link(source, destination, *args, **kwargs)

    def interrupted_unlink(path, *args, **kwargs):
        result = original_unlink(path, *args, **kwargs)
        if Path(path).suffix == ".stage":
            event("private-stage-unlinked")
            crash("unlink")
        return result

    os.link = interrupted_link
    os.unlink = interrupted_unlink
    if mode not in {*CRASHES, "normal", "foreign-before-link"}:
        raise RuntimeError("Unknown test fault mode")
    return review.main()


class HermesMemoryProposalFaults(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        supplied = os.environ.get("REALBUD_TEST_HERMES_RUNTIME")
        if not supplied:
            raise unittest.SkipTest("Explicit REALBUD_TEST_HERMES_RUNTIME admission is required")
        if os.name != "posix":
            raise unittest.SkipTest("The native publication path is admitted only on POSIX")
        cls.runtime = Path(supplied).expanduser().resolve()
        cls.python = cls.runtime / "venv/bin/python"
        if not cls.python.is_file() or not (cls.runtime / "tools/memory_tool_store.py").is_file():
            raise RuntimeError("The selected Hermes runtime and its venv Python are required")
        if not PROPOSALS.is_file():
            raise RuntimeError("The owned proposal helper has not been integrated")

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="realbud-fictional-proposal-fault-")
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name).resolve()
        self.profile = self.base / PROFILE
        self.profile.mkdir(mode=0o700)
        for directory in ("memories", "pending", "pending/memory"):
            (self.profile / directory).mkdir(mode=0o700)
        self.memory = self.profile / "memories/MEMORY.md"
        self.config = self.profile / "config.yaml"
        self.pending_dir = self.profile / "pending/memory"
        self.reviews = self.profile / ".realbud-memory-reviews"
        self.proposals = self.reviews / "proposals"
        self.event_log = self.base / "test-events.log"
        self.private(self.memory, BEFORE.encode())
        self.private(self.config, CONFIG.encode())
        self.input = {"requestId": "fictional-schedule-correction", "payload": {
            "action": "replace", "target": "memory", "old_text": "Monday", "content": AFTER,
        }}

    @staticmethod
    def private(path: Path, value: bytes):
        path.write_bytes(value)
        path.chmod(0o600)

    def request(self, command="propose", **fields):
        request = {"version": 1, "command": command, "profileDirectory": str(self.profile),
                   "runtimeDirectory": str(self.runtime), "workspaceId": WORKSPACE,
                   "profileId": PROFILE, "runtimeId": self.runtime.parent.name, "key": KEY}
        if command == "propose":
            request.update(scopeId=SCOPE, input=self.input)
        request.update(fields)
        return request

    def call(self, request=None, *, mode="normal", expect_crash=False):
        env = {key: value for key, value in os.environ.items() if key in (
            "PATH", "HOME", "USERPROFILE", "SystemRoot", "WINDIR", "TMP", "TEMP", "TMPDIR", "LANG",
        )}
        env.update(HERMES_HOME=str(self.profile), HERMES_SKIP_DOTENV="1", PYTHONDONTWRITEBYTECODE="1",
                   REALBUD_TEST_EVENT_LOG=str(self.event_log))
        completed = subprocess.run([str(self.python), "-I", "-B", str(SCRIPT), "--child", mode],
                                   input=json.dumps(request or self.request()).encode(),
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
                                   cwd=str(self.runtime), timeout=30)
        if expect_crash:
            self.assertEqual(completed.returncode, CRASHES[mode], completed.stdout.decode(errors="replace"))
            self.assertEqual(completed.stdout, b"")
            self.assertEqual(completed.stderr, b"")
            return None
        self.assertEqual(completed.returncode, 0, completed.stderr.decode(errors="replace"))
        self.assertEqual(completed.stderr, b"")
        return json.loads(completed.stdout)

    def journal(self):
        files = list(self.proposals.glob("*.json"))
        self.assertEqual(len(files), 1)
        return files[0], json.loads(files[0].read_text())

    def paths(self):
        journal, value = self.journal()
        return journal, journal.with_suffix(".stage"), self.pending_dir / (value["id"] + ".json"), value

    def events(self):
        return self.event_log.read_text().splitlines() if self.event_log.exists() else []

    def held(self, result):
        self.assertFalse(result["ok"], result)
        self.assertIn(result["code"], ("conflict", "recovery-required", "unsafe-storage"))

    def assert_pending(self, result, expected_id=None):
        self.assertTrue(result["ok"], result)
        value = result["result"]
        self.assertEqual(set(value), {"version", "id", "reviewLocation"})
        self.assertEqual(value["version"], 1)
        self.assertEqual(value["reviewLocation"], "You → Bud → Bud’s memory")
        if expected_id is not None:
            self.assertEqual(value["id"], expected_id)
        self.assertEqual([path.name for path in self.pending_dir.glob("*.json")], [value["id"] + ".json"])
        record = json.loads((self.pending_dir / (value["id"] + ".json")).read_text())
        self.assertEqual((record["id"], record["subsystem"], record["origin"]), (value["id"], "memory", "foreground"))
        self.assertEqual(self.memory.read_text(), BEFORE)
        self.assertEqual(self.events().count("native-memory-write"), 0)
        return value

    def crash_then_retry(self, point):
        self.call(mode=point, expect_crash=True)
        _journal, stage, pending, value = self.paths()
        expected_id = value["id"]
        self.assertEqual(self.memory.read_text(), BEFORE)
        if point in ("intent", "stage", "link", "unlink"):
            self.assertEqual(value["state"], "prepared")
        else:
            self.assertEqual(value["state"], "published")
        if point == "link":
            self.assertEqual(stage.stat().st_ino, pending.stat().st_ino)
            self.assertEqual(stage.stat().st_nlink, 2)
        self.assert_pending(self.call(), expected_id)
        self.assert_pending(self.call(), expected_id)
        self.assertEqual(self.journal()[1]["state"], "published")
        self.assertFalse(stage.exists())
        self.assertEqual(pending.stat().st_nlink, 1)
        self.assertEqual(self.events().count("native-pending-published-by-link"), 1)

    def test_crash_after_durable_intent_reuses_the_saved_pending_id(self):
        self.crash_then_retry("intent")

    def test_crash_after_private_stage_write_publishes_once(self):
        self.crash_then_retry("stage")

    def test_crash_after_hard_link_recovers_only_the_owned_two_link_pair(self):
        self.crash_then_retry("link")

    def test_crash_after_stage_unlink_finishes_the_same_pending_record(self):
        self.crash_then_retry("unlink")

    def test_crash_after_published_receipt_before_output_replays_saved_id(self):
        self.crash_then_retry("published")

    def completed_review_retry(self, decision, *, crash_before_published_receipt=False):
        if crash_before_published_receipt:
            self.call(mode="unlink", expect_crash=True)
            _journal, stage, pending, saved = self.paths()
            self.assertEqual(saved["state"], "prepared")
            self.assertTrue(pending.is_file())
            self.assertFalse(stage.exists())
            proposal = {"version": 1, "id": saved["id"], "reviewLocation": "You → Bud → Bud’s memory"}
        else:
            proposal = self.assert_pending(self.call())
        preview = self.call(self.request("preview", id=proposal["id"]))
        self.assertTrue(preview["ok"], preview)
        review = preview["result"]
        result = self.call(self.request("decide", id=proposal["id"], expectedDigest=review["reviewDigest"], decision=decision))
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["result"]["state"], "applied" if decision == "approve" else "rejected")
        self.assertEqual(list(self.pending_dir.glob("*.json")), [])
        self.assertEqual(self.memory.read_text(), AFTER if decision == "approve" else BEFORE)
        for _attempt in range(2):
            replay = self.call()
            self.assertTrue(replay["ok"], replay)
            self.assertEqual(replay["result"], proposal)
        self.assertEqual(self.journal()[1]["state"], "published")
        self.assertEqual(list(self.pending_dir.glob("*.json")), [])
        self.assertEqual(list(self.proposals.glob("*.stage")), [])
        self.assertEqual(self.events().count("native-pending-published-by-link"), 1)
        self.assertEqual(self.events().count("native-memory-write"), 1 if decision == "approve" else 0)

    def test_repeat_after_human_approval_does_not_recreate_or_apply_again(self):
        self.completed_review_retry("approve")

    def test_repeat_after_human_rejection_does_not_recreate_or_write_memory(self):
        self.completed_review_retry("reject")

    def test_approval_after_unlink_crash_completes_receipt_without_recreating_pending(self):
        self.completed_review_retry("approve", crash_before_published_receipt=True)

    def test_rejection_after_unlink_crash_completes_receipt_without_recreating_pending(self):
        self.completed_review_retry("reject", crash_before_published_receipt=True)

    def test_same_request_id_with_changed_payload_is_denied(self):
        original = self.assert_pending(self.call())
        changed = {**self.input, "payload": {**self.input["payload"], "content": "Fictional Office sends updates on Friday."}}
        before = {path.name: path.read_bytes() for path in self.pending_dir.glob("*.json")}
        self.held(self.call(self.request(input=changed)))
        self.assertEqual({path.name: path.read_bytes() for path in self.pending_dir.glob("*.json")}, before)
        self.assert_pending(self.call(), original["id"])
        self.assertEqual(self.events().count("native-pending-published-by-link"), 1)

    def test_missing_published_pending_is_held_without_recreation(self):
        original = self.assert_pending(self.call())
        journal, stage, pending, _value = self.paths()
        before = journal.read_bytes()
        pending.unlink()
        self.held(self.call())
        self.assertFalse(pending.exists())
        self.assertFalse(stage.exists())
        self.assertEqual(journal.read_bytes(), before)
        self.assertEqual(self.memory.read_text(), BEFORE)
        self.assertEqual(self.events().count("native-pending-published-by-link"), 1)
        self.assertRegex(original["id"], r"^[a-f0-9]{8}$")

    def test_third_hard_link_is_held_and_all_bytes_preserved(self):
        self.call(mode="link", expect_crash=True)
        journal, stage, pending, _value = self.paths()
        third = self.base / "unadmitted-third-link.json"
        os.link(pending, third)
        before = {path: path.read_bytes() for path in (journal, stage, pending, third)}
        self.held(self.call())
        for path, content in before.items():
            self.assertEqual(path.read_bytes(), content)
        self.assertEqual(pending.stat().st_nlink, 3)
        self.assertEqual(self.memory.read_text(), BEFORE)
        self.assertEqual(self.events().count("native-memory-write"), 0)

    def test_foreign_replacement_of_linked_pending_preserves_both_files(self):
        self.call(mode="link", expect_crash=True)
        journal, stage, pending, _value = self.paths()
        replacement = self.base / "fictional-foreign.json"
        self.private(replacement, FOREIGN)
        os.replace(replacement, pending)
        before = {path: path.read_bytes() for path in (journal, stage, pending)}
        self.held(self.call())
        for path, content in before.items():
            self.assertEqual(path.read_bytes(), content)
        self.assertNotEqual(stage.stat().st_ino, pending.stat().st_ino)
        self.assertEqual(self.memory.read_text(), BEFORE)

    def test_private_stage_corruption_is_held_without_overwriting_evidence(self):
        self.call(mode="stage", expect_crash=True)
        journal, stage, pending, _value = self.paths()
        self.private(stage, FOREIGN)
        before = journal.read_bytes()
        self.held(self.call())
        self.assertEqual(stage.read_bytes(), FOREIGN)
        self.assertEqual(journal.read_bytes(), before)
        self.assertFalse(pending.exists())
        self.assertEqual(self.memory.read_text(), BEFORE)

    def test_foreign_pending_created_at_publication_is_not_overwritten(self):
        self.held(self.call(mode="foreign-before-link"))
        journal, stage, pending, _value = self.paths()
        self.assertEqual(pending.read_bytes(), FOREIGN)
        before = {path: path.read_bytes() for path in (journal, stage, pending)}
        self.held(self.call())
        for path, content in before.items():
            self.assertEqual(path.read_bytes(), content)
        self.assertEqual(self.memory.read_text(), BEFORE)
        self.assertEqual(self.events().count("native-pending-published-by-link"), 0)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--child":
        raise SystemExit(child_main(sys.argv[2]))
    unittest.main(verbosity=2)
