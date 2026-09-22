#!/usr/bin/env python3
"""Portable journal integration tests: actual Hermes semantics, fake Windows IO.

Explicit --runtime selects an admitted, unmodified Hermes checkout and its venv.
Every profile is fictional and disposable. The storage facade below uses POSIX
fixture files; it exercises no WinAPI, ACL, sharing, device or durability claim.
The private Python dispatch seam is never exposed through request JSON or env.
"""
from __future__ import annotations

import argparse
import base64
from contextlib import contextmanager
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = Path(__file__).resolve()
REVIEW = ROOT / "server/helpers/hermes-memory-review.py"
PROPOSALS = ROOT / "server/helpers/hermes-memory-proposals.py"
PROFILE = "property-fictional-windows-journal"
WORKSPACE = "77777777-8888-4999-aaaa-bbbbbbbbbbbb"
KEY = base64.b64encode(b"j" * 32).decode("ascii")
SCOPE = "a" * 64
BEFORE = "Fictional Office sends updates on Monday."
AFTER = "Fictional Office sends updates on Tuesday."
FOREIGN = b'{"fictional":"unreviewed bytes must survive"}'
CONFIG = b"memory:\n  write_approval: true\n  memory_enabled: true\n  user_profile_enabled: true\n  memory_char_limit: 2200\n  user_char_limit: 1375\n"
CRASHES = {name: 70 + index for index, name in enumerate((
    "proposal-intent", "proposal-stage", "proposal-move-before", "proposal-move-after",
    "proposal-published-before", "proposal-published-after", "review-intent",
    "memory-before", "memory-after", "review-final-before", "review-final-after",
), 1)}
ORIGINAL = {name: getattr(os, name) for name in ("rename", "replace", "unlink", "link", "scandir")}
RUNTIME: Path | None = None


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


class FixtureStorageError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


