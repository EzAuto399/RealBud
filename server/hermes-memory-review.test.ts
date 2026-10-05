import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DATA_DIR } from './config.ts';
import { describe, expect, it, vi } from 'vitest';
import {
  createHermesMemoryReviewService, memoryReviewChildEnvironment,
  MEMORY_REVIEW_RUNTIME, MEMORY_REVIEW_CANDIDATE_RUNTIME, MEMORY_REVIEW_NATIVE_FILES, MEMORY_REVIEW_RUNTIMES, type MemoryReviewContext,
} from './hermes-memory-review.ts';
import {
  MEMORY_REVIEW_API, MEMORY_REVIEW_ERRORS, MEMORY_LEARNING_API, parseMemoryLearningUndo,
  memoryReviewId, memoryReviewDigest, parseMemoryLearningState,
  parseMemoryReviewPage, parseMemoryReviewPreview, parseMemoryReviewDecision,
  type MemoryReviewItem,
} from '../shared/hermes-memory-review.ts';
import { learningHold } from '../shared/learning-policy.ts';

// All context, signing material and native responses below are synthetic.
// Trusted validation/invoke seams never inspect or launch a user profile.
const id = '00000010', digest = 'a'.repeat(64);
const context = (): MemoryReviewContext => ({
  profileDirectory: '/synthetic/profiles/property-fixture', runtimeDirectory: '/synthetic/release/hermes-agent',
  workspaceId: '11111111-2222-4333-8444-555555555555', profileId: 'property-fixture', runtimeId: MEMORY_REVIEW_RUNTIME,
  python: '/synthetic/release/hermes-agent/venv/bin/python',
});
const item = (patch: Partial<MemoryReviewItem> = {}): MemoryReviewItem => ({ id, state: 'pending', target: 'user', action: 'replace', origin: 'foreground', createdAt: 1_700_000_000_000, decision: null, reviewDigest: null, ...patch });
const page = () => ({ version: 1, items: [item()], nextCursor: null, total: 1, held: 0 });
const preview = () => ({ version: 1, id, target: 'user', action: 'replace', origin: 'foreground', createdAt: 1_700_000_000_000, reviewDigest: digest, before: 'Use Australian English.\n', after: 'Use Australian English.\nKeep updates concise.\n', operationCount: 1, charLimit: 5000 });
const decision = () => ({ version: 1, id, state: 'applied', reviewDigest: digest, changed: true, at: 1_700_000_000_001 });
const successful = (result: unknown) => ({ ok: true, result });
function deferred<T = unknown>() { let resolve!: (value: T) => void, reject!: (cause: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
type Options = Parameters<typeof createHermesMemoryReviewService>[0];
function fixture(overrides: Partial<Options> = {}) {
  const key = Buffer.alloc(32, 7), validateRuntime = vi.fn(async () => {}), invoke = vi.fn<NonNullable<Options['invoke']>>(async (_context, request) => successful(request.command === 'list' ? page() : request.command === 'preview' ? preview() : decision()));
  const hostContext = vi.fn(context), getKey = vi.fn(() => key);
  const service = createHermesMemoryReviewService({ context: hostContext, key: getKey, validateRuntime, invoke, ...overrides });
  return { service, key, getKey, hostContext, validateRuntime, invoke };
}
const expectError = (response: Awaited<ReturnType<ReturnType<typeof createHermesMemoryReviewService>['handle']>>, code: keyof typeof MEMORY_REVIEW_ERRORS, status?: number) => {
  expect(response?.body).toEqual({ code, error: MEMORY_REVIEW_ERRORS[code] });
  expect(response?.status).toBe(status ?? 409);
};

const badRequests: [string, string, unknown, string, number][] = [
  [MEMORY_REVIEW_API, 'GET', {}, '', 400], [MEMORY_REVIEW_API, 'GET', null, '', 400],
  [MEMORY_REVIEW_API, 'GET', undefined, 'cursor=', 400], [MEMORY_REVIEW_API, 'GET', undefined, 'cursor=00000010&cursor=00000020', 400],
  [MEMORY_REVIEW_API, 'GET', undefined, 'cursor=ABCDEF10', 400], [MEMORY_REVIEW_API, 'GET', undefined, 'cursor=000000100', 400],
  [MEMORY_REVIEW_API, 'GET', undefined, 'profileDirectory=%2Fcaller', 400], [MEMORY_REVIEW_API, 'GET', undefined, 'limit=999', 400],
  [`${MEMORY_REVIEW_API}/`, 'GET', undefined, '', 404], [`${MEMORY_REVIEW_API}/../memory`, 'GET', undefined, '', 404],
  [`${MEMORY_REVIEW_API}/ABCDEF10`, 'GET', undefined, '', 404], [`${MEMORY_REVIEW_API}/${id}/extra`, 'GET', undefined, '', 404],
  [`${MEMORY_REVIEW_API}/${id}`, 'DELETE', undefined, '', 404], [`${MEMORY_REVIEW_API}/${id}`, 'GET', undefined, 'cursor=00000001', 400],
  [`${MEMORY_REVIEW_API}/${id}`, 'GET', '', '', 400], [`${MEMORY_REVIEW_API}/${id}/decision`, 'GET', undefined, '', 404],
  [`${MEMORY_REVIEW_API}/${id}/decision`, 'POST', null, '', 400], [`${MEMORY_REVIEW_API}/${id}/decision`, 'POST', [], '', 400],
  [`${MEMORY_REVIEW_API}/${id}/decision`, 'POST', { decision: 'approve' }, '', 400],
  [`${MEMORY_REVIEW_API}/${id}/decision`, 'POST', { expectedDigest: digest, decision: 'always' }, '', 400],
  [`${MEMORY_REVIEW_API}/${id}/decision`, 'POST', { expectedDigest: digest.toUpperCase(), decision: 'approve' }, '', 400],
  [`${MEMORY_REVIEW_API}/${id}/decision`, 'POST', { expectedDigest: digest, decision: 'approve', key: 'caller-key' }, '', 400],
  [`${MEMORY_REVIEW_API}/${id}/decision`, 'POST', { expectedDigest: digest, decision: 'approve', workspaceId: 'caller-workspace' }, '', 400],
  [`${MEMORY_REVIEW_API}/${id}/decision`, 'POST', { expectedDigest: digest, decision: 'approve', profileDirectory: '/caller-profile' }, '', 400],
  [`${MEMORY_REVIEW_API}/${id}/decision`, 'POST', { expectedDigest: digest, decision: 'approve' }, 'target=memory', 400],
];

describe('memory review HTTP boundary', () => {
  it.each(badRequests)('rejects invalid %s %s body/query %# before resolving authority', async (path, method, body, query, status) => {
    const { service, hostContext, getKey, validateRuntime, invoke } = fixture();
    expectError(await service.handle(path, method, body, new URLSearchParams(query)), 'invalid', status);
    expect(hostContext).not.toHaveBeenCalled(); expect(getKey).not.toHaveBeenCalled(); expect(validateRuntime).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled();
  });
  it('leaves unrelated routes to their owner without resolving worker or key state', async () => {
    const { service, hostContext } = fixture();
    for (const path of ['/api/hermes', `${MEMORY_REVIEW_API}-other`, '/api/business-records']) expect(await service.handle(path, 'GET')).toBeNull();
    expect(hostContext).not.toHaveBeenCalled();
  });
  it('uses only host context and a workspace/profile-derived signing key for its private invocation', async () => {
    const f = fixture(); const result = await f.service.handle(MEMORY_REVIEW_API, 'GET', undefined, new URLSearchParams('cursor=00000001'));
    expect(result).toEqual({ status: 200, body: page() }); expect(f.validateRuntime).toHaveBeenCalledWith(context());
    const [actualContext, request] = f.invoke.mock.calls[0], { python: _python, ...binding } = context();
    const expectedKey = createHmac('sha256', f.key).update(`realbud-memory-review-v1\0${binding.workspaceId}\0${binding.profileId}`).digest('base64');
    expect(actualContext).toEqual(context()); expect(request).toEqual({ ...binding, version: 1, command: 'list', cursor: '00000001', key: expectedKey });
    expect(expectedKey).not.toBe(f.key.toString('base64')); expect(f.key.equals(Buffer.alloc(32, 7))).toBe(true);
    expect(JSON.stringify(result)).not.toContain(expectedKey); expect(request).not.toHaveProperty('python');
    for (const changed of [{ ...context(), workspaceId: '22222222-3333-4444-8555-666666666666' }, { ...context(), profileId: 'property-other' }]) {
      const next = fixture({ context: () => changed }); await next.service.handle(MEMORY_REVIEW_API, 'GET');
      expect(next.invoke.mock.calls[0][1].key).not.toBe(expectedKey);
    }
  });
  it('admits each native operation through workspace activity and rejects a held workspace before invoking it', async () => {
    const events: string[] = [];
    const f = fixture({ withActivity: async work => { events.push('admitted'); try { return await work(); } finally { events.push('drained'); } } });
    await f.service.handle(`${MEMORY_REVIEW_API}/${id}`, 'GET'); expect(events).toEqual(['admitted', 'drained']); expect(f.invoke).toHaveBeenCalledOnce();
    const held = fixture({ withActivity: async () => { throw new Error('private workspace restore path'); } });
    expectError(await held.service.handle(MEMORY_REVIEW_API, 'GET'), 'unavailable', 503); expect(held.invoke).not.toHaveBeenCalled();
  });
  it('fails closed on unavailable key and validation errors without reflecting private diagnostics', async () => {
    for (const key of [Buffer.alloc(31), Buffer.alloc(33), 'not-a-buffer'] as unknown[]) {
      const f = fixture({ key: () => key as Buffer }); expectError(await f.service.handle(MEMORY_REVIEW_API, 'GET'), 'unavailable', 503); expect(f.invoke).not.toHaveBeenCalled();
    }
    const f = fixture({ validateRuntime: async () => { throw new Error('/private/fictional-owner token=never-render-this'); } });
    expectError(await f.service.handle(MEMORY_REVIEW_API, 'GET'), 'unavailable', 503); expect(f.invoke).not.toHaveBeenCalled();
  });
});

describe('memory review runtime admission', () => {
  it('admits exactly the two reviewed commits, binding the 0.21.5 hermes_platform import closure', async () => {
    expect(Object.keys(MEMORY_REVIEW_RUNTIMES)).toEqual([MEMORY_REVIEW_RUNTIME, MEMORY_REVIEW_CANDIDATE_RUNTIME]);
    expect(MEMORY_REVIEW_RUNTIMES[MEMORY_REVIEW_RUNTIME]).toBe(MEMORY_REVIEW_NATIVE_FILES);
    const legacy = Object.keys(MEMORY_REVIEW_NATIVE_FILES), candidate = Object.keys(MEMORY_REVIEW_RUNTIMES[MEMORY_REVIEW_CANDIDATE_RUNTIME]);
    expect(candidate).toEqual([...legacy, 'hermes_platform/__init__.py', 'hermes_platform/host/__init__.py', 'hermes_platform/host/facts.py', 'hermes_platform/host/runtime.py']);
    for (const files of Object.values(MEMORY_REVIEW_RUNTIMES)) for (const digest of Object.values(files)) expect(digest).toMatch(/^[a-f0-9]{64}$/);
    // The service carries whichever admitted runtime is selected; the helper is told only its identity.
    const selected = { ...context(), runtimeId: `${MEMORY_REVIEW_CANDIDATE_RUNTIME}-fictional` }, f = fixture({ context: () => selected });
    expect((await f.service.handle(MEMORY_REVIEW_API, 'GET'))?.status).toBe(200);
    expect(f.invoke.mock.calls[0][1]).toMatchObject({ runtimeId: selected.runtimeId });
  });
});

describe('memory review context and lifetime', () => {
  it('rejects a profile/runtime switch during validation before passing signing authority to a helper', async () => {
    let selected = context(); const validation = deferred<void>(); const started = deferred<void>();
    const f = fixture({ context: () => selected, validateRuntime: async () => { started.resolve(); await validation.promise; } });
    const pending = f.service.handle(MEMORY_REVIEW_API, 'GET'); await started.promise;
    selected = { ...selected, runtimeDirectory: '/synthetic/release-updated/hermes-agent' }; validation.resolve();
    expectError(await pending, 'stale-review'); expect(f.invoke).not.toHaveBeenCalled(); expect(f.getKey).not.toHaveBeenCalled();
  });
  it('rejects a complete but stale helper result after the host changes workspace', async () => {
    let selected = context(); const result = deferred(); const entered = deferred<void>();
    const f = fixture({ context: () => selected, invoke: async () => { entered.resolve(); return result.promise; } });
    const pending = f.service.handle(`${MEMORY_REVIEW_API}/${id}`, 'GET'); await entered.promise;
    selected = { ...selected, workspaceId: '22222222-3333-4444-8555-666666666666' }; result.resolve(successful(preview()));
    expectError(await pending, 'stale-review');
  });
  it('holds simultaneous requests for the same profile until the first helper actually drains', async () => {
    const result = deferred(), entered = deferred<void>(); let selected = context(); let invokes = 0;
    const f = fixture({ context: () => selected, invoke: async () => { invokes++; entered.resolve(); return result.promise; } });
    const pending = f.service.handle(MEMORY_REVIEW_API, 'GET'); await entered.promise;
    try {
      expectError(await f.service.handle(`${MEMORY_REVIEW_API}/${id}`, 'GET'), 'busy');
      selected = { ...selected, workspaceId: '22222222-3333-4444-8555-666666666666' };
      expectError(await f.service.handle(MEMORY_REVIEW_API, 'GET'), 'busy');
      selected = { ...selected, profileDirectory: `${selected.profileDirectory}/../property-fixture` };
      expectError(await f.service.handle(MEMORY_REVIEW_API, 'GET'), 'busy'); expect(invokes).toBe(1);
    } finally { result.resolve(successful(page())); await pending; }
    const after = await f.service.handle(MEMORY_REVIEW_API, 'GET'); expect(after?.status).toBe(200); expect(invokes).toBe(2);
  });
  it('close aborts and awaits an owned active helper, rejects new work, and is safe to repeat', async () => {
    const drain = deferred(), entered = deferred<void>(); let signal: AbortSignal | undefined;
    const f = fixture({ invoke: async (_context, _request, options) => { signal = options?.signal; entered.resolve(); return drain.promise; } });
    const pending = f.service.handle(MEMORY_REVIEW_API, 'GET'); await entered.promise;
    let closed = false; const closing = f.service.close().then(() => { closed = true; });
    try {
      expect(signal).toBeInstanceOf(AbortSignal); expect(signal!.aborted).toBe(true);
      await Promise.resolve(); expect(closed).toBe(false);
      expectError(await f.service.handle(MEMORY_REVIEW_API, 'GET'), 'unavailable', 503);
    } finally { drain.reject(new Error('fictional helper drained after abort')); await pending; await closing; }
    expect(closed).toBe(true); await f.service.close();
  });
  it('close drains in-flight validation and never starts its helper afterward', async () => {
    const validation = deferred<void>(), entered = deferred<void>();
    const f = fixture({ validateRuntime: async () => { entered.resolve(); await validation.promise; } });
    const pending = f.service.handle(MEMORY_REVIEW_API, 'GET'); await entered.promise;
    let closed = false; const closing = f.service.close().then(() => { closed = true; });
    await Promise.resolve(); expect(closed).toBe(false);
    validation.resolve(); await pending; await closing;
    expect(closed).toBe(true); expect(f.invoke).not.toHaveBeenCalled();
  });
});

describe('memory review helper output boundary', () => {
  it.each([null, [], {}, { ok: 'true', result: page() }, { ok: true, result: page(), stdout: 'private diagnostic' }, { ok: false, code: 'unsupported', detail: 'private diagnostic' }, { ok: false, code: 'unknown' }])('rejects malformed envelopes without reflecting them %#', async raw => {
    const f = fixture({ invoke: async () => raw }); expectError(await f.service.handle(MEMORY_REVIEW_API, 'GET'), 'unavailable', 503);
  });
  it('maps only the known fixed helper errors, including failures without public result data', async () => {
    const f = fixture({ invoke: async () => ({ ok: false, code: 'unsupported' }) });
    expectError(await f.service.handle(`${MEMORY_REVIEW_API}/${id}`, 'GET'), 'unsupported');
  });
  it.each([
    { ...preview(), id: '00000020' }, { ...preview(), reviewDigest: 'bad' }, { ...preview(), key: 'private helper field' },
    { ...preview(), before: 123 }, { ...preview(), operationCount: 0 }, { ...preview(), target: 'company' },
  ])('rejects an unbound or malformed full preview %#', async raw => {
    const f = fixture({ invoke: async () => successful(raw) }); expectError(await f.service.handle(`${MEMORY_REVIEW_API}/${id}`, 'GET'), 'unavailable', 503);
  });
  it.each([
    'ak_' + 'a'.repeat(32), 'ck_' + 'b'.repeat(32), 'Bearer ' + 'x'.repeat(32),
    'password = fictionalPassword123', 'unsafe\u0000text', 'unsafe\u0007text', 'unsafe\u001b[31mtext', 'unsafe\u007ftext',
    'unsafe\u0085text', 'unsafe\u009btext', 'unsafe\u202etext', 'unsafe\u202atext', 'unsafe\u2066text', 'unsafe\u2069text',
  ])('blocks credentials and unsafe controls in either complete text field %#', async content => {
    for (const field of ['before', 'after']) {
      const f = fixture({ invoke: async () => successful({ ...preview(), [field]: content }) });
      expectError(await f.service.handle(`${MEMORY_REVIEW_API}/${id}`, 'GET'), 'blocked-content');
    }
  });
  it('preserves literal newlines, tabs and markup through an otherwise valid preview', async () => {
    const raw = { ...preview(), before: '  <em>literal</em>\n\t**plain text**\r\n', after: 'Next preference.\n' };
    const f = fixture({ invoke: async () => successful(raw) }); expect(await f.service.handle(`${MEMORY_REVIEW_API}/${id}`, 'GET')).toEqual({ status: 200, body: raw });
  });
  it.each([
    { ...decision(), id: '00000020' }, { ...decision(), reviewDigest: 'b'.repeat(64) },
    { ...decision(), state: 'rejected', changed: false }, { ...decision(), changed: 'true' },
    { ...decision(), context: '/private/fixture' },
  ])('keeps a wrong or malformed decision result unconfirmed %#', async raw => {
    const f = fixture({ invoke: async () => successful(raw) });
    expectError(await f.service.handle(`${MEMORY_REVIEW_API}/${id}/decision`, 'POST', { expectedDigest: digest, decision: 'approve' }), 'recovery-required', 503);
  });
  it.each([null, {}, { ok: true, result: decision(), extra: 'private detail' }, { ok: false, code: 'unknown' },
    { ok: false, code: 'unavailable' }, { ok: false, code: 'unsafe-storage' }, { ok: false, code: 'capacity' },
  ])('reports ambiguous post-dispatch output as recovery required, never as proof of a failed write %#', async raw => {
    const f = fixture({ invoke: async () => raw });
    expectError(await f.service.handle(`${MEMORY_REVIEW_API}/${id}/decision`, 'POST', { expectedDigest: digest, decision: 'approve' }), 'recovery-required', 503);
  });
  it('reports a post-dispatch context switch as an unknown decision even when the helper returned success', async () => {
    let selected = context(); const entered = deferred<void>(), result = deferred();
    const f = fixture({ context: () => selected, invoke: async () => { entered.resolve(); return result.promise; } });
    const pending = f.service.handle(`${MEMORY_REVIEW_API}/${id}/decision`, 'POST', { expectedDigest: digest, decision: 'approve' });
    await entered.promise; selected = { ...selected, workspaceId: '22222222-3333-4444-8555-666666666666' };
    result.resolve(successful(decision())); expectError(await pending, 'recovery-required', 503);
  });
  it.each([new Error('private helper storage path'), new SyntaxError('invalid helper JSON with fictional private content'), Object.assign(new Error('unclassified thrown policy-looking value'), { code: 'stale-review', status: 409 })])('does not trust thrown post-dispatch failures as proof that memory was unchanged %#', async error => {
    const f = fixture({ invoke: async () => { throw error; } });
    expectError(await f.service.handle(`${MEMORY_REVIEW_API}/${id}/decision`, 'POST', { expectedDigest: digest, decision: 'approve' }), 'recovery-required', 503);
  });
  it.each(['stale-review', 'conflict', 'disabled'] as const)('preserves the explicit native policy refusal %s', async code => {
    const f = fixture({ invoke: async () => ({ ok: false, code }) });
    expectError(await f.service.handle(`${MEMORY_REVIEW_API}/${id}/decision`, 'POST', { expectedDigest: digest, decision: 'approve' }), code);
  });
  it('accepts an exact saved rejection and sends the required reviewed binding', async () => {
    const invoke = vi.fn<NonNullable<Options['invoke']>>(async () => successful({ ...decision(), state: 'rejected', changed: false }));
    const f = fixture({ invoke });
    const result = await f.service.handle(`${MEMORY_REVIEW_API}/${id}/decision`, 'POST', { expectedDigest: digest, decision: 'reject' });
    expect(result?.status).toBe(200); expect(result?.body).toEqual({ ...decision(), state: 'rejected', changed: false });
    expect(invoke.mock.calls[0][1]).toMatchObject({ command: 'decide', id, expectedDigest: digest, decision: 'reject' });
  });
});

describe('memory review child environment', () => {
  it('passes only platform necessities and fixed isolated profile settings, excluding source and provider credentials', () => {
    const source: NodeJS.ProcessEnv = {
      PATH: '/synthetic/bin', HOME: '/synthetic/home', USERPROFILE: 'C:\\synthetic\\home',
      SystemRoot: 'C:\\Windows', COMSPEC: 'C:\\Windows\\System32\\cmd.exe', LANG: 'en_AU.UTF-8', TMPDIR: '/synthetic/tmp',
      COMPOSIO_API_KEY: 'fictional-composio', OPENAI_API_KEY: 'fictional-provider', ANTHROPIC_API_KEY: 'fictional-provider',
      REALBUD_MEMORY_KEY: 'fictional-private-key', GMAIL_ACCESS_TOKEN: 'fictional-mail-token', HTTP_PROXY: 'http://fictional:secret@proxy.invalid',
      PYTHONPATH: '/injected/python', PYTHONHOME: '/injected/home', HERMES_HOME: '/other/profile', HERMES_SKIP_DOTENV: '0',
      NODE_OPTIONS: '--require /injected', AWS_SECRET_ACCESS_KEY: 'fictional-cloud',
    };
    const copy = { ...source }, env = memoryReviewChildEnvironment(context(), source);
    expect(env).toEqual({ PATH: source.PATH, HOME: source.HOME, USERPROFILE: source.USERPROFILE, SystemRoot: source.SystemRoot, COMSPEC: source.COMSPEC, LANG: source.LANG, TMPDIR: source.TMPDIR,
      HERMES_HOME: context().profileDirectory, HERMES_SKIP_DOTENV: '1', PYTHONDONTWRITEBYTECODE: '1' });
    expect(source).toEqual(copy); expect(JSON.stringify(env)).not.toContain('fictional-'); expect(JSON.stringify(env)).not.toContain('/injected');
  });
});

describe('memory review shared parser contracts', () => {
  it('bounds identifiers, pages, metadata and paired signed recovery bindings', () => {
    expect(memoryReviewId(id)).toBe(true); expect(memoryReviewDigest(digest)).toBe(true);
    for (const value of [null, true, 10, 'ABCDEFFF', '../00000010', '00000010\n']) expect(memoryReviewId(value)).toBe(false);
    for (const value of [null, [], 'a'.repeat(63), digest.toUpperCase(), `${digest}\n`]) expect(memoryReviewDigest(value)).toBe(false);
    expect(parseMemoryReviewPage(page())).toEqual(page());
    const invalid = [
      { ...page(), privateContext: 'must not be forwarded' }, { ...page(), held: 2 }, { ...page(), total: -1 }, { ...page(), nextCursor: 'bad' },
      { ...page(), items: [item(), item()], total: 2 }, { ...page(), items: Array.from({ length: 21 }, (_, i) => item({ id: i.toString(16).padStart(8, '0') })), total: 21 },
      { ...page(), items: [{ ...item(), origin: { toString: () => 'foreground' } }] },
      { ...page(), items: [item({ decision: 'approve', reviewDigest: digest })] },
      { ...page(), items: [item({ state: 'recovery-required', decision: 'approve', reviewDigest: null })] },
      { ...page(), items: [item({ state: 'recovery-required', decision: null, reviewDigest: digest })] },
      { ...page(), items: [{ ...item(), sourceAccount: 'fictional@example.invalid' }] },
    ];
    for (const raw of invalid) expect(parseMemoryReviewPage(raw)).toBeNull();
    const recovering = { ...page(), items: [item({ state: 'recovery-required', decision: 'approve', reviewDigest: digest })], held: 1 };
    const parsed = parseMemoryReviewPage(recovering)!; expect(parsed).toEqual(recovering);
    parsed.items[0].id = '000000ff'; expect(recovering.items[0].id).toBe(id);
  });
  it('counts Unicode characters, bounds bytes and permits only shrinking native removal above its configured limit', () => {
    expect(parseMemoryReviewPreview({ ...preview(), after: '🦘'.repeat(5), charLimit: 5 })).not.toBeNull();
    for (const raw of [
      { ...preview(), after: '🦘'.repeat(6), charLimit: 5 }, { ...preview(), before: 'a'.repeat(131_073) },
      { ...preview(), after: '🦘'.repeat(40_000), charLimit: 100_000 }, { ...preview(), operationCount: 101 },
      { ...preview(), charLimit: 100_001 }, { ...preview(), createdAt: Number.NaN },
      { ...preview(), action: { toString: () => 'replace' } },
      { ...preview(), before: 'a'.repeat(1000), after: 'b'.repeat(900), charLimit: 500 },
      { ...preview(), action: 'remove', before: 'a'.repeat(1000), after: 'a'.repeat(1100), charLimit: 500 },
      { ...preview(), action: 'remove', before: 'a'.repeat(1000), after: 'a'.repeat(1000), charLimit: 500 },
      { ...preview(), action: 'remove', before: '🦘'.repeat(600), after: 'a'.repeat(700), charLimit: 500 },
    ]) expect(parseMemoryReviewPreview(raw)).toBeNull();
    expect(parseMemoryReviewPreview({ ...preview(), action: 'remove', before: 'a'.repeat(1000), after: 'a'.repeat(900), charLimit: 500 })).not.toBeNull();
    expect(parseMemoryReviewPreview({ ...preview(), action: 'remove', before: 'a'.repeat(1000), after: '🦘'.repeat(900), charLimit: 500 })).not.toBeNull();
  });
  it('requires a real final state and rejects receipt coercions, extra fields and a rejection claiming changed memory', () => {
    expect(parseMemoryReviewDecision(decision())).toEqual(decision());
    for (const raw of [
      { ...decision(), changed: 'true' }, { ...decision(), state: 'rejected', changed: true },
      { ...decision(), state: 'pending' }, { ...decision(), state: { toString: () => 'applied' } },
      { ...decision(), at: Number.POSITIVE_INFINITY }, { ...decision(), key: 'private-result' },
    ]) expect(parseMemoryReviewDecision(raw)).toBeNull();
  });
});

// A fictional in-memory native store: one target, exact entries, digests over
// the complete before/after text, idempotent proposals and final receipts.
const DELIM = '\n§\n';
type FakeItem = { target: 'user'; action: 'add' | 'replace' | 'remove'; createdAt: number; content?: string; old_text?: string };
function nativeStore(initial = 'Prefers concise updates.') {
  const s = { memory: initial, pending: new Map<string, FakeItem>(), receipts: new Map<string, { decision: 'approve' | 'reject'; reviewDigest: string }>(), journals: new Map<string, string>(), calls: [] as Record<string, unknown>[] };
  const entries = (text: string) => text ? text.split(DELIM) : [];
  const apply = (item: FakeItem, before: string) => {
    const saved = entries(before);
    if (item.action === 'add') return [...saved, item.content!].join(DELIM);
    const matches = saved.filter(entry => entry.includes(item.old_text!));
    if (matches.length !== 1) return null;
    return item.action === 'remove' ? saved.filter(entry => entry !== matches[0]).join(DELIM) : saved.map(entry => entry === matches[0] ? item.content! : entry).join(DELIM);
  };
  const digestOf = (id: string, before: string, after: string) => createHash('sha256').update(JSON.stringify([id, before, after])).digest('hex');
  const preview = (id: string) => {
    const item = s.pending.get(id); if (!item) return null; const after = apply(item, s.memory); if (after === null) return null;
    return { version: 1, id, target: item.target, action: item.action, origin: 'foreground', createdAt: item.createdAt, reviewDigest: digestOf(id, s.memory, after), before: s.memory, after, operationCount: 1, charLimit: 5000 };
  };
  const invoke = vi.fn<NonNullable<Options['invoke']>>(async (_context, request) => {
    const r = request as unknown as Record<string, any>; s.calls.push({ command: r.command, id: r.id, decision: r.decision, input: r.input });
    if (r.command === 'list') {
      const ids = [...new Set([...s.pending.keys(), ...s.receipts.keys()])].sort();
      return successful({ version: 1, nextCursor: null, total: ids.length, held: 0, items: ids.map(id => {
        const receipt = s.receipts.get(id), item = s.pending.get(id);
        return receipt ? { id, state: receipt.decision === 'approve' ? 'applied' : 'rejected', action: 'add', target: 'user', origin: 'foreground', createdAt: 1, decision: receipt.decision, reviewDigest: receipt.reviewDigest }
          : { id, state: 'pending', action: item!.action, target: item!.target, origin: 'foreground', createdAt: item!.createdAt, decision: null, reviewDigest: null };
      }) });
    }
    if (r.command === 'preview') { if (s.receipts.has(r.id)) return { ok: false, code: 'recovery-required' }; const value = preview(r.id); return value ? successful(value) : { ok: false, code: 'conflict' }; }
    if (r.command === 'decide') {
      const done = s.receipts.get(r.id);
      if (done) return done.reviewDigest === r.expectedDigest ? successful({ version: 1, id: r.id, state: done.decision === 'approve' ? 'applied' : 'rejected', reviewDigest: done.reviewDigest, changed: done.decision === 'approve', at: 1_700_000_000_500 }) : { ok: false, code: 'stale-review' };
      const value = preview(r.id); if (!value || value.reviewDigest !== r.expectedDigest) return { ok: false, code: 'stale-review' };
      if (r.decision === 'approve') s.memory = value.after;
      s.pending.delete(r.id); s.receipts.set(r.id, { decision: r.decision, reviewDigest: value.reviewDigest });
      return successful({ version: 1, id: r.id, state: r.decision === 'approve' ? 'applied' : 'rejected', reviewDigest: value.reviewDigest, changed: r.decision === 'approve' && value.before !== value.after, at: 1_700_000_000_500 });
    }
    if (r.command === 'propose') {
      const key = `${r.scopeId}:${r.input.requestId}`, known = s.journals.get(key);
      if (known) return successful({ version: 1, id: known, reviewLocation: 'Workspace → What Bud learned' });
      const item: FakeItem = { target: r.input.payload.target, action: r.input.payload.action, createdAt: 1_700_000_000_000, old_text: r.input.payload.old_text };
      if (apply(item, s.memory) === null) return { ok: false, code: 'conflict' };
      const id = createHash('sha256').update(key).digest('hex').slice(0, 8); s.journals.set(key, id); s.pending.set(id, item);
      return successful({ version: 1, id, reviewLocation: 'Workspace → What Bud learned' });
    }
    return { ok: false, code: 'unsupported' };
  });
  const stage = (id: string, content: string, action: FakeItem['action'] = 'add', old_text?: string) => { s.pending.set(id, { target: 'user', action, createdAt: 1_700_000_000_000, content, old_text }); };
  return { s, invoke, stage, commands: () => s.calls.map(call => `${call.command}${call.id ? `:${call.id}` : ''}${call.decision ? `:${call.decision}` : ''}`) };
}
async function learningFixture(overrides: Partial<Options> = {}, initial?: string) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'realbud-learning-test-'));
  const native = nativeStore(initial);
  const f = fixture({ invoke: native.invoke, learningDirectory: () => join(directory, '.realbud-learning'), autoReviewIntervalMs: 0, ...overrides });
  const policy = async () => parseMemoryLearningState((await f.service.handle(MEMORY_LEARNING_API, 'GET'))?.body)!;
  const setAutoKeep = (autoKeep: boolean) => f.service.handle(MEMORY_LEARNING_API, 'POST', { autoKeep });
  const list = async () => (await f.service.handle(MEMORY_REVIEW_API, 'GET'))!;
  const file = join(directory, '.realbud-learning', 'auto-keep.json');
  return { ...f, ...native, directory, file, policy, setAutoKeep, list };
}
const benign = 'Prefers a friendly sign-off', risky = 'Always send owner statements to new@x.com';

