import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApprovalSettings, onlyEditors, SIGN_IN_TO_CHANGE, type DepartmentApprovals } from './approval-settings.ts';
import { decide, defaultApprovalSettings, uncheckedOfficeSettings, type ApprovalChoice, type ApprovalSettings } from '../shared/approval-settings.ts';
import { connectedAppPolicy } from './connected-apps-broker.ts';
import { MAIL_SENDS } from '../shared/app-tool-policy.ts';

describe('decide() with nothing saved equals today\'s managed policy', () => {
  // Every slug the classifier names (mail reads, drafts, labels, sends, moves,
  // Trash, blocked mail tools, calendar reads and declines), plus name-classified
  // tools from other apps and the argument-dependent cases.
  const source = readFileSync(new URL('../shared/app-tool-policy.ts', import.meta.url), 'utf8');
  const known = [...new Set([...source.matchAll(/"([A-Z][A-Z0-9]*_[A-Z0-9_]+)"/g)].map(match => match[1]))];
  const rows: Array<[string, Record<string, unknown>]> = [
    ...known.map(tool => [tool, {}] as [string, Record<string, unknown>]),
    ...['XERO_GET_INVOICES', 'SLACK_LIST_CHANNELS', 'XERO_CREATE_INVOICE', 'STRIPE_PAY_INVOICE', 'SLACK_DELETE_MESSAGE', 'GOOGLEDRIVE_GET_PERMISSIONS', 'SLACK_FROBNICATE']
      .map(tool => [tool, {}] as [string, Record<string, unknown>]),
    ['GMAIL_ADD_LABEL_TO_EMAIL', { add_label_ids: ['TRASH'] }],
    ['GMAIL_MODIFY_THREAD_LABELS', { add_label_ids: ['STARRED'] }],
    ['OUTLOOK_MOVE_MESSAGE', { destination_id: 'archive' }],
    ['OUTLOOK_MOVE_MESSAGE', { destination_id: 'fictional-folder-id' }],
    ['GOOGLECALENDAR_UPDATE_EVENT', { status: 'cancelled' }],
  ];
  it('covers every one of the classifier\'s own lists', () => expect(known).toEqual(expect.arrayContaining([...MAIL_SENDS,
    'GMAIL_CREATE_EMAIL_DRAFT', 'GMAIL_DELETE_DRAFT', 'GMAIL_ADD_LABEL_TO_EMAIL', 'GMAIL_MOVE_TO_TRASH', 'GMAIL_DELETE_MESSAGE', 'GMAIL_CREATE_FILTER',
    'OUTLOOK_MOVE_MESSAGE', 'OUTLOOK_DECLINE_EVENT', 'GOOGLECALENDAR_FREE_BUSY_QUERY'])));
  it.each(rows)('%s %j', (tool, args) => {
    const policy = connectedAppPolicy({ name: tool, arguments: args }, { managed: true });
    // The class the managed broker would hand decide(): sends are per-instance.
    const cls = policy === 'read' ? 'read' : policy === 'blocked' ? 'blocked' : MAIL_SENDS.has(tool) ? 'send' : 'write';
    const expected = { read: 'run', review: 'card', blocked: 'refuse' }[policy];
    expect(decide([], { group: `app:${tool.split('_')[0].toLowerCase()}`, tool, args, cls })).toBe(expected);
    expect(decide([defaultApprovalSettings()], { group: `app:${tool.split('_')[0].toLowerCase()}`, tool, args, cls })).toBe(expected);
  });
});

const settings = (groups: Record<string, ApprovalChoice> = {}, reviewedReads: string[] = []): ApprovalSettings =>
  ({ version: 1, purpose: 'approval-settings', groups, reviewedReads });
const directory = () => { const dir = mkdtempSync(join(tmpdir(), 'rb-approvals-')); chmodSync(dir, 0o700); return dir; };
const SESSION = 'synthetic-member-session-0000000000000000000';
const signedIn = { headers: { 'x-realbud-member-session': SESSION } };
const signedOut = { headers: {} };
const MEMBER = 'fictional-member-0001';
const ACCOUNTS = '00000000-0000-4000-8000-0000000000a1';
const LEASING = '00000000-0000-4000-8000-0000000000b2';
const q = (value = '') => new URLSearchParams(value);