class FakeWindowsIO:
    """Test-only POSIX persistence model, deliberately not a WinAPI emulator."""
    def __init__(self, review, profile: str, mode: str, events: Path):
        self.review, self.profile, self.mode, self.events = review, profile, mode, events
        self.error_type = FixtureStorageError
        self.held: set[str] = set()

    def path(self, path) -> Path:
        value = Path(path)
        if not value.is_absolute() or not value.is_relative_to(Path(self.profile)):
            raise AssertionError("Fixture IO escaped its fictional profile")
        return value

    def event(self, name: str, path=None) -> None:
        record = {"op": name}
        if path is not None:
            record["path"] = str(self.path(path).relative_to(self.profile))
        with self.events.open("ab") as stream:
            stream.write(json.dumps(record, sort_keys=True).encode() + b"\n")
            stream.flush()
            os.fsync(stream.fileno())

    def crash(self, point: str) -> None:
        if self.mode == point:
            self.event("crash:" + point)
            os._exit(CRASHES[point])

    def read(self, path, limit=128 * 1024, missing_ok=False):
        target = self.path(path)
        self.event("read", target)
        try:
            data = target.read_bytes()
        except FileNotFoundError:
            if missing_ok and target.parent.is_dir():
                return None
            raise self.error_type("unavailable") from None
        if len(data) > limit:
            raise self.error_type("capacity")
        return data

    def names(self, path, limit, missing_ok=True):
        target = self.path(path)
        self.event("names", target)
        try:
            with ORIGINAL["scandir"](target) as entries:
                names = [entry.name for entry in entries]
        except FileNotFoundError:
            if missing_ok:
                return []
            raise self.error_type("unavailable") from None
        if len(names) > limit:
            raise self.error_type("capacity")
        return names

    def checkpoint(self, path: Path, data: bytes, when: str) -> None:
        if path.name in ("MEMORY.md", "USER.md"):
            self.crash("memory-" + when)
        elif path.suffix == ".stage" and when == "after":
            self.crash("proposal-stage")
        elif path.suffix == ".json":
            record = json.loads(data)
            if path.parent.name == "proposals":
                if record.get("state") == "prepared" and when == "after":
                    self.crash("proposal-intent")
                if record.get("state") == "published":
                    self.crash("proposal-published-" + when)
            elif path.parent.name == ".realbud-memory-reviews":
                if record.get("phase") == "intent" and when == "after":
                    self.crash("review-intent")
                if record.get("phase") == "final":
                    self.crash("review-final-" + when)

    def require_lock(self):
        expected = str(Path(self.profile) / ".realbud-memory-reviews/review.lock")
        if expected not in self.held:
            raise AssertionError("A journal mutation escaped the selected review lock")

    def atomic_write(self, path, data):
        target = self.path(path)
        self.require_lock()
        if target.name in ("MEMORY.md", "USER.md") and str(target) + ".lock" not in self.held:
            raise AssertionError("A memory write escaped the exact selected memory lock")
        self.checkpoint(target, data, "before")
        fd, temporary = tempfile.mkstemp(prefix=".fictional-stage-", dir=target.parent)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            ORIGINAL["replace"](temporary, target)
        finally:
            if os.path.exists(temporary):
                ORIGINAL["unlink"](temporary)
        self.event("atomic-write", target)
        self.checkpoint(target, data, "after")

    def write_new(self, path, data):
        target = self.path(path)
        self.require_lock()
        self.checkpoint(target, data, "before")
        try:
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            raise self.error_type("conflict") from None
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        self.event("write-new", target)
        self.checkpoint(target, data, "after")

    def move_new(self, source, target, expected_digest):
        source, target = self.path(source), self.path(target)
        self.require_lock()
        proposal = source.suffix == ".stage"
        if proposal:
            self.crash("proposal-move-before")
            if self.mode == "foreign-before-move":
                with target.open("xb") as stream:
                    stream.write(FOREIGN)
            elif self.mode == "changed-stage-before-move":
                source.write_bytes(FOREIGN)
        if digest(self.read(source)) != expected_digest or target.exists():
            raise self.error_type("conflict")
        ORIGINAL["rename"](source, target)
        self.event("move-new", target)
        if proposal:
            self.crash("proposal-move-after")
        return None

    def delete_exact(self, path, expected_digest):
        target = self.path(path)
        self.require_lock()
        if self.mode == "changed-before-delete":
            target.write_bytes(FOREIGN)
        if digest(self.read(target)) != expected_digest:
            raise self.error_type("conflict")
        self.event("delete-requested", target)
        if self.mode != "delete-pending":
            ORIGINAL["unlink"](target)
            self.event("delete-namespace-absent", target)
        return "deletion-requested"

    def flush_file(self, path, expected_digest=None):
        target = self.path(path)
        data = self.read(target)
        if expected_digest is not None and digest(data) != expected_digest:
            raise self.error_type("conflict")
        with target.open("rb") as stream:
            os.fsync(stream.fileno())
        self.event("flush-file", target)

    def verify_directory(self, path):
        target = self.path(path)
        self.event("verify-directory", target)
        if not target.is_dir():
            raise self.error_type("unsafe-storage")

    def ensure_directory(self, path):
        target = self.path(path)
        target.mkdir(mode=0o700, exist_ok=True)
        self.event("ensure-directory", target)
        self.verify_directory(target)

    @contextmanager
    def lock(self, lock_path):
        target = str(self.path(lock_path))
        if target in self.held:
            raise AssertionError("Selected IO lock unexpectedly reentered")
        self.held.add(target)
        self.event("lock-acquired", target)
        try:
            yield
        finally:
            self.held.remove(target)
            self.event("lock-released", target)


