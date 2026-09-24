"""One metadata-only development prompt over a fresh Grok ACP agent.

No credential contents or raw diagnostics are read or persisted by this harness.
No model-call retry, continuation, tools, web, or existing session is requested.
"""
from pathlib import Path
import datetime
import hashlib
import json
import os
import selectors
import signal
import subprocess
import tempfile
import time

OUT = Path(__file__).resolve().parent
CLI = Path('/Users/yoda/.local/bin/grok') if Path('/Users/yoda/.local/bin/grok').exists() else Path('/Users/yoda/.grok/bin/grok')
AUTH = Path('/Users/yoda/.grok/auth.json')
CONFIG = Path('/Users/yoda/.grok/config.toml')
LIMIT = 300
PROFILE = '''---
name: realbud-key-custody-review
description: One metadata-only Windows key-custody design review
promptMode: full
tools: []
skills: []
agentsMd: false
permissionMode: plan
outputFormat: concise
---
Analyze only the supplied fictional development-test metadata. Do not use tools,
web, skills, files, subagents, or ask questions. Return one concise final JSON
object. This is design review, never a claim that Windows tests have run.
'''
PROMPT = (OUT / 'grok-acp-prompt.txt').read_text()
OVERRIDES = {'GROK_DISABLE_AUTOUPDATER': '1', 'GROK_MEMORY': '0', 'GROK_SUBAGENTS': '0'}
for vendor in ('CURSOR', 'CLAUDE'):
    for surface in ('SKILLS', 'RULES', 'AGENTS', 'MCPS', 'HOOKS'):
        OVERRIDES[f'GROK_{vendor}_{surface}_ENABLED'] = '0'


class StopRun(Exception):
    pass


