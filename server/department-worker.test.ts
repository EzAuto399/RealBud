import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { askDepartmentWorker as realAskDepartmentWorker, DEPARTMENT_LIMITS, DEPARTMENT_SYSTEM_PROMPT, relayIdempotencyKey, relayRefusalDetail, todoToolReply, type DepartmentWorkerOptions } from './department-worker.ts';
import { currentWorkerProfile, withWorkerProfile } from './hermes-profile.ts';
import { MANAGED_ACCESS_MISMATCH, MANAGED_ACCESS_RECOVERY, MANAGED_ACCESS_UNPAIRED, MANAGED_ACCESS_WITHDRAWN, setWorkerModelAccessSnapshot } from './hermes-runtime-env.ts';
import { setWorkerModelGrant } from './worker-model-access.ts';

const dirs: string[] = [], servers: Server[] = [];
const askDepartmentWorker = (prompt: string, opts: DepartmentWorkerOptions = {}) => realAskDepartmentWorker(prompt, {
  beforeLaunch: async () => {}, beforeRequest: async () => {}, ...opts,
});
afterEach(async () => {
  vi.unstubAllEnvs(); setWorkerModelAccessSnapshot({}); setWorkerModelGrant({ state: 'none' });
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('relayed inference and the model service', () => {
  const body = Buffer.from(JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'FICTIONAL case' }] }));
  it('sends one Idempotency-Key per logical request: stable for a body within a run, new for another run or body', () => {
    const key = relayIdempotencyKey('run-one', body);
    // Modelvia admits keys matching its id() shape.
    expect(key).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,159}$/);
    expect(relayIdempotencyKey('run-one', Buffer.from(body))).toBe(key);
    expect(relayIdempotencyKey('run-two', body)).not.toBe(key);
    expect(relayIdempotencyKey('run-one', Buffer.concat([body, Buffer.from(' ')]))).not.toBe(key);
    expect(key).not.toContain('run-one');
  });
  it('turns a known model-service refusal into one sentence and ignores everything else', () => {
    const refusal = (code: string, receipt?: unknown) => Buffer.from(JSON.stringify({ error: { message: code, type: 'invalid_request_error', code, param: null }, ...(receipt ? { receipt } : {}) }));
    expect(relayRefusalDetail(409, refusal('request_already_processed', { requestId: 'req_0123456789abcdef', state: 'settled', model: 'deepseek-v4.1-flash', priceBasis: 'withheld' })))
      .toMatch(/^The model service already handled this exact request.*\.$/);
    expect(relayRefusalDetail(409, refusal('customer_terms_required'))).toMatch(/^Your office's AI pricing terms/);
    expect(relayRefusalDetail(402, refusal('project_request_cap_exceeded'))).toMatch(/more reserved capacity/);
    for (const [status, bytes] of [[200, refusal('customer_terms_required')], [500, refusal('internal_error')], [409, Buffer.from('not json')], [409, Buffer.alloc(70 * 1024, 32)]] as const)
      expect(relayRefusalDetail(status, bytes)).toBeNull();
  });
});

