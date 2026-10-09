import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { departmentConfigurationDrafts, type DepartmentDraftContext } from '@/lib/department-configuration-draft-journal';
vi.mock('@/state/store', () => ({ api: vi.fn() }));
vi.mock('@/lib/company-api', () => ({ companyApi: { sessionVersion: vi.fn(() => 0) }, departmentMutationUncertain: vi.fn() }));
import { companyApi } from '@/lib/company-api';
import { CompanyDepartmentConfiguration } from './CompanyDepartmentConfiguration';
const context: DepartmentDraftContext = { workspaceId: 'fictional-component-private', companyId: 'a0000000-0000-4000-8000-000000000001', memberId: 'a0000000-0000-4000-8000-000000000002', role: 'owner', sessionVersion: 0, departmentId: 'a0000000-0000-4000-8000-000000000003' };
const wording = { configuration: { version: 1 as const, template: 'custom' as const, plans: [], workflowDefaults: [{ id: 'typed-work', label: 'Private original work type', defaultRecipeId: null }] }, note: 'Private original reason', sourceReceiptId: null };
const render = (actor = context) => renderToStaticMarkup(createElement(CompanyDepartmentConfiguration, { departmentId: actor.departmentId, draftActor: actor, operationBlocked: false }));
describe('retained workflow recovery rendering', () => {
  it('shows memory-only unsaved status and discard/reload recovery before optional field groups', () => {
    const entry = departmentConfigurationDrafts.write(context, '7', wording, null);
    try { const html = render(); expect(html).toContain('starting department revision is 7'); expect(html).toContain('Discard unsaved workflow draft and reload current settings'); expect(html).not.toContain('Changes saved'); }
    finally { departmentConfigurationDrafts.discard(context, entry.sequence); }
  });
  it('does not render foreign actor private wording or a prior request', () => {
    const entry = departmentConfigurationDrafts.write(context, '7', wording, null);
    try { const html = render({ ...context, memberId: 'other-member' }); expect(html).not.toContain('Private original'); expect(html).not.toContain('starting department revision'); }
    finally { departmentConfigurationDrafts.discard(context, entry.sequence); }
  });
  it('hides retained original text on an epoch change even without a parent unmount', () => {
    const entry = departmentConfigurationDrafts.write(context,'7',wording,null), requestId='a0000000-0000-4000-8000-000000000004';
    departmentConfigurationDrafts.beginSave(context,'7',entry.sequence,{ ...wording,requestId,departmentId:context.departmentId,expectedRevision:'7',reviewDigest:'a'.repeat(64) }); departmentConfigurationDrafts.finish(context,entry.sequence,requestId,false);
    try { vi.mocked(companyApi.sessionVersion).mockReturnValue(1); const html=render(); expect(html).not.toContain('Private original'); expect(html).not.toContain(requestId); expect(departmentConfigurationDrafts.read(context)?.phase).toBe('unknown'); }
    finally { vi.mocked(companyApi.sessionVersion).mockReturnValue(0); departmentConfigurationDrafts.beginReplay(context,entry.sequence); departmentConfigurationDrafts.finish(context,entry.sequence,requestId,true); }
  });
  it('shows exact original settings, uncertainty and explicit retry even if the server outbox is absent', () => {
    const entry = departmentConfigurationDrafts.write(context, '7', wording, null), requestId = 'a0000000-0000-4000-8000-000000000004';
    departmentConfigurationDrafts.beginSave(context, '7', entry.sequence, { ...wording, note: wording.note.trim(), requestId, departmentId: context.departmentId, expectedRevision: '7', reviewDigest: 'a'.repeat(64) }); departmentConfigurationDrafts.finish(context, entry.sequence, requestId, false);
    try { const html = render(); expect(html).toContain('empty saved-change queue does not prove'); expect(html).toContain('Retry exact original workflow save'); expect(html).toContain('Private original work type'); expect(html).toContain('Private original reason'); expect(html).not.toContain('Discard unsaved workflow draft'); }
    finally { departmentConfigurationDrafts.beginReplay(context, entry.sequence); departmentConfigurationDrafts.finish(context, entry.sequence, requestId, true); }
  });
});
