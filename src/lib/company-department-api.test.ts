import { describe, expect, it, vi } from 'vitest';
vi.mock('@/state/store', () => ({ api: vi.fn() }));
import { createCompanyApi } from './company-api';

const item = { id: 'case-id', title: 'Synthetic task', description: '', assignee: null, needsAssignment: true, canAssign: false, canClose: false, lastClosure: null, status: 'recovery_required', fence: '2', holder: { id: 'member-id', displayName: 'Alex', active: true }, leaseExpiresAt: null, createdAt: '2026-09-21T00:00:00.000Z', needsReview: true, lastRecovery: null };
const page = { department: { id: 'department-id', name: 'Operations', revision: '1', access: 'read', retiredAt: null, retiredBy: null, retirementNote: '', unresolvedCases: 1 }, cases: [item], offset: 0, hasMore: false, filter: 'needs-review', canRecover: false, canCreate: false };
const request = { departmentId: 'department-id', caseId: 'case-id', expectedFence: '2', requestId: 'request-id', resolution: 'done' as const, note: 'Confirmed outcome.' };

describe('department recovery client boundary', () => {
  it('sends explicit scope, filter, page and unchanged recovery identity', async () => {
    const transport = vi.fn().mockResolvedValueOnce(page).mockResolvedValueOnce({ item, receiptId: request.requestId, replayed: false }).mockResolvedValueOnce({ ok: true });
    const api = createCompanyApi(transport);
    expect(await api.departmentCases('department-id')).toEqual(page);
    expect(JSON.parse(transport.mock.calls[0][1].body)).toEqual({ departmentId: 'department-id', offset: 0, filter: 'needs-review' });
    expect(await api.recoverDepartmentCase(request)).toMatchObject({ receiptId: request.requestId });
    expect(JSON.parse(transport.mock.calls[1][1].body)).toEqual(request);
  });
  it.each([
    { department: { ...page.department, id: 'foreign-department' } },
    { offset: 20 }, { filter: 'all' }, { cases: Array(21).fill(item) },
    { cases: [{ ...item, fence: '-1' }] }, { cases: [{ ...item, status: 'unknown' }] },
    { cases: [{ ...item, holder: { id: 'one' } }] }, { cases: [{ ...item, leaseExpiresAt: 'not-a-date' }] },
    { cases: [{ ...item, lastRecovery: { resolution: 'erase' } }] },
  ])('rejects an incomplete, foreign or incorrectly paged response %j', async patch => {
    await expect(createCompanyApi(vi.fn().mockResolvedValue({ ...page, ...patch })).departmentCases('department-id')).rejects.toThrow('incomplete response');
  });
  it.each([{ receiptId: 'another-request' }, { item: { ...item, id: 'another-case' } }, { replayed: undefined }])('rejects the wrong recovery receipt %j', async patch => {
    await expect(createCompanyApi(vi.fn().mockResolvedValue({ item, receiptId: request.requestId, replayed: false, ...patch })).recoverDepartmentCase(request)).rejects.toThrow('incomplete response');
  });
  it('explains live claims and departure resolution without leaking backend details', async () => {
    const transport = vi.fn().mockRejectedValueOnce({ status: 409, code: 'claim_busy', message: 'private DB detail' }).mockRejectedValueOnce({ status: 409, code: 'work_resolution_required' });
    const api = createCompanyApi(transport);
    await expect(api.recoverDepartmentCase(request)).rejects.toThrow('active claim');
    await expect(api.leaveOffice()).rejects.toThrow('Departments and access');
  });
});