def child_main(mode: str) -> int:
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location("realbud_windows_journal_subject", REVIEW)
    assert spec is not None and spec.loader is not None
    review = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = review
    spec.loader.exec_module(review)
    if mode == "public-windows":
        review.POSIX = False
        return review.main()
    request = json.loads(sys.stdin.buffer.read(128 * 1024))
    io = None
    try:
        ctx = review._parse_request(request)
        if mode == "direct-windows":
            review.POSIX = False
            result = review._dispatch(ctx)
        else:
            io = FakeWindowsIO(review, ctx.profile_dir, mode, Path(os.environ["REALBUD_TEST_EVENT_LOG"]))
            original_import = review._import_native
            def import_native(context):
                original_import(context)
                def forbidden_native(*args, **kwargs):
                    io.event("FORBIDDEN:native-memory-write")
                    raise AssertionError("Selected Windows IO escaped to native MemoryStore._write_file")
                context.MemoryStore._write_file = staticmethod(forbidden_native)
            review._import_native = import_native
            def forbidden_posix(*args, **kwargs):
                io.event("FORBIDDEN:posix-io")
                raise AssertionError("Selected Windows IO escaped to POSIX profile IO")
            for name in ORIGINAL:
                setattr(os, name, forbidden_posix)
            review._open_nofollow = forbidden_posix
            review.POSIX = False
            result = review._dispatch_ready(ctx, storage=io)
            if io.held:
                raise AssertionError("Selected IO locks remained held after dispatch")
            if review._windows_io(ctx.profile_dir) is not None:
                raise AssertionError("Request-bound selected IO leaked outside dispatch")
        review._emit({"ok": True, "result": result})
    except review.ReviewError as error:
        review._emit({"ok": False, "code": error.code})
    finally:
        if io is not None:
            if io.held:
                raise AssertionError("Selected IO locks leaked after successful or failed dispatch")
            if review._windows_io(io.profile) is not None:
                raise AssertionError("Request-bound selected IO leaked after successful or failed dispatch")
    return 0