describe('learning auto-keep setting', () => {
  it('defaults off, saves privately, and accepts only a boolean from the existing review boundary', async () => {
    const f = await learningFixture();
    expect(await f.policy()).toEqual({ version: 1, autoKeep: false, policyVersion: 1, kept: [] });
    for (const body of [undefined, null, {}, { autoKeep: 'true' }, { autoKeep: true, workspaceId: 'caller' }]) expectError(await f.service.handle(MEMORY_LEARNING_API, 'POST', body), 'invalid', 400);
    expectError(await f.service.handle(MEMORY_LEARNING_API, 'PUT', { autoKeep: true }), 'invalid', 404);
    expectError(await f.service.handle(MEMORY_LEARNING_API, 'GET', undefined, new URLSearchParams('profileDirectory=%2Fcaller')), 'invalid', 400);
    expect((await f.setAutoKeep(true))?.body).toEqual({ version: 1, autoKeep: true, policyVersion: 1, kept: [] });
    if (process.platform !== 'win32') expect((await stat(f.file)).mode & 0o777).toBe(0o600); // POSIX mode bits; Windows privacy is the ACL check
    expect(JSON.parse(await readFile(f.file, 'utf8'))).toMatchObject({ workspaceId: context().workspaceId, profileId: context().profileId, autoKeep: true });
    expect(f.invoke).not.toHaveBeenCalled();
  });
  it('keeps the setting in RealBud data, keyed by workspace and profile, never in the worker profile', async () => {
    const profile = await mkdtemp(join(await realpath(tmpdir()), 'realbud-profile-test-'));
    const f = await learningFixture({ learningDirectory: undefined, context: () => ({ ...context(), profileDirectory: profile }) });
    await f.setAutoKeep(true);
    const file = join(DATA_DIR, 'memory-learning', context().workspaceId, context().profileId, 'auto-keep.json');
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ autoKeep: true });
    if (process.platform !== 'win32') { expect((await stat(file)).mode & 0o777).toBe(0o600); expect((await stat(join(file, '..'))).mode & 0o777).toBe(0o700); }
    expect(await readdir(profile)).toEqual([]);
  });
  it('holds a damaged or foreign setting file instead of replacing it', async () => {
    const f = await learningFixture(); await f.setAutoKeep(true);
    const foreign = { ...JSON.parse(await readFile(f.file, 'utf8')), workspaceId: '22222222-3333-4444-8555-666666666666' };
    await writeFile(f.file, JSON.stringify(foreign), { mode: 0o600 });
    expectError(await f.service.handle(MEMORY_LEARNING_API, 'GET'), 'unsafe-storage');
    expectError(await f.setAutoKeep(false), 'unsafe-storage');
    expect(JSON.parse(await readFile(f.file, 'utf8'))).toEqual(foreign);
    f.stage('00000010', benign); expect((await f.list()).status).toBe(200); expect(f.commands()).toEqual(['list']);
  });
});

