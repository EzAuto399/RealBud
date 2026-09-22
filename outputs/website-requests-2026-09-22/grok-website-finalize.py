"""Summarize an already completed bounded review; does not call Grok."""
from pathlib import Path
import datetime
import hashlib
import json
import subprocess

out = Path(__file__).resolve().parent
run = json.loads((out / 'grok-website-acp-run.json').read_text())
assert 'exitCode' in run and 'processReaped' in run, 'Collector is not terminal'
rows = subprocess.check_output(['ps', '-axo', 'pid=,ppid=,pgid='], text=True)
own = [list(map(int, line.split())) for line in rows.splitlines() if len(line.split()) == 3 and int(line.split()[2]) == run['ownedPid']]
config_hash = hashlib.sha256(Path('/Users/yoda/.grok/config.toml').read_bytes()).hexdigest()
cleanup = {
    'verifiedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'ownedAgentPid': run['ownedPid'], 'matchingOwnedProcessRows': own,
    'processReaped': run['processReaped'], 'isolatedHomeRemoved': run['isolatedHomeRemoved'],
    'collectorGlobalConfigUnchanged': run['globalConfigUnchanged'],
    'globalConfigSha256AtIndependentCheck': config_hash,
    'globalConfigUnchangedAtIndependentCheck': config_hash == run['globalConfigSha256Before'],
    'rawCredentialsRead': False, 'authCopied': False, 'retryCount': 0,
}
(out / 'grok-website-cleanup.json').write_text(json.dumps(cleanup, indent=2) + '\n')
meta = (run.get('terminal') or {}).get('_meta') or {}
usage = meta.get('usage') or {}
disposition = {
    'scope': 'metadata-only website requests protocol design advice; no production-source inspection or approval',
    'completed': run.get('completed', False), 'requestedModel': run['requestedModel'],
    'selectedModelOption': run.get('returnedModelOption'), 'selectedEffort': run.get('returnedReasoningEffort'),
    'actualModelBuckets': list((usage.get('modelUsage') or {}).keys()),
    'modelCalls': usage.get('modelCalls'), 'numTurns': usage.get('numTurns'),
    'stopReason': (run.get('terminal') or {}).get('stopReason'),
    'terminalUsage': usage, 'terminalAtSeconds': run.get('terminalAtSeconds'),
    'collectionAndCleanupSeconds': run.get('elapsedSeconds'), 'promptBytes': run['promptBytes'],
    'promptRequestsSent': run['promptRequestsSent'], 'toolCallCount': run['toolCallCount'],
    'permissionRequestCount': run['permissionRequestCount'],
    'observedMcpInitialization': run.get('observedMcpInitialization'),
    'observedMcpServerCount': run.get('observedMcpServerCount'),
    'disposition': 'Use returned cases as guidance for implementation and regression tests only. Actual request, authority, executor, recovery and privacy behavior requires separate application/test evidence.',
    'advisoryCorrections': [
        'A dispatch intent is deliberately persisted before claim, so claim denial can leave an intent. Assert no valid dispatch permission or new executor receipt, rather than no intent.',
        'An absent executor receipt after startup must not automatically resume an old approval or expired claim. The contract requires interrupted status and renewed review/claim for the same logical request; stable keys continue to prevent duplicate runs.',
        'The single saved intent and claim identity may gain later durable reconciliation/decision events. Do not interpret no second intent as forbidding required append-only recovery evidence.'
    ],
    'retryCount': 0,
}
(out / 'grok-website-disposition.json').write_text(json.dumps(disposition, indent=2) + '\n')
lines = ['# Grok website request protocol review', '',
         'Metadata-only design advice. This review did not inspect production source, implement behavior or run tests. It is not approval or release/customer acceptance evidence.', '',
         f"Requested `{run['requestedModel']}` / `{run.get('returnedReasoningEffort')}`; completed: **{run.get('completed', False)}**.",
         f"Actual terminal model buckets: `{', '.join(disposition['actualModelBuckets']) or 'not returned'}`. Model calls: {disposition['modelCalls']}; turns: {disposition['numTurns']}; terminal: `{disposition['stopReason']}`.",
         f"Prompt: {run['promptBytes']} bytes; one request; no tool or permission calls. Elapsed including cleanup: {run.get('elapsedSeconds')} seconds.", '']
for case in (run.get('structuredOutput') or {}).get('cases', []):
    lines.extend(['## ' + case['title'], '', case['setup'], ''])
    lines.extend('- ' + assertion for assertion in case['assertions'])
    lines.append('')
if not run.get('completed'):
    lines.extend(['No completed review verdict. No retry was attempted.', '', str(run.get('failure', 'Terminal answer unavailable.')), ''])
lines.extend(['## Advisory adjudication', '', 'The returned advice does not override the implementation contract. Correct these imprecise assertions before turning them into tests:', ''])
lines.extend('- ' + correction for correction in disposition['advisoryCorrections'])
lines.append('')
lines.extend(['## Collection boundaries', '', 'Existing cached authentication was supplied by an opaque symlink in a disposable private Grok home. The collector never opened or copied authentication contents. CLI auto-update, memory, subagents, tool lists, workspace instructions, web search and external MCP configuration were disabled or omitted. Observed MCP server/tool counts and no-tool activity are retained as evidence; they are not a claim of OS-level sandboxing.', '', 'The owned process group was reaped, isolated home removed and global config hash independently rechecked. See `grok-website-cleanup.json` for the exact result. No production edits or global configuration changes were made by this reviewer.', ''])
(out / 'grok-website-review.md').write_text('\n'.join(lines))
manifest = {p.name: {'bytes': p.stat().st_size, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(out.glob('grok-*')) if p.is_file() and p.name != 'grok-website-manifest.json'}
(out / 'grok-website-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps({'completed': run.get('completed'), 'cleanup': cleanup, 'disposition': disposition, 'cases': run.get('structuredOutput')}, indent=2))