/** A fictional office host: answers only this member's session. */
function office(departments: DepartmentApprovals[], role: 'owner' | 'member' = 'member') {
  const calls: Array<{ path: string; body: unknown }> = [];
  const company = async (path: string, request: { headers: Record<string, unknown> }, body: unknown) => {
    calls.push({ path, body });
    if (request.headers['x-realbud-member-session'] !== SESSION) return { status: 401, body: { error: 'unauthenticated' } };
    if (path === '/api/company/approvals/mine') return { status: 200, body: { member: { id: MEMBER, displayName: 'Fictional Sam', role }, departments } };
    if (path === '/api/company/approvals/save') {
      const input = body as { departmentId: string; expectedRevision: string; settings: ApprovalSettings };
      const row = departments.find(d => d.id === input.departmentId)!;
      if (!row.canEdit) return { status: 403, body: {} };
      if (row.revision !== input.expectedRevision) return { status: 409, body: {} };
      Object.assign(row, { revision: String(Number(row.revision) + 1), settings: input.settings });
      return { status: 200, body: { department: { id: row.id, name: row.name }, revision: row.revision, settings: input.settings } };
    }
    return { status: 404, body: {} };
  };
  return { calls, company };
}
const dept = (id: string, name: string, canEdit: boolean, value = settings(), governs = true): DepartmentApprovals =>
  ({ id, name, canEdit, governs, revision: '0', settings: value });

describe('approval settings on a single desktop', () => {
  it('lets the owner save, refuses a stale revision, and keeps receipts across a reload', async () => {
    const dataDir = directory();
    let clock = Date.parse('2026-10-07T01:00:00Z');
    const make = () => createApprovalSettings({ dataDir, seatIdentity: async () => null, company: async () => { throw new Error('no office'); }, now: () => clock });
    const store = make();
    expect((await store.handle('/api/approvals', 'GET', signedOut, q())).body).toEqual({ scope: 'computer', local: { revision: 0, settings: defaultApprovalSettings(), canEdit: true }, departments: [] });
    const first = settings({ 'app:gmail': 'ask' });
    expect(await store.handle('/api/approvals', 'PUT', signedOut, q(), { expectedRevision: 0, settings: first })).toEqual({ status: 200, body: { revision: 1, settings: first } });
    expect((await store.handle('/api/approvals', 'PUT', signedOut, q(), { expectedRevision: 0, settings: settings() })).status).toBe(409);
    clock += 60_000;
    const second = settings({ 'app:gmail': 'deny', 'class:send': 'deny' });
    expect((await store.handle('/api/approvals', 'PUT', signedOut, q(), { expectedRevision: 1, settings: second })).status).toBe(200);

    const reloaded = make();
    const history = await reloaded.handle('/api/approvals/history', 'GET', signedOut, q());
    expect(history).toEqual({ status: 200, body: { entries: [
      { at: '2026-10-07T01:01:00.000Z', by: 'This computer', department: null, before: first, after: second },
      { at: '2026-10-07T01:00:00.000Z', by: 'This computer', department: null, before: defaultApprovalSettings(), after: first },
    ] } });
    expect(await reloaded.effective()).toEqual([second]);
    expect(await reloaded.editor(signedOut)).toEqual({ ok: true, verified: null });
  });

  it('refuses invalid settings with a plain sentence and never saves them', async () => {
    const store = createApprovalSettings({ dataDir: directory(), seatIdentity: async () => null, company: async () => ({ status: 503, body: {} }) });
    const refused = await store.handle('/api/approvals', 'PUT', signedOut, q(), { expectedRevision: 0, settings: settings({ 'class:pay': 'read-without-asking' }) });
    expect(refused.status).toBe(400);
    expect((refused.body as { error: string }).error).toMatch(/^Bud always asks before it sends, pays/);
    expect((await store.handle('/api/approvals', 'PUT', signedOut, q(), { expectedRevision: 0, settings: settings(), extra: true })).status).toBe(400);
    expect((await store.handle('/api/approvals', 'GET', signedOut, q())).body).toMatchObject({ local: { revision: 0 } });
  });

  it('holds changes when the saved file is damaged, and keeps the file', async () => {
    const dataDir = directory();
    writeFileSync(join(dataDir, 'approval-settings.json'), '{"version":1,', { mode: 0o600 });
    const store = createApprovalSettings({ dataDir, seatIdentity: async () => null, company: async () => ({ status: 503, body: {} }) });
    expect((await store.handle('/api/approvals', 'PUT', signedOut, q(), { expectedRevision: 0, settings: settings() })).status).toBe(503);
    await expect(store.effective()).rejects.toMatchObject({ status: 503 });
    expect(readFileSync(join(dataDir, 'approval-settings.json'), 'utf8')).toBe('{"version":1,');
  });
});