describe('the todo_list planning tool', () => {
  const call = (name: string, args: unknown, id: unknown = 'call-1') => ({ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
  it('answers a valid plan with the plan and nothing else', () => {
    const todos = [{ id: '1', content: 'Read the case', status: 'in_progress' }];
    expect(todoToolReply(call('todo_list', { todos }))).toEqual({ role: 'tool', tool_call_id: 'call-1', content: JSON.stringify({ todos }) });
  });
  it('answers any other tool or malformed plan with an error the model can correct, and refuses a call it cannot answer', () => {
    for (const bad of [call('terminal', { command: 'cat /synthetic/secret' }), call('todo_list', '{not json'), call('todo_list', { todos: [{ id: '1', content: 'x', status: 'done' }] }),
      call('todo_list', { todos: [{ id: '1', content: 'x', status: 'pending', extra: true }] }), call('todo_list', { todos: [], merge: true }),
      call('todo_list', { todos: Array.from({ length: 51 }, (_, i) => ({ id: String(i), content: 'x', status: 'pending' })) })]) {
      const reply = todoToolReply(bad);
      expect(reply?.tool_call_id).toBe('call-1'); expect(JSON.parse(reply!.content)).toHaveProperty('error');
    }
    for (const unanswerable of [call('todo_list', { todos: [] }, ''), call('todo_list', { todos: [] }, 7), null, { id: 'x', type: 'other', function: {} }]) expect(todoToolReply(unanswerable)).toBeNull();
  });
});

it('refuses a cancelled run before any authority work', async () => {
  const controller = new AbortController(); controller.abort(); const beforeLaunch = vi.fn();
  expect(await askDepartmentWorker('case', { signal: controller.signal, beforeLaunch })).toEqual({ ok: false, detail: 'Preparation cancelled.' });
  expect(beforeLaunch).not.toHaveBeenCalled();
});

type Message = Record<string, unknown>;
const PROFILE_CONFIG = (port: number, model = 'deepseek-v4.1-flash', effort = 'high') =>
  `model:\n  default: ${model}\n  provider: custom:realbud\nproviders:\n  realbud:\n    base_url: http://127.0.0.1:${port}/v1\n    key_env: REALBUD_MODEL_API_KEY\n    api_mode: chat_completions\napprovals:\n  mode: manual\nagent:\n  system_prompt: PRIVATE_CONFIG_CANARY\n  reasoning_effort: ${effort}\nskills:\n  auto_load: [private]\n`;

/** A fictional Modelvia: records every request and answers with `answer`'s message. */
async function fixture(answer: (request: any, index: number) => Message | { status: number; body: unknown } | Promise<Message>) {
  const captures: { body: any; path?: string; authorization?: string; idempotency?: string }[] = [];
  const provider = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    captures.push({ body: structuredClone(body), path: request.url, authorization: request.headers.authorization, idempotency: request.headers['idempotency-key'] as string });
    const message: Message = await answer(body, captures.length);
    if (typeof message.status === 'number') { response.writeHead(message.status, { 'content-type': 'application/json' }); response.end(JSON.stringify(message.body)); return; }
    response.writeHead(200, { 'content-type': 'application/json', 'x-request-id': `req_fictional_${captures.length}` });
    response.end(JSON.stringify({ id: `fictional-${captures.length}`, object: 'chat.completion', created: 1, model: body.model,
      choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  }); servers.push(provider);
  await new Promise<void>(done => provider.listen(0, '127.0.0.1', done));
  const address = provider.address(); if (!address || typeof address === 'string') throw new Error();
  // `root` is the worker folder (the Hermes home): runtime-free, profile only.
  const root = mkdtempSync(join(tmpdir(), 'department-owned-')); dirs.push(root);
  const profile = join(root, 'profiles', currentWorkerProfile().profile); mkdirSync(join(profile, 'memories'), { recursive: true });
  for (const name of ['SOUL.md', 'USER.md', 'MEMORY.md', 'AGENTS.md', 'CLAUDE.md']) writeFileSync(join(profile, name), `PRIVATE_${name}_CANARY`);
  writeFileSync(join(profile, 'memories/MEMORY.md'), 'PROFILE_MEMORY_CANARY'); writeFileSync(join(profile, 'memories/USER.md'), 'PROFILE_USER_CANARY');
  mkdirSync(join(profile, 'skills/private'), { recursive: true }); writeFileSync(join(profile, 'skills/private/SKILL.md'), 'PRIVATE_SKILL_CANARY');
  writeFileSync(join(profile, '.skills_prompt_snapshot.json'), JSON.stringify({ skills: ['POISONED_SNAPSHOT_CANARY'] }));
  writeFileSync(join(profile, '.env'), 'HERMES_EPHEMERAL_SYSTEM_PROMPT=PROFILE_ENV_CANARY\n');
  writeFileSync(join(profile, 'config.yaml'), PROFILE_CONFIG(address.port));
  setWorkerModelAccessSnapshot({ REALBUD_MODEL_API_KEY: 'fictional-selected-profile-key' });
  setWorkerModelGrant({ state: 'active', baseUrl: `http://127.0.0.1:${address.port}/v1/`, keyId: 'fictional-key-id', spendCapLabel: 'Fictional cap' });
  vi.stubEnv('HERMES_EPHEMERAL_SYSTEM_PROMPT', 'AMBIENT_PROMPT_CANARY'); vi.stubEnv('OPENAI_API_KEY', 'wrong-ambient-key'); vi.stubEnv('REALBUD_MODEL_API_KEY', 'wrong-ambient-key');
  return { root, captures, profile, port: address.port };
}
const todo = (index: number) => ({ role: 'assistant', content: null, tool_calls: [{ id: `todo-${index}`, type: 'function', function: { name: 'todo_list', arguments: JSON.stringify({ todos: [{ id: String(index), content: `Prepare case step ${index}`, status: 'in_progress' }] }) } }] });

/**
 * What one preparation looked like on the wire when it ran inside the worker
 * (the admitted Hermes AIAgent with only `todo_list`, captured by the former
 * native fixture tests): the owned loop must keep this shape and these limits.
 * The upstream planner's own system prompt is not kept (owner decision, 8 Oct).
 */
const WORKER_PREPARATION = {
  path: '/v1/chat/completions', authorization: 'Bearer fictional-selected-profile-key',
  body: { model: 'deepseek-v4.1-flash', reasoning_effort: 'high' }, tools: ['todo_list'],
  absent: ['tool_choice', 'parallel_tool_calls', 'temperature'],
  limits: { turns: { default: 6, max: 12 }, timeoutMs: { default: 120_000, max: 300_000 } },
  result: { ok: true, stdout: 'Prepared fictional case.' },
};

describe('owned preparation loop on a fictional provider', () => {
  it('keeps the worker preparation shape and limits: case only, the seat\'s model route, the todo tool, no private profile text', async () => withWorkerProfile('fictional-company-member', async () => {
    const { root, captures } = await fixture(() => ({ role: 'assistant', content: 'Prepared fictional case.' }));
    const beforeLaunch = vi.fn(), beforeRequest = vi.fn();
    const result = await askDepartmentWorker('REVIEWED_INSTRUCTIONS: summarize SELECTED_CASE_42 only.', { root, beforeLaunch, beforeRequest, maxTurns: 2 });
    expect(result).toEqual({ ...WORKER_PREPARATION.result, usage: { requestIds: ['req_fictional_1'], calls: 1, inputTokens: 10, outputTokens: 5 } });
    expect(DEPARTMENT_LIMITS).toEqual(WORKER_PREPARATION.limits);
    expect(beforeLaunch).toHaveBeenCalledOnce(); expect(beforeRequest).toHaveBeenCalledOnce(); expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({ path: WORKER_PREPARATION.path, authorization: WORKER_PREPARATION.authorization, body: WORKER_PREPARATION.body });
    expect(captures[0]!.idempotency).toMatch(/^realbud-case-[0-9a-f]{48}$/);
    for (const field of WORKER_PREPARATION.absent) expect(captures[0]!.body).not.toHaveProperty(field);
    expect(captures[0]!.body.tools.map((tool: any) => tool.function.name)).toEqual(WORKER_PREPARATION.tools);
    // Isolated messages: RealBud's own instructions, then exactly the case prompt.
    expect(captures[0]!.body.messages).toEqual([{ role: 'system', content: DEPARTMENT_SYSTEM_PROMPT }, { role: 'user', content: 'REVIEWED_INSTRUCTIONS: summarize SELECTED_CASE_42 only.' }]);
    expect(JSON.stringify(captures[0]!.body)).not.toContain('CANARY');
  }));

  it('plans with validated todo turns, guards every request and honours a reviewed allowance above six', async () => {
    const { root, captures } = await fixture((_request, index) => index < 8 ? todo(index) : { role: 'assistant', content: 'Prepared after seven planning turns.' });
    const beforeRequest = vi.fn();
    const result = await askDepartmentWorker('Prepare case.', { root, maxTurns: 12, beforeRequest });
    expect(result).toMatchObject({ ok: true, stdout: 'Prepared after seven planning turns.', usage: { calls: 8 } });
    expect(captures).toHaveLength(8); expect(beforeRequest).toHaveBeenCalledTimes(8);
    // Each todo call is answered with its own id before the next request, and no request key repeats.
    const second = captures[1]!.body.messages;
    expect(second.slice(-2)).toEqual([
      { role: 'assistant', content: null, tool_calls: todo(1).tool_calls },
      { role: 'tool', tool_call_id: 'todo-1', content: JSON.stringify({ todos: [{ id: '1', content: 'Prepare case step 1', status: 'in_progress' }] }) },
    ]);
    expect(new Set(captures.map(capture => capture.idempotency)).size).toBe(8);
  });

  it('stops at the turn limit with the office sentence, and clamps an oversized allowance to twelve', async () => {
    const { root, captures } = await fixture((_request, index) => todo(index));
    expect(await askDepartmentWorker('Prepare case.', { root, maxTurns: 2 })).toMatchObject({ ok: false, detail: expect.stringMatching(/turn or time limit/) });
    expect(captures).toHaveLength(2);
    expect(await askDepartmentWorker('Prepare case.', { root, maxTurns: 50 })).toMatchObject({ ok: false });
    expect(captures).toHaveLength(14);
  });

  it('stops at the time limit and aborts the request in flight', async () => {
    let aborted = false;
    const { root, captures } = await fixture(() => new Promise<Message>(() => {}));
    servers[0]!.on('request', request => request.on('close', () => { aborted = true; }));
    expect(await askDepartmentWorker('Prepare case.', { root, timeoutMs: 200 })).toMatchObject({ ok: false, detail: expect.stringMatching(/turn or time limit/) });
    expect(captures).toHaveLength(1);
    await vi.waitFor(() => expect(aborted).toBe(true));
  });

  it('denies the second model request after a todo turn without forwarding it', async () => {
    const { root, captures } = await fixture(() => todo(1));
    let checks = 0;
    const result = await askDepartmentWorker('Prepare selected case.', { root, maxTurns: 3, beforeRequest: async () => { if (++checks > 1) throw new Error('revoked'); } });
    expect(result.ok).toBe(false); expect(checks).toBe(2); expect(captures).toHaveLength(1);
  });

  it('does not forward after authority changes during the awaited admission hook', async () => {
    const { root, captures } = await fixture(() => ({ role: 'assistant', content: 'unused' }));
    const controller = new AbortController();
    const result = await askDepartmentWorker('Prepare case.', { root, signal: controller.signal, beforeRequest: async () => { await Promise.resolve(); controller.abort(); } });
    expect(result).toEqual({ ok: false, detail: 'Preparation cancelled.' }); expect(captures).toHaveLength(0);
  });

  it('does not ask for request authority after a Stop during the launch hook', async () => {
    const { root, captures } = await fixture(() => ({ role: 'assistant', content: 'unused' }));
    const controller = new AbortController(), beforeRequest = vi.fn();
    expect(await askDepartmentWorker('Prepare case.', { root, signal: controller.signal, beforeLaunch: async () => { controller.abort(); }, beforeRequest })).toEqual({ ok: false, detail: 'Preparation cancelled.' });
    expect(beforeRequest).not.toHaveBeenCalled(); expect(captures).toHaveLength(0);
  });

  it('never forwards when final launch authority is denied, or when the caller omits its checks', async () => {
    const { root, captures } = await fixture(() => ({ role: 'assistant', content: 'unused' }));
    const hook = vi.fn(async () => { throw new Error('stale company claim'); });
    expect(await askDepartmentWorker('Prepare case.', { root, beforeLaunch: hook })).toMatchObject({ ok: false });
    expect(hook).toHaveBeenCalledOnce();
    expect(await realAskDepartmentWorker('Prepare case.', { root })).toMatchObject({ ok: false });
    expect(await realAskDepartmentWorker('Prepare case.', { root, beforeLaunch: async () => {} })).toMatchObject({ ok: false });
    expect(captures).toHaveLength(0);
  });

  it('stops forwarding when the office key changes mid-run', async () => {
    // Withdrawn while the first answer is on its way: the snapshot change aborts
    // the exchange and the withdrawn grant names the reason.
    const { root, captures } = await fixture((_request, index) => { setWorkerModelGrant({ state: 'withdrawn' }); setWorkerModelAccessSnapshot({}); return todo(index); });
    expect(await askDepartmentWorker('Prepare case.', { root })).toMatchObject({ ok: false, detail: MANAGED_ACCESS_WITHDRAWN });
    expect(captures).toHaveLength(1);
  });

  it('refuses before any request without a grant, a key or a valid saved choice', async () => {
    const { root, captures, profile, port } = await fixture(() => ({ role: 'assistant', content: 'unused' }));
    // A saved model with an effort RealBud never pairs with it is repaired, not re-priced.
    writeFileSync(join(profile, 'config.yaml'), PROFILE_CONFIG(port, 'deepseek-v4.1-flash', 'xhigh'));
    expect(await askDepartmentWorker('Prepare case.', { root })).toEqual({ ok: false, detail: MANAGED_ACCESS_MISMATCH });
    writeFileSync(join(profile, 'config.yaml'), PROFILE_CONFIG(port));
    setWorkerModelAccessSnapshot({});
    expect(await askDepartmentWorker('Prepare case.', { root })).toEqual({ ok: false, detail: MANAGED_ACCESS_RECOVERY });
    setWorkerModelGrant({ state: 'withdrawn' });
    expect(await askDepartmentWorker('Prepare case.', { root })).toEqual({ ok: false, detail: MANAGED_ACCESS_WITHDRAWN });
    setWorkerModelGrant({ state: 'none' });
    expect(await askDepartmentWorker('Prepare case.', { root })).toEqual({ ok: false, detail: MANAGED_ACCESS_UNPAIRED });
    // The key only ever goes to an https or loopback grant, never to a plain-http remote.
    setWorkerModelAccessSnapshot({ REALBUD_MODEL_API_KEY: 'fictional-selected-profile-key' });
    setWorkerModelGrant({ state: 'active', baseUrl: 'http://attacker.invalid/v1', keyId: 'fictional-key-id', spendCapLabel: 'Fictional cap' });
    expect(await askDepartmentWorker('Prepare case.', { root })).toMatchObject({ ok: false });
    expect(captures).toHaveLength(0);
  });

  it('sends the key only to the granted endpoint, whatever the worker-writable profile names', async () => {
    const { root, captures, profile } = await fixture(() => ({ role: 'assistant', content: 'Prepared.' }));
    const config = join(profile, 'config.yaml');
    writeFileSync(config, readFileSync(config, 'utf8').replace(/base_url: http:\/\/127\.0\.0\.1:\d+\/v1/, 'base_url: https://attacker.invalid/v1'));
    writeFileSync(join(profile, '.env'), 'REALBUD_MODEL_API_KEY=wrong-dotenv-key\n');
    expect(await askDepartmentWorker('Prepare case.', { root })).toMatchObject({ ok: true, stdout: 'Prepared.' });
    expect(captures[0]).toMatchObject({ path: '/v1/chat/completions', authorization: 'Bearer fictional-selected-profile-key' });
  });

  it('shows a known model-service refusal as its sentence and counts the request', async () => {
    const { root } = await fixture(() => ({ status: 402, body: { error: { message: 'cap', type: 'invalid_request_error', code: 'project_request_cap_exceeded', param: null } } }));
    expect(await askDepartmentWorker('Prepare case.', { root })).toMatchObject({ ok: false, detail: expect.stringMatching(/more reserved capacity/), usage: { calls: 1 } });
  });

  it('does not carry a previous case into a fresh run', async () => {
    const { root, captures } = await fixture(() => ({ role: 'assistant', content: 'Prepared.' }));
    expect((await askDepartmentWorker('PREVIOUS_CASE_UNIQUE_17', { root })).ok).toBe(true);
    expect((await askDepartmentWorker('CURRENT_CASE_UNIQUE_28', { root })).ok).toBe(true);
    expect(captures).toHaveLength(2); expect(JSON.stringify(captures[1]!.body)).not.toContain('PREVIOUS_CASE_UNIQUE_17');
  });

  it('aborts a forwarded provider request on cancellation', async () => {
    let entered!: () => void, release!: () => void;
    const pendingRequest = new Promise<void>(done => { entered = done; });
    const held = new Promise<void>(done => { release = done; });
    const { root, captures } = await fixture(async () => { entered(); await held; return { role: 'assistant', content: 'Too late.' }; });
    const controller = new AbortController();
    const pending = askDepartmentWorker('Prepare case.', { root, signal: controller.signal });
    try {
      await pendingRequest; controller.abort();
      expect(await pending).toMatchObject({ ok: false, detail: 'Preparation cancelled.' }); expect(captures).toHaveLength(1);
    } finally { controller.abort(); release(); await pending; }
  });

  it('still prepares after the worker folder is deleted, on the office default model', async () => {
    const { root, captures } = await fixture(() => ({ role: 'assistant', content: 'Prepared without a worker.' }));
    expect(await askDepartmentWorker('Prepare case.', { root })).toMatchObject({ ok: true });
    rmSync(root, { recursive: true, force: true }); expect(existsSync(root)).toBe(false);
    expect(await askDepartmentWorker('Prepare case.', { root })).toMatchObject({ ok: true, stdout: 'Prepared without a worker.' });
    expect(captures.map(capture => [capture.body.model, capture.body.reasoning_effort])).toEqual([['deepseek-v4.1-flash', 'high'], ['claude-sonnet-5.5', 'medium']]);
    expect(existsSync(root)).toBe(false);
  });
});
