#!/usr/bin/env python3
"""Portable harness-control checks. These exercise no Windows storage or Hermes."""
from contextlib import redirect_stderr, redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
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
