import { describe, expect, it, vi } from 'vitest';
import { createHermesMemoryReviewService, MEMORY_REVIEW_RUNTIME, type MemoryReviewContext } from './hermes-memory-review.ts';
import { currentWorkerProfile, withWorkerProfile } from './hermes-profile.ts';
import { MEMORY_REVIEW_API } from '../shared/hermes-memory-review.ts';
import { MEMORY_PROPOSAL_REVIEW_LOCATION, type MemoryProposalInput } from '../shared/hermes-memory-proposal.ts';

const input: MemoryProposalInput = { requestId: 'preference-1', payload: { target: 'memory', action: 'replace', old_text: 'Concise updates.', content: 'Detailed updates.' } };
const result = { version: 1, id: '1234abcd', reviewLocation: MEMORY_PROPOSAL_REVIEW_LOCATION };
const context = (): MemoryReviewContext => ({ profileDirectory: `/fictional/profiles/${currentWorkerProfile().profile}`, profileId: currentWorkerProfile().profile,
  runtimeDirectory: '/fictional/runtime/hermes-agent', runtimeId: MEMORY_REVIEW_RUNTIME,
  python: '/fictional/runtime/hermes-agent/venv/bin/python', workspaceId: '11111111-2222-4333-8444-555555555555' });
function deferred<T = unknown>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
type Options = Parameters<typeof createHermesMemoryReviewService>[0];
function fixture(patch: Partial<Options> = {}) {
  const invoke = vi.fn<NonNullable<Options['invoke']>>(async () => ({ ok: true, result }));
  const validateRuntime = vi.fn(async () => {});
  const service = createHermesMemoryReviewService({ context, key: () => Buffer.alloc(32, 19), validateRuntime, invoke, ...patch });
  return { service, invoke, validateRuntime };
}
const signal = () => new AbortController().signal;

