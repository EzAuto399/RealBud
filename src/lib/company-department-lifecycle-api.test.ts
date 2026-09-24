import { describe, expect, it, vi } from 'vitest';
vi.mock('@/state/store', () => ({ api: vi.fn() }));
import { createCompanyApi, departmentMutationUncertain } from './company-api';

const departmentId = 'a0000000-0000-4000-8000-000000000001', caseId = 'b0000000-0000-4000-8000-000000000002', requestId = 'c0000000-0000-4000-8000-000000000003';
const department = { id: departmentId, name: 'Operations', revision: '2', access: 'write', retiredAt: null, retiredBy: null, retirementNote: '', unresolvedCases: 1 };
const item = { id: caseId, title: 'Fictional task', description: 'A synthetic note', status: 'open', fence: '3', assignee: null, needsAssignment: true, canAssign: true, canClose: true, holder: null, leaseExpiresAt: null, createdAt: '2026-09-21T00:00:00Z', needsReview: false, lastRecovery: null, lastClosure: null };
const create = { departmentId, requestId, title: 'Fictional task', description: 'A synthetic note', assigneeMemberId: null };
const assign = { departmentId, requestId, caseId, expectedFence: '3', assigneeMemberId: null };
const close = { departmentId, requestId, caseId, expectedFence: '3', resolution: 'done' as const, note: 'Human checked result.' };
const retire = { departmentId, requestId, expectedRevision: '2', retired: true, note: 'Fictional department has finished.' };