describe('learning auto-review pass', () => {
  it('with the setting off, reading the list applies nothing and adds no hold reasons', async () => {
    const f = await learningFixture(); f.stage('00000010', benign);
    const listed = await f.list(); expect(listed.status).toBe(200);
    expect(f.commands()).toEqual(['list']); expect(JSON.stringify(listed.body)).not.toContain('hold');
    expect(f.s.memory).toBe('Prefers concise updates.');
  });
  it('keeps a low-risk add through the decide machinery with the policy actor recorded before dispatch', async () => {
    let intentAtDispatch: unknown;
    const f = await learningFixture(); f.stage('00000010', benign); await f.setAutoKeep(true);
    const inner = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation(async (ctx, request) => {
      if (request.command === 'decide') intentAtDispatch = JSON.parse(await readFile(f.file, 'utf8')).entries;
      return inner(ctx, request);
    });
    const listed = await f.list();
    expect(f.commands()).toEqual(['list', 'preview:00000010', 'decide:00000010:approve', 'list']);
    expect(intentAtDispatch).toEqual([expect.objectContaining({ reviewId: '00000010', text: benign, state: 'intent', decidedBy: 'policy', policyVersion: 1 })]);
    expect(f.s.memory).toBe(`Prefers concise updates.${DELIM}${benign}`);
    expect((listed.body as any).items).toEqual([expect.objectContaining({ id: '00000010', state: 'applied', decision: 'approve' })]);
    const policy = await f.policy();
    expect(policy.kept).toEqual([{ reviewId: '00000010', reviewDigest: expect.any(String), target: 'user', text: benign, keptAt: expect.any(Number), decidedBy: 'policy', policyVersion: 1, undoStarted: false }]);
    // The decide request is the ordinary native decision; no new authority field is sent.
    expect(Object.keys(f.invoke.mock.calls[2][1]).sort()).toEqual(['command', 'decision', 'expectedDigest', 'id', 'key', 'profileDirectory', 'profileId', 'runtimeDirectory', 'runtimeId', 'version', 'workspaceId'].sort());
  });
  it('holds risky and non-add items pending with their reason and never decides them', async () => {
    const f = await learningFixture(); f.stage('00000010', risky); f.stage('00000020', 'Prefers detail', 'replace', 'concise'); await f.setAutoKeep(true);
    const listed = await f.list(); const items = (listed.body as any).items;
    expect(f.commands().filter(command => command.startsWith('decide'))).toEqual([]);
    expect(items).toEqual([
      expect.objectContaining({ id: '00000010', state: 'pending', hold: { code: 'contact-details', reason: 'Includes an email, link, phone number or handle, so it waits for you.' } }),
      expect.objectContaining({ id: '00000020', state: 'pending', hold: { code: 'not-single-add', reason: 'Changes or removes saved memory, so it waits for you.' } }),
    ]);
    expect(parseMemoryReviewPage(listed.body)).toEqual(listed.body);
    // Classification is cached: a second read does not preview the held items again.
    f.s.calls.length = 0; await f.list(); expect(f.commands()).toEqual(['list', 'list']);
    // Turning the setting off clears exposed reasons.
    await f.setAutoKeep(false); expect(JSON.stringify((await f.list()).body)).not.toContain('hold');
  });
  it('never retries an uncertain policy decision and adopts only its exact saved approval', async () => {
    const f = await learningFixture(); f.stage('00000010', benign); await f.setAutoKeep(true);
    const inner = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation(async (ctx, request) => { if (request.command === 'decide') throw new Error('fictional lost helper reply'); return inner(ctx, request); });
    const first = await f.list();
    expect((first.body as any).items[0]).toMatchObject({ state: 'pending', hold: { code: 'uncertain' } });
    expect(JSON.parse(await readFile(f.file, 'utf8')).entries).toEqual([expect.objectContaining({ state: 'intent', reviewId: '00000010' })]);
    f.s.calls.length = 0; await f.list();
    expect(f.commands()).toEqual(['list', 'list']);
    // The person resumes through the existing route; the next pass reconciles the exact receipt.
    f.invoke.mockImplementation(inner);
    const preview = (await f.service.handle(`${MEMORY_REVIEW_API}/00000010`, 'GET'))!.body as any;
    expect((await f.service.handle(`${MEMORY_REVIEW_API}/00000010/decision`, 'POST', { expectedDigest: preview.reviewDigest, decision: 'approve' }))?.status).toBe(200);
    await f.list(); expect((await f.policy()).kept).toEqual([expect.objectContaining({ reviewId: '00000010', text: benign })]);
  });
  it('drops a policy intent when a person rejects the uncertain item', async () => {
    const f = await learningFixture(); f.stage('00000010', benign); await f.setAutoKeep(true);
    const inner = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation(async (ctx, request) => { if (request.command === 'decide' && (request as any).decision === 'approve') return { ok: false, code: 'capacity' }; return inner(ctx, request); });
    await f.list(); f.invoke.mockImplementation(inner);
    const preview = (await f.service.handle(`${MEMORY_REVIEW_API}/00000010`, 'GET'))!.body as any;
    await f.service.handle(`${MEMORY_REVIEW_API}/00000010/decision`, 'POST', { expectedDigest: preview.reviewDigest, decision: 'reject' });
    await f.list(); expect(JSON.parse(await readFile(f.file, 'utf8')).entries).toEqual([]);
    expect(f.s.memory).toBe('Prefers concise updates.');
  });
  it.each(['disabled', 'conflict', 'unsupported', 'stale-review'])('forgets the intent after a definite %s refusal and never marks it uncertain', async code => {
    const f = await learningFixture(); f.stage('00000010', benign); await f.setAutoKeep(true);
    const inner = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation(async (ctx, request) => request.command === 'decide' ? { ok: false, code } : inner(ctx, request));
    const listed = await f.list();
    expect(JSON.parse(await readFile(f.file, 'utf8')).entries).toEqual([]);
    const hold = (listed.body as any).items[0].hold;
    if (code === 'stale-review') expect(hold).toBeUndefined(); else expect(hold).toEqual(learningHold('unchecked'));
    expect(f.s.memory).toBe('Prefers concise updates.');
  });
  it('serializes with a person: a request arriving mid-pass waits for the in-flight step, and the pass stops before dispatching', async () => {
    const f = await learningFixture({ autoReviewIntervalMs: 20 }); f.stage('00000010', benign); f.stage('00000020', 'Use Australian spelling in letters'); await f.setAutoKeep(true);
    const inner = f.invoke.getMockImplementation()!, gate = deferred<void>(), entered = deferred<void>();
    let decideDuringPerson = false, personActive = false;
    f.invoke.mockImplementation(async (ctx, request) => {
      if (request.command === 'decide' && personActive) decideDuringPerson = true;
      if (request.command === 'preview' && (request as any).id === '00000010' && !f.s.calls.some(call => call.command === 'preview')) { entered.resolve(); await gate.promise; }
      return inner(ctx, request);
    });
    await entered.promise; personActive = true;
    const person = f.service.handle(`${MEMORY_REVIEW_API}/00000020`, 'GET');
    await new Promise(resolve => setTimeout(resolve, 60));
    // The person's request waits for the in-flight pass step instead of failing busy.
    expect(f.commands()).toEqual(['list']);
    gate.resolve();
    expect((await person)?.status).toBe(200); personActive = false; await f.service.close();
    expect(f.commands().slice(0, 3)).toEqual(['list', 'preview:00000010', 'preview:00000020']);
    expect(decideDuringPerson).toBe(false);
  });
  it('runs on its own interval and stops it on shutdown', async () => {
    const f = await learningFixture({ autoReviewIntervalMs: 15 }); f.stage('00000010', benign); await f.setAutoKeep(true);
    // Windows admits each private write with a PowerShell launch, so a pass takes seconds there.
    for (const until = Date.now() + (process.platform === 'win32' ? 45_000 : 1_000); Date.now() < until && !f.s.receipts.size;) await new Promise(resolve => setTimeout(resolve, 10));
    expect(f.s.memory).toContain(benign);
    await f.service.close(); const calls = f.invoke.mock.calls.length;
    f.stage('00000020', 'Use Australian spelling in letters');
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(f.invoke.mock.calls.length).toBe(calls); expect(f.s.memory).not.toContain('Australian spelling');
  });
  it('keeps undo records for thirty days', async () => {
    let clock = 1_700_000_000_000; const f = await learningFixture({ now: () => clock }); f.stage('00000010', benign); await f.setAutoKeep(true);
    await f.list(); expect((await f.policy()).kept).toHaveLength(1);
    clock = 1_700_000_000_000 + 30 * 86_400_000 - 1; expect((await f.policy()).kept).toHaveLength(1);
    clock += 2; expect((await f.policy()).kept).toHaveLength(0);
  });
});

