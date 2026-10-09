import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { departmentConfigurationDrafts, type DepartmentDraftContext } from '@/lib/department-configuration-draft-journal';
vi.mock('@/state/store', () => ({ api: vi.fn() }));
vi.mock('@/lib/company-api', () => ({ companyApi: { sessionVersion: () => 1 }, departmentMutationUncertain: vi.fn() }));
import { CompanyDepartments } from './CompanyDepartments';
const context: DepartmentDraftContext = { workspaceId: 'fictional-departments-private', companyId: 'a0000000-0000-4000-8000-000000000001', memberId: 'a0000000-0000-4000-8000-000000000002', role: 'owner', sessionVersion: 1, departmentId: 'a0000000-0000-4000-8000-000000000003' };
const wording = { configuration: { version: 1 as const, template: 'custom' as const, plans: [], workflowDefaults: [] }, note: 'Private predecessor reason', sourceReceiptId: null };
describe('department selection and ended-memory recovery', () => {
  it('reopens the retained selected editor after parent remount without recovering permission', () => {
    const entry = departmentConfigurationDrafts.write(context, '7', wording, null);
    try { const html = renderToStaticMarkup(createElement(CompanyDepartments, { draftActor: context })); expect(html).toContain('<details open=""'); expect(html).toContain('aria-label="Department workflow configuration"'); expect(html).toContain('Unsaved department typing'); expect(html).not.toContain('You manage access as office owner'); }
    finally { departmentConfigurationDrafts.discard(context, entry.sequence); }
  });
  it('shows only ended counts and an explicit review action; private text and destruction are not automatic', () => {
    const old = { ...context, sessionVersion: 0 }, entry = departmentConfigurationDrafts.write(old, '7', wording, null);
    try { const html = renderToStaticMarkup(createElement(CompanyDepartments, { draftActor: context })); expect(html).toContain('1 unsaved department draft is kept'); expect(html).toContain('Review clearing ended-session department typing'); expect(html).not.toContain('Private predecessor reason'); expect(html).not.toContain('Permanently remove ended-session department typing'); expect(departmentConfigurationDrafts.read(old)).not.toBeNull(); }
    finally { departmentConfigurationDrafts.discard(old, entry.sequence); }
  });
});
