import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createHermesMemoryReviewService, memoryReviewChildEnvironment,
  MEMORY_REVIEW_RUNTIME, type MemoryReviewContext,
} from './hermes-memory-review.ts';
import {
  MEMORY_REVIEW_API, MEMORY_REVIEW_ERRORS,
  memoryReviewId, memoryReviewDigest,
  parseMemoryReviewPage, parseMemoryReviewPreview, parseMemoryReviewDecision,
  type MemoryReviewItem,
} from '../shared/hermes-memory-review.ts';

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
