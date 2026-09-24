"""One bounded pack transition source review over a fresh Grok ACP agent.

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
CLI = Path('/Users/yoda/.local/bin/grok')
AUTH = Path('/Users/yoda/.grok/auth.json')
CONFIG = Path('/Users/yoda/.grok/config.toml')
LIMIT = 300
PROFILE = '---\nname: realbud-pack-upgrade-review\ndescription: One bounded source-only pack transition review\npromptMode: full\ntools: []\nskills: []\nagentsMd: false\npermissionMode: plan\noutputFormat: concise\n---\nReview only the supplied source excerpts. No tools, web, files, skills, subagents or questions. Return the requested final JSON. Report concrete defects and limits, not production approval.\n'
PROMPT = 'Review frozen source excerpts only; no tools/web/edits/questions. Find concrete rollback, retired-plan or interrupted-resume defects. Return JSON {"findings":[{"file":"...","line":1,"severity":"P1|P2","failure":"interleaving","fix":"precise fix"}],"limits":["..."]}, <=500 words. Empty findings allowed. Host journal queue is exclusive; recipe writes/reset are atomic revision-CAS. Bounded journal schema/digest validation is omitted: do not infer it. Retired plans stay saved but unavailable until reviewed rollback. Affected plans must remain paused with approvals/schedules cleared. This is code review, not approval or test proof.\n\nFILE server/customer-pack-upgrades.ts SHA256 742545536c8102bc11ad4135d47243b5e77d18ef21ec9d0f69b911582fe9082e\n\n92:export async function previewPackChange(entry: PackUpgradeState, targetPack: CustomerPack, allEntries: PackUpgradeState[], deps: Dependencies,\n93:  rollback?: PackSnapshot): Promise<{ preview: CustomerPackChangePreview; change: PackTransition }> {\n94:  const conflicts: string[] = [];\n95:  if (entry.transition) conflicts.push(\'Finish the saved pack change before previewing another version.\');\n96:  if ((entry.history?.length ?? 0) >= 8) conflicts.push(\'Eight prior configurations are retained. Export the pack history and ask service support to archive it before another change.\');\n97:  if (targetPack.id !== entry.pack.id || !rollback && targetPack.revision <= entry.pack.revision) conflicts.push(\'Choose a newer revision of this same pack, or explicitly preview a saved rollback.\');\n98:  for (const role of AGENCY_RECIPE_ROLES) {\n99:    const required = workflowRecipeId(entry.pack.id, role);\n100:    if (required && !targetPack.recipes.some(r => r.id === required)) conflicts.push(`Keep ${required}: this installed RealBud version uses that fixed business-workflow role. A host adapter migration is required before removing it.`);\n101:  }\n102:  const local = new Map(deps.listRecipes().map(recipe => [recipe.id, recipe]));\n103:  const base = new Map(entry.pack.recipes.map(recipe => [recipe.id, recipe]));\n104:  const desired = new Map((rollback?.recipes ?? targetPack.recipes).map(recipe => [recipe.id, recipe]));\n105:  const recipes: RecipeChange[] = [], displayed: CustomerPackChangePreview[\'recipes\'] = [];\n106:  const recipeIds = [...new Set([...base.keys(), ...desired.keys()])];\n107:  for (const id of recipeIds) {\n108:    if (allEntries.some(other => other.pack.id !== entry.pack.id && (other.pack.recipes.some(r => r.id === id) || other.retiredRecipeIds?.includes(id))))\n109:      conflicts.push(`${id} is claimed by another pack. Resolve plan ownership before changing it.`);\n110:    const current = local.get(id), before = current ? definition(current) : null, published = base.get(id), wanted = desired.get(id);\n111:    if (published && !current) conflicts.push(`${id} is missing. Repair its installed plan before upgrading.`);\n112:    if (!published && current && !entry.retiredRecipeIds?.includes(id)) conflicts.push(`${id} already exists outside this pack. Rename the incoming plan or resolve its ownership first.`);\n113:    let after = wanted ? definition(wanted) : before!;\n114:    if (!after) continue;\n115:    if (current && wanted) {\n116:      const original = definition(published ?? wanted), merged: Record<string, unknown> = { ...definition(current) };\n117:      for (const field of Object.keys(original) as (keyof CustomerPackRecipe)[]) {\n118:        if (field === \'id\' || field === \'schedule\') continue;\n119:        if (same(after[field], original[field])) continue;\n120:        if (same(before![field], original[field]) || same(before![field], after[field])) merged[field] = after[field];\n121:        else conflicts.push(`${id}: both your local plan and the incoming version changed ${field}. Resolve that field in the plan or revise the pack, then preview again.`);\n122:      }\n123:      after = definition(merged as CustomerPackRecipe);\n124:    }\n125:    after = off(after);\n126:    recipes.push({ id, revision:current?.revision ?? 0,beforeStamp:current ? stamp(current) : null,before,after,retired:!wanted });\n127:    displayed.push({ id, action:!wanted ? \'retire\' : !before ? \'add\' : same(off(before),after) ? \'preserve\' : \'update\',before,after });\n128:  }\n129:  const overrides: Record<string, SkillOverride> = {};\n130:  for (const skill of targetPack.skills) {\n131:    const override = entry.overrides?.[skill.id] ?? rollback?.overrides?.[skill.id];\n132:    if (override) overrides[skill.id] = structuredClone(override);\n133:  }\n134:  const target: PackConfiguration = { pack:targetPack,digest:digest(targetPack),...(Object.keys(overrides).length ? {overrides} : {}) };\n135:  const previousArtifacts = new Map(deps.artifacts(entry).map(a => [a.key,a])), nextArtifacts = new Map(deps.artifacts(target).map(a => [a.key,a]));\n\n152:  const retiredRecipeIds = [...new Set([...(entry.retiredRecipeIds ?? []),...recipes.filter(r => r.retired).map(r => r.id)])].filter(id => !desired.has(id));\n153:  const before: PackSnapshot = {pack:entry.pack,digest:entry.digest,...(entry.overrides ? {overrides:entry.overrides} : {}),generation:entry.generation ?? 1,\n154:    savedAt:new Date().toISOString(),recipes:entry.pack.recipes.map(r => local.get(r.id)).filter((r):r is Recipe => !!r).map(definition),retiredRecipeIds:entry.retiredRecipeIds ?? []};\n155:  const change: PackTransition = { version:1,action:rollback ? \'rollback\' : \'upgrade\',requestDigest:\'\',previewDigest:\'\',fromGeneration:entry.generation ?? 1,\n156:    fromDigest:entry.digest,scope:deps.scope(),target,before,recipes,artifacts,retiredRecipeIds };\n157:  change.previewDigest = transitionDigest(change);\n\n165:export function checkPackRecipeStage(change: PackTransition, current: Recipe[]): \'before\' | \'paused\' | \'after\' {\n166:  const local = new Map(current.map(r=>[r.id,r]));\n167:  const paused = (row:RecipeChange, target:CustomerPackRecipe, revision:number) => {\n168:    const saved=local.get(row.id);\n169:    return !!saved && saved.revision===revision && saved.status===\'shadow\' && saved.schedule===null && saved.planApprovedAt===null && saved.approvedRevision===null && same(definition(saved),target);\n170:  };\n171:  if (change.recipes.every(r=>paused(r,r.after,r.revision===0 ? 1 : r.revision+1+(same(off(r.before!),r.after)?0:1)))) return \'after\';\n172:  if (change.recipes.every(r=>r.before===null ? !local.has(r.id) : paused(r,off(r.before),r.revision+1))) return \'paused\';\n173:  if (change.recipes.every(r=>r.before===null ? !local.has(r.id) : local.has(r.id)&&stamp(local.get(r.id)!)===r.beforeStamp)) return \'before\';\n174:  return bad(\'Plans changed during this pack update. Keep the saved change and ask service support to reconcile the listed plans; no newer plan was overwritten.\');\n175:}\n176:\n177:export function packRecipeWrites(change: PackTransition) {\n178:  return change.recipes.map(r=>({...r.after,status:\'shadow\',expectedRevision:r.revision===0 ? 0 : r.revision+1}));\n\nFILE server/customer-packs.ts SHA256 bd9e9bb6ac33dccaacd04269562f704f8af0f8cafc136fd69030329b15010d65\n\n261:  async function finishChange(entries:Record<string,Journal>,entry:Journal) {\n262:    const change=entry.transition;\n263:    if (!change) return fail(\'No reviewed pack change is waiting for recovery.\',409);\n264:    const completed=completeChange(entries,entry); assertJournalFits(completed);\n265:    const assertCurrent=()=>{\n266:      if(scope()!==change.scope) return fail(\'Select the same Bud profile and workroom used to review this change before resuming it.\',409);\n267:      if((options.activeRecipeIds?.() ?? []).some(id=>change.recipes.some(r=>r.id===id))) return fail(\'Wait for this pack’s queued or running work to finish before resuming its change.\',409);\n268:    };\n269:    assertCurrent();\n270:    const paths=new Map([...changeDeps.artifacts(change.before),...changeDeps.artifacts(change.target)].map(a=>[a.key,a.path]));\n271:    for(const other of Object.values(entries).filter(e=>e.pack.id!==entry.pack.id)) {\n272:      if(other.pack.recipes.some(r=>change.recipes.some(c=>c.id===r.id))) return fail(\'Another pack now claims an affected plan. Resolve ownership before resuming.\',409);\n273:      for(const artifact of changeDeps.artifacts(other)) for(const item of change.artifacts)\n274:        if(paths.get(item.key)===artifact.path && item.after!==artifact.contents) return fail(\'Another pack now owns an affected instruction file. Resolve shared ownership before resuming.\',409);\n275:    }\n276:    const state=async (item:typeof change.artifacts[number])=>{\n277:      const path=paths.get(item.key); if(!path) return fail(\'The saved instruction target needs service recovery.\',409);\n278:      const previous=item.before===null ? await artifactState(path,item.after ?? \'\')===\'missing\' : await artifactState(path,item.before)===\'identical\';\n279:      const next=item.after===null ? await artifactState(path,item.before ?? \'\')===\'missing\' : await artifactState(path,item.after)===\'identical\';\n280:      if(!previous&&!next) return fail(`Instruction ${item.key} changed after review. Preserve that file and reconcile it before resuming.`,409);\n281:      return {path,next};\n282:    };\n283:    // Validate every file and plan before the first mutation. Paused plans and\n284:    // the pending journal prevent interrupted instructions from being used.\n285:    for(const artifact of change.artifacts) await state(artifact);\n286:    let stage=checkPackRecipeStage(change,listRecipes());\n287:    assertCurrent();\n288:    if(stage===\'before\') {\n289:      resetApprovals(change.recipes.filter(r=>r.revision>0).map(r=>({id:r.id,revision:r.revision})));\n290:      stage=checkPackRecipeStage(change,listRecipes());\n291:    }\n292:    for(const artifact of change.artifacts) {\n293:      assertCurrent(); const current=await state(artifact); if(current.next) continue;\n294:      await safeAncestors(dirname(current.path)); assertCurrent();\n295:      if(artifact.after===null) { await unlink(current.path); fsyncDir(dirname(current.path)); }\n296:      else {\n297:        await mkdir(dirname(current.path),{recursive:true,mode:0o700});\n298:        // Only the exact reviewed before/after state is replaceable.\n299:        const checked=await state(artifact); if(!checked.next) writeFileAtomic(current.path,artifact.after,0o600);\n300:      }\n301:      if(!(await state(artifact)).next) return fail(\'Instruction readback is incomplete. Plans remain paused; resume the saved change.\',409);\n302:    }\n303:    assertCurrent(); stage=checkPackRecipeStage(change,listRecipes());\n304:    if(stage!==\'after\') saveRecipes(packRecipeWrites(change));\n305:    if(checkPackRecipeStage(change,listRecipes())!==\'after\') return fail(\'Plan readback is incomplete. Resume the saved pack change.\',409);\n306:    for(const artifact of change.artifacts) if(!(await state(artifact)).next) return fail(\'Instruction readback is incomplete. Plans remain paused.\',409);\n307:    assertCurrent(); await persistJournals(completed);\n308:    return status(completed[entry.pack.id]);\n309:  }\n\n523:        const input=fields(body,packChange[2]===\'resume-change\' ? [\'expectedInstalledDigest\',\'expectedInstalledRevision\',\'expectedPreviewDigest\'] : [\'installationRevision\']);\n524:        if(packChange[2]===\'resume-change\') return exclusive(async()=>{\n525:          const entries=await journals(),entry=entries[packChange[1]];\n526:          if(!entry||entry.digest!==input.expectedInstalledDigest||(entry.generation ?? 1)!==input.expectedInstalledRevision||entry.transition?.previewDigest!==input.expectedPreviewDigest)\n527:            return fail(\'The saved change no longer matches this screen. Refresh setup before resuming.\',409);\n528:          return {status:200,body:await finishChange(entries,entry)};\n529:        });\n530:        const entry=(await journals())[packChange[1]],prior=entry?.history?.find(s=>s.generation===input.installationRevision);\n531:        if(!prior) return fail(\'That saved configuration is unavailable. Refresh pack history.\',404);\n'
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
    (OUT / 'grok-pack-acp-run.json').write_text(json.dumps(record, indent=2) + '\n')


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
        if method == '_x.ai/mcp_initialized' and isinstance(params, dict):
            record['observedMcpInitialization'] = {key: params.get(key) for key in ('elapsedMs', 'mcpToolCount', 'sessionId')}
        elif method == '_x.ai/mcp/servers_updated' and isinstance(params, dict) and isinstance(params.get('mcpServers'), list):
            record['observedMcpServerCount'] = len(params['mcpServers'])
            record['observedMcpServerNames'] = [entry.get('name') for entry in params['mcpServers'] if isinstance(entry, dict)]
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
    (OUT / 'grok-pack-acp-profile.md').write_text(PROFILE)
    (OUT / 'grok-pack-acp-prompt.txt').write_text(PROMPT + '\n')
    record['cliVersion'] = subprocess.run([str(CLI), '--version'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=10, check=True).stdout.decode().strip()
    temp_context = tempfile.TemporaryDirectory(prefix='realbud-grok-pack-review-')
    base = Path(temp_context.name).resolve(); base.chmod(0o700)
    grok_home, working = base / 'grok-home', base / 'empty-workspace'
    grok_home.mkdir(mode=0o700); working.mkdir(mode=0o700)
    (grok_home / 'config.toml').write_text('[cli]\nauto_update = false\n')
    (grok_home / 'config.toml').chmod(0o600)
    (grok_home / 'auth.json').symlink_to(AUTH)
    args = [str(CLI), '--no-auto-update', '--disable-web-search', '--permission-mode', 'plan',
            'agent', '--no-leader', '--model', 'grok-4.7', '--reasoning-effort', 'xhigh',
            '--agent-profile', str(OUT / 'grok-pack-acp-profile.md'), 'stdio']
    record['argv'] = args
    env = dict(os.environ); env.update(OVERRIDES, GROK_HOME=str(grok_home))
    proc = subprocess.Popen(args, cwd=working, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, start_new_session=True)
    record['ownedPid'] = proc.pid
    for stream, name in ((proc.stdout, 'stdout'), (proc.stderr, 'stderr')):
        os.set_blocking(stream.fileno(), False)
        selection.register(stream, selectors.EVENT_READ, name)
    init = request('initialize', {'protocolVersion': 1, 'clientInfo': {'name': 'realbud-bounded-pack-review', 'version': '1'},
                                 'clientCapabilities': {'fs': {'readTextFile': False, 'writeTextFile': False}, 'terminal': False}})
    record['initialize'] = {key: init.get(key) for key in ('protocolVersion', 'agentInfo', 'agentCapabilities')}
    record['initializeMetaKeys'] = sorted((init.get('_meta') or {}).keys())
    init_meta = init.get('_meta') or {}
    mcp_init = init_meta.get('mcpServers')
    record['initializeMcpShape'] = type(mcp_init).__name__
    if isinstance(mcp_init, list):
        record['initializeMcpCount'] = len(mcp_init)
        record['initializeMcpNames'] = [entry.get('name') for entry in mcp_init if isinstance(entry, dict)]

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
    valid = (isinstance(parsed, dict) and set(parsed) == {'findings','limits'}
             and isinstance(parsed.get('findings'), list) and isinstance(parsed.get('limits'), list)
             and all(isinstance(v, str) for v in parsed['limits'])
             and all(isinstance(v, dict) and set(v) == {'file','line','severity','failure','fix'}
                     and isinstance(v['line'], int) and v['line'] > 0
                     and v['severity'] in ('P1','P2')
                     and all(isinstance(v[k], str) for k in ('file','failure','fix')) for v in parsed['findings']))
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