describe.skipIf(process.platform === 'win32')('host-owned typed memory proposal integration', () => {
  it('captures the member scope and exposes only an opaque scope and proposal callback', async () => {
    const f = fixture();
    const integration = withWorkerProfile('fictional-member-a', () => f.service.proposalIntegration('chat-one', () => true))!;
    expect(Object.keys(integration).sort()).toEqual(['propose', 'scope']); expect(integration.scope).toMatch(/^[a-f0-9]{64}$/);
    const response = await withWorkerProfile('fictional-member-b', () => integration.propose(input, signal()));
    expect(response).toEqual(result);
    const [captured, request] = f.invoke.mock.calls[0];
    expect(captured.profileId).toBe('property-fictional-member-a');
    expect(request).toMatchObject({ command: 'propose', scopeId: integration.scope, input, profileId: captured.profileId });
    expect(request).not.toHaveProperty('threadId'); expect(request).not.toHaveProperty('decision');
    expect(JSON.stringify(response)).not.toContain('fictional-member'); expect(response).not.toHaveProperty('reviewDigest');
    await f.service.close();
  });

  it('keeps retries in the same conversation binding and separates member, workspace and runtime changes', () => {
    let selected = context(); const f = fixture({ context: () => selected });
    const first = f.service.proposalIntegration('chat-one', () => true)!.scope;
    expect(f.service.proposalIntegration('chat-one', () => true)!.scope).toBe(first);
    expect(f.service.proposalIntegration('chat-two', () => true)!.scope).not.toBe(first);
    for (const patch of [{ profileId: 'property-other', profileDirectory: '/fictional/other' }, { runtimeId: `${MEMORY_REVIEW_RUNTIME}-different` }, { workspaceId: '22222222-3333-4444-8555-666666666666' }]) {
      selected = { ...context(), ...patch }; expect(f.service.proposalIntegration('chat-one', () => true)!.scope).not.toBe(first);
    }
  });

  it.each([
    { ...input, scopeId: 'caller-owned' }, { ...input, key: 'caller-key' }, { ...input, decision: 'approve' },
    { ...input, payload: { ...input.payload, profileDirectory: '/caller' } },
    { ...input, payload: { target: 'memory', action: 'add', content: 'ak_' + 'a'.repeat(32) } },
  ])('refuses injected authority or credentials before runtime/helper admission %#', async raw => {
    const f = fixture(); const integration = f.service.proposalIntegration('chat', () => true)!;
    await expect(integration.propose(raw as MemoryProposalInput, signal())).rejects.toMatchObject({ code: Object.hasOwn(raw.payload, 'content') && String((raw.payload as { content?: string }).content).startsWith('ak_') ? 'blocked-content' : 'invalid' });
    expect(f.validateRuntime).not.toHaveBeenCalled(); expect(f.invoke).not.toHaveBeenCalled();
  });

  it('does not expose proposal creation through the renderer memory API', async () => {
    const f = fixture();
    expect(await f.service.handle(`${MEMORY_REVIEW_API}/propose`, 'POST', input)).toMatchObject({ status: 404, body: { code: 'invalid' } });
    expect(await f.service.handle(MEMORY_REVIEW_API, 'POST', input)).toMatchObject({ status: 404 });
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it('rechecks captured authority after asynchronous runtime admission before writing a proposal', async () => {
    const admitted = deferred<void>(), validation = deferred<void>(); let current = true;
    const f = fixture({ validateRuntime: async () => { admitted.resolve(); await validation.promise; } });
    const integration = f.service.proposalIntegration('chat', () => current)!;
    const pending = integration.propose(input, signal()); await admitted.promise; current = false; validation.resolve();
    await expect(pending).rejects.toMatchObject({ code: 'stale-review' }); expect(f.invoke).not.toHaveBeenCalled();
  });

  it('refuses a changed context before helper dispatch even when the owner remains active', async () => {
    let selected = context(); const f = fixture({ context: () => selected });
    const integration = f.service.proposalIntegration('chat', () => true)!;
    selected = { ...selected, workspaceId: '22222222-3333-4444-8555-666666666666' };
    await expect(integration.propose(input, signal())).rejects.toMatchObject({ code: 'stale-review' }); expect(f.invoke).not.toHaveBeenCalled();
  });

  it('does not report success after authority changes during an in-flight publication', async () => {
    const entered = deferred<void>(), response = deferred(); let current = true;
    const f = fixture({ invoke: async () => { entered.resolve(); return response.promise; } });
    const integration = f.service.proposalIntegration('chat', () => current)!;
    const pending = integration.propose(input, signal()); await entered.promise; current = false;
    response.resolve({ ok: true, result }); await expect(pending).rejects.toMatchObject({ code: 'recovery-required' });
  });

  it('passes cancellation to the owned helper and drains it before releasing the profile mutex', async () => {
    const entered = deferred<void>(), response = deferred(); let ownedSignal: AbortSignal | undefined;
    const f = fixture({ invoke: async (_context, _request, options) => { ownedSignal = options?.signal; entered.resolve(); return response.promise; } });
    const integration = f.service.proposalIntegration('chat', () => true)!; const controller = new AbortController();
    const pending = integration.propose(input, controller.signal); await entered.promise; controller.abort();
    expect(ownedSignal?.aborted).toBe(true);
    await expect(integration.propose(input, signal())).rejects.toMatchObject({ code: 'busy' });
    let closed = false; const closing = f.service.close().then(() => { closed = true; }); await Promise.resolve(); expect(closed).toBe(false);
    response.resolve({ ok: true, result }); await expect(pending).rejects.toMatchObject({ code: 'recovery-required' }); await closing;
    expect(closed).toBe(true); expect(f.service.proposalIntegration('chat', () => true)).toBeNull();
  });

  it('does not dispatch an already aborted proposal or one denied by workspace activity', async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort();
    await expect(f.service.proposalIntegration('chat', () => true)!.propose(input, controller.signal)).rejects.toMatchObject({ code: 'stale-review' });
    expect(f.invoke).not.toHaveBeenCalled();
    const held = fixture({ withActivity: async () => { throw new Error('held fictional workspace'); } });
    await expect(held.service.proposalIntegration('chat', () => true)!.propose(input, signal())).rejects.toThrow(); expect(held.invoke).not.toHaveBeenCalled();
  });

  it.each([null, { ...result, reviewDigest: 'a'.repeat(64) }, { ...result, reviewLocation: '/private/file' }, { ...result, id: 'bad' }])('holds malformed or overprivileged helper replies as uncertain %#', async value => {
    const f = fixture({ invoke: async () => ({ ok: true, result: value }) });
    await expect(f.service.proposalIntegration('chat', () => true)!.propose(input, signal())).rejects.toMatchObject({ code: 'recovery-required' });
  });
});
