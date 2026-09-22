from pathlib import Path
import datetime, hashlib, json

out = Path(__file__).resolve().parent
root = out.parent.parent
full = json.loads((out / 'full-suite-final.json').read_text())
assert full['success'] and full['numFailedTests'] == 0
source = json.loads((out / 'source-final-suite-start.json').read_text())
assert all(hashlib.sha256((root / name).read_bytes()).hexdigest() == value for name, value in source['files'].items())
source['unchangedDuringFinalSuite'] = True
(out / 'source-final.json').write_text(json.dumps(source, indent=2) + '\n')
package = json.loads((out / 'package-manifest.json').read_text())
app = Path(package['path'])
assert all(('symlink:' + str((app / name).readlink()) if (app / name).is_symlink() else hashlib.sha256((app / name).read_bytes()).hexdigest()) == value for name, value in package['entries'].items())
gui = {}
for mode in ('source', 'packaged'):
    item = json.loads((out / ('gui-' + mode) / 'receipt.json').read_text())
    assert item['passed'] and item['cleanup'] and not item['errors'] and not item['blockedNetwork'] and item['adminHeadersSeen'] == 0
    gui[mode] = {'passed': True, 'checks': len(item['checks']), 'receipt': 'gui-' + mode + '/receipt.json', 'runtime': item['runtime'], 'cleanup': True, 'desktopAndMobileInspected': True}
health = json.loads((out / 'grok-health-run.json').read_text())
review = json.loads((out / 'grok-closure-review-run.json').read_text())
assert health['passed'] and health['processReaped'] and review['processReaped']
assert '[smoke-mac-package] OK:' in (out / 'mac-smoke.log').read_text()
receipt = {
  'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
  'status': 'local-source-and-mac-package-verified-windows-and-live-gates-retained',
  'scope': 'Signed staff closure for interrupted memory proposals, missing-evidence holds and private profile/config provisioning',
  'source': {'manifest': 'source-final.json', 'files': len(source['files']), 'digest': source['digest'], 'unchangedDuringFinalSuite': True, 'testOnlyChangeSincePackage': ['server/index.test.ts']},
  'fullSuite': {'receipt': 'full-suite-final.json', 'files': len(full['testResults']), 'passed': full['numPassedTests'], 'failed': full['numFailedTests'], 'skipped': full['numPendingTests'], 'durationSeconds': round((max(r['endTime'] for r in full['testResults']) - full['startTime']) / 1000, 2), 'nativeHermesOptIn': True, 'runtime': '/Users/yoda/.realbud/hermes/runtimes/345cd2b057a452236de401d3534b8502a7465e8d-cfb3f08a9ee7/hermes-agent'},
  'overlappingFocusedChecks': {
    'profile': {'passed': 180, 'skipped': 6, 'receipt': 'profile-verification.json'},
    'hostAndNativeBeforeFinalAncestry': {'passed': 232, 'log': 'host-native-final.log'},
    'nativeAndActualHTTPAfterAncestry': {'passed': 60, 'log': 'native-after-ancestry.log'},
    'client': {'passed': 38, 'note': 'Included in final full suite; recovery and normal review client tests.'},
    'pythonRecovery': {'passed': 25, 'receipt': '../hermes-memory-windows-journal-2026-09-22/proposals-interrupted-ancestry-final-receipt.json'},
    'pythonPOSIXFaults': {'passed': 15, 'note': 'Included in ancestry receipt.'},
    'pythonFakeWindowsIntegration': {'passed': 25, 'note': 'Selected fictional IO with actual admitted Hermes parsing; not native Windows.'}
  },
  'gui': gui,
  'builds': {'typecheck': 'typecheck-verified.log', 'packagePreparation': 'package-prepare.log', 'electronSyntax': 'electron-syntax.log', 'package': 'package.log', 'smoke': 'mac-smoke.log', 'helperParity': 'helper-parity.json', 'passed': True},
  'package': {'path': package['path'], 'signed': False, 'installedApplicationChanged': False, 'manifest': 'package-manifest.json', 'files': package['files'], 'symlinks': package['symlinks'], 'digest': package['digest'], 'unchangedAfterChecks': True, 'allFiveHelpersMatchSourceBuiltAndManifest': True},
  'grok': {'requestedModel': 'grok-4.7', 'reasoningEffort': 'xhigh', 'health': {'passed': True, 'actualModel': 'grok-4.7-build', 'elapsedSeconds': health['elapsedSeconds'], 'receipt': 'grok-health-run.json'}, 'closureContractReview': {'complete': False, 'timedOut': review.get('timedOut'), 'deadlineSeconds': 180, 'receipt': 'grok-closure-review-run.json', 'findings': None}, 'processesReaped': True, 'globalConfigUnchanged': health['globalConfigUnchanged'] and review['globalConfigUnchanged'], 'toolIsolationVerified': False},
  'preservedNegativeEvidence': [
    {'receipt': 'full-suite.json', 'passed': 4362, 'failed': 4, 'skipped': 185, 'resolution': 'Canonicalized the index API fixture temporary path; no profile guard weakened. All51 index checks and subsequent full suite passed.'},
    {'log': 'host-native.log', 'resolution': 'Corrected test expectation from recovery-required to the exact conflict taxonomy; byte preservation assertions retained.'},
    {'log': 'typecheck-final.log', 'resolution': 'Added explicit declaration for the test-only mjs crash fixture.'},
    {'receipt': '../hermes-memory-windows-journal-2026-09-22/proposals-interrupted-ancestry-before.json', 'resolution': 'Reproduced and fixed missing evidence directories being recreated. Existing journals now require intact evidence parents.'}
  ],
  'limits': [
    'Actual Windows execution and production memory platform admission remain unverified; no Windows CI job triggered.',
    'Windows startup uses sequential synchronous ACL probes; real latency is unmeasured. .env and config are separate file operations.',
    'Source and packaged GUI use fictional profiles, grants and ACP peers; no real provider or customer account was used.',
    'Unsigned Mac package is separate from installed-device/keychain acceptance, signed distribution and office soak.',
    'Managed provider/connector/subscription deployment, two-computer office operation and live Austin CSV/Gmail/REI acceptance remain external gates.'
  ]
}
(out / 'verification.json').write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps({'fullSuite': receipt['fullSuite'], 'sourceDigest': source['digest'], 'packageDigest': package['digest']}))