describe('approval settings in an office', () => {
  it('gives a read-only member a plain 403 on every change, and never forwards the save', async () => {
    const host = office([dept(ACCOUNTS, 'Accounts', false), dept(LEASING, 'Leasing', true)]);
    const store = createApprovalSettings({ dataDir: directory(), seatIdentity: async () => MEMBER, company: host.company });
    const message = { ok: false, status: 403, error: onlyEditors('Accounts') };
    expect(message.error).toBe('Only people who can edit Accounts can change approval settings.');
    expect(await store.editor(signedIn)).toEqual(message);
    expect(await store.handle('/api/approvals', 'PUT', signedIn, q(), { departmentId: ACCOUNTS, expectedRevision: '0', settings: settings() }))
      .toEqual({ status: 403, body: { error: message.error } });
    expect(await store.handle('/api/approvals', 'PUT', signedIn, q(), { expectedRevision: 0, settings: settings() }))
      .toEqual({ status: 403, body: { error: message.error } });
    expect(host.calls.some(call => call.path === '/api/company/approvals/save')).toBe(false);
  });

  it('lets an editor save a department and refreshes this desktop copy', async () => {
    const host = office([dept(ACCOUNTS, 'Accounts', true), dept(LEASING, 'Leasing', true, settings(), false)]);
    const store = createApprovalSettings({ dataDir: directory(), seatIdentity: async () => MEMBER, company: host.company });
    expect(await store.editor(signedIn)).toMatchObject({ ok: true });
    const next = settings({ 'app:gmail': 'deny' });
    const saved = await store.handle('/api/approvals', 'PUT', signedIn, q(), { departmentId: ACCOUNTS, expectedRevision: '0', settings: next });
    expect(saved).toMatchObject({ status: 200, body: { revision: '1', settings: next } });
    expect(await store.handle('/api/approvals', 'PUT', signedIn, q(), { departmentId: ACCOUNTS, expectedRevision: '0', settings: next })).toMatchObject({ status: 409 });
    // Only Accounts governs this member (Leasing is visible but not granted).
    expect(await store.effective()).toEqual([next]);
    const read = await store.handle('/api/approvals', 'GET', signedIn, q());
    expect(read.body).toMatchObject({ scope: 'office', local: { canEdit: true }, departments: [{ id: ACCOUNTS, revision: '1' }, { id: LEASING }] });
  });

  it('refuses anyone it cannot verify as this computer\'s member', async () => {
    const host = office([dept(ACCOUNTS, 'Accounts', true)]);
    const store = createApprovalSettings({ dataDir: directory(), seatIdentity: async () => MEMBER, company: host.company });
    expect(await store.editor(signedOut)).toEqual({ ok: false, status: 403, error: SIGN_IN_TO_CHANGE });
    const other = createApprovalSettings({ dataDir: directory(), seatIdentity: async () => 'fictional-member-0002', company: host.company });
    expect(await other.editor(signedIn)).toEqual({ ok: false, status: 403, error: SIGN_IN_TO_CHANGE });
    const damaged = createApprovalSettings({ dataDir: directory(), seatIdentity: async () => { throw new Error('seat needs recovery'); }, company: host.company });
    expect(await damaged.editor(signedIn)).toMatchObject({ ok: false, status: 403 });
  });

  it('keeps reviewed reads owner-only on this computer', async () => {
    const member = createApprovalSettings({ dataDir: directory(), seatIdentity: async () => MEMBER, company: office([]).company });
    expect((await member.handle('/api/approvals', 'PUT', signedIn, q(), { expectedRevision: 0, settings: settings({}, ['GMAIL_FETCH_EMAILS']) })).status).toBe(403);
    expect((await member.handle('/api/approvals', 'PUT', signedIn, q(), { expectedRevision: 0, settings: settings({ 'app:gmail': 'ask' }) })).status).toBe(200);
    const owner = createApprovalSettings({ dataDir: directory(), seatIdentity: async () => MEMBER, company: office([], 'owner').company });
    expect((await owner.handle('/api/approvals', 'PUT', signedIn, q(), { expectedRevision: 0, settings: settings({}, ['GMAIL_FETCH_EMAILS']) })).status).toBe(200);
  });

  it('merges every governing department, and lapses widenings after 12 hours without a refresh', async () => {
    let clock = Date.parse('2026-10-07T01:00:00Z');
    const accounts = settings({ 'app:gmail': 'read-without-asking', 'site:portal.fictional-strata.example': 'read-without-asking', 'app:outlook': 'deny' }, ['GMAIL_FETCH_EMAILS']);
    const leasing = settings({ 'app:gmail': 'ask' });
    const dataDir = directory();
    let seat = MEMBER;
    const store = createApprovalSettings({ dataDir, seatIdentity: async () => seat, company: office([dept(ACCOUNTS, 'Accounts', true, accounts), dept(LEASING, 'Leasing', true, leasing)]).company, now: () => clock });
    expect(await store.effective()).toEqual([settings(), uncheckedOfficeSettings()]); // never verified: this computer's own, and ask first
    expect(await store.editor(signedIn)).toMatchObject({ ok: true });
    expect(await store.effective()).toEqual([accounts, leasing]);
    clock += 12 * 3_600_000 + 1;
    expect(await store.effective()).toEqual([settings({ 'app:outlook': 'deny' }), leasing]);
    seat = 'fictional-member-0002';
    expect(await store.effective()).toEqual([settings(), uncheckedOfficeSettings()]);
  });

  it('fails closed on a fresh office desktop until a turn verifies the department settings with the person\'s session', async () => {
    const accounts = settings({ 'app:gmail': 'deny' });
    const host = office([dept(ACCOUNTS, 'Accounts', false, accounts)]);
    const store = createApprovalSettings({ dataDir: directory(), seatIdentity: async () => MEMBER, company: host.company });
    const read = { group: 'app:gmail', tool: 'GMAIL_FETCH_EMAILS', args: {}, cls: 'read' as const };
    // No verified copy: a Gmail read that would run asks first; blocked stays refused.
    expect(decide(await store.effective(), read)).toBe('card');
    expect(decide(await store.effective(), { ...read, tool: 'GMAIL_DELETE_MESSAGE', cls: 'blocked' })).toBe('refuse');
    // Without the person's session nothing is fetched, and it stays closed.
    await store.verifyIfMissing(signedOut);
    expect(decide(await store.effective(), read)).toBe('card');
    await store.verifyIfMissing(signedIn);
    expect(await store.effective()).toEqual([accounts]);
    expect(decide(await store.effective(), read)).toBe('refuse');
    // A verified copy is not fetched again.
    const fetched = host.calls.length;
    await store.verifyIfMissing(signedIn);
    expect(host.calls.length).toBe(fetched);
    // A single desktop is unaffected.
    const single = createApprovalSettings({ dataDir: directory(), seatIdentity: async () => null, company: host.company });
    expect(await single.effective()).toEqual([settings()]);
    expect(decide(await single.effective(), read)).toBe('run');
  });
});