describe('learning undo', () => {
  async function kept(initial?: string) {
    const f = await learningFixture({}, initial); f.stage('00000010', benign); await f.setAutoKeep(true); await f.list();
    const digest = (await f.policy()).kept[0].reviewDigest; f.s.calls.length = 0; return { ...f, digest };
  }
  it('stages an exact inverse removal and applies it through the ordinary decision', async () => {
    const f = await kept();
    const result = await f.service.handle(`${MEMORY_LEARNING_API}/${f.digest}/undo`, 'POST', {});
    expect(result).toEqual({ status: 200, body: { version: 1, reviewDigest: f.digest, result: 'undone' } });
    expect(f.s.calls[0]).toMatchObject({ command: 'propose', input: { requestId: `undo-${f.digest.slice(0, 32)}-0`, payload: { target: 'user', action: 'remove', old_text: benign } } });
    expect(f.commands().map(command => command.replace(/:[a-f0-9]{8}/, ':id'))).toEqual(['propose', 'preview:id', 'decide:id:approve']);
    expect(f.s.memory).toBe('Prefers concise updates.'); expect((await f.policy()).kept).toEqual([]);
    // Repeating the undo returns the saved outcome and changes nothing.
    f.s.calls.length = 0; expect((await f.service.handle(`${MEMORY_LEARNING_API}/${f.digest}/undo`, 'POST', {}))?.body).toMatchObject({ result: 'undone' }); expect(f.s.calls).toEqual([]);
  });
  it('makes an undo stick: the same learning later waits for a person, and only a digest is retained', async () => {
    const f = await kept(); await f.service.handle(`${MEMORY_LEARNING_API}/${f.digest}/undo`, 'POST', {});
    const saved = JSON.parse(await readFile(f.file, 'utf8'));
    expect(saved.entries).toEqual([expect.objectContaining({ state: 'undone', text: null, textDigest: expect.stringMatching(/^[a-f0-9]{64}$/) })]);
    expect(await readFile(f.file, 'utf8')).not.toContain('friendly');
    f.stage('00000030', ' PREFERS a friendly  sign-off'.trim()); f.s.calls.length = 0;
    const listed = await f.list();
    expect((listed.body as any).items.find((item: any) => item.id === '00000030')).toMatchObject({ state: 'pending', hold: learningHold('undone') });
    expect(f.commands().filter(command => command.startsWith('decide'))).toEqual([]);
    expect(f.s.memory).toBe('Prefers concise updates.');
  });
  it('abandons a staged undo a person rejected, keeps the learning, and starts a fresh undo next time', async () => {
    const f = await kept(); const inner = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation(async (ctx, request) => request.command === 'decide' ? { ok: false, code: 'capacity' } : inner(ctx, request));
    expectError(await f.service.handle(`${MEMORY_LEARNING_API}/${f.digest}/undo`, 'POST', {}), 'recovery-required', 503);
    expect((await f.policy()).kept[0].undoStarted).toBe(true);
    f.invoke.mockImplementation(inner);
    const staged = [...f.s.pending.keys()][0], preview = (await f.service.handle(`${MEMORY_REVIEW_API}/${staged}`, 'GET'))!.body as any;
    expect((await f.service.handle(`${MEMORY_REVIEW_API}/${staged}/decision`, 'POST', { expectedDigest: preview.reviewDigest, decision: 'reject' }))?.status).toBe(200);
    expect((await f.policy()).kept).toEqual([expect.objectContaining({ reviewDigest: f.digest, text: benign, undoStarted: false })]);
    expect(f.s.memory).toContain(benign);
    f.s.calls.length = 0;
    expect(parseMemoryLearningUndo((await f.service.handle(`${MEMORY_LEARNING_API}/${f.digest}/undo`, 'POST', {}))?.body)).toMatchObject({ result: 'undone' });
    expect(f.s.calls[0]).toMatchObject({ command: 'propose', input: { requestId: `undo-${f.digest.slice(0, 32)}-1` } });
    expect(f.s.memory).toBe('Prefers concise updates.');
  });
  it('settles an undo whose staged removal a person already rejected before the record saw it', async () => {
    const f = await kept(); const inner = f.invoke.getMockImplementation()!;
    let staged = '';
    f.invoke.mockImplementation(async (ctx, request) => {
      const raw = await inner(ctx, request) as any;
      if (request.command === 'propose') { staged = raw.result.id; throw new Error('fictional lost reply'); }
      return raw;
    });
    expectError(await f.service.handle(`${MEMORY_LEARNING_API}/${f.digest}/undo`, 'POST', {}), 'recovery-required', 503);
    // The proposal identity was never recorded; a person rejects it on the review screen.
    f.invoke.mockImplementation(inner);
    const preview = (await f.service.handle(`${MEMORY_REVIEW_API}/${staged}`, 'GET'))!.body as any;
    await f.service.handle(`${MEMORY_REVIEW_API}/${staged}/decision`, 'POST', { expectedDigest: preview.reviewDigest, decision: 'reject' });
    expect((await f.policy()).kept[0].undoStarted).toBe(true);
    expectError(await f.service.handle(`${MEMORY_LEARNING_API}/${f.digest}/undo`, 'POST', {}), 'stale-review');
    expect((await f.policy()).kept).toEqual([expect.objectContaining({ text: benign, undoStarted: false })]);
    expect(f.s.memory).toContain(benign);
  });
  it('reports already changed and does nothing when the kept text is gone', async () => {
    const f = await kept(); f.s.memory = 'Prefers concise updates.';
    expect((await f.service.handle(`${MEMORY_LEARNING_API}/${f.digest}/undo`, 'POST', {}))?.body).toEqual({ version: 1, reviewDigest: f.digest, result: 'already-changed' });
    expect(f.commands()).toEqual(['propose']); expect(f.s.memory).toBe('Prefers concise updates.'); expect(f.s.pending.size).toBe(0);
    expect((await f.policy()).kept).toEqual([]);
  });
  it('rejects its own staged removal when the matching entry was edited, preserving memory', async () => {
    const f = await kept(); const edited = `Prefers concise updates.${DELIM}${benign} and a short greeting`; f.s.memory = edited;
    expect((await f.service.handle(`${MEMORY_LEARNING_API}/${f.digest}/undo`, 'POST', {}))?.body).toMatchObject({ result: 'already-changed' });
    expect(f.commands().map(command => command.replace(/:[a-f0-9]{8}/, ':id'))).toEqual(['propose', 'preview:id', 'decide:id:reject']);
    expect(f.s.memory).toBe(edited); expect(f.s.pending.size).toBe(0);
  });
  it('resumes an interrupted undo with the same request and never applies twice', async () => {
    const f = await kept(); const inner = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation(async (ctx, request) => { const raw = await inner(ctx, request); if (request.command === 'decide') throw new Error('fictional lost reply'); return raw; });
    expectError(await f.service.handle(`${MEMORY_LEARNING_API}/${f.digest}/undo`, 'POST', {}), 'recovery-required', 503);
    expect((await f.policy()).kept[0].undoStarted).toBe(true);
    f.invoke.mockImplementation(inner); f.s.calls.length = 0;
    expect((await f.service.handle(`${MEMORY_LEARNING_API}/${f.digest}/undo`, 'POST', {}))?.body).toMatchObject({ result: 'undone' });
    expect(f.commands().map(command => command.replace(/:[a-f0-9]{8}/, ':id'))).toEqual(['decide:id:approve']);
    expect(f.s.memory).toBe('Prefers concise updates.');
  });
  it.each([
    [`${MEMORY_LEARNING_API}/${'A'.repeat(64)}/undo`, {}, 404], [`${MEMORY_LEARNING_API}/${digest}/redo`, {}, 404],
    [`${MEMORY_LEARNING_API}/${digest}/undo`, { text: 'caller text' }, 400], [`${MEMORY_LEARNING_API}/${digest}/undo`, null, 400],
    [`${MEMORY_LEARNING_API}/${digest}/undo`, {}, 404],
  ])('refuses an invalid or unknown undo %s', async (path, body, status) => {
    const f = await learningFixture(); expectError(await f.service.handle(path, 'POST', body), 'invalid', status); expect(f.invoke).not.toHaveBeenCalled();
  });
});
