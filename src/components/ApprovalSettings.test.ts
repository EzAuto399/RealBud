import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { defaultApprovalSettings, type ApprovalSettings as Settings } from '@shared/approval-settings';

vi.mock('@/state/store', () => ({ api: vi.fn(), useStore: () => ({ state: { config: { composio: { managed: true } } }, dispatch: vi.fn() }) }));
vi.mock('@/lib/connected-apps-refresh', () => ({ useOfficeSources: () => ({ snapshot: null }) }));
// Each render's answer to the unsaved-work guard (beforeunload and the update restart).
const guards = vi.hoisted(() => [] as boolean[]);
vi.mock('@/lib/unsaved-work', async original => ({ ...await original<object>(), useUnsavedGuard: (dirty: boolean) => { guards.push(dirty); } }));
import { APPROVALS_INTRO, ApprovalSettings, approvalRows, changeLines, LOCKED_ROWS, readApprovalHistory, readApprovalsPayload, rowOptions, SITE_HINT } from './ApprovalSettings';

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

  it('offers a website Recommended, Read without asking or Don\'t use, and a saved Ask every time only while it is saved', () => {
    const words = (saved?: 'ask' | 'deny' | 'read-without-asking') => rowOptions('site', saved).map(([value, label]) => [value, label]);
    expect(words()).toEqual([[null, 'Recommended'], ['read-without-asking', 'Read without asking'], ['deny', "Don't use"]]);
    expect(words('deny')).toEqual(words());
    expect(words('ask')).toEqual([...words(), ['ask', 'Ask every time']]);
    expect(SITE_HINT).toBe('Recommended: approved workflows read this site; Bud asks before reading anywhere else here.');
    // Apps and connectors keep their choices.
    expect(rowOptions('managed', 'ask').map(([, label]) => label)).toEqual(['Recommended', 'Ask every time', "Don't use"]);
    expect(rowOptions('direct', undefined).map(([, label]) => label)).toEqual(['Ask every time', 'Read without asking', "Don't use"]);
    expect(rowOptions('connector', undefined).map(([, label]) => label)).toEqual(['Recommended', 'Ask every time', "Don't use"]);
    const rows = approvalRows({ apps: [], managed: true, sites: ['portal.fictional.test'], connectors: [], saved: [] });
    const change = { at: Date.parse('2026-10-08T04:14:00.000Z'), by: 'Bud', before: settings(), after: settings({ 'site:portal.fictional.test': 'ask' }) };
    expect(changeLines(change, rows)[0]).toMatch(/^Bud · portal\.fictional\.test: Recommended → Ask every time · /);
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

describe('unsaved approval rules', () => {
  it('registers one guard for beforeunload and the update restart, holding nothing before the rules load', () => {
    guards.length = 0;
    renderToStaticMarkup(createElement(ApprovalSettings));
    expect(guards).toEqual([false]);
  });
});
