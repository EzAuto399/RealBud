import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { defaultApprovalSettings, type ApprovalSettings as Settings } from '@shared/approval-settings';

vi.mock('@/state/store', () => ({ api: vi.fn(), useStore: () => ({ state: { config: { composio: { managed: true } } }, dispatch: vi.fn() }) }));
vi.mock('@/lib/connected-apps-refresh', () => ({ useOfficeSources: () => ({ snapshot: null }) }));
import { APPROVALS_INTRO, ApprovalSettings, approvalRows, changeLines, LOCKED_ROWS, readApprovalHistory, readApprovalsPayload } from './ApprovalSettings';

const settings = (groups: Settings['groups'] = {}, reviewedReads: string[] = []): Settings => ({ ...defaultApprovalSettings(), groups, reviewedReads });

describe('Workspace → Approvals', () => {
  it('opens with the intro and a loading state, never a fallback setting', () => {
    const html = renderToStaticMarkup(createElement(ApprovalSettings));
    expect(html).toContain(APPROVALS_INTRO);
    expect(html).toContain('aria-label="Loading approval settings"');
    expect(html).not.toContain('Save changes');
    expect(html).toContain('Saved on this computer');
  });

  it('re-validates the settings reply and refuses a malformed one', () => {
    const body = { scope: 'office', local: { revision: 2, canEdit: false, settings: settings({ 'app:gmail': 'ask' }) },
      departments: [{ id: 'dept-accounts', name: 'Accounts', canEdit: false, governs: true, revision: '4', settings: settings({ 'site:portal.fictional.test': 'deny' }) }] };
    expect(readApprovalsPayload(body)).toEqual(body);
    for (const broken of [null, { ...body, scope: 'cloud' }, { ...body, local: { ...body.local, revision: '2' } },
      { ...body, departments: [{ ...body.departments[0], canEdit: 'yes' }] }, { ...body, local: { ...body.local, settings: settings({ 'class:send': 'read-without-asking' }) } }]) {
      expect(() => readApprovalsPayload(broken)).toThrow('Approval settings could not be read. Try again.');
    }
  });

  it('lists one row per connected app, website and connector, plus anything saved', () => {
    const rows = approvalRows({ apps: ['gmail', 'googlecalendar'], managed: true, sites: ['portal.fictional.test', 'portal.fictional.test', ''], connectors: [{ id: 'fictional-crm', label: 'Fictional CRM' }],
      saved: ['app:outlook', 'site:old.fictional.test', 'class:pay'] });
    expect(rows.map(row => [row.key, row.label, row.kind])).toEqual([
      ['app:gmail', 'Gmail', 'managed'], ['app:googlecalendar', 'Google Calendar', 'managed'], ['app:outlook', 'Outlook', 'managed'],
      ['site:old.fictional.test', 'old.fictional.test', 'site'], ['site:portal.fictional.test', 'portal.fictional.test', 'site'],
      ['connector:fictional-crm', 'Fictional CRM', 'connector']]);
    expect(approvalRows({ apps: ['gmail'], managed: false, sites: [], connectors: [], saved: [] })[0]?.kind).toBe('direct');
    expect(approvalRows({ apps: [], managed: true, sites: [], connectors: [], saved: [] })).toEqual([]);
    expect(LOCKED_ROWS.map(row => row.label)).toContain('Payments');
  });

  it('reads history from this computer and from a department, and says each change in words', () => {
    const local = readApprovalHistory({ entries: [{ at: '2026-10-08T04:14:00.000Z', by: 'Fictional Sam', department: null, before: settings(), after: settings({ 'app:gmail': 'ask' }, ['GMAIL_FETCH_EMAILS']) }] });
    const office = readApprovalHistory({ department: { id: 'd', name: 'Accounts' }, entries: [{ revision: '2', at: '2026-10-08T04:14:00.000Z', by: { id: 'm', displayName: 'Fictional Kim' }, before: settings({ 'class:pay': 'deny' }), after: settings() }] });
    const rows = [...approvalRows({ apps: ['gmail'], managed: true, sites: [], connectors: [], saved: [] }), ...LOCKED_ROWS];
    const lines = changeLines(local[0]!, rows);
    expect(lines[0]).toMatch(/^Fictional Sam · Gmail: Recommended → Ask every time · 8 Oct/);
    expect(lines[1]).toMatch(/^Fictional Sam · Marked Fetch emails as only reading · /);
    expect(changeLines(office[0]!, rows)[0]).toMatch(/^Fictional Kim · Payments: Don't use → Recommended · /);
    expect(() => readApprovalHistory({ entries: [{ at: 'soon', by: 'x', before: settings(), after: settings() }] })).toThrow('Changes could not be read.');
  });
});
