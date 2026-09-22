#!/usr/bin/env python3
"""Signed interrupted-proposal closure tests in disposable fictional profiles.

Uses an explicitly admitted native runtime for its lock implementation. Selected
Windows cases use the existing fictional IO fixture, never actual Windows APIs.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
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
HELPERS = ROOT / 'server/helpers'
PROFILE = 'property-fictional-interrupted'
WORKSPACE = '77777777-8888-4999-aaaa-bbbbbbbbbbbb'
SCOPE = 'c' * 64
KEY_BYTES = b'r' * 32
KEY = base64.b64encode(KEY_BYTES).decode()
BEFORE = b'Fictional Office sends updates on Monday.'
CONFIG = b'memory:\n  write_approval: true\n  memory_enabled: true\n  user_profile_enabled: true\n'
FOREIGN = b'Fictional conflicting evidence must remain intact.'
EXIT_PREPARED, EXIT_CLOSED = 81, 82


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def child(mode, selected):
    review = load('realbud_interrupted_subject', HELPERS / 'hermes-memory-review.py')
    original_import = review._import_native
    def native(context):
        original_import(context)
        def forbidden(*args, **kwargs):
            raise AssertionError('Metadata recovery attempted a native memory write')
        context.MemoryStore._write_file = staticmethod(forbidden)
        review._write_memory = forbidden
        review._cmd_decide = forbidden
    review._import_native = native
    atomic = review._atomic_write
    def interrupted(profile, path, data, *args, **kwargs):
        record = json.loads(data) if Path(path).suffix == '.json' else {}
        if record.get('state') == 'closed' and mode == 'artifact-during-close':
            stage = Path(path).with_suffix('.stage')
            stage.write_bytes(FOREIGN); stage.chmod(0o600)
        result = atomic(profile, path, data, *args, **kwargs)
        if mode == 'prepare' and record.get('state') == 'prepared':
            os._exit(EXIT_PREPARED)
        if mode == 'close-after' and record.get('state') == 'closed':
            os._exit(EXIT_CLOSED)
        return result
    review._atomic_write = interrupted
    try:
        req = json.loads(sys.stdin.buffer.read())
        ctx = review._parse_request(req)
        io = None
        if selected:
            fixture = load('realbud_interrupted_fake_io', ROOT / 'scripts/testing/hermes-memory-windows-journal.py')
            io = fixture.FakeWindowsIO(review, ctx.profile_dir, 'normal', Path(os.environ['REALBUD_TEST_EVENT_LOG']))
            review.POSIX = False
            def forbidden_posix(*args, **kwargs):
                raise AssertionError('Selected IO escaped to POSIX profile mutation/enumeration')
            for name in fixture.ORIGINAL:
                setattr(os, name, forbidden_posix)
            review._open_nofollow = forbidden_posix
        if mode == 'denied-record':
            read = review._safe_read
            def denied(profile, path, *args, **kwargs):
                if Path(path).parent.name == 'proposals' and Path(path).suffix == '.json':
                    raise PermissionError('fictional private diagnostic must not escape')
                return read(profile, path, *args, **kwargs)
            review._safe_read = denied
        if mode == 'denied-inventory':
            if io is not None:
                io.names = lambda *args, **kwargs: (_ for _ in ()).throw(io.error_type('unsafe-storage'))
            else:
                os.scandir = lambda *args, **kwargs: (_ for _ in ()).throw(PermissionError('fictional private diagnostic'))
        if mode == 'public-windows-hold':
            review.POSIX = False
            result = review._dispatch(ctx)
        else:
            result = review._dispatch_ready(ctx, storage=io) if selected else review._dispatch(ctx)
        if io is not None and io.held:
            raise AssertionError('Selected IO lock leaked')
        review._emit({'ok': True, 'result': result})
    except review.ReviewError as error:
        review._emit({'ok': False, 'code': error.code})
    return 0


class InterruptedRecovery(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        supplied = os.environ.get('REALBUD_TEST_HERMES_RUNTIME')
        if not supplied or os.name != 'posix':
            raise unittest.SkipTest('Explicit admitted runtime on POSIX required; Windows IO is fictional')
        cls.runtime = Path(supplied).resolve()
        cls.python = cls.runtime / 'venv/bin/python'
        if not cls.python.is_file():
            raise RuntimeError('Selected runtime interpreter is required')
        cls.proposals = load('realbud_interrupted_test_signer', HELPERS / 'hermes-memory-proposals.py')

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='realbud-fictional-interrupted-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.profile = self.base / PROFILE
        for part in ('', 'memories', 'pending', 'pending/memory'):
            (self.profile / part).mkdir(mode=0o700, parents=True, exist_ok=True)
        self.private(self.profile / 'memories/MEMORY.md', BEFORE)
        self.private(self.profile / 'config.yaml', CONFIG)
        self.reviews = self.profile / '.realbud-memory-reviews'
        self.journals = self.reviews / 'proposals'
        self.input = {'requestId': 'fictional-proposal', 'payload': {'action': 'replace', 'target': 'memory', 'old_text': 'Monday', 'content': 'Fictional Office sends updates on Tuesday.'}}

    @staticmethod
    def private(path, value):
        path.write_bytes(value); path.chmod(0o600)

    def request(self, command='interrupted-list', **fields):
        value = {'version': 1, 'command': command, 'profileDirectory': str(self.profile),
                 'runtimeDirectory': str(self.runtime), 'workspaceId': WORKSPACE,
                 'profileId': PROFILE, 'runtimeId': self.runtime.parent.name, 'key': KEY}
        if command == 'propose':
            value.update(scopeId=SCOPE, input=self.input)
        return {**value, **fields}

    def call(self, request=None, *, mode='normal', selected=False, crash=None):
        env = {k: os.environ[k] for k in ('PATH', 'LANG', 'TMPDIR', 'TMP', 'TEMP') if k in os.environ}
        env.update(HOME=str(self.base), HERMES_HOME=str(self.profile), HERMES_SKIP_DOTENV='1',
                   PYTHONDONTWRITEBYTECODE='1', REALBUD_TEST_EVENT_LOG=str(self.base / 'events.jsonl'))
        command = [str(self.python), '-I', '-B', str(SCRIPT), '--child', mode, 'selected' if selected else 'posix']
        completed = subprocess.run(command, input=json.dumps(request or self.request()).encode(), stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, cwd=self.runtime, env=env, timeout=30)
        self.assertEqual(completed.returncode, crash if crash is not None else 0, completed.stderr.decode(errors='replace'))
        self.assertEqual(completed.stderr, b'')
        if crash is not None:
            self.assertEqual(completed.stdout, b''); return None
        result = json.loads(completed.stdout)
        self.assertNotIn('fictional private diagnostic', completed.stdout.decode())
        return result

    def success(self, result):
        self.assertTrue(result['ok'], result); return result['result']

    def prepared(self, *, selected=False):
        self.call(self.request('propose'), mode='prepare', selected=selected, crash=EXIT_PREPARED)
        paths = list(self.journals.glob('*.json')); self.assertEqual(len(paths), 1)
        return paths[0], json.loads(paths[0].read_text())

    def listed(self, *, selected=False):
        return self.success(self.call(selected=selected))['items']

    def close_request(self, item):
        return self.request('interrupted-close', proposalKey=item['key'], expectedDigest=item['recoveryDigest'])

    def assert_no_memory_effect(self):
        self.assertEqual((self.profile / 'memories/MEMORY.md').read_bytes(), BEFORE)
        self.assertEqual(list((self.profile / 'pending/memory').glob('*')), [])
        self.assertEqual(list(self.reviews.glob('????????.json')), [])

    def signed(self, record):
        keys = self.proposals.CLOSED_KEYS if record['version'] == 2 else self.proposals.JOURNAL_KEYS
        body = {k: record[k] for k in keys if k != 'mac'}
        domain = self.proposals.CLOSED_DOMAIN if record['version'] == 2 else self.proposals.JOURNAL_DOMAIN
        canonical = json.dumps(body, ensure_ascii=True, sort_keys=True, separators=(',', ':')).encode('ascii')
        return {**record, 'mac': hmac.new(KEY_BYTES, domain + canonical, hashlib.sha256).hexdigest()}

    def test_fresh_profile_bootstraps_private_parents_without_config(self):
        (self.profile / 'config.yaml').unlink()
        for path in (self.profile / 'pending/memory', self.profile / 'pending'):
            path.rmdir()
        self.assertEqual(self.listed(), [])
        for path in (self.reviews, self.journals, self.reviews / 'claims', self.profile / 'pending', self.profile / 'pending/memory'):
            self.assertEqual(path.stat().st_mode & 0o777, 0o700)

    def test_close_and_restart_replay_retains_identity_without_effects(self):
        path, original = self.prepared()
        row, = self.listed(); self.assertEqual(row['state'], 'interrupted')
        self.assertIsNone(row['closedAt']); self.assertEqual(row['createdAt'], original['createdAt'])
        request = self.close_request(row)
        closed = self.success(self.call(request)); again = self.success(self.call(request))
        self.assertEqual(closed, again); self.assertEqual(closed['recoveryDigest'], row['recoveryDigest'])
        saved = json.loads(path.read_text()); self.assertEqual((saved['version'], saved['state']), (2, 'closed'))
        for key in self.proposals.JOURNAL_KEYS:
            if key not in ('version', 'state', 'mac'):
                self.assertEqual(saved[key], original[key])
        self.assertEqual(self.listed(), [{**row, 'state': 'closed', 'closedAt': closed['closedAt']}])
        self.assertEqual(self.call(self.request('propose')), {'ok': False, 'code': 'proposal-closed'})
        self.assert_no_memory_effect()

    def test_lost_close_response_reconciles_exact_saved_result(self):
        self.prepared(); row, = self.listed(); request = self.close_request(row)
        self.call(request, mode='close-after', crash=EXIT_CLOSED)
        saved = json.loads(next(self.journals.glob('*.json')).read_text())
        result = self.success(self.call(request))
        self.assertEqual(result, {'version': 1, 'key': row['key'], 'state': 'closed', 'closedAt': saved['closedAt'], 'recoveryDigest': row['recoveryDigest']})
        self.assert_no_memory_effect()

    def test_selected_windows_io_close_and_lost_response(self):
        self.prepared(selected=True); row, = self.listed(selected=True); request = self.close_request(row)
        self.call(request, selected=True, mode='close-after', crash=EXIT_CLOSED)
        result = self.success(self.call(request, selected=True))
        self.assertEqual(result['state'], 'closed')
        self.assertEqual(self.listed(selected=True)[0]['recoveryDigest'], row['recoveryDigest'])
        self.assertEqual(self.call(self.request('propose'), selected=True), {'ok': False, 'code': 'proposal-closed'})
        self.assert_no_memory_effect()

    def test_no_config_or_disabled_memory_blocks_metadata_close(self):
        self.prepared(); row, = self.listed()
        self.private(self.profile / 'config.yaml', b'broken: [invalid')
        self.assertEqual(self.listed()[0]['state'], 'interrupted')
        self.assertEqual(self.success(self.call(self.close_request(row)))['state'], 'closed')
        self.assert_no_memory_effect()

    def test_wrong_digest_and_changed_request_cannot_use_closed_receipt(self):
        path, original = self.prepared(); row, = self.listed()
        self.assertEqual(self.call({**self.close_request(row), 'expectedDigest': 'f' * 64})['code'], 'stale-review')
        self.assertEqual(json.loads(path.read_text()), original)
        self.success(self.call(self.close_request(row)))
        self.input['payload']['content'] = 'Different fictional request.'
        self.assertEqual(self.call(self.request('propose'))['code'], 'conflict')
        self.assertEqual(self.call({**self.close_request(row), 'expectedDigest': 'f' * 64})['code'], 'stale-review')

    def test_changed_signed_journal_invalidates_displayed_recovery_digest(self):
        path, original = self.prepared(); row, = self.listed()
        replacement = self.signed({**original, 'createdAt': original['createdAt'] + 1000})
        self.private(path, json.dumps(replacement).encode())
        self.assertEqual(self.call(self.close_request(row))['code'], 'stale-review')
        self.assertEqual(json.loads(path.read_text()), replacement)
        self.assertNotEqual(self.listed()[0]['recoveryDigest'], row['recoveryDigest'])

    def test_signed_human_intent_and_final_decisions_prevent_closure(self):
        _, original = self.prepared(); row, = self.listed()
        review = load('realbud_interrupted_test_receipt', HELPERS / 'hermes-memory-review.py')
        context = review._parse_request(self.request())
        receipt_path = self.reviews / (original['id'] + '.json')
        for phase, decision in [('intent', 'approve'), ('final', 'approve'), ('final', 'reject')]:
            record = {'version': 1, 'id': original['id'], 'workspaceId': WORKSPACE, 'profileId': PROFILE,
                      'runtimeId': self.runtime.parent.name, 'decision': decision,
                      'state': 'applied' if decision == 'approve' else 'rejected', 'phase': phase,
                      'pendingDigest': original['pendingDigest'], 'configDigest': '1' * 64,
                      'beforeDigest': '2' * 64, 'afterDigest': '3' * 64, 'reviewDigest': '4' * 64,
                      'target': 'memory', 'action': 'replace', 'origin': 'foreground',
                      'createdAt': original['createdAt'], 'at': original['createdAt'], 'operationCount': 1, 'charLimit': 2200}
            signed = review._sign_receipt(context, record)
            self.assertIsNotNone(review._verify_receipt(context, signed))
            self.private(receipt_path, json.dumps(signed).encode()); before = receipt_path.read_bytes()
            self.assertEqual(self.listed()[0]['state'], 'recovery-required')
            self.assertFalse(self.call(self.close_request(row))['ok'])
            self.assertEqual(receipt_path.read_bytes(), before)
            receipt_path.unlink()

    def test_public_windows_hold_still_covers_both_metadata_commands(self):
        for request in (self.request(), self.request('interrupted-close', proposalKey='a' * 64, expectedDigest='b' * 64)):
            self.assertEqual(self.call(request, mode='public-windows-hold'), {'ok': False, 'code': 'platform-unverified'})

    def test_each_existing_artifact_prevents_closure_and_preserves_bytes(self):
        path, record = self.prepared(); row, = self.listed()
        artifacts = (path.with_suffix('.stage'), self.profile / 'pending/memory' / (record['id'] + '.json'),
                     self.reviews / 'claims' / (record['id'] + '.json'), self.reviews / (record['id'] + '.json'))
        for artifact in artifacts:
            with self.subTest(artifact=artifact.parent.name + artifact.suffix):
                self.private(artifact, FOREIGN)
                shown, = self.listed(); self.assertEqual(shown['state'], 'recovery-required')
                self.assertIsNone(shown['recoveryDigest']); self.assertIsNone(shown['closedAt'])
                self.assertFalse(self.call(self.close_request(row))['ok'])
                self.assertEqual(artifact.read_bytes(), FOREIGN)
                self.assertEqual(json.loads(path.read_text()), record)
                artifact.unlink()

    def test_artifact_appearing_during_close_is_preserved_and_holds_replay(self):
        path, _ = self.prepared(); row, = self.listed(); request = self.close_request(row)
        self.assertFalse(self.call(request, mode='artifact-during-close')['ok'])
        self.assertEqual(path.with_suffix('.stage').read_bytes(), FOREIGN)
        shown, = self.listed(); self.assertEqual(shown['state'], 'recovery-required')
        self.assertIsNone(shown['closedAt']); self.assertIsNone(shown['recoveryDigest'])
        self.assertFalse(self.call(request)['ok'])

    def test_closed_replay_refuses_new_artifacts(self):
        path, record = self.prepared(); row, = self.listed(); request = self.close_request(row)
        self.success(self.call(request)); saved = path.read_bytes()
        for artifact in (path.with_suffix('.stage'), self.profile / 'pending/memory' / (record['id'] + '.json'),
                         self.reviews / 'claims' / (record['id'] + '.json'), self.reviews / (record['id'] + '.json')):
            self.private(artifact, FOREIGN)
            self.assertFalse(self.call(request)['ok']); self.assertEqual(path.read_bytes(), saved)
            self.assertEqual(artifact.read_bytes(), FOREIGN); artifact.unlink()

    def test_eight_character_id_collision_holds_both_full_keys(self):
        path, record = self.prepared(); row, = self.listed()
        other_key = record['requestKey'][:8] + ('a' if record['requestKey'][8] != 'a' else 'b') + record['requestKey'][9:]
        other = self.signed({**record, 'requestKey': other_key})
        self.private(self.journals / (other_key + '.json'), json.dumps(other).encode())
        rows = self.listed(); self.assertEqual(len(rows), 2)
        self.assertTrue(all(r['state'] == 'recovery-required' and r['recoveryDigest'] is None for r in rows))
        self.assertEqual(self.call(self.close_request(row))['code'], 'conflict')
        self.assertEqual(json.loads(path.read_text()), record)

    def test_published_collision_still_blocks_prepared_closure(self):
        _, record = self.prepared(); row, = self.listed()
        other_key = record['requestKey'][:8] + ('a' if record['requestKey'][8] != 'a' else 'b') + record['requestKey'][9:]
        other = self.signed({**record, 'state': 'published', 'requestKey': other_key})
        self.private(self.journals / (other_key + '.json'), json.dumps(other).encode())
        rows = self.listed(); self.assertEqual(len(rows), 1); self.assertEqual(rows[0]['state'], 'recovery-required')
        self.assertFalse(self.call(self.close_request(row))['ok'])

    def test_malformed_tampered_foreign_identity_records_are_held(self):
        path, record = self.prepared(); row, = self.listed()
        corruptions = [b'{', json.dumps({**record, 'mac': '0' * 64}).encode(),
                       json.dumps({**record, 'createdAt': float('nan')}).encode(),
                       b'[' * 1500 + b']' * 1500]
        for field, value in [('workspaceId', '88888888-8888-4888-8888-888888888888'), ('profileId', 'another-fictional'), ('runtimeId', 'another-runtime')]:
            corruptions.append(json.dumps(self.signed({**record, field: value})).encode())
        for data in corruptions:
            self.private(path, data)
            shown, = self.listed(); self.assertEqual(shown['state'], 'recovery-required')
            self.assertIsNone(shown['createdAt']); self.assertIsNone(shown['recoveryDigest'])
            self.assertFalse(self.call(self.close_request(row))['ok']); self.assertEqual(path.read_bytes(), data)

    def test_denied_record_returns_fixed_row_and_denied_inventory_fails(self):
        self.prepared()
        result = self.success(self.call(mode='denied-record'))
        self.assertEqual(result['items'][0]['state'], 'recovery-required')
        self.assertIsNone(result['items'][0]['recoveryDigest'])
        self.assertFalse(self.call(mode='denied-inventory')['ok'])
        self.assertFalse(self.call(mode='denied-inventory', selected=True)['ok'])

    def test_nonprivate_and_symlink_records_preserved(self):
        path, _ = self.prepared(); row, = self.listed(); data = path.read_bytes()
        path.chmod(0o644)
        self.assertEqual(self.listed()[0]['state'], 'recovery-required')
        self.assertFalse(self.call(self.close_request(row))['ok']); self.assertEqual(path.read_bytes(), data)
        path.chmod(0o600); target = self.base / 'fictional-symlink-target'; self.private(target, data)
        path.unlink(); path.symlink_to(target)
        self.assertEqual(self.listed()[0]['state'], 'recovery-required')
        self.assertFalse(self.call(self.close_request(row))['ok']); self.assertTrue(path.is_symlink())

    def test_closed_signature_and_original_digest_are_both_validated(self):
        path, _ = self.prepared(); row, = self.listed(); request = self.close_request(row)
        self.success(self.call(request)); saved = json.loads(path.read_text())
        tampered = self.signed({**saved, 'recoveryDigest': '0' * 64})
        self.private(path, json.dumps(tampered).encode())
        self.assertEqual(self.listed()[0]['state'], 'recovery-required')
        self.assertFalse(self.call(request)['ok'])

    def test_published_v1_records_are_unchanged_and_omitted(self):
        path, original = self.prepared()
        published = self.signed({**original, 'state': 'published'})
        self.private(path, json.dumps(published).encode()); before = path.read_bytes()
        self.assertEqual(self.listed(), []); self.assertEqual(path.read_bytes(), before)

    def test_bounded_pagination_by_full_key(self):
        path, original = self.prepared(); path.unlink()
        for index in range(23):
            key = f'{index + 1:064x}'
            # Native ID must also be unique so these are ordinary interrupted rows.
            key = f'{index + 1:08x}' + key[8:]
            record = self.signed({**original, 'requestKey': key, 'id': key[:8]})
            self.private(self.journals / (key + '.json'), json.dumps(record).encode())
        page = self.success(self.call()); self.assertEqual(len(page['items']), 20)
        self.assertEqual(page['nextCursor'], page['items'][-1]['key'])
        following = self.success(self.call(self.request(cursor=page['nextCursor'])))
        self.assertEqual(len(following['items']), 3); self.assertIsNone(following['nextCursor'])
        self.assertEqual(len({r['key'] for r in page['items'] + following['items']}), 23)

    def test_inventory_capacity_is_not_reported_as_empty(self):
        self.prepared()
        for index in range(2000):
            self.private(self.journals / f'fictional-stage-{index}', b'')
        response = self.call(); self.assertEqual(response, {'ok': False, 'code': 'capacity'})

    def test_request_schema_refuses_authority_aliases_and_noncanonical_keys(self):
        self.prepared(); row, = self.listed(); valid = self.close_request(row)
        bad = [self.request(cursor='a' * 8), self.request(cursor='A' * 64), self.request(proposalKey='a' * 64),
               {**valid, 'input': self.input}, {**valid, 'id': 'abcd1234'}, {**valid, 'decision': 'reject'},
               {**valid, 'proposalKey': row['key'].upper()}, {**valid, 'proposalKey': row['key'] + ' '},
               {**valid, 'expectedDigest': 'F' * 64}, {k: v for k, v in valid.items() if k != 'expectedDigest'}]
        for request in bad:
            self.assertEqual(self.call(request), {'ok': False, 'code': 'invalid'})

    def test_missing_record_and_unsafe_parent_never_create_closed_record(self):
        self.assertFalse(self.call(self.request('interrupted-close', proposalKey='a' * 64, expectedDigest='b' * 64))['ok'])
        self.assertEqual(list(self.journals.glob('*.json')), [])
        self.journals.rmdir(); other = self.base / 'fictional-foreign-directory'; other.mkdir(mode=0o700)
        self.journals.symlink_to(other, target_is_directory=True)
        self.assertFalse(self.call()['ok']); self.assertEqual(list(other.iterdir()), [])

    def test_missing_evidence_ancestry_is_never_recreated_after_prepared_or_closed(self):
        for selected in (False, True):
            for state in ('prepared', 'closed'):
                for removed in ('claims', 'pending-memory', 'pending'):
                    with self.subTest(selected_io=selected, state=state, removed=removed):
                        case = InterruptedRecovery(methodName='runTest'); case.setUp()
                        self.addCleanup(case.doCleanups)
                        path, _ = case.prepared(selected=selected)
                        # Producers must create private evidence parents before
                        # recording durable intent, not on the first recovery read.
                        self.assertTrue((case.reviews / 'claims').is_dir())
                        row, = case.listed(selected=selected)
                        request = case.close_request(row)
                        if state == 'closed':
                            case.success(case.call(request, selected=selected))
                        before = path.read_bytes()
                        target = case.reviews / 'claims' if removed == 'claims' else case.profile / 'pending/memory'
                        target.rmdir()
                        if removed == 'pending':
                            target = case.profile / 'pending'; target.rmdir()
                        # The ordinary panel refresh must not repair ancestry
                        # before its interrupted-proposal list checks evidence.
                        case.call(case.request('list'), selected=selected)
                        self.assertFalse(target.exists())
                        self.assertFalse(case.call(selected=selected)['ok'])
                        self.assertFalse(case.call(request, selected=selected)['ok'])
                        self.assertFalse(case.call(case.request('propose'), selected=selected)['ok'])
                        self.assertFalse(target.exists())
                        self.assertEqual(path.read_bytes(), before)
                        self.assertEqual((case.profile / 'memories/MEMORY.md').read_bytes(), BEFORE)

    def test_fresh_selected_io_profile_can_initialize_empty_parents(self):
        (self.profile / 'pending/memory').rmdir(); (self.profile / 'pending').rmdir()
        self.assertEqual(self.listed(selected=True), [])
        self.assertTrue((self.reviews / 'claims').is_dir())
        self.assertTrue((self.profile / 'pending/memory').is_dir())


if __name__ == '__main__':
    if len(sys.argv) == 4 and sys.argv[1] == '--child':
        raise SystemExit(child(sys.argv[2], sys.argv[3] == 'selected'))
    unittest.main(verbosity=2)
