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
import uuid

OUT = Path(__file__).resolve().parent
CLI = Path('/Users/yoda/.local/bin/grok')
AUTH = Path('/Users/yoda/.grok/auth.json')
CONFIG = Path('/Users/yoda/.grok/config.toml')
SCHEMA = {'type': 'object', 'properties': {'risk': {'type': 'string'}, 'validation': {'type': 'string'}}, 'required': ['risk', 'validation'], 'additionalProperties': False}
PROMPT = 'Review this new interrupted-memory-proposal closure contract for one material correctness gap. This is a design review, not a code or runtime audit. No tools. A prepared proposal journal has full 64-hex request identity, native8-hex pending ID, workspace/profile/runtime binding, request/pending digests, time, HMAC and no payload. Publication may have crashed after durable preparation, before a payload stage. Staff GET lists bounded full-key metadata; only a valid signed prepared journal with strict absence of stage, pending, cleanup claim and any human-decision receipt is closable. All directory ancestry must be admitted; missing parent, ACL denial or full-key collision on native ID blocks closure. POST carries only exact displayed recovery digest to full-key URL. Under the same native review lock, host revalidates identity, journal signature, digest and artifact absence, atomically replaces journal with signed v2 closed retaining original immutable fields, close time and domain-separated recovery digest, then checks absence again. Replay is valid only for same key/digest and artifacts still absent. It never writes memory, deletes payload, or creates approval/rejection. Existing published/invalid records are not closable. GUI requires confirmation, serializes requests, reconciles a lost reply via GET and only reports closed on exact key+digest; never automatic POST retry. Same-key future proposal returns terminal closed; model cannot close and receives fixed no-retry instruction. Existing review/decide unaffected. Tell us strongest remaining correctness risk or say none, and one precise validation case. Do not assume arbitrary code is safe. Return schema only.'
OVERRIDES = {'GROK_DISABLE_AUTOUPDATER': '1', 'GROK_MEMORY': '0', 'GROK_SUBAGENTS': '0'}
for vendor in ('CURSOR', 'CLAUDE'):
    for surface in ('SKILLS', 'RULES', 'AGENTS', 'MCPS', 'HOOKS'):
        OVERRIDES[f'GROK_{vendor}_{surface}_ENABLED'] = '0'

config_before = hashlib.sha256(CONFIG.read_bytes()).hexdigest()
requested_session = str(uuid.uuid4())
record = {'startedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'cliVersion': '1.0.34 (3736acbc8658)',
          'requestedModel': 'grok-4.7', 'reasoningEffort': 'xhigh', 'requestedSession': requested_session,
          'hardTimeoutSeconds': 180, 'prompt': PROMPT, 'reviewKind': 'closure-contract-design',
          'promptBytes': len(PROMPT.encode()), 'maxTurns': 1, 'processOverrides': OVERRIDES,
          'rawDiagnosticsPersisted': False, 'credentialsReadByHarness': False,
          'authentication': 'Opaque auth.json symlink in private disposable GROK_HOME; no credential contents copied or printed.',
          'globalConfigSha256Before': config_before}
