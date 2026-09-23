#!/usr/bin/env python3
"""Native Windows journal acceptance; the production memory holds stay intact.

Uses an explicit Hermes venv and the selected helpers, never a source fallback.
Reuses scenario assertions from the portable suite, but not its FakeWindowsIO.
All data is fictional, beneath a new temporary root. No runtime is downloaded.
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
import platform
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import unittest

SCRIPT = Path(__file__).resolve()
ROOT = SCRIPT.parents[2]
SCENARIOS = SCRIPT.with_name("hermes-memory-windows-journal.py")
HELPERS = ("hermes-memory-review.py", "hermes-memory-proposals.py",
           "hermes-memory-windows-journal.py", "hermes-memory-windows.py",
           "hermes-memory-windows-native.py")
RUNTIME_FILES = {"tools/memory_tool.py", "tools/memory_tool_store.py",
                 "tools/write_approval.py", "tools/threat_patterns.py",
                 "tools/__init__.py", "tools/registry.py", "utils.py", "hermes_constants.py"}
CRASHES = {name: 70 + index for index, name in enumerate((
    "proposal-intent", "proposal-stage", "proposal-move-before", "proposal-move-after",
    "proposal-published-before", "proposal-published-after", "review-intent",
    "memory-before", "memory-after", "review-final-before", "review-final-after",
    "cleanup-before", "cleanup-after"), 1)}
CORE_CASES = (
    "test_propose_list_preview_approve_and_exact_replay", "test_reject_and_replay_never_writes_memory",
    "test_stage_crash_retries_once", "test_before_publication_crash_retries_once",
    "test_after_publication_crash_reconciles_once", "test_before_published_receipt_crash_reconciles_once",
    "test_after_published_receipt_replays_exactly", "test_prepared_intent_with_both_names_missing_is_held",
    "test_equal_bytes_in_two_names_are_not_a_valid_move_replay", "test_unsigned_orphan_stage_is_not_adopted",
    "test_human_approval_before_proposal_receipt_never_restages", "test_human_rejection_before_proposal_receipt_never_restages",
    "test_review_intent_retry_writes_once", "test_before_memory_write_retry_writes_once",
    "test_after_memory_write_retry_flushes_without_rewrite", "test_before_final_receipt_retry_flushes_without_rewrite",
    "test_after_final_receipt_retry_only_cleans_up", "test_public_json_and_direct_dispatch_cannot_bypass_windows_hold",
    "test_untrusted_request_and_payload_fields_are_rejected", "test_changed_memory_after_intent_preserves_current_content",
    "test_native_dry_run_rejects_missing_replace_match",
)
EXTRA_CASES = ("test_cleanup_before_crash_retries_without_rewrite", "test_cleanup_after_crash_replays_without_rewrite",
               "test_interrupted_intent_can_be_closed_without_memory_change", "test_native_review_lock_blocks_another_process",
               "test_broad_acl_refuses_without_repair", "test_junction_ancestor_refuses_without_mutation",
               "test_native_facade_rejects_paths_outside_profile")
CHILD_SECONDS, FIXTURE_SECONDS, RUN_SECONDS = 60, 120, 900
MARKER = "fictional-journal-proof-root.json"
NATIVE_STARTED = False


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def checked_file(path):
    info = Path(path).lstat()
    require(stat.S_ISREG(info.st_mode) and not info.st_nlink > 1 and
            not getattr(info, "st_file_attributes", 0) & 0x400,
            "A selected input must be an ordinary, singly linked file.")
    return Path(path)


def read_admission(path):
    source = checked_file(path).read_text(encoding="utf-8")
    runtime = re.search(r"MEMORY_REVIEW_RUNTIME\s*=\s*['\"]([a-f0-9]{40})['\"]", source)
    table = re.search(r"MEMORY_REVIEW_NATIVE_FILES\s*=\s*\{([^}]+)\}", source, re.S)
    require(runtime is not None and table is not None, "The selected admission table is missing.")
    entry_pattern = r"['\"]([^'\"]+)['\"]\s*:\s*['\"]([a-f0-9]{64})['\"]"
    entries = re.findall(entry_pattern, table.group(1))
    require(len(entries) == len(RUNTIME_FILES) and {name for name, _ in entries} == RUNTIME_FILES,
            "The runtime admission file set changed; review the harness before running.")
    require(not re.sub(entry_pattern, "", table.group(1)).strip(" \t\r\n,"),
            "The runtime admission table contains an unrecognized entry.")
    return runtime.group(1), dict(entries)


def input_hashes(args):
    commit, admitted = read_admission(args.admission)
    result = {"harness": sha(SCRIPT), "scenario_assertions": sha(checked_file(SCENARIOS)),
              "admission": sha(args.admission), "helpers": {}, "runtime_files": {}}
    for name in HELPERS:
        result["helpers"][name] = sha(checked_file(args.helpers / name))
    for name, expected in admitted.items():
        actual = sha(checked_file(args.runtime / name))
        require(actual == expected, "Selected Hermes source does not match the admission table: " + name)
        result["runtime_files"][name] = actual
    python = checked_file(args.runtime / "venv/Scripts/python.exe")
    result["runtime_python"] = sha(python)
    require(not (args.runtime / ".env").exists(), "Select a runtime without an ambient dotenv file.")
    return commit, result


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    require(spec is not None and spec.loader is not None, "A selected module cannot be loaded.")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def checkpoint(path, data, when):
    path = Path(path)
    if path.name in ("MEMORY.md", "USER.md"):
        return "memory-" + when
    if path.parent.name == "proposals" and re.fullmatch(r"[a-f0-9]{64}\.stage", path.name) and when == "after":
        return "proposal-stage"
    if path.suffix != ".json":
        return None
    record = json.loads(data)
    if path.parent.name == "proposals":
        if record.get("state") == "prepared" and when == "after":
            return "proposal-intent"
        if record.get("state") == "published":
            return "proposal-published-" + when
    if path.parent.name == ".realbud-memory-reviews":
        if record.get("phase") == "intent" and when == "after":
            return "review-intent"
        if record.get("phase") == "final":
            return "review-final-" + when
    return None


def environment(root, profile=None):
    env = {key: value for key, value in os.environ.items()
           if key.upper() in {"SYSTEMROOT", "WINDIR", "PATH", "PATHEXT", "COMSPEC", "SYSTEMDRIVE"}}
    home = root / "fictional-home"
    for path in (home, home / "AppData/Roaming", home / "AppData/Local"):
        path.mkdir(parents=True, exist_ok=True)
    env.update(HOME=str(home), USERPROFILE=str(home), APPDATA=str(home / "AppData/Roaming"),
               LOCALAPPDATA=str(home / "AppData/Local"), TEMP=str(root), TMP=str(root),
               HERMES_SKIP_DOTENV="1", PYTHONDONTWRITEBYTECODE="1")
    if profile is not None:
        env["HERMES_HOME"] = str(profile)
    return env


def stop_tree(child):
    if child.poll() is not None:
        return False
    killer = Path(os.environ["SystemRoot"]) / "System32/taskkill.exe"
    stopped = False
    try:
        killed = subprocess.run([str(killer), "/PID", str(child.pid), "/T", "/F"], stdin=subprocess.DEVNULL,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20, check=False)
        stopped = killed.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        pass
    finally:
        if child.poll() is None:
            child.kill()
        child.wait(timeout=10)
    return stopped


def run_process(command, *, env, cwd, payload=None, timeout=CHILD_SECONDS):
    child = subprocess.Popen(command, env=env, cwd=cwd, stdin=subprocess.PIPE if payload is not None else subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=subprocess.CREATE_NO_WINDOW)
    try:
        stdout, stderr = child.communicate(payload, timeout=timeout)
    except subprocess.TimeoutExpired:
        stopped = stop_tree(child)
        child.stdout.close()
        child.stderr.close()
        raise AssertionError("A disposable child exceeded its timeout; " +
                             ("its process tree was stopped." if stopped else "descendant cleanup is unverified.")) from None
    require(len(stdout) <= 256 * 1024 and len(stderr) <= 64 * 1024, "Child output exceeded the proof bound.")
    return child.returncode, stdout, stderr


def common_args(args):
    return ["--runtime", str(args.runtime), "--helpers", str(args.helpers), "--admission", str(args.admission),
            "--suite-root", str(args.suite_root)]


def observed_io(journal, profile, mode, events):
    class ObservedNativeIO(journal.WindowsJournalIO):
        # Every operation delegates to the unchanged native implementation.
        # Observations and intentional process exits are the only additions.
        def event(self, operation, path=None):
            record = {"op": operation}
            if path is not None:
                record["path"] = Path(path).relative_to(Path(self.profile)).as_posix()
            with events.open("ab") as stream:
                stream.write(json.dumps(record, sort_keys=True).encode() + b"\n")
                stream.flush()
                os.fsync(stream.fileno())

        def crash(self, point):
            if point is not None and mode == point:
                self.event("crash:" + point)
                os._exit(CRASHES[point])

        def names(self, path, **kwargs):
            self.event("names", path)
            return super().names(path, **kwargs)

        @contextmanager
        def lock(self, path):
            with super().lock(path):
                self.event("lock-acquired", path)
                try:
                    yield
                finally:
                    self.event("lock-released", path)

        def atomic_write(self, path, data):
            self.crash(checkpoint(path, data, "before"))
            result = super().atomic_write(path, data)
            self.event("atomic-write", path)
            self.crash(checkpoint(path, data, "after"))
            return result

        def write_new(self, path, data):
            result = super().write_new(path, data)
            self.event("write-new", path)
            self.crash(checkpoint(path, data, "after"))
            return result

        def move_new(self, source, target, expected_digest):
            proposal = Path(source).parent.name == "proposals" and re.fullmatch(r"[a-f0-9]{64}\.stage", Path(source).name)
            if proposal:
                self.crash("proposal-move-before")
            result = super().move_new(source, target, expected_digest)
            self.event("move-new", target)
            if proposal:
                self.crash("proposal-move-after")
            return result

        def delete_exact(self, path, expected_digest):
            claim = Path(path).parent.name == "claims"
            if claim:
                self.crash("cleanup-before")
            result = super().delete_exact(path, expected_digest)
            self.event("delete-exact", path)
            if claim:
                self.crash("cleanup-after")
            return result

        def flush_file(self, path, **kwargs):
            result = super().flush_file(path, **kwargs)
            self.event("flush-file", path)
            return result
    return ObservedNativeIO(profile)


def child_main(args):
    review = load("realbud_native_journal_review", args.helpers / HELPERS[0])
    if args.child == "public-windows":
        return review.main()
    raw = sys.stdin.buffer.read(128 * 1024 + 1)
    require(len(raw) <= 128 * 1024, "Request exceeded its bound.")
    request = json.loads(raw)
    profile = Path(request["profileDirectory"])
    require(profile.is_relative_to(args.suite_root) and profile.name == "property-fictional-windows-journal",
            "The child accepts only its disposable fictional profile.")
    io = None
    try:
        context = review._parse_request(request)
        if args.child == "direct-windows":
            result = review._dispatch(context)
        else:
            journal = load("realbud_native_journal_io", args.helpers / HELPERS[2])
            io = observed_io(journal, context.profile_dir, args.child, Path(os.environ["REALBUD_TEST_EVENT_LOG"]))
            original = review._import_native

            def native_import(ctx):
                original(ctx)

                def forbidden(*_args, **_kwargs):
                    io.event("FORBIDDEN:upstream-path-write")
                    raise AssertionError("The native journal escaped to the upstream path-based writer.")
                ctx.MemoryStore._write_file = staticmethod(forbidden)
            review._import_native = native_import
            result = review._dispatch_ready(context, storage=io)
        review._emit({"ok": True, "result": result})
    except review.ReviewError as error:
        review._emit({"ok": False, "code": error.code})
    finally:
        if io is not None:
            require(not io._held, "Native journal locks leaked after dispatch.")
            require(review._REQUEST_STORAGE.get() is None, "Request-bound native storage leaked after dispatch.")
            try:
                review._windows_io(io.profile)
            except review.ReviewError as error:
                require(error.code == "platform-unverified", "An unexpected ambient storage fallback was selected.")
            else:
                raise AssertionError("Native storage remained available outside its request context.")
    return 0


def fixture_powershell(args, script, path, target=None):
    env = environment(args.suite_root)
    env["REALBUD_JOURNAL_PATH"] = str(path)
    if target is not None:
        env["REALBUD_JOURNAL_TARGET"] = str(target)
    command = Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    code, stdout, stderr = run_process([str(command), "-NoProfile", "-NonInteractive", "-EncodedCommand",
                                      base64.b64encode(script.encode("utf-16le")).decode()], env=env,
                                     cwd=args.suite_root, timeout=FIXTURE_SECONDS)
    require(code == 0 and not stderr, "The disposable ACL/junction fixture command failed.")
    return stdout.decode("utf-8-sig").strip()


def suite_main(args):
    global NATIVE_STARTED
    core = load("realbud_native_journal_scenarios", SCENARIOS)
    core.RUNTIME = args.runtime
    commit, _ = read_admission(args.admission)
    native_module = load("realbud_native_journal_fixture", args.helpers / HELPERS[4])
    journal = load("realbud_native_journal_direct_io", args.helpers / HELPERS[2])

    def forbidden_fake(*_args, **_kwargs):
        raise AssertionError("FakeWindowsIO is forbidden in native acceptance.")
    core.FakeWindowsIO.__init__ = forbidden_fake

    class NativeJournalAcceptance(core.WindowsJournalIntegration):
        def setUp(self):
            global NATIVE_STARTED
            self.base = Path(tempfile.mkdtemp(prefix="fictional-case-", dir=args.suite_root)).resolve()
            self.addCleanup(lambda: shutil.rmtree(self.base))
            self.native = native_module.Win32Native()
            self.profile = self.base / core.PROFILE
            for part in ("", "memories", "pending", "pending/memory"):
                handle = self.native.create_private_directory(str(self.profile / part))
                try:
                    self.native.verify_private(handle)
                finally:
                    self.native.close(handle)
            NATIVE_STARTED = True
            self.memory = self.profile / "memories/MEMORY.md"
            self.private(self.memory, core.BEFORE.encode())
            self.private(self.profile / "config.yaml", core.CONFIG)
            self.events = self.base / "fixture-events.jsonl"
            self.reviews = self.profile / ".realbud-memory-reviews"
            self.input = {"requestId": "fictional-schedule-change", "payload": {
                "action": "replace", "target": "memory", "old_text": "Monday", "content": core.AFTER}}

        def private(self, path, data):
            path = Path(path)
            require(path.is_relative_to(self.profile), "Fixture mutation escaped its profile.")
            if path.exists():
                # Negative-test edits only, between child processes. Existing ACLs stay intact.
                checked_file(path).write_bytes(data)
                return
            handle = self.native.create_private_file(str(path))
            try:
                self.native.verify_private(handle)
                self.native.write(handle, data)
                self.native.flush(handle)
            finally:
                self.native.close(handle)

        def request(self, command="propose", **extra):
            request = super().request(command, **extra)
            request["runtimeId"] = commit
            return request

        def count(self, operation, path=None):
            normalized = None if path is None else path.replace("\\", "/")
            return sum(row["op"] == operation and (normalized is None or row.get("path") == normalized)
                       for row in self.log())

        def call(self, request=None, *, mode="normal", crash=False):
            env = environment(args.suite_root, self.profile)
            env["REALBUD_TEST_EVENT_LOG"] = str(self.events)
            code, stdout, stderr = run_process([sys.executable, "-I", "-B", str(SCRIPT), *common_args(args), "--child", mode],
                                               env=env, cwd=args.runtime, payload=json.dumps(request or self.request()).encode())
            self.assertEqual(code, CRASHES[mode] if crash else 0, "The journal child returned an unexpected exit status.")
            self.assertEqual(stderr, b"", "The journal child wrote unexpected stderr.")
            self.assertFalse(any(row["op"].startswith("FORBIDDEN:") for row in self.log()))
            if crash:
                self.assertEqual(stdout, b"")
                self.assertTrue(any(row["op"] == "crash:" + mode for row in self.log()))
                return None
            return json.loads(stdout)

        def retry_review_crash(self, point):
            # The shared assertions use a POSIX path literal for this ordering
            # check. Keep the same contract with canonical receipt paths here.
            item = self.propose()
            preview = self.preview(item)
            request = self.decision(item, preview)
            self.call(request, mode=point, crash=True)
            receipt_path = self.reviews / (item + ".json")
            saved = json.loads(receipt_path.read_text())
            self.assertEqual(saved["reviewDigest"], preview["reviewDigest"])
            result = self.success(self.call(request))
            self.assertEqual(result["state"], "applied")
            self.assertEqual(self.memory.read_text(), core.AFTER)
            self.assertEqual(self.count("atomic-write", "memories/MEMORY.md"), 1)
            self.assertEqual(self.success(self.call(request)), result)
            if point in ("memory-after", "review-final-before"):
                logs = self.log()
                crash_index = next(i for i, row in enumerate(logs) if row["op"] == "crash:" + point)
                later = logs[crash_index + 1:]
                flush = next(i for i, row in enumerate(later) if row["op"] == "flush-file" and row.get("path") == "memories/MEMORY.md")
                final = next(i for i, row in enumerate(later) if row["op"] == "atomic-write" and row.get("path") == receipt_path.relative_to(self.profile).as_posix())
                self.assertLess(flush, final)
            self.assertFalse((self.reviews / "claims" / (item + ".json")).exists())

        def test_cleanup_before_crash_retries_without_rewrite(self):
            self.retry_review_crash("cleanup-before")

        def test_cleanup_after_crash_replays_without_rewrite(self):
            self.retry_review_crash("cleanup-after")

        def test_interrupted_intent_can_be_closed_without_memory_change(self):
            self.call(mode="proposal-intent", crash=True)
            row, = self.success(self.call(self.request("interrupted-list")))["items"]
            self.assertEqual(row["state"], "interrupted")
            request = self.request("interrupted-close", proposalKey=row["key"], expectedDigest=row["recoveryDigest"])
            first = self.success(self.call(request))
            self.assertEqual(first["state"], "closed")
            self.assertEqual(self.success(self.call(request)), first)
            self.assertEqual(self.memory.read_text(), core.BEFORE)
            self.assertEqual(self.count("atomic-write", "memories/MEMORY.md"), 0)

        def test_native_review_lock_blocks_another_process(self):
            self.propose()
            handle = self.native.open_lock(str(self.reviews / "review.lock"))
            try:
                self.native.lock(handle, timeout_ms=0)
                try:
                    self.assertEqual(self.call(self.request("list")), {"ok": False, "code": "conflict"})
                finally:
                    self.native.unlock(handle)
            finally:
                self.native.close(handle)
            self.assertEqual(len(self.success(self.call(self.request("list")))["items"]), 1)
            self.assertEqual(self.memory.read_text(), core.BEFORE)

        def test_broad_acl_refuses_without_repair(self):
            item = self.propose()
            pending = self.profile / "pending/memory" / (item + ".json")
            before = pending.read_bytes()
            mutate = r"""
