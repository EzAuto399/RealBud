import { describe, expect, it, vi } from 'vitest';
vi.mock('@/state/store', () => ({ api: vi.fn() }));
import { createCompanyApi } from './company-api';

const department = { id: 'department-fixture', name: 'Accounts', revision: '2', access: 'write', retiredAt: null, retiredBy: null, retirementNote: '', unresolvedCases: 0 };
describe('department response boundaries', () => {
  it('checks pages and sends explicit revision-bound changes', async () => {
    const request = vi.fn().mockResolvedValueOnce({ departments: [department], offset: 0, hasMore: true, canManage: true })
      .mockResolvedValueOnce({ department, offset: 100, hasMore: false, members: [{ id: 'member-fixture', displayName: 'Alex', role: 'member', access: 'read' }] })
      .mockResolvedValueOnce({ department: { ...department, revision: '3' } });
    const api = createCompanyApi(request);
    expect((await api.departments()).hasMore).toBe(true);
    expect((await api.departmentAccess(department.id, 100)).members[0].access).toBe('read');
    await api.setDepartmentAccess({ departmentId: department.id, memberId: 'member-fixture', access: 'none', expectedRevision: '2' });
    expect(request.mock.calls[2][1]).toMatchObject({ method: 'PUT', body: JSON.stringify({ departmentId: department.id, memberId: 'member-fixture', access: 'none', expectedRevision: '2' }) });
  });
  it.each([
    { departments: [department], offset: 50, hasMore: false, canManage: true },
    { departments: [{ ...department, access: 'admin' }], offset: 0, hasMore: false, canManage: true },
    { departments: [department], offset: 0, hasMore: false },
  ])('rejects incomplete or wrong-page state', async response => {
    await expect(createCompanyApi(vi.fn().mockResolvedValue(response)).departments()).rejects.toThrow('incomplete response');
  });
  it('rejects cross-department permission responses', async () => {
    const api = createCompanyApi(vi.fn().mockResolvedValue({ department, offset: 0, hasMore: false, members: [] }));
    await expect(api.departmentAccess('another-department')).rejects.toThrow('incomplete response');
  });
});