started = None
proc = None
buffers = {'stdout': bytearray(), 'stderr': bytearray()}
try:
    if not AUTH.is_file():
        raise RuntimeError('Existing cached authentication file is unavailable; no login was attempted.')
    with tempfile.TemporaryDirectory(prefix='realbud-grok-isolation-') as temporary:
        base = Path(temporary).resolve()
        base.chmod(0o700)
        grok_home, working = base / 'grok-home', base / 'empty-workspace'
        grok_home.mkdir(mode=0o700)
        working.mkdir(mode=0o700)
        (grok_home / 'config.toml').write_text('[cli]\nauto_update = false\n')
        (grok_home / 'config.toml').chmod(0o600)
        (grok_home / 'auth.json').symlink_to(AUTH)
        env = dict(os.environ)
        env.update(OVERRIDES, GROK_HOME=str(grok_home))
        inspection = subprocess.run([str(CLI), 'inspect', '--json'], cwd=working, env=env,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=25, check=False)
        if inspection.returncode != 0:
            raise RuntimeError('Isolated inspection failed; raw diagnostics withheld.')
        view = json.loads(inspection.stdout)
        preflight = {'grokVersion': view.get('grokVersion'), 'projectTrusted': view.get('projectTrusted'),
                     'discoveredCounts': {name: len(view.get(name, [])) for name in ('projectInstructions', 'mcpServers', 'hooks', 'skills', 'plugins')},
                     'activeCounts': {name: sum(row.get('disabled') is not True and row.get('compatibilityStatus') != 'disabled' and row.get('enabled') is not False for row in view.get(name, [])) for name in ('projectInstructions', 'mcpServers', 'hooks', 'skills', 'plugins')},
                     'compatibilityScanners': view.get('externalCompat', {}).get('cells'),
                     'mcpNames': [server.get('name') for server in view.get('mcpServers', [])],
                     'globalConfigRead': any(layer.get('path') == str(CONFIG) for layer in view.get('configSources', {}).get('layers', []))}
        record['isolationPreflight'] = preflight
        (OUT / 'grok-closure-review-preflight.json').write_text(json.dumps(preflight, indent=2) + '\n')
        if preflight['activeCounts']['mcpServers'] or preflight['activeCounts']['hooks'] or preflight['globalConfigRead']:
            raise RuntimeError('Isolation did not exclude inherited MCP/hooks/config; probe was not started.')
        args = [str(CLI), '--model', 'grok-4.7', '--reasoning-effort', 'xhigh', '--session-id', requested_session,
                '--no-subagents', '--tools', '', '--deny', 'MCPTool', '--disable-web-search',
                '--permission-mode', 'plan', '--max-turns', '1', '--verbatim',
                '--system-prompt-override', 'Review only the supplied contract. Return the schema JSON. Do not use tools.',
                '--json-schema', json.dumps(SCHEMA), '--output-format', 'streaming-messages-json', '--single', PROMPT]
        record['argv'] = args
        (OUT / 'grok-closure-review-run.json').write_text(json.dumps(record, indent=2) + '\n')
        started = time.monotonic()
        proc = subprocess.Popen(args, cwd=working, env=env, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        record['ownedPid'] = proc.pid
        selection = selectors.DefaultSelector()
        for stream, name in ((proc.stdout, 'stdout'), (proc.stderr, 'stderr')):
            os.set_blocking(stream.fileno(), False)
            selection.register(stream, selectors.EVENT_READ, name)
        cutoff = started + 180
        stopped = False
        while selection.get_map():
            if time.monotonic() >= cutoff and not stopped:
                record['timedOut'] = True
                stopped = True
                os.killpg(proc.pid, signal.SIGTERM)
            if stopped and time.monotonic() >= cutoff + 5 and proc.poll() is None:
                os.killpg(proc.pid, signal.SIGKILL)
            for key, _mask in selection.select(timeout=0.2):
                data = os.read(key.fileobj.fileno(), 65536)
                if not data:
                    selection.unregister(key.fileobj)
                    continue
                name = key.data
                record.setdefault('first' + name.title() + 'Seconds', round(time.monotonic() - started, 3))
                if len(buffers[name]) + len(data) > 8 * 1024 * 1024:
                    record['outputLimitExceeded'] = True
                    if not stopped:
                        stopped = True
                        os.killpg(proc.pid, signal.SIGTERM)
                    continue
                buffers[name].extend(data)
        record['exitCode'] = proc.wait(timeout=5)
        record['elapsedSeconds'] = round(time.monotonic() - started, 3)
        record['stdoutBytes'] = len(buffers['stdout'])
        record['stderrBytes'] = len(buffers['stderr'])
        lines = bytes(buffers['stdout']).decode('utf-8', errors='replace').splitlines()
        frames = []
        for line in lines:
            try: frames.append(json.loads(line))
            except ValueError: pass
        if not frames:
            try: frames = [json.loads(bytes(buffers['stdout']))]
            except ValueError: frames = []
        safe = []
        for frame in frames:
            kind = frame.get('type')
            if kind == 'system':
                safe.append({key: frame.get(key) for key in ('type', 'subtype', 'session_id', 'model', 'mcp_servers', 'tools')})
            elif kind == 'assistant':
                message = frame.get('message', {})
                texts = [block.get('text', '') for block in message.get('content', []) if block.get('type') == 'text']
                safe.append({'type': kind, 'session_id': frame.get('session_id'), 'model': message.get('model'),
                             'text': ''.join(texts), 'toolUseCount': sum(block.get('type') == 'tool_use' for block in message.get('content', []))})
            elif kind == 'result':
                safe.append({key: frame.get(key) for key in ('type', 'subtype', 'is_error', 'session_id', 'num_turns', 'result', 'stop_reason', 'modelUsage', 'structured_output', 'usage')})
            elif 'stopReason' in frame:
                safe.append({key: frame.get(key) for key in ('sessionId', 'requestId', 'stopReason', 'modelUsage', 'structuredOutput', 'text', 'usage', 'num_turns')})
        record['safeFrames'] = safe
        terminal = next((frame for frame in reversed(safe) if frame.get('type') == 'result' or 'stopReason' in frame), None)
        record['terminalResult'] = terminal
        record['passed'] = bool(record['exitCode'] == 0 and terminal is not None and
                                isinstance(terminal.get('structured_output') or terminal.get('structuredOutput'), dict) and
                                (terminal.get('stop_reason') or terminal.get('stopReason')) == 'end_turn')
        record['isolatedHomeRemoved'] = False
    record['isolatedHomeRemoved'] = not base.exists()
except Exception as error:
    record['passed'] = False
    record['failureType'] = type(error).__name__
    record['failure'] = str(error) if isinstance(error, RuntimeError) else 'Probe setup or collection failed; raw diagnostics withheld.'
finally:
    if proc is not None and proc.poll() is None:
        os.killpg(proc.pid, signal.SIGTERM)
        try: proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait()
    record['processReaped'] = proc is None or proc.poll() is not None
    record['globalConfigSha256After'] = hashlib.sha256(CONFIG.read_bytes()).hexdigest()
    record['globalConfigUnchanged'] = record['globalConfigSha256After'] == config_before
    (OUT / 'grok-closure-review-run.json').write_text(json.dumps(record, indent=2) + '\n')
    print(json.dumps({key: record.get(key) for key in ('passed', 'timedOut', 'exitCode', 'elapsedSeconds', 'processReaped', 'isolatedHomeRemoved', 'globalConfigUnchanged', 'failure')}))