$ErrorActionPreference='Stop'
$item=[System.IO.FileInfo]::new($env:REALBUD_JOURNAL_PATH)
$acl=$item.GetAccessControl()
$sid=[System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid,'Read','Allow'))
$item.SetAccessControl($acl)
[Console]::Write($item.GetAccessControl().Sddl)
"""
            descriptor = fixture_powershell(args, mutate, pending)
            self.assertEqual(self.call(self.request("preview", id=item)), {"ok": False, "code": "unsafe-storage"})
            after = fixture_powershell(args, "[Console]::Write([System.IO.FileInfo]::new($env:REALBUD_JOURNAL_PATH).GetAccessControl().Sddl)", pending)
            self.assertEqual(after, descriptor)
            self.assertEqual(pending.read_bytes(), before)
            self.assertEqual(self.memory.read_text(), core.BEFORE)

        def test_junction_ancestor_refuses_without_mutation(self):
            item = self.propose()
            pending = self.profile / "pending/memory"
            moved = self.profile / "pending/fictional-preserved"
            os.rename(pending, moved)
            try:
                fixture_powershell(args, "$ErrorActionPreference='Stop'; New-Item -ItemType Junction -Path $env:REALBUD_JOURNAL_PATH -Target $env:REALBUD_JOURNAL_TARGET | Out-Null", pending, moved)
                before = (moved / (item + ".json")).read_bytes()
                self.assertEqual(self.call(self.request("preview", id=item)), {"ok": False, "code": "unsafe-storage"})
                self.assertEqual((moved / (item + ".json")).read_bytes(), before)
                self.assertEqual(self.memory.read_text(), core.BEFORE)
            finally:
                if pending.exists():
                    require(pending.lstat().st_file_attributes & 0x400, "The disposable junction changed type.")
                    os.rmdir(pending)
                os.rename(moved, pending)

        def test_native_facade_rejects_paths_outside_profile(self):
            io = journal.WindowsJournalIO(str(self.profile))
            sentinel = self.base / "fictional-outside.txt"
            sentinel.write_bytes(b"fictional sentinel")
            for path in (str(sentinel), str(self.memory) + ":fictional", str(self.profile) + "\\memories\\..\\config.yaml", r"\\fictional.invalid\share\file"):
                with self.assertRaises(io.error_type) as error:
                    io.read(path)
                self.assertEqual(error.exception.code, "unsafe-storage")
            self.assertEqual(sentinel.read_bytes(), b"fictional sentinel")

    state = {"checks": [], "native_windows_validation": False, "runtime_python": platform.python_version(),
             "runtime_architecture": platform.machine(), "expected_checks": len(CORE_CASES + EXTRA_CASES)}

    class ReceiptResult(unittest.TestResult):
        def startTest(self, test):
            super().startTest(test)
            self.started = time.monotonic()
            state["active_check"] = test._testMethodName
            self.persist()

        def persist(self):
            state["native_windows_validation"] = NATIVE_STARTED
            staging = args.progress.with_suffix(".stage")
            staging.write_text(json.dumps(state), encoding="utf-8")
            staging.replace(args.progress)

        def finish(self, test, outcome, error=None):
            row = {"name": test._testMethodName, "status": outcome, "seconds": round(time.monotonic() - self.started, 3)}
            if error:
                row["failure_type"] = error[0].__name__
                code = getattr(error[1], "code", None)
                if code in {"unsafe-storage", "unavailable", "platform-unverified", "conflict", "capacity", "invalid", "recovery-required"}:
                    row["failure_code"] = code
                if isinstance(error[1], AssertionError):
                    row["failure"] = str(error[1])[:500]
            state["checks"].append(row)
            self.persist()

        def addSuccess(self, test):
            super().addSuccess(test)
            self.finish(test, "passed")

        def addFailure(self, test, err):
            super().addFailure(test, err)
            self.finish(test, "failed", err)
            self.stop()

        def addError(self, test, err):
            super().addError(test, err)
            self.finish(test, "error", err)
            self.stop()

        def addSkip(self, test, reason):
            super().addSkip(test, reason)
            self.finish(test, "skipped")
            self.stop()

    result = ReceiptResult()
    unittest.TestSuite(NativeJournalAcceptance(name) for name in CORE_CASES + EXTRA_CASES).run(result)
    state["passed"] = result.wasSuccessful() and not result.skipped and result.testsRun == state["expected_checks"]
    state.pop("active_check", None)
    result.persist()
    return 0 if state["passed"] else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime", type=Path, required=True, help="Explicit admitted Hermes checkout with venv/Scripts/python.exe")
    parser.add_argument("--helpers", "--helpers-dir", dest="helpers", type=Path, required=True, help="Exact source or installed server/helpers directory")
    parser.add_argument("--admission", type=Path, required=True, help="Matching server/hermes-memory-review.ts or packaged .js")
    parser.add_argument("--receipt", type=Path, help="Fresh receipt path; never overwritten")
    parser.add_argument("--source-revision", default=os.environ.get("REALBUD_BUILD_SHA") or os.environ.get("GITHUB_SHA"),
                        help="Optional full build revision recorded alongside exact input hashes")
    parser.add_argument("--child", choices=("normal", "public-windows", "direct-windows", *CRASHES), help=argparse.SUPPRESS)
    parser.add_argument("--suite-root", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--progress", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    sys.dont_write_bytecode = True
    args.runtime, args.helpers, args.admission = args.runtime.absolute(), args.helpers.absolute(), args.admission.absolute()
    if args.child or args.suite_root:
        require(os.name == "nt" and sys.platform == "win32", "Internal native mode requires Windows.")
        require(args.suite_root is not None and (args.suite_root / MARKER).is_file(), "Missing disposable proof root marker.")
        return child_main(args) if args.child else suite_main(args)
    if args.receipt is None or args.receipt.exists():
        parser.error("Use a fresh --receipt path.")
    if args.source_revision and not re.fullmatch(r"[a-fA-F0-9]{40}", args.source_revision):
        parser.error("--source-revision must be a full Git revision.")
    started = time.monotonic()
    receipt = {"schema": 1, "kind": "realbud-native-windows-memory-journal-proof", "passed": False,
               "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "platform": sys.platform,
               "layer": "Native Windows journal candidate with admitted Hermes semantics and fictional protected profiles",
               "native_windows_validation": False, "cleanup": True, "checks": [],
               "expected_checks": len(CORE_CASES + EXTRA_CASES), "reported_source_revision": args.source_revision,
               "selected_helpers": str(args.helpers), "selected_runtime": str(args.runtime),
               "selected_admission": str(args.admission), "timeouts": {"child_seconds": CHILD_SECONDS, "fixture_seconds": FIXTURE_SECONDS, "run_seconds": RUN_SECONDS},
               "limits": ["Public helper/host platform holds remain enforced. This harness calls an internal candidate seam only.",
                          "No model, provider, customer profile, credentials or hosted calls; no GUI or installer acceptance.",
                          "Crash cases terminate real children between native facade operations, not mid-syscall or at every kernel boundary.",
                          "No physical power-loss, disk-exhaustion, network/removable filesystem or adversarial same-user concurrency proof.",
                          "No forced sharing-denial/deferred-delete scenario beyond the separate native primitive suite.",
                          "A passing journal candidate is evidence for review, not authorization to remove production holds."]}
    scratch = None
    exit_code = 1
    try:
        if os.name != "nt" or sys.platform != "win32":
            receipt.update(status="unsupported", reason="A real Windows process is required; no selected modules or runtime were loaded.", cleanup=True)
            exit_code = 2
        else:
            commit, before = input_hashes(args)
            receipt.update(runtime_commit=commit, input_hashes=before)
            scratch = Path(tempfile.mkdtemp(prefix="RealBud fictional native journal 中文 ")).resolve()
            receipt["cleanup"] = False
            receipt["fixture_root"] = str(scratch)
            (scratch / MARKER).write_text('{"kind":"fictional-native-journal-proof"}', encoding="utf-8")
            args.suite_root, args.progress = scratch, scratch / "proof-progress.json"
            code, stdout, stderr = run_process([str(args.runtime / "venv/Scripts/python.exe"), "-I", "-B", str(SCRIPT),
                                               *common_args(args), "--progress", str(args.progress)], env=environment(scratch), cwd=scratch, timeout=RUN_SECONDS)
            if args.progress.exists():
                receipt.update(json.loads(args.progress.read_text(encoding="utf-8")))
            require(not stdout and not stderr, "The suite returned unexpected diagnostic output.")
            require(input_hashes(args) == (commit, before), "Selected helper/runtime inputs changed during acceptance.")
            receipt["sources_unchanged"] = True
            require(code == 0 and receipt.get("passed") and len(receipt["checks"]) == len(CORE_CASES + EXTRA_CASES),
                    "Native journal acceptance did not complete every required check.")
            exit_code = 0
    except Exception as error:
        receipt.update(passed=False, status="failed", failure_type=type(error).__name__)
        if isinstance(error, AssertionError):
            receipt["failure"] = str(error)
        if scratch is not None and args.progress is not None and args.progress.exists():
            try:
                progress = json.loads(args.progress.read_text(encoding="utf-8"))
                progress.pop("passed", None)
                receipt.update(progress)
            except (OSError, ValueError):
                receipt["progress_unreadable"] = True
    finally:
        if scratch is not None:
            try:
                shutil.rmtree(scratch)
                receipt["cleanup"] = not scratch.exists()
            except Exception:
                receipt.update(cleanup=False, cleanup_failure=True, passed=False)
                exit_code = 1
        if exit_code == 0 and receipt["cleanup"]:
            receipt.update(passed=True, status="passed")
        elif exit_code != 2:
            receipt["passed"] = False
        receipt["elapsed_seconds"] = round(time.monotonic() - started, 3)
        receipt["check_counts"] = {name: sum(row["status"] in states for row in receipt["checks"])
                                   for name, states in (("passed", {"passed"}), ("failed", {"failed", "error"}), ("skipped", {"skipped"}))}
        args.receipt.parent.mkdir(parents=True, exist_ok=True)
        with args.receipt.open("x", encoding="utf-8") as stream:
            json.dump(receipt, stream, indent=2)
            stream.write("\n")
        print(json.dumps({"status": receipt.get("status"), "passed": receipt["passed"], "checks": len(receipt["checks"]), "cleanup": receipt["cleanup"]}))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