describe('department lifecycle receipt and retry boundary', () => {
  it('keeps department notifications per client, supports cleanup, and contains refresh failures', () => {
    const api = createCompanyApi(vi.fn()), other = createCompanyApi(vi.fn()), refreshed = vi.fn();
    api.subscribeDepartmentChanges(() => { throw new Error('view unmounted'); });
    const stop = api.subscribeDepartmentChanges(refreshed);
    other.notifyDepartmentChange(); expect(refreshed).not.toHaveBeenCalled();
    expect(() => api.notifyDepartmentChange()).not.toThrow(); expect(refreshed).toHaveBeenCalledTimes(1);
    stop(); api.notifyDepartmentChange(); expect(refreshed).toHaveBeenCalledTimes(1);
  });
  it.each(['success', 'unknown', 'ack-failed', 'malformed'] as const)('refreshes saved state exactly once after %s mutation outcome', async outcome => {
    const transport = outcome === 'unknown' ? vi.fn().mockRejectedValue(new Error('uncertain'))
      : vi.fn().mockResolvedValueOnce(outcome === 'malformed' ? {} : { item, receiptId: requestId, replayed: false });
    if (outcome === 'ack-failed') transport.mockRejectedValueOnce(new Error('ack unknown'));
    else if (outcome !== 'unknown') transport.mockResolvedValueOnce({ ok: true });
    const api = createCompanyApi(transport), refreshed = vi.fn(); api.subscribeDepartmentChanges(refreshed);
    await api.assignDepartmentCase(assign).catch(() => {});
    expect(refreshed).toHaveBeenCalledTimes(1); expect(refreshed.mock.calls[0]).toEqual([]);
  });
  it.each([true, false])('refreshes after direct acknowledgement regardless of success (%s)', async success => {
    const api = createCompanyApi(success ? vi.fn().mockResolvedValue({ ok: true }) : vi.fn().mockRejectedValue(new Error('lost acknowledgement')));
    const refreshed = vi.fn(); api.subscribeDepartmentChanges(refreshed);
    await api.acknowledgeDepartmentOperation(requestId).catch(() => {});
    expect(refreshed).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['createDepartmentCase', '/api/company/departments/cases/create', create, { item: { ...item, id: requestId } }],
    ['assignDepartmentCase', '/api/company/departments/cases/assign', assign, { item }],
    ['closeDepartmentCase', '/api/company/departments/cases/close', close, { item: { ...item, status: 'done' } }],
    ['closeDepartmentCase', '/api/company/departments/cases/close', { ...close, resolution: 'cancelled' }, { item: { ...item, status: 'cancelled' } }],
    ['setDepartmentLifecycle', '/api/company/departments/lifecycle', retire, { department: { ...department, retiredAt: '2026-09-21T01:00:00Z' } }],
    ['setDepartmentLifecycle', '/api/company/departments/lifecycle', { ...retire, retired: false, note: 'Reviewed access before reopening.' }, { department }],
  ] as const)('validates %s then acknowledges exactly that request', async (method, path, input, body) => {
    const response = { ...body, receiptId: requestId, replayed: false };
    const transport = vi.fn().mockResolvedValueOnce(response).mockResolvedValueOnce({ ok: true });
    const api = createCompanyApi(transport);
    await expect((api[method] as (value: unknown) => Promise<unknown>)(input)).resolves.toEqual(response);
    expect(transport.mock.calls.map(call => call[0])).toEqual([path, '/api/company/department-outbox/ack']);
    expect(JSON.parse(transport.mock.calls[0][1].body)).toEqual(input);
    expect(JSON.parse(transport.mock.calls[1][1].body)).toEqual({ requestId });
  });
  it.each([
    { item: { ...item, id: caseId }, receiptId: requestId, replayed: false },
    { item: { ...item, id: requestId }, receiptId: caseId, replayed: false },
    { item: { ...item, id: requestId, canAssign: undefined }, receiptId: requestId, replayed: false },
  ])('does not retire the local journal for a malformed or mismatched creation receipt', async response => {
    const transport = vi.fn().mockResolvedValue(response);
    await expect(createCompanyApi(transport).createDepartmentCase(create)).rejects.toThrow('incomplete response');
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('retains uncertainty when acknowledgement is lost and never automatically repeats the mutation', async () => {
    const transport = vi.fn().mockResolvedValueOnce({ item, receiptId: requestId, replayed: false }).mockRejectedValueOnce(new Error('lost response'));
    await expect(createCompanyApi(transport).assignDepartmentCase(assign)).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it('rejects malformed acknowledgement rather than claiming the saved journal was cleared', async () => {
    await expect(createCompanyApi(vi.fn().mockResolvedValue({ ok: false })).acknowledgeDepartmentOperation(requestId)).rejects.toThrow('incomplete response');
  });
  it.each(['pending', 'confirmed'] as const)('reads an encrypted-journal projection in %s phase without sending a mutation', async phase => {
    const state = { pending: { phase, path: '/api/company/departments/cases/create', input: create }, otherOfficePending: false };
    const transport = vi.fn().mockResolvedValue(state);
    expect(await createCompanyApi(transport).pendingDepartmentOperation()).toEqual(state);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][1]).not.toHaveProperty('body');
  });
  it.each([
    { phase: 'complete', path: '/api/company/departments/cases/create', input: create },
    { phase: 'pending', path: '/api/company/members/revoke', input: create },
    { phase: 'pending', path: '/api/company/departments/cases/create', input: { ...create, extraAuthority: true } },
    { phase: 'pending', path: '/api/company/departments/cases/close', input: { ...close, expectedFence: '-1' } },
  ])('rejects unsupported saved requests before enabling resume', async pending => {
    await expect(createCompanyApi(vi.fn().mockResolvedValue({ pending, otherOfficePending: false })).pendingDepartmentOperation()).rejects.toThrow('incomplete response');
  });
  it('explicitly resumes only the same normalized input and acknowledges the resulting receipt', async () => {
    const response = { item: { ...item, id: requestId }, receiptId: requestId, replayed: true };
    const transport = vi.fn().mockResolvedValueOnce(response).mockResolvedValueOnce({ ok: true });
    await createCompanyApi(transport).resumeDepartmentOperation({ path: '/api/company/departments/cases/create', input: create });
    expect(JSON.parse(transport.mock.calls[0][1].body)).toEqual(create);
    expect(transport.mock.calls[1][0]).toBe('/api/company/department-outbox/ack');
  });
  it('rejects foreign/incorrectly paged assignee results', async () => {
    const transport = vi.fn().mockResolvedValue({ department: { ...department, id: caseId }, members: [], offset: 0, hasMore: false });
    await expect(createCompanyApi(transport).departmentAssignees(departmentId)).rejects.toThrow('incomplete response');
  });
  it('does not expose retired department write authority from an inconsistent response', async () => {
    const response = { department: { ...department, retiredAt: '2026-09-21T01:00:00Z' }, cases: [item], filter: 'all', offset: 0, hasMore: false, canCreate: true, canRecover: false };
    await expect(createCompanyApi(vi.fn().mockResolvedValue(response)).departmentCases(departmentId, 0, 'all')).rejects.toThrow('incomplete response');
  });
  it('distinguishes a definitive refusal from a timeout or unavailable host', () => {
    for (const status of [400, 401, 403, 404, 409, 410, 422]) expect(departmentMutationUncertain({ status })).toBe(false);
    for (const cause of [new Error('network'), { status: 429 }, { status: 500 }, { status: 503 }]) expect(departmentMutationUncertain(cause)).toBe(true);
  });
});