def hash_file(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def process_rows():
    result = subprocess.run(['ps', '-axo', 'pid=,ppid=,pgid='], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5, check=True)
    return [tuple(map(int, line.split())) for line in result.stdout.decode().splitlines() if len(line.split()) == 3]


record = {
    'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'requestedModel': 'grok-4.7', 'reasoningEffort': 'xhigh', 'hardTimeoutSeconds': LIMIT,
    'transport': 'fresh agent --no-leader stdio ACP', 'maxPromptRequests': 1,
    'turnLimitScope': 'One ACP prompt; cancel/stop on any tool-call or client permission request. Top-level --max-turns is not forwarded to the agent branch in the inspected official source.',
    'prompt': PROMPT, 'promptBytes': len(PROMPT.encode()), 'promptSha256': hashlib.sha256(PROMPT.encode()).hexdigest(),
    'profileSha256': hashlib.sha256(PROFILE.encode()).hexdigest(), 'processOverrides': OVERRIDES,
    'credentialsReadByHarness': False, 'credentialsCopied': False, 'rawDiagnosticsPersisted': False,
    'authentication': 'Existing cached auth via opaque symlink in disposable private GROK_HOME; harness never opens auth contents.',
    'globalConfigSha256Before': hash_file(CONFIG), 'promptRequestsSent': 0,
    'updates': {}, 'safeEvents': [], 'assistantText': '', 'toolCallCount': 0,
    'permissionRequestCount': 0, 'unsupportedClientRequests': [],
    'mcpIsolationVerified': False, 'toolIsolationVerified': False,
}
proc = None
base = None
started = time.monotonic()
next_id = 0
responses = {}
buffers = {'stdout': bytearray(), 'stderr': bytearray()}
selection = selectors.DefaultSelector()
temp_context = None


def persist():
    record['elapsedSeconds'] = round(time.monotonic() - started, 3)
    (OUT / 'grok-acp-windows-fixture-run.json').write_text(json.dumps(record, indent=2) + '\n')


def send(value):
    proc.stdin.write((json.dumps(value) + '\n').encode())
    proc.stdin.flush()


def safe_config(options):
    return [{key: row.get(key) for key in ('id', 'name', 'category', 'type', 'currentValue')}
            for row in options if isinstance(row, dict)]


def safe_meta(meta):
    if not isinstance(meta, dict):
        return {}
    # Drop prompt bodies, system messages, thought text, file paths, and diagnostics.
    names = ('sessionId', 'requestId', 'modelId', 'model', 'reasoningEffort', 'inputTokens',
             'outputTokens', 'reasoningTokens', 'cachedReadTokens', 'totalTokens', 'usage',
             'modelUsage', 'numTurns', 'turns', 'cancellationCategory')
    return {name: meta[name] for name in names if name in meta}


def handle(frame):
    if not isinstance(frame, dict):
        return
    if 'id' in frame and ('result' in frame or 'error' in frame):
        responses[frame['id']] = frame
        return
    method = frame.get('method')
    params = frame.get('params') or {}
    if 'id' in frame:
        if method == 'session/request_permission':
            record['permissionRequestCount'] += 1
            send({'jsonrpc': '2.0', 'id': frame['id'], 'result': {'outcome': {'outcome': 'cancelled'}}})
        else:
            record['unsupportedClientRequests'].append(method)
            send({'jsonrpc': '2.0', 'id': frame['id'], 'error': {'code': -32601, 'message': 'This bounded client provides no filesystem or terminal tools.'}})
        raise StopRun('Agent requested a client operation; no model continuation permitted.')
    if method in ('session/update', 'x.ai/session/update'):
        update = params.get('update') or {}
        kind = update.get('sessionUpdate', 'unknown')
        record['updates'][kind] = record['updates'].get(kind, 0) + 1
        if kind == 'agent_message_chunk':
            content = update.get('content') or {}
            if content.get('type') == 'text':
                record['assistantText'] += content.get('text', '')
                if len(record['assistantText']) > 32000:
                    raise StopRun('Assistant output exceeded the bound.')
        elif kind in ('tool_call', 'tool_call_update'):
            record['toolCallCount'] += 1
            raise StopRun('Tool activity observed; no model continuation permitted.')
        elif kind == 'config_option_update':
            record['safeEvents'].append({'kind': kind, 'configOptions': safe_config(update.get('configOptions', []))})
        elif kind == 'current_mode_update':
            record['safeEvents'].append({'kind': kind, 'currentModeId': update.get('currentModeId')})
        # Internal thought content is deliberately not retained.
    elif method:
        record.setdefault('notificationMethods', {})[method] = record.setdefault('notificationMethods', {}).get(method, 0) + 1
        # Retain field names only so unfamiliar metadata cannot leak config values.
        record.setdefault('notificationShapes', {})[method] = sorted(params.keys()) if isinstance(params, dict) else []


def pump():
    if time.monotonic() - started >= LIMIT:
        record['timedOut'] = True
        raise StopRun('Hard 300-second deadline reached.')
    if proc.poll() is not None:
        raise StopRun('Agent exited before the requested protocol result.')
    for ready, _mask in selection.select(timeout=0.2):
        data = os.read(ready.fileobj.fileno(), 65536)
        if not data:
            selection.unregister(ready.fileobj)
            continue
        name = ready.data
        record.setdefault(f'first{name.title()}Seconds', round(time.monotonic() - started, 3))
        record[f'{name}Bytes'] = record.get(f'{name}Bytes', 0) + len(data)
        if record[f'{name}Bytes'] > 8 * 1024 * 1024:
            raise StopRun('Protocol output exceeded the bound.')
        if name == 'stderr':
            # No raw log persists; track byte counts only.
            continue
        buffers[name].extend(data)
        while b'\n' in buffers[name]:
            line, _, remaining = buffers[name].partition(b'\n')
            buffers[name] = bytearray(remaining)
            try:
                handle(json.loads(line))
            except json.JSONDecodeError:
                record['nonJsonStdoutLines'] = record.get('nonJsonStdoutLines', 0) + 1


def request(method, params):
    global next_id
    next_id += 1
    own_id = next_id
    if method == 'session/prompt':
        record['promptRequestsSent'] += 1
        if record['promptRequestsSent'] != 1:
            raise StopRun('Prompt limit exceeded; refused locally.')
    record.setdefault('requests', []).append({'id': own_id, 'method': method, 'atSeconds': round(time.monotonic() - started, 3)})
    send({'jsonrpc': '2.0', 'id': own_id, 'method': method, 'params': params})
    persist()
    while own_id not in responses:
        pump()
    response = responses.pop(own_id)
    if 'error' in response:
        record['protocolError'] = {'method': method, 'code': response['error'].get('code'), 'messageWithheld': True}
        raise StopRun('ACP request returned an error; no retry attempted.')
    return response.get('result') or {}


try:
    if not AUTH.is_file():
        raise StopRun('Existing cached authentication file unavailable; no login attempted.')
    (OUT / 'grok-acp-profile.md').write_text(PROFILE)
    (OUT / 'grok-acp-prompt.txt').write_text(PROMPT + '\n')
    record['cliVersion'] = subprocess.run([str(CLI), '--version'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=10, check=True).stdout.decode().strip()
    temp_context = tempfile.TemporaryDirectory(prefix='realbud-grok-acp-fixture-')
    base = Path(temp_context.name).resolve(); base.chmod(0o700)
    grok_home, working = base / 'grok-home', base / 'empty-workspace'
    grok_home.mkdir(mode=0o700); working.mkdir(mode=0o700)
    (grok_home / 'config.toml').write_text('[cli]\nauto_update = false\n')
    (grok_home / 'config.toml').chmod(0o600)
    (grok_home / 'auth.json').symlink_to(AUTH)
    args = [str(CLI), '--no-auto-update', '--disable-web-search', '--permission-mode', 'plan',
            'agent', '--no-leader', '--model', 'grok-4.7', '--reasoning-effort', 'xhigh',
            '--agent-profile', str(OUT / 'grok-acp-profile.md'), 'stdio']
    record['argv'] = args
    env = dict(os.environ); env.update(OVERRIDES, GROK_HOME=str(grok_home))
    proc = subprocess.Popen(args, cwd=working, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, start_new_session=True)
    record['ownedPid'] = proc.pid
    for stream, name in ((proc.stdout, 'stdout'), (proc.stderr, 'stderr')):
        os.set_blocking(stream.fileno(), False)
        selection.register(stream, selectors.EVENT_READ, name)
    init = request('initialize', {'protocolVersion': 1, 'clientInfo': {'name': 'realbud-bounded-fixture-review', 'version': '1'},
                                 'clientCapabilities': {'fs': {'readTextFile': False, 'writeTextFile': False}, 'terminal': False}})
    record['initialize'] = {key: init.get(key) for key in ('protocolVersion', 'agentInfo', 'agentCapabilities')}
    record['initializeMetaKeys'] = sorted((init.get('_meta') or {}).keys())
    record['authMethodIds'] = [method.get('id') for method in init.get('authMethods', [])]
    session = request('session/new', {'cwd': str(working), 'mcpServers': []})
    sid = session.get('sessionId')
    if not isinstance(sid, str) or not sid:
        raise StopRun('Session creation did not return an identifier.')
    record['sessionId'] = sid
    record['sessionConfigOptions'] = safe_config(session.get('configOptions', []))
    record['sessionMeta'] = safe_meta(session.get('_meta'))
    record['sessionMetaKeys'] = sorted((session.get('_meta') or {}).keys())
    record['sessionResultKeys'] = sorted(session.keys())
    model_option = next((item for item in session.get('configOptions', []) if item.get('id') == 'model'), None)
    effort_option = next((item for item in session.get('configOptions', []) if item.get('id') == 'reasoning_effort'), None)
    if model_option:
        record['returnedModelOption'] = model_option.get('currentValue')
    if effort_option:
        record['returnedReasoningEffort'] = effort_option.get('currentValue')
    # Required model and effort must be observable before the only prompt.
    if not model_option or model_option.get('currentValue') not in ('grok-4.7', 'grok-4.7-build') or not effort_option or effort_option.get('currentValue') != 'xhigh':
        raise StopRun('Requested model and xhigh effort were not confirmed by session options; no prompt sent.')
    terminal = request('session/prompt', {'sessionId': sid, 'prompt': [{'type': 'text', 'text': PROMPT}]})
    record['terminal'] = {'stopReason': terminal.get('stopReason'), '_meta': safe_meta(terminal.get('_meta'))}
    record['terminalMetaKeys'] = sorted((terminal.get('_meta') or {}).keys())
    record['terminalAtSeconds'] = round(time.monotonic() - started, 3)
    try:
        parsed = json.loads(record['assistantText'])
    except ValueError:
        parsed = None
    valid = isinstance(parsed, dict) and set(parsed) == {'verdict', 'requiredChecks', 'nativeProofLimit'} and isinstance(parsed.get('verdict'), str) and isinstance(parsed.get('nativeProofLimit'), str) and isinstance(parsed.get('requiredChecks'), list) and len(parsed['requiredChecks']) <= 4 and all(isinstance(v, str) for v in parsed['requiredChecks'])
    record['structuredOutputValid'] = valid
    record['structuredOutput'] = parsed if valid else None
    record['completed'] = bool(terminal.get('stopReason') == 'end_turn' and record['promptRequestsSent'] == 1 and not record['toolCallCount'] and valid)
except StopRun as error:
    record['completed'] = False; record['failure'] = str(error)
except Exception as error:
    record['completed'] = False; record['failureType'] = type(error).__name__; record['failure'] = 'Setup or protocol collector failed; raw diagnostics withheld.'
finally:
    if proc is not None:
        if proc.poll() is None and record.get('sessionId') and not record.get('terminal'):
            try:
                send({'jsonrpc': '2.0', 'method': 'session/cancel', 'params': {'sessionId': record['sessionId']}})
                record['cancelSent'] = True
            except (OSError, ValueError):
                record['cancelSent'] = False
        if proc.poll() is None:
            try:
                proc.stdin.close()
                proc.wait(timeout=3)
                record['shutdown'] = 'stdin-eof'
            except (OSError, subprocess.TimeoutExpired):
                try: os.killpg(proc.pid, signal.SIGTERM)
                except ProcessLookupError: pass
                try: proc.wait(timeout=3); record['shutdown'] = 'owned-group-sigterm'
                except subprocess.TimeoutExpired:
                    try: os.killpg(proc.pid, signal.SIGKILL)
                    except ProcessLookupError: pass
                    proc.wait(timeout=3); record['shutdown'] = 'owned-group-sigkill'
        record['exitCode'] = proc.returncode
        rows = process_rows()
        own_group = [pid for pid, _ppid, pgid in rows if pgid == proc.pid]
        if own_group:
            try: os.killpg(proc.pid, signal.SIGTERM)
            except ProcessLookupError: pass
            time.sleep(0.2)
            own_group = [pid for pid, _ppid, pgid in process_rows() if pgid == proc.pid]
            if own_group:
                try: os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError: pass
                time.sleep(0.2)
        record['remainingOwnedGroupPids'] = [pid for pid, _ppid, pgid in process_rows() if pgid == proc.pid]
        record['processReaped'] = proc.poll() is not None
    selection.close()
    if temp_context is not None:
        temp_context.cleanup()
    record['isolatedHomeRemoved'] = base is None or not base.exists()
    record['globalConfigSha256After'] = hash_file(CONFIG)
    record['globalConfigUnchanged'] = record['globalConfigSha256After'] == record['globalConfigSha256Before']
    persist()
    print(json.dumps({key: record.get(key) for key in ('completed', 'failure', 'timedOut', 'promptRequestsSent', 'sessionId', 'returnedModelOption', 'returnedReasoningEffort', 'exitCode', 'terminalAtSeconds', 'elapsedSeconds', 'processReaped', 'remainingOwnedGroupPids', 'isolatedHomeRemoved', 'globalConfigUnchanged')}))
