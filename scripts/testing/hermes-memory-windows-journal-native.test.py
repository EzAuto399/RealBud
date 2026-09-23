#!/usr/bin/env python3
"""Portable harness-control checks. These exercise no Windows storage or Hermes."""
from contextlib import redirect_stderr, redirect_stdout
import base64
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

SCRIPT = Path(__file__).with_name("hermes-memory-windows-journal-native.py")
spec = importlib.util.spec_from_file_location("native_journal_harness_control", SCRIPT)
harness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(harness)


class HarnessControls(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="fictional-harness-controls-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def invoke(self, receipt, *extra):
        args = [str(SCRIPT), "--runtime", str(self.root / "absent-runtime"),
                "--helpers-dir", str(self.root / "absent-helpers"),
                "--admission", str(self.root / "absent-admission"), "--receipt", str(receipt), *extra]
        with patch.object(sys, "argv", args), patch.object(sys, "platform", "unsupported-control-fixture"), \
             patch.dict(os.environ, {}, clear=True), redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            return harness.main()

    def test_unsupported_host_cannot_report_native_pass_or_load_inputs(self):
        receipt = self.root / "receipt.json"
        with patch.object(harness, "input_hashes", side_effect=AssertionError("must not load")) as selected:
            self.assertEqual(self.invoke(receipt), 2)
            selected.assert_not_called()
        value = json.loads(receipt.read_text())
        self.assertEqual((value["passed"], value["native_windows_validation"], value["cleanup"]), (False, False, True))
        self.assertEqual(value["status"], "unsupported")
        self.assertEqual(value["checks"], [])
        self.assertEqual(value["check_counts"], {"passed": 0, "failed": 0, "skipped": 0})
        self.assertEqual(value["expected_checks"], 28)

    def test_existing_receipt_is_preserved(self):
        receipt = self.root / "receipt.json"
        receipt.write_bytes(b"fictional prior receipt")
        with self.assertRaises(SystemExit) as error:
            self.invoke(receipt)
        self.assertEqual(error.exception.code, 2)
        self.assertEqual(receipt.read_bytes(), b"fictional prior receipt")

    def test_invalid_revision_fails_before_writing_receipt(self):
        receipt = self.root / "receipt.json"
        with self.assertRaises(SystemExit):
            self.invoke(receipt, "--source-revision", "short")
        self.assertFalse(receipt.exists())

    def test_valid_revision_is_recorded_without_native_claim(self):
        receipt = self.root / "receipt.json"
        self.assertEqual(self.invoke(receipt, "--source-revision", "a" * 40), 2)
        self.assertEqual(json.loads(receipt.read_text())["reported_source_revision"], "a" * 40)

    def admission(self, extra="", omit=None):
        path = self.root / "admission.ts"
        entries = [json.dumps(name) + ": " + json.dumps("b" * 64)
                   for name in sorted(harness.RUNTIME_FILES) if name != omit]
        path.write_text("export const MEMORY_REVIEW_RUNTIME = '" + "a" * 40 + "';\n"
                        "export const MEMORY_REVIEW_NATIVE_FILES = {" + ",".join(entries) + extra + "} as const;\n")
        return path

    def test_exact_runtime_admission_table_is_required(self):
        commit, files = harness.read_admission(self.admission())
        self.assertEqual(commit, "a" * 40)
        self.assertEqual(set(files), harness.RUNTIME_FILES)
        for path in (self.admission(omit="utils.py"),):
            with self.assertRaises(AssertionError):
                harness.read_admission(path)
        for extra in (',"foreign.py":"' + "c" * 64 + '"', ',"unexpected": true', ',"utils.py":"' + "b" * 64 + '"'):
            with self.assertRaises(AssertionError):
                harness.read_admission(self.admission(extra))

    def test_native_checkpoint_names_do_not_treat_internal_stages_as_proposal_stages(self):
        proposal = self.root / "proposals"
        self.assertEqual(harness.checkpoint(proposal / ("a" * 64 + ".stage"), b"not json", "after"), "proposal-stage")
        self.assertIsNone(harness.checkpoint(proposal / (".realbud-write-" + "a" * 64 + ".stage"), b"not json", "after"))
        self.assertIsNone(harness.checkpoint(proposal / ("a" * 64 + ".stage"), b"not json", "before"))
        self.assertEqual(harness.checkpoint(proposal / "intent.json", b'{"state":"prepared"}', "after"), "proposal-intent")
        self.assertEqual(harness.checkpoint(proposal / "intent.json", b'{"state":"published"}', "before"), "proposal-published-before")
        self.assertEqual(harness.checkpoint(self.root / ".realbud-memory-reviews/receipt.json", b'{"phase":"final"}', "after"), "review-final-after")
        self.assertEqual(harness.checkpoint(self.root / "memories/MEMORY.md", b"fictional", "before"), "memory-before")
        self.assertEqual(len(set(harness.CRASHES.values())), len(harness.CRASHES))

    def test_child_environment_excludes_ambient_credentials_and_profiles(self):
        with patch.dict(os.environ, {"PATH": "fictional-system-path", "OPENAI_API_KEY": "fictional-key",
                                    "HERMES_HOME": "fictional-existing-profile", "PYTHONPATH": "fictional-injection"}, clear=True):
            env = harness.environment(self.root, self.root / "fictional-profile")
        self.assertEqual(env["PATH"], "fictional-system-path")
        self.assertEqual(env["HERMES_SKIP_DOTENV"], "1")
        self.assertEqual(env["HERMES_HOME"], str(self.root / "fictional-profile"))
        self.assertTrue(Path(env["HOME"]).is_relative_to(self.root))
        self.assertNotIn("OPENAI_API_KEY", env)
        self.assertNotIn("PYTHONPATH", env)

    def test_fixture_suppresses_progress_before_running_the_owned_script(self):
        script = "[Console]::Write('fictional fixture')"
        with patch.dict(os.environ, {"SystemRoot": str(self.root)}, clear=True), \
             patch.object(harness, "run_process", return_value=(0, b"fictional fixture", b"")) as run:
            self.assertEqual(harness.fixture_powershell(SimpleNamespace(suite_root=self.root), script,
                             self.root / "fictional-link", self.root / "fictional-target"), "fictional fixture")
        command = run.call_args.args[0]
        self.assertEqual(command[1:4], ["-NoProfile", "-NonInteractive", "-EncodedCommand"])
        self.assertEqual(base64.b64decode(command[4]).decode("utf-16le"),
                         "$ProgressPreference='SilentlyContinue'\n" + script)
        self.assertEqual(run.call_args.kwargs["timeout"], harness.FIXTURE_SECONDS)

    def test_fixture_nonzero_or_any_stderr_still_fails_including_progress(self):
        progress = b'#< CLIXML\n<Objs><Obj S="progress">fictional progress</Obj></Objs>'
        for result in ((23, b"", b""), (0, b"fictional output", b"fictional error"), (0, b"", progress)):
            with self.subTest(exit_code=result[0], stderr_bytes=len(result[2])), \
                 patch.dict(os.environ, {"SystemRoot": str(self.root)}, clear=True), \
                 patch.object(harness, "run_process", return_value=result):
                with self.assertRaises(harness.FixtureCommandError) as error:
                    harness.fixture_powershell(SimpleNamespace(suite_root=self.root), "exit 0", self.root)
            diagnostic = error.exception.diagnostic
            self.assertEqual(diagnostic["exit_code"], result[0])
            self.assertEqual(diagnostic["stdout_bytes"], len(result[1]))
            self.assertEqual(diagnostic["stderr_bytes"], len(result[2]))
        self.assertEqual(diagnostic["stderr_kind"], "clixml")
        self.assertEqual(diagnostic["signals"], ["powershell-progress"])

    def test_fixture_diagnostics_retain_only_numeric_values_and_fixed_labels(self):
        private = rb'API_KEY=fictional-secret-8123 C:\Users\fictional-private https://fictional.invalid/?token=private-query'
        stderr = b'#< CLIXML\n<Objs><S S="Error">PermissionDenied ' + private + b'</S></Objs>'
        error = harness.FixtureCommandError(17, private, stderr)
        diagnostic = error.diagnostic
        self.assertEqual(diagnostic, {"exit_code": 17, "stdout_bytes": len(private), "stderr_bytes": len(stderr),
                         "stdout_kind": "text", "stderr_kind": "clixml", "signals": ["access-denied", "powershell-error"]})
        serialized = json.dumps({"failure": str(error), "fixture_diagnostic": diagnostic})
        for value in ("API_KEY", "fictional-secret-8123", "fictional-private", "fictional.invalid", "private-query"):
            self.assertNotIn(value, serialized)
        self.assertLess(len(serialized), 500)
        self.assertEqual(harness.fixture_diagnostic(0, b"", b"\xff"),
                         {"exit_code": 0, "stdout_bytes": 0, "stderr_bytes": 1,
                          "stdout_kind": "empty", "stderr_kind": "non-utf8", "signals": []})

    def test_fixture_junction_requires_directory_mount_point_before_following_target(self):
        valid = {"st_mode": stat.S_IFDIR, "st_file_attributes": 0x400, "st_reparse_tag": 0xA0000003}
        for change in ({"st_mode": stat.S_IFREG}, {"st_file_attributes": 0}, {"st_reparse_tag": 0},
                       {"st_reparse_tag": 0xA000000C}):
            with self.subTest(change=change), patch.object(Path, "lstat", return_value=SimpleNamespace(**(valid | change))), \
                 patch.object(os.path, "samefile") as same:
                with self.assertRaisesRegex(AssertionError, "directory mount-point"):
                    harness.require_fixture_junction(self.root / "fictional-link", self.root / "fictional-target")
                same.assert_not_called()

    def test_fixture_junction_requires_its_exact_owned_target(self):
        info = SimpleNamespace(st_mode=stat.S_IFDIR, st_file_attributes=0x400, st_reparse_tag=0xA0000003)
        link, target = self.root / "fictional-link", self.root / "fictional-target"
        with patch.object(Path, "lstat", return_value=info), patch.object(os.path, "samefile", return_value=False) as same:
            with self.assertRaisesRegex(AssertionError, "owned target"):
                harness.require_fixture_junction(link, target)
            same.assert_called_once_with(link, target)
        with patch.object(Path, "lstat", return_value=info), patch.object(os.path, "samefile", return_value=True):
            harness.require_fixture_junction(link, target)

    def test_timeout_always_attempts_to_kill_and_reap_owned_child(self):
        child = Mock(pid=123, poll=Mock(return_value=None))
        with patch.dict(os.environ, {"SystemRoot": str(self.root)}), \
             patch.object(subprocess, "run", side_effect=subprocess.TimeoutExpired("fictional-taskkill", 20)):
            self.assertFalse(harness.stop_tree(child))
        child.kill.assert_called_once_with()
        child.wait.assert_called_once_with(timeout=10)

    def test_process_timeout_is_failure_even_when_termination_succeeds(self):
        child = Mock(stdout=io.BytesIO(), stderr=io.BytesIO())
        child.communicate.side_effect = subprocess.TimeoutExpired("fictional-child", 60)
        with patch.object(subprocess, "CREATE_NO_WINDOW", 0, create=True), \
             patch.object(subprocess, "Popen", return_value=child), patch.object(harness, "stop_tree", return_value=True) as stop:
            with self.assertRaisesRegex(AssertionError, "exceeded its timeout"):
                harness.run_process(["fictional-child"], env={}, cwd=self.root)
        stop.assert_called_once_with(child)
        self.assertTrue(child.stdout.closed and child.stderr.closed)


if __name__ == "__main__":
    unittest.main(verbosity=2)
