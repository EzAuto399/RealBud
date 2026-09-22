import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { askDepartmentWorker as realAskDepartmentWorker, DEPARTMENT_WORKER_RUNTIME, type DepartmentWorkerOptions } from './department-worker.ts';
import { currentWorkerProfile, withWorkerProfile } from './hermes-profile.ts';
import { resetRuntimeSelectionForTests } from './hermes-runtime-selection.ts';

const dirs: string[] = [], servers: Server[] = [];
const askDepartmentWorker = (prompt: string, opts: DepartmentWorkerOptions = {}) => realAskDepartmentWorker(prompt, {
  beforeLaunch: async () => {}, beforeRequest: async () => {}, ...opts,
});
afterEach(async () => {
  vi.unstubAllEnvs(); resetRuntimeSelectionForTests();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it('refuses a cancelled run before any authority or process work', async () => {
  const controller = new AbortController(); controller.abort(); const beforeLaunch = vi.fn();
  expect(await askDepartmentWorker('case', { signal: controller.signal, beforeLaunch })).toEqual({ ok: false, detail: 'Preparation cancelled.' });
  expect(beforeLaunch).not.toHaveBeenCalled();
});
it('holds unsupported or absent runtime without falling back to private askWorker', async () => {
  const root = mkdtempSync(join(tmpdir(), 'department-missing-')); dirs.push(root);
  const beforeLaunch = vi.fn(); expect(await askDepartmentWorker('case', { root, beforeLaunch })).toMatchObject({ ok: false });
  expect(beforeLaunch).not.toHaveBeenCalled();
});

const nativeRuntime = process.env.REALBUD_DEPARTMENT_TEST_RUNTIME;
describe.skipIf(!nativeRuntime || !existsSync(join(nativeRuntime, 'venv/bin/python')))('admitted Hermes with fictional provider', () => {
  async function fixture(answer: (request: any, index: number) => unknown | Promise<unknown>) {
    const captures: any[] = [];
    const provider = createServer(async (request, response) => {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString()); captures.push({ body, path: request.url, authorization: request.headers.authorization });
      const message = await answer(body, captures.length);
      const base = { id: `fictional-${captures.length}`, object: 'chat.completion.chunk', created: 1, model: 'fictional-case-model' };
      if (body.stream) {
        const delta: any = message; if (delta.tool_calls) delta.tool_calls = delta.tool_calls.map((call: any, index: number) => ({ ...call, index }));
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
      } else {
        response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: 'stop' }] }));
      }
    }); servers.push(provider);
    await new Promise<void>(done => provider.listen(0, '127.0.0.1', done));
    const address = provider.address(); if (!address || typeof address === 'string') throw new Error();
    const root = mkdtempSync(join(tmpdir(), 'department-native-')); dirs.push(root);
    const runtime = join(root, 'runtimes', DEPARTMENT_WORKER_RUNTIME, 'hermes-agent'); mkdirSync(runtime, { recursive: true });
    for (const name of readdirSync(nativeRuntime!)) if (name !== '.env' && name !== '.git') symlinkSync(join(nativeRuntime!, name), join(runtime, name));
    writeFileSync(join(runtime, '.env'), 'HERMES_EPHEMERAL_SYSTEM_PROMPT=RUNTIME_DOTENV_CANARY\n');
    writeFileSync(join(root, 'realbud-runtime.json'), JSON.stringify({ version: 1, selected: DEPARTMENT_WORKER_RUNTIME, previous: null }));
    const profile = join(root, 'profiles', currentWorkerProfile().profile); mkdirSync(join(profile, 'memories'), { recursive: true });
    for (const name of ['SOUL.md', 'USER.md', 'MEMORY.md', 'AGENTS.md', 'CLAUDE.md']) writeFileSync(join(profile, name), `PRIVATE_${name}_CANARY`);
    writeFileSync(join(profile, 'memories/MEMORY.md'), 'PROFILE_MEMORY_CANARY'); writeFileSync(join(profile, 'memories/USER.md'), 'PROFILE_USER_CANARY');
    mkdirSync(join(profile, 'skills/private'), { recursive: true }); writeFileSync(join(profile, 'skills/private/SKILL.md'), 'PRIVATE_SKILL_CANARY');
    writeFileSync(join(profile, 'prefill.json'), JSON.stringify([{ role: 'user', content: 'PREFILL_CANARY' }]));
    writeFileSync(join(profile, '.env'), 'OPENAI_API_KEY=fictional-selected-profile-key\nHERMES_EPHEMERAL_SYSTEM_PROMPT=PROFILE_ENV_CANARY\n');
    writeFileSync(join(profile, 'config.yaml'), `model:\n  default: fictional-case-model\n  provider: custom\n  base_url: http://127.0.0.1:${address.port}/v1\napprovals:\n  mode: manual\nagent:\n  system_prompt: PRIVATE_CONFIG_CANARY\nprefill_messages_file: ${JSON.stringify(join(profile, 'prefill.json'))}\nskills:\n  auto_load: [private]\n`);
    // If the base profile is accidentally launched, there is no usable route.
    if (currentWorkerProfile().profile !== 'property') { mkdirSync(join(root, 'profiles/property'), { recursive: true }); writeFileSync(join(root, 'profiles/property/config.yaml'), 'model:\n  provider: invalid-base-profile\n'); }
    vi.stubEnv('HERMES_EPHEMERAL_SYSTEM_PROMPT', 'AMBIENT_PROMPT_CANARY'); vi.stubEnv('HERMES_PREFILL_MESSAGES_FILE', join(profile, 'prefill.json')); vi.stubEnv('OPENAI_API_KEY', 'wrong-ambient-key');
    return { root, captures, profile };
  }

  it('sends only selected case/instructions, exact member provider route, and todo tools', async () => withWorkerProfile('fictional-company-member', async () => {
    const { root, captures } = await fixture(() => ({ role: 'assistant', content: 'Prepared fictional case.' }));
    const beforeLaunch = vi.fn(), beforeRequest = vi.fn();
    const result = await askDepartmentWorker('REVIEWED_INSTRUCTIONS: summarize SELECTED_CASE_42 only.', { root, beforeLaunch, beforeRequest, maxTurns: 2 });
    expect(result).toEqual({ ok: true, stdout: 'Prepared fictional case.' });
    expect(beforeLaunch).toHaveBeenCalledOnce(); expect(beforeRequest).toHaveBeenCalledOnce(); expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({ path: '/v1/chat/completions', authorization: 'Bearer fictional-selected-profile-key', body: { model: 'fictional-case-model' } });
    const body = JSON.stringify(captures[0].body); expect(body).toContain('SELECTED_CASE_42'); expect(body).not.toContain('CANARY');
    expect(captures[0].body.tools.map((tool: any) => tool.function.name)).toEqual(['todo_list']);
  }), 120_000);

  it('denies the second model request after a todo turn without forwarding it', async () => {
    const { root, captures } = await fixture(() => ({ role: 'assistant', content: null, tool_calls: [{ id: 'todo-call', type: 'function', function: { name: 'todo_list', arguments: JSON.stringify({ todos: [{ id: '1', content: 'Prepare case', status: 'in_progress' }] }) } }] }));
    let checks = 0;
    const result = await askDepartmentWorker('Prepare selected case.', { root, maxTurns: 3, beforeRequest: async () => { if (++checks > 1) throw new Error('revoked'); } });
    expect(result.ok).toBe(false); expect(checks).toBe(2); expect(captures).toHaveLength(1);
  }, 120_000);

  it('does not forward after authority changes during the awaited admission hook', async () => {
    const { root, captures } = await fixture(() => ({ role: 'assistant', content: 'unused' }));
    const controller = new AbortController();
    const result = await askDepartmentWorker('Prepare case.', { root, signal: controller.signal, beforeRequest: async () => { await Promise.resolve(); controller.abort(); } });
    expect(result).toEqual({ ok: false, detail: 'Preparation cancelled.' }); expect(captures).toHaveLength(0);
  }, 120_000);

  it('never forwards or starts a private fallback when final launch authority is denied', async () => {
    const { root, captures } = await fixture(() => ({ role: 'assistant', content: 'unused' }));
    const hook = vi.fn(async () => { throw new Error('stale company claim'); });
    expect(await askDepartmentWorker('Prepare case.', { root, beforeLaunch: hook })).toMatchObject({ ok: false });
    expect(hook).toHaveBeenCalledOnce(); expect(captures).toHaveLength(0);
  }, 120_000);

  it('holds unsupported provider routing before any inference', async () => {
    const { root, captures, profile } = await fixture(() => ({ role: 'assistant', content: 'unused' }));
    writeFileSync(join(profile, 'config.yaml'), 'model:\n  default: ignored-model\n  provider: copilot\napprovals:\n  mode: manual\n');
    expect(await askDepartmentWorker('Prepare case.', { root })).toMatchObject({ ok: false }); expect(captures).toHaveLength(0);
  }, 120_000);

  it('requires explicit caller authority checks on an otherwise admitted runtime', async () => {
    const { root, captures } = await fixture(() => ({ role: 'assistant', content: 'unused' }));
    expect(await realAskDepartmentWorker('Prepare case.', { root })).toMatchObject({ ok: false });
    expect(await realAskDepartmentWorker('Prepare case.', { root, beforeLaunch: async () => {} })).toMatchObject({ ok: false });
    expect(captures).toHaveLength(0);
  }, 120_000);

  it('honors a reviewed turn allowance above six while guarding every request', async () => {
    const { root, captures } = await fixture((_request, index) => index < 8
      ? { role: 'assistant', content: null, tool_calls: [{ id: `todo-${index}`, type: 'function', function: { name: 'todo_list', arguments: JSON.stringify({ todos: [{ id: String(index), content: `Prepare case step ${index}`, status: 'in_progress' }] }) } }] }
      : { role: 'assistant', content: 'Prepared after seven planning turns.' });
    const beforeRequest = vi.fn();
    expect(await askDepartmentWorker('Prepare case.', { root, maxTurns: 12, timeoutMs: 300_000, beforeRequest })).toEqual({ ok: true, stdout: 'Prepared after seven planning turns.' });
    expect(captures).toHaveLength(8); expect(beforeRequest).toHaveBeenCalledTimes(8);
  }, 120_000);

  it('does not carry previous case history into a fresh run and removes both scratch homes', async () => {
    const { root, captures } = await fixture(() => ({ role: 'assistant', content: 'Prepared.' }));
    const initial = new Set(readdirSync(tmpdir()).filter(name => name.startsWith('realbud-department-')));
    const scratch: string[] = [];
    const beforeLaunch = async () => { scratch.push(...readdirSync(tmpdir()).filter(name => name.startsWith('realbud-department-') && !initial.has(name))); };
    expect((await askDepartmentWorker('PREVIOUS_CASE_UNIQUE_17', { root, beforeLaunch })).ok).toBe(true);
    expect((await askDepartmentWorker('CURRENT_CASE_UNIQUE_28', { root, beforeLaunch })).ok).toBe(true);
    expect(captures).toHaveLength(2); expect(JSON.stringify(captures[1].body)).not.toContain('PREVIOUS_CASE_UNIQUE_17');
    expect(scratch).toHaveLength(2); expect(new Set(scratch).size).toBe(2);
    for (const name of scratch) expect(existsSync(join(tmpdir(), name))).toBe(false);
  }, 120_000);

  it('aborts a forwarded provider request and reaps its worker on cancellation', async () => {
    let entered!: () => void, release!: () => void;
    const pendingRequest = new Promise<void>(done => { entered = done; });
    const held = new Promise<void>(done => { release = done; });
    const { root, captures } = await fixture(async () => { entered(); await held; return { role: 'assistant', content: 'Too late.' }; });
    const controller = new AbortController();
    const pending = askDepartmentWorker('Prepare case.', { root, signal: controller.signal });
    try {
      await pendingRequest; controller.abort();
      expect(await pending).toEqual({ ok: false, detail: 'Preparation cancelled.' }); expect(captures).toHaveLength(1);
    } finally { controller.abort(); release(); await pending; }
  }, 120_000);
});