class WindowsJournalIntegration(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="realbud-fictional-windows-journal-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.profile = self.base / PROFILE
        for part in ("", "memories", "pending/memory"):
            (self.profile / part).mkdir(mode=0o700, parents=True, exist_ok=True)
        self.memory = self.profile / "memories/MEMORY.md"
        self.private(self.memory, BEFORE.encode())
        self.private(self.profile / "config.yaml", CONFIG)
        self.events = self.base / "fixture-events.jsonl"
        self.reviews = self.profile / ".realbud-memory-reviews"
        self.input = {"requestId": "fictional-schedule-change", "payload": {
            "action": "replace", "target": "memory", "old_text": "Monday", "content": AFTER}}

    @staticmethod
    def private(path, data):
        path.write_bytes(data)
        path.chmod(0o600)

    def request(self, command="propose", **extra):
        request = {"version": 1, "command": command, "profileDirectory": str(self.profile),
                   "runtimeDirectory": str(RUNTIME), "workspaceId": WORKSPACE,
                   "profileId": PROFILE, "runtimeId": RUNTIME.parent.name, "key": KEY}
        if command == "propose":
            request.update(scopeId=SCOPE, input=self.input)
        request.update(extra)
        return request

    def call(self, request=None, *, mode="normal", crash=False):
        env = {name: os.environ[name] for name in ("PATH", "LANG", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR") if name in os.environ}
        env.update(HOME=str(self.base), HERMES_HOME=str(self.profile), HERMES_SKIP_DOTENV="1",
                   PYTHONDONTWRITEBYTECODE="1", REALBUD_TEST_EVENT_LOG=str(self.events))
        completed = subprocess.run([str(RUNTIME / "venv/bin/python"), "-I", "-B", str(SCRIPT), "--child", mode],
                                   input=json.dumps(request or self.request()).encode(), env=env,
                                   cwd=RUNTIME, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=40)
        if crash:
            self.assertEqual(completed.returncode, CRASHES[mode], completed.stderr.decode(errors="replace"))
            self.assertEqual(completed.stdout, b"")
            self.assertEqual(completed.stderr, b"")
            return None
        self.assertEqual(completed.returncode, 0, completed.stderr.decode(errors="replace"))
        self.assertEqual(completed.stderr, b"")
        response = json.loads(completed.stdout)
        self.assertFalse(any(entry["op"].startswith("FORBIDDEN:") for entry in self.log()))
        return response

    def log(self):
        return [json.loads(line) for line in self.events.read_text().splitlines()] if self.events.exists() else []

    def count(self, op, path=None):
        return sum(row["op"] == op and (path is None or row.get("path") == path) for row in self.log())

    def journal(self):
        matches = list((self.reviews / "proposals").glob("*.json"))
        self.assertEqual(len(matches), 1)
        path = matches[0]
        value = json.loads(path.read_text())
        return path, value, path.with_suffix(".stage"), self.profile / "pending/memory" / (value["id"] + ".json")

    def success(self, response):
        self.assertTrue(response["ok"], response)
        return response["result"]

    def propose(self):
        result = self.success(self.call())
        self.assertEqual(set(result), {"version", "id", "reviewLocation"})
        self.assertEqual(self.memory.read_text(), BEFORE)
        self.assertEqual(self.count("atomic-write", "memories/MEMORY.md"), 0)
        return result["id"]

    def preview(self, item):
        value = self.success(self.call(self.request("preview", id=item)))
        self.assertEqual((value["before"], value["after"]), (BEFORE, AFTER))
        return value

    def decision(self, item, preview, decision="approve"):
        return self.request("decide", id=item, expectedDigest=preview["reviewDigest"], decision=decision)

    def test_propose_list_preview_approve_and_exact_replay(self):
        item = self.propose()
        pending = self.profile / "pending/memory" / (item + ".json")
        pending_bytes = pending.read_bytes()
        self.assertEqual(self.success(self.call())["id"], item)
        self.assertEqual(pending.read_bytes(), pending_bytes)
        listed = self.success(self.call(self.request("list")))["items"]
        self.assertEqual([(row["id"], row["state"]) for row in listed], [(item, "pending")])
        preview = self.preview(item)
        request = self.decision(item, preview)
        first = self.success(self.call(request))
        self.assertEqual((first["state"], first["changed"]), ("applied", True))
        self.assertEqual(self.memory.read_text(), AFTER)
        self.assertFalse(pending.exists())
        self.assertEqual(self.success(self.call(request)), first)
        self.assertEqual(self.success(self.call())["id"], item)
        self.assertFalse(pending.exists(), "Proposal replay must not restage a reviewed item")
        self.assertEqual(self.count("atomic-write", "memories/MEMORY.md"), 1)
        self.assertGreater(self.count("names"), 0)
        self.assertEqual(self.count("lock-acquired"), self.count("lock-released"))

    def test_reject_and_replay_never_writes_memory(self):
        item = self.propose()
        request = self.decision(item, self.preview(item), "reject")
        first = self.success(self.call(request))
        self.assertEqual((first["state"], first["changed"]), ("rejected", False))
        self.assertEqual(self.success(self.call(request)), first)
        self.assertEqual(self.success(self.call())["id"], item)
        self.assertEqual(self.memory.read_text(), BEFORE)
        self.assertEqual(self.count("atomic-write", "memories/MEMORY.md"), 0)
        self.assertFalse(list((self.profile / "pending/memory").iterdir()))

    def retry_proposal_crash(self, point):
        self.call(mode=point, crash=True)
        _path, journal, stage, pending = self.journal()
        self.assertEqual(self.memory.read_text(), BEFORE)
        if point in ("proposal-stage", "proposal-move-before"):
            self.assertTrue(stage.exists())
            self.assertFalse(pending.exists())
        else:
            self.assertFalse(stage.exists())
            self.assertTrue(pending.exists())
        first = self.success(self.call())
        self.assertEqual(first["id"], journal["id"])
        blob = pending.read_bytes()
        self.assertEqual(self.success(self.call()), first)
        self.assertEqual(pending.read_bytes(), blob)
        self.assertEqual(self.journal()[1]["state"], "published")
        self.assertEqual(self.count("move-new", str(pending.relative_to(self.profile))), 1)
        self.assertEqual(self.memory.read_text(), BEFORE)

    def test_stage_crash_retries_once(self): self.retry_proposal_crash("proposal-stage")
    def test_before_publication_crash_retries_once(self): self.retry_proposal_crash("proposal-move-before")
    def test_after_publication_crash_reconciles_once(self): self.retry_proposal_crash("proposal-move-after")
    def test_before_published_receipt_crash_reconciles_once(self): self.retry_proposal_crash("proposal-published-before")
    def test_after_published_receipt_replays_exactly(self): self.retry_proposal_crash("proposal-published-after")

    def test_prepared_intent_with_both_names_missing_is_held(self):
        self.call(mode="proposal-intent", crash=True)
        path, journal, stage, pending = self.journal()
        before = path.read_bytes()
        self.assertFalse(stage.exists() or pending.exists())
        self.assertEqual(self.call(), {"ok": False, "code": "recovery-required"})
        self.assertEqual(path.read_bytes(), before)
        self.assertFalse(stage.exists() or pending.exists())
        self.assertEqual(journal["state"], "prepared")

    def test_colliding_destination_preserves_both_files(self):
        self.assertEqual(self.call(mode="foreign-before-move"), {"ok": False, "code": "conflict"})
        _path, _journal, stage, pending = self.journal()
        stage_bytes = stage.read_bytes()
        self.assertEqual(pending.read_bytes(), FOREIGN)
        self.assertEqual(self.call(), {"ok": False, "code": "conflict"})
        self.assertEqual((stage.read_bytes(), pending.read_bytes()), (stage_bytes, FOREIGN))
        self.assertEqual(self.memory.read_text(), BEFORE)

    def test_changed_stage_preserves_unreviewed_bytes(self):
        self.assertEqual(self.call(mode="changed-stage-before-move"), {"ok": False, "code": "conflict"})
        _path, _journal, stage, pending = self.journal()
        self.assertEqual(stage.read_bytes(), FOREIGN)
        self.assertFalse(pending.exists())
        self.assertFalse(self.call()["ok"])
        self.assertEqual(stage.read_bytes(), FOREIGN)
        self.assertFalse(pending.exists())

    def test_equal_bytes_in_two_names_are_not_a_valid_move_replay(self):
        self.call(mode="proposal-stage", crash=True)
        _path, _journal, stage, pending = self.journal()
        self.private(pending, stage.read_bytes())
        snapshot = (stage.read_bytes(), pending.read_bytes())
        self.assertEqual(self.call(), {"ok": False, "code": "conflict"})
        self.assertEqual((stage.read_bytes(), pending.read_bytes()), snapshot)

    def test_unsigned_orphan_stage_is_not_adopted(self):
        self.call(mode="proposal-stage", crash=True)
        path, _journal, stage, pending = self.journal()
        staged = stage.read_bytes()
        path.unlink()
        self.assertEqual(self.call(), {"ok": False, "code": "recovery-required"})
        self.assertEqual(stage.read_bytes(), staged)
        self.assertFalse(path.exists() or pending.exists())
        self.assertEqual(self.memory.read_text(), BEFORE)

    def human_review_before_published_receipt(self, decision):
        self.call(mode="proposal-move-after", crash=True)
        _path, journal, stage, pending = self.journal()
        self.assertEqual(journal["state"], "prepared")
        item = journal["id"]
        request = self.decision(item, self.preview(item), decision)
        first = self.success(self.call(request))
        self.assertFalse(stage.exists() or pending.exists())
        self.assertEqual(self.success(self.call())["id"], item)
        self.assertEqual(self.journal()[1]["state"], "published")
        self.assertEqual(self.success(self.call(request)), first)
        self.assertFalse(stage.exists() or pending.exists())
        self.assertEqual(self.memory.read_text(), AFTER if decision == "approve" else BEFORE)
        self.assertEqual(self.count("atomic-write", "memories/MEMORY.md"), int(decision == "approve"))
        self.assertEqual(self.count("move-new", str(pending.relative_to(self.profile))), 1)

    def test_human_approval_before_proposal_receipt_never_restages(self):
        self.human_review_before_published_receipt("approve")

    def test_human_rejection_before_proposal_receipt_never_restages(self):
        self.human_review_before_published_receipt("reject")

    def retry_review_crash(self, point):
        item = self.propose()
        preview = self.preview(item)
        request = self.decision(item, preview)
        self.call(request, mode=point, crash=True)
        receipt_path = self.reviews / (item + ".json")
        saved = json.loads(receipt_path.read_text())
        self.assertEqual(saved["reviewDigest"], preview["reviewDigest"])
        result = self.success(self.call(request))
        self.assertEqual(result["state"], "applied")
        self.assertEqual(self.memory.read_text(), AFTER)
        self.assertEqual(self.count("atomic-write", "memories/MEMORY.md"), 1)
        self.assertEqual(self.success(self.call(request)), result)
        if point in ("memory-after", "review-final-before"):
            logs = self.log()
            checkpoint = next(i for i, row in enumerate(logs) if row["op"] == "crash:" + point)
            later = logs[checkpoint + 1:]
            flush = next(i for i, row in enumerate(later) if row["op"] == "flush-file" and row.get("path") == "memories/MEMORY.md")
            final = next(i for i, row in enumerate(later) if row["op"] == "atomic-write" and row.get("path") == str(receipt_path.relative_to(self.profile)))
            self.assertLess(flush, final)

    def test_review_intent_retry_writes_once(self): self.retry_review_crash("review-intent")
    def test_before_memory_write_retry_writes_once(self): self.retry_review_crash("memory-before")
    def test_after_memory_write_retry_flushes_without_rewrite(self): self.retry_review_crash("memory-after")
    def test_before_final_receipt_retry_flushes_without_rewrite(self): self.retry_review_crash("review-final-before")
    def test_after_final_receipt_retry_only_cleans_up(self): self.retry_review_crash("review-final-after")

    def test_delete_request_is_not_terminal_cleanup(self):
        item = self.propose()
        request = self.decision(item, self.preview(item))
        self.assertEqual(self.call(request, mode="delete-pending"), {"ok": False, "code": "recovery-required"})
        claim = self.reviews / "claims" / (item + ".json")
        self.assertTrue(claim.exists())
        self.assertEqual(json.loads((self.reviews / (item + ".json")).read_text())["phase"], "final")
        row = self.success(self.call(self.request("list")))["items"][0]
        self.assertEqual(row["state"], "recovery-required")
        self.assertEqual(self.success(self.call(request))["state"], "applied")
        self.assertFalse(claim.exists())
        self.assertEqual(self.count("atomic-write", "memories/MEMORY.md"), 1)

    def test_changed_claim_is_preserved_without_duplicate_memory_write(self):
        item = self.propose()
        request = self.decision(item, self.preview(item))
        self.assertEqual(self.call(request, mode="changed-before-delete"), {"ok": False, "code": "conflict"})
        claim = self.reviews / "claims" / (item + ".json")
        self.assertEqual(claim.read_bytes(), FOREIGN)
        self.assertEqual(self.call(request), {"ok": False, "code": "conflict"})
        self.assertEqual(claim.read_bytes(), FOREIGN)
        self.assertEqual(self.memory.read_text(), AFTER)
        self.assertEqual(self.count("atomic-write", "memories/MEMORY.md"), 1)

    def test_public_json_and_direct_dispatch_cannot_bypass_windows_hold(self):
        for mode in ("public-windows", "direct-windows"):
            self.assertEqual(self.call(mode=mode), {"ok": False, "code": "platform-unverified"})
        for field in ("storage", "windowsIO", "platform", "_dispatch_ready", "allowWindows", "testMode"):
            self.assertEqual(self.call(self.request(**{field: True}), mode="public-windows"),
                             {"ok": False, "code": "platform-unverified"})
        self.assertFalse(self.reviews.exists())
        self.assertEqual(self.memory.read_text(), BEFORE)

    def test_untrusted_request_and_payload_fields_are_rejected(self):
        for field in ("storage", "windowsIO", "platform", "testMode"):
            self.assertEqual(self.call(self.request(**{field: True})), {"ok": False, "code": "invalid"})
        for field in ("approved", "expectedDigest", "decision", "path", "skipReview"):
            modified = json.loads(json.dumps(self.input))
            modified["payload"][field] = True
            self.assertEqual(self.call(self.request(input=modified)), {"ok": False, "code": "unsupported"})
        self.assertEqual(self.memory.read_text(), BEFORE)
        self.assertFalse(list((self.profile / "pending/memory").iterdir()))

    def test_changed_memory_after_intent_preserves_current_content(self):
        item = self.propose()
        request = self.decision(item, self.preview(item))
        self.call(request, mode="memory-after", crash=True)
        changed = b"Fictional current preference changed independently."
        self.private(self.memory, changed)
        self.assertEqual(self.call(request), {"ok": False, "code": "conflict"})
        self.assertEqual(self.memory.read_bytes(), changed)
        self.assertEqual(self.count("atomic-write", "memories/MEMORY.md"), 1)

    def test_native_dry_run_rejects_missing_replace_match(self):
        modified = json.loads(json.dumps(self.input))
        modified["payload"]["old_text"] = "Never existed in this fictional memory"
        self.assertEqual(self.call(self.request(input=modified)), {"ok": False, "code": "conflict"})
        self.assertEqual(self.memory.read_text(), BEFORE)
        self.assertFalse(list((self.profile / "pending/memory").iterdir()))


def main() -> int:
    global RUNTIME
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", type=Path, required=True, help="Explicit admitted unmodified Hermes runtime")
    parser.add_argument("--receipt", type=Path, required=True, help="Fresh structured receipt; never overwritten")
    args = parser.parse_args()
    if args.receipt.exists():
        parser.error("Use a fresh receipt path")
    RUNTIME = args.runtime.expanduser().resolve()
    if os.name != "posix":
        parser.error("This is a POSIX-backed fake IO harness, not native Windows acceptance")
    inputs = [SCRIPT, REVIEW, PROPOSALS, RUNTIME / "tools/memory_tool.py", RUNTIME / "tools/memory_tool_store.py"]
    if not (RUNTIME / "venv/bin/python").is_file() or any(not path.is_file() for path in inputs):
        parser.error("The selected runtime, venv Python and exact helper sources are required")
    before = {str(path): digest(path.read_bytes()) for path in inputs}
    started = time.monotonic()
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(WindowsJournalIntegration)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    stable = {str(path): digest(path.read_bytes()) for path in inputs} == before
    passed = result.wasSuccessful() and stable and not result.skipped
    receipt = {"schema": 1, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
               "layer": "Actual admitted Hermes parser/dry-run and owned journal logic with explicit POSIX-backed fake Windows IO; no WinAPI",
               "passed": passed, "tests_run": result.testsRun, "failures": len(result.failures), "errors": len(result.errors),
               "skipped": len(result.skipped), "elapsed_seconds": round(time.monotonic() - started, 3),
               "native_windows_validation": False, "source_hashes": before, "sources_unchanged": stable,
               "failed_tests": [{"test": test.id(), "traceback": detail} for test, detail in result.failures + result.errors],
               "limits": ["No WinAPI, ACL, sharing, filesystem durability, installed Windows application, GUI, provider or customer validation.",
                          "The production WindowsJournalIO, WindowsMemoryStorage and native backend are not called; this suite substitutes the entire IO facade and does not prove concurrency.",
                          "Faults are actual child-process exits against fictional fixture files; fake IO does not reproduce native Windows storage guarantees.",
                          "Public main and dispatch platform holds remain enforced; no JSON or environment test override is added."]}
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    with args.receipt.open("x") as stream:
        json.dump(receipt, stream, indent=2)
        stream.write("\n")
    print(json.dumps({"passed": passed, "tests_run": result.testsRun, "failures": len(result.failures), "errors": len(result.errors), "receipt": str(args.receipt)}))
    return 0 if passed else 1


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--child":
        raise SystemExit(child_main(sys.argv[2]))
    raise SystemExit(main())
