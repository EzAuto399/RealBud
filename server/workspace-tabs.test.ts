import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkspaceTabsHandler } from './workspace-tabs.ts';
import { parseWorkspaceTabsResponse } from '../shared/workspace-tabs.ts';
import { plantPrivateFile, removeFixture } from './testing/private-fixture.ts';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => removeFixture(path))); });
const tab = { id: 'view-accounts', label: 'Waiting work', visible: true, view: { kind: 'tasks', filter: 'waiting' } };
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'realbud-views-')); directories.push(directory);
  const workspaceId = randomUUID();
  const handler = createWorkspaceTabsHandler({ directory, workspaceId });
  const call = (method = 'GET', body?: unknown, path = '/api/workspace-tabs') => handler.handle(path, method, body);
  const read = async () => parseWorkspaceTabsResponse((await call())?.body);
  return { directory, workspaceId, handler, call, read, path: join(directory, 'workspace-views', 'tabs.json') };
}
describe('private workspace saved views', () => {
  it('persists a mail filter as a private shortcut without executable settings or source access', async () => {
    const a = await fixture();
    const mail = { ...tab, label: 'Mail waiting', view: { kind: 'mail', filter: 'waiting' } };
    expect((await a.call('PUT', { version: 1, expectedRevision: 0, tabs: [mail] }))?.status).toBe(200);
    const reopened = createWorkspaceTabsHandler({ directory: a.directory, workspaceId: a.workspaceId });
    expect(parseWorkspaceTabsResponse((await reopened.handle('/api/workspace-tabs', 'GET'))?.body).state?.tabs).toEqual([mail]);
    expect((await a.call('PUT', { version: 1, expectedRevision: 1, tabs: [{ ...mail, view: { kind: 'mail', filter: 'send-all' } }] }))?.status).toBe(400);
    expect(await readdir(a.directory)).toEqual(['workspace-views']);
  });
  it('persists bounded views across handlers without changing scope or business data', async () => {
    const a = await fixture(), b = await fixture();
    expect((await a.read()).state).toEqual({ version: 1, revision: 0, tabs: [] });
    expect((await a.call('PUT', { version: 1, expectedRevision: 0, tabs: [tab] }))?.status).toBe(200);
    const reopened = createWorkspaceTabsHandler({ directory: a.directory, workspaceId: a.workspaceId });
    expect(parseWorkspaceTabsResponse((await reopened.handle('/api/workspace-tabs', 'GET'))?.body).state?.tabs).toEqual([tab]);
    expect((await b.read()).state?.tabs).toEqual([]);
    const differentIdentity = createWorkspaceTabsHandler({ directory: a.directory, workspaceId: randomUUID() });
    expect(parseWorkspaceTabsResponse((await differentIdentity.handle('/api/workspace-tabs', 'GET'))?.body).state).toBeNull();
    expect((await a.read()).state?.tabs).toEqual([tab]);
  });
  it('serializes concurrent windows and rejects stale writes and resets', async () => {
    const a = await fixture();
    const other = createWorkspaceTabsHandler({ directory: a.directory, workspaceId: a.workspaceId });
    const results = await Promise.all([a.call('PUT', { version: 1, expectedRevision: 0, tabs: [tab] }), other.handle('/api/workspace-tabs', 'PUT', { version: 1, expectedRevision: 0, tabs: [{ ...tab, label: 'Other' }] })]);
    expect(results.map(item => item?.status).sort()).toEqual([200, 409]);
    expect((await a.call('POST', { expectedRevision: 0, confirm: true }, '/api/workspace-tabs/reset'))?.status).toBe(409);
    expect((await a.read()).state?.revision).toBe(1);
  });
  it.each([
    [{ ...tab, script: 'execute arbitrary code' }],
    [{ ...tab, view: { kind: 'iframe', filter: 'https://example.com' } }],
    [{ ...tab, view: { kind: 'tasks', filter: 'all', url: 'https://example.com' } }],
    [{ ...tab, view: { kind: 'tasks', filter: 'settled' } }],
    [tab, tab],
    [{ ...tab, id: '../../another-workspace' }],
    [{ ...tab, label: 'x'.repeat(41) }],
    [{ ...tab, label: 'Hidden\u202ecode' }],
    Array.from({ length: 13 }, (_, i) => ({ ...tab, id: `view-${i}` })),
  ].map(tabs => ({ tabs })))('rejects an invalid imported configuration before mutation', async ({ tabs }) => {
    const a = await fixture();
    expect((await a.call('PUT', { version: 1, expectedRevision: 0, tabs }))?.status).toBe(400);
    expect((await a.read()).state?.revision).toBe(0);
  });
  it('requires revision and rejects caller-selected storage or identity', async () => {
    const a = await fixture();
    for (const extra of [{}, { expectedRevision: '0' }, { expectedRevision: 0, workspaceId: randomUUID() }, { expectedRevision: 0, path: '/tmp/elsewhere' }]) expect((await a.call('PUT', { version: 1, tabs: [tab], ...extra }))?.status).toBe(400);
  });
  it('does not overflow a persisted revision during either edit or reset', async () => {
    const a = await fixture(); await a.read();
    plantPrivateFile(a.path, JSON.stringify({ workspaceId: a.workspaceId, state: { version: 1, revision: Number.MAX_SAFE_INTEGER, tabs: [tab] } }));
    expect((await a.call('PUT', { version: 1, expectedRevision: Number.MAX_SAFE_INTEGER, tabs: [] }))?.status).toBe(400);
    expect((await a.call('POST', { expectedRevision: Number.MAX_SAFE_INTEGER, confirm: true }, '/api/workspace-tabs/reset'))?.status).toBe(409);
    expect((await a.read()).state?.tabs).toEqual([tab]);
  });
  it.each(['{broken-json', 'x'.repeat(40_000), JSON.stringify({ state: { version: 2, revision: 4, tabs: [] }, workspaceId: 'wrong' })])('holds corrupt or oversized configuration, then retains its recovery copy on explicit reset', async content => {
    const a = await fixture(); await a.read();
    plantPrivateFile(a.path, content);
    const held = await a.read(); expect(held.state).toBeNull(); expect(held.recovery?.resetToken).toHaveLength(64);
    expect((await a.call('PUT', { version: 1, expectedRevision: 0, tabs: [tab] }))?.status).toBe(409);
    expect((await a.call('POST', { confirm: true, resetToken: 'stale' }, '/api/workspace-tabs/reset'))?.status).toBe(409);
    expect((await a.call('POST', { confirm: true, resetToken: held.recovery?.resetToken }, '/api/workspace-tabs/reset'))?.status).toBe(200);
    const archive = (await readdir(join(a.directory, 'workspace-views'))).find(name => name.startsWith('tabs-recovery-'))!;
    expect(await readFile(join(a.directory, 'workspace-views', archive), 'utf8')).toBe(content);
    expect((await a.read()).state).toEqual({ version: 1, revision: 1, tabs: [] });
  });
  it('does not replace a linked configuration or modify its target', async () => {
    const a = await fixture(); await a.read();
    const target = join(a.directory, 'business-record.json');
    await writeFile(target, 'preserve me', { mode: 0o600 }); await symlink(target, a.path);
    expect((await a.call())?.status).toBe(503);
    expect((await a.call('POST', { expectedRevision: 0, confirm: true }, '/api/workspace-tabs/reset'))?.status).toBe(503);
    expect(await readFile(target, 'utf8')).toBe('preserve me');
  });
  it('resets only views after confirmation and leaves business records intact', async () => {
    const a = await fixture(); await writeFile(join(a.directory, 'business-record.json'), 'kept');
    await a.call('PUT', { version: 1, expectedRevision: 0, tabs: [tab] });
    expect((await a.call('POST', { expectedRevision: 1 }, '/api/workspace-tabs/reset'))?.status).toBe(400);
    expect((await a.call('POST', { expectedRevision: 1, confirm: true }, '/api/workspace-tabs/reset'))?.status).toBe(200);
    expect((await a.read()).state).toEqual({ version: 1, revision: 2, tabs: [] });
    expect(await readFile(join(a.directory, 'business-record.json'), 'utf8')).toBe('kept');
  });
});
