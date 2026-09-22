import { describe, expect, it, vi } from 'vitest';
import { createHermesMemoryReviewService, MEMORY_REVIEW_RUNTIME, type MemoryReviewContext } from './hermes-memory-review.ts';
import { MEMORY_RECOVERY_API, parseMemoryRecoveryPage, parseMemoryRecoveryClosure } from '../shared/hermes-memory-recovery.ts';
import { MEMORY_REVIEW_ERRORS } from '../shared/hermes-memory-review.ts';
import { isPrivilegedServiceMutation } from './service-admin.ts';

const key = '1'.repeat(64), digest = 'a'.repeat(64);
const row = () => ({ key, state: 'interrupted', createdAt: 1700000000000, closedAt: null, recoveryDigest: digest });
const page = () => ({ version: 1, items: [row()], nextCursor: null });
const closure = () => ({ version: 1, key, state: 'closed', closedAt: 1700000000001, recoveryDigest: digest });
const context = (): MemoryReviewContext => ({ profileDirectory: '/fictional/property-recovery', runtimeDirectory: '/fictional/hermes-agent', workspaceId: '11111111-2222-4333-8444-555555555555', profileId: 'property-recovery', runtimeId: MEMORY_REVIEW_RUNTIME, python: '/fictional/python' });
function fixture(value: unknown = page()) {
  const invoke = vi.fn<NonNullable<Parameters<typeof createHermesMemoryReviewService>[0]['invoke']>>(async () => ({ ok: true, result: value }));
  const service = createHermesMemoryReviewService({ context, key: () => Buffer.alloc(32, 7), validateRuntime: async () => {}, invoke });
  return { invoke, service };
}
const post = `${MEMORY_RECOVERY_API}/${key}/close`;

describe('interrupted memory proposal contract', () => {
  it('accepts only fixed metadata with consistent action eligibility and terminal state', () => {
    expect(parseMemoryRecoveryPage(page())).toEqual(page());
    expect(parseMemoryRecoveryPage({ ...page(), items: [{ ...row(), state: 'closed', closedAt: 1700000000001 }] })).not.toBeNull();
    expect(parseMemoryRecoveryPage({ ...page(), items: [{ ...row(), state: 'recovery-required', createdAt: null, recoveryDigest: null }] })).not.toBeNull();
    for (const fields of [{ content: 'private' }, { scopeId: key }, { state: 'interrupted', recoveryDigest: null }, { state: 'closed', closedAt: null }, { state: 'recovery-required' }, { key: 'abcdef12' }, { createdAt: 1.5 }]) {
      expect(parseMemoryRecoveryPage({ ...page(), items: [{ ...row(), ...fields }] })).toBeNull();
    }
    expect(parseMemoryRecoveryClosure(closure())).toEqual(closure());
    expect(parseMemoryRecoveryClosure({ ...closure(), changed: false })).toBeNull();
    expect(parseMemoryRecoveryClosure({ ...closure(), state: 'applied' })).toBeNull();
  });
  it('rejects repeated or reversed keys, fabricated cursors, and oversized pages', () => {
    const second = { ...row(), key: '2'.repeat(64) };
    for (const value of [{ ...page(), items: [row(), row()] }, { ...page(), items: [second, row()] }, { ...page(), nextCursor: second.key }, { ...page(), items: [], nextCursor: key }, { ...page(), items: Array(21).fill(row()) }]) expect(parseMemoryRecoveryPage(value)).toBeNull();
    expect(parseMemoryRecoveryPage({ ...page(), items: [row(), second], nextCursor: second.key })).not.toBeNull();
  });
});

describe('staff interrupted proposal boundary', () => {
  it('uses host identity for list and close and admits only exact request fields', async () => {
    const f = fixture();
    expect((await f.service.handle(MEMORY_RECOVERY_API, 'GET'))?.body).toEqual(page());
    expect(f.invoke.mock.calls[0][1]).toMatchObject({ command: 'interrupted-list', workspaceId: context().workspaceId, profileId: context().profileId });
    f.invoke.mockResolvedValue({ ok: true, result: closure() });
    expect(await f.service.handle(post, 'POST', { expectedDigest: digest })).toEqual({ status: 200, body: closure() });
    expect(f.invoke.mock.calls[1][1]).toMatchObject({ command: 'interrupted-close', proposalKey: key, expectedDigest: digest });
    for (const body of [{}, { expectedDigest: digest, decision: 'approve' }, { expectedDigest: digest, profileId: 'other' }, { expectedDigest: 'bad' }, { expectedDigest: digest, payload: {} }]) expect((await f.service.handle(post, 'POST', body))?.status).toBe(400);
    expect(f.invoke).toHaveBeenCalledTimes(2);
    await f.service.close();
  });
  it('validates cursor scope and rejects unsupported verbs and duplicate query authority', async () => {
    const f = fixture();
    for (const params of ['cursor=bad', `cursor=${key}&cursor=${key}`, 'profileId=other']) expect((await f.service.handle(MEMORY_RECOVERY_API, 'GET', undefined, new URLSearchParams(params)))?.status).toBe(400);
    expect((await f.service.handle(MEMORY_RECOVERY_API, 'GET', {}))?.status).toBe(400);
    for (const path of [`${MEMORY_RECOVERY_API}/abcdef12/close`, `${post}/other`, `${MEMORY_RECOVERY_API}/${key}/approve`]) expect((await f.service.handle(path, 'POST', { expectedDigest: digest }))?.status).toBe(404);
    expect((await f.service.handle(post, 'DELETE', { expectedDigest: digest }))?.status).toBe(404);
    expect(f.invoke).not.toHaveBeenCalled();
    expect((await f.service.handle(MEMORY_RECOVERY_API, 'GET', undefined, new URLSearchParams({ cursor: key })))?.status).toBe(503);
    await f.service.close();
  });
  it('requires matching terminal receipt and treats malformed or lost responses as uncertain', async () => {
    for (const value of [{ ...closure(), key: '2'.repeat(64) }, { ...closure(), recoveryDigest: 'b'.repeat(64) }, { ...closure(), state: 'interrupted' }, { privatePath: '/fictional/private' }]) {
      const f = fixture(value);
      expect((await f.service.handle(post, 'POST', { expectedDigest: digest }))?.body).toEqual({ code: 'recovery-required', error: MEMORY_REVIEW_ERRORS['recovery-required'] });
      await f.service.close();
    }
    const f = fixture(); f.invoke.mockRejectedValue(new Error('fictional private diagnostics'));
    expect((await f.service.handle(post, 'POST', { expectedDigest: digest }))?.body).toEqual({ code: 'recovery-required', error: MEMORY_REVIEW_ERRORS['recovery-required'] });
    await f.service.close();
  });
  it('does not broaden service administration exemptions or accept an MCP close capability', () => {
    expect(isPrivilegedServiceMutation(post, 'POST')).toBe(false);
    for (const path of [`${post}/extra`, `${MEMORY_RECOVERY_API}/${key}/approve`, '/api/hermes/provider', `${MEMORY_RECOVERY_API}/abcdef12/close`]) expect(isPrivilegedServiceMutation(path, 'POST')).toBe(true);
    expect(isPrivilegedServiceMutation(post, 'PUT')).toBe(true);
  });
});
