import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkspaceTabsHandler } from './workspace-tabs.ts';
import { defaultDeskSections, defaultShellLayout, parseWorkspaceTabsResponse } from '../shared/workspace-tabs.ts';

const desk = { sections: defaultDeskSections() };
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
  it('starts a newly linked office on the simple desk, never replacing a saved layout', async () => {
    const fresh = await fixture();
    expect(await fresh.handler.simpleDeskIfNeverCustomized()).toBe(true);
    const visible = (await fresh.read()).state!.desk.sections.filter(section => section.visible).map(section => section.id).sort();
    expect(visible).toEqual(['brief', 'go-live', 'queue']);
    // Applying twice is a no-op, and the standard layout stays restorable.
    expect(await fresh.handler.simpleDeskIfNeverCustomized()).toBe(false);
    expect((await fresh.read()).state!.history.length).toBeGreaterThan(0);

    const chosen = await fixture();
    expect((await chosen.call('PUT', { version: 1, expectedRevision: 0, tabs: [tab] }))?.status).toBe(200);
    expect(await chosen.handler.simpleDeskIfNeverCustomized()).toBe(false);
    expect((await chosen.read()).state!.desk.sections).toEqual(defaultDeskSections());
  });
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
    expect((await a.read()).state).toEqual({ version: 2, revision: 0, tabs: [], desk, history: [] });
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
  it.each(['{broken-json', 'x'.repeat(40_000), JSON.stringify({ state: { version: 2, revision: 4, tabs: [], desk, history: [] }, workspaceId: 'wrong' })])('holds corrupt or oversized configuration, then retains its recovery copy on explicit reset', async content => {
    const a = await fixture(); await a.read();
    plantPrivateFile(a.path, content);
    const held = await a.read(); expect(held.state).toBeNull(); expect(held.recovery?.resetToken).toHaveLength(64);
    expect((await a.call('PUT', { version: 1, expectedRevision: 0, tabs: [tab] }))?.status).toBe(409);
    expect((await a.call('POST', { confirm: true, resetToken: 'stale' }, '/api/workspace-tabs/reset'))?.status).toBe(409);
    expect((await a.call('POST', { confirm: true, resetToken: held.recovery?.resetToken }, '/api/workspace-tabs/reset'))?.status).toBe(200);
    const archive = (await readdir(join(a.directory, 'workspace-views'))).find(name => name.startsWith('tabs-recovery-'))!;
    expect(await readFile(join(a.directory, 'workspace-views', archive), 'utf8')).toBe(content);
    expect((await a.read()).state).toEqual({ version: 2, revision: 1, tabs: [], desk, history: [] });
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
    expect((await a.read()).state).toEqual({ version: 2, revision: 2, tabs: [], desk, history: [] });
    expect(await readFile(join(a.directory, 'business-record.json'), 'utf8')).toBe('kept');
  });
});

describe('customizable Desk layout', () => {
  const custom = () => { const sections = defaultDeskSections().reverse(); sections[0] = { ...sections[0]!, visible: false }; return sections; };
  it('migrates a stored version 1 file to the default Desk order without changing its tabs or revision', async () => {
    const a = await fixture(); await a.read();
    plantPrivateFile(a.path, JSON.stringify({ workspaceId: a.workspaceId, state: { version: 1, revision: 7, tabs: [tab] } }));
    expect((await a.read()).state).toEqual({ version: 2, revision: 7, tabs: [tab], desk, history: [] });
    // A version 1 tabs-only save keeps the Desk layout and writes version 2.
    expect((await a.call('PUT', { version: 1, expectedRevision: 7, tabs: [] }))?.status).toBe(200);
    const stored = JSON.parse(await readFile(a.path, 'utf8'));
    expect(stored.state).toEqual({ version: 2, revision: 8, tabs: [], desk, history: [] });
  });
  it('saves a layout, keeps history with the earlier layout, and reverts as a new revision', async () => {
    let clock = 1_000;
    const a = await fixture();
    const handler = createWorkspaceTabsHandler({ directory: a.directory, workspaceId: a.workspaceId, now: () => ++clock });
    const saved = parseWorkspaceTabsResponse((await handler.handle('/api/workspace-tabs', 'PUT', { version: 2, expectedRevision: 0, tabs: [tab], desk: { sections: custom() } }))?.body).state!;
    expect(saved.desk.sections).toEqual(custom());
    expect(saved.history).toEqual([{ revision: 1, savedAt: 1_001, sections: custom() }, { revision: 0, savedAt: null, sections: defaultDeskSections() }]);
    // Tabs-only saves do not add history entries.
    const tabsOnly = parseWorkspaceTabsResponse((await handler.handle('/api/workspace-tabs', 'PUT', { version: 1, expectedRevision: 1, tabs: [] }))?.body).state!;
    expect(tabsOnly.history).toHaveLength(2); expect(tabsOnly.desk.sections).toEqual(custom());
    expect((await handler.handle('/api/workspace-tabs/revert', 'POST', { expectedRevision: 1, toRevision: 0 }))?.status).toBe(409);
    expect((await handler.handle('/api/workspace-tabs/revert', 'POST', { expectedRevision: 2, toRevision: 5 }))?.status).toBe(400);
    const reverted = parseWorkspaceTabsResponse((await handler.handle('/api/workspace-tabs/revert', 'POST', { expectedRevision: 2, toRevision: 0 }))?.body).state!;
    expect(reverted.revision).toBe(3);
    expect(reverted.desk.sections).toEqual(defaultDeskSections());
    // The restored layout moves to the top instead of being listed twice.
    expect(reverted.history.map(entry => entry.revision)).toEqual([3, 1]);
  });
  it('bounds history to ten layouts inside the size cap', async () => {
    const a = await fixture();
    for (let revision = 0; revision < 14; revision++) {
      const sections = defaultDeskSections().map((section, index) => ({ ...section, visible: section.id === 'queue' || (((revision + 1) >> index) & 1) === 1 }));
      expect((await a.call('PUT', { version: 2, expectedRevision: revision, tabs: [], desk: { sections } }))?.status).toBe(200);
    }
    const state = (await a.read()).state!;
    expect(state.history).toHaveLength(10);
    expect(state.history[0]!.revision).toBe(14);
  });
  it.each([
    [{ sections: defaultDeskSections().map(section => section.id === 'queue' ? { ...section, visible: false } : section) }],
    [{ sections: defaultDeskSections().filter(section => section.id !== 'queue') }],
    [{ sections: [...defaultDeskSections().slice(1), { id: 'mail', visible: true }] }],
    [{ sections: [...defaultDeskSections().slice(1), { id: 'iframe', visible: true }] }],
    [{ sections: defaultDeskSections().map(section => ({ ...section, script: 'x' })) }],
    [{ sections: defaultDeskSections(), url: 'https://example.com' }],
    [undefined],
  ])('rejects an invalid Desk layout before mutation', async deskValue => {
    const a = await fixture();
    expect((await a.call('PUT', { version: 2, expectedRevision: 0, tabs: [], desk: deskValue }))?.status).toBe(400);
    expect((await a.read()).state?.revision).toBe(0);
  });
  it('answers a stale layout save with 409 and keeps the stored layout', async () => {
    const a = await fixture();
    expect((await a.call('PUT', { version: 2, expectedRevision: 0, tabs: [], desk: { sections: custom() } }))?.status).toBe(200);
    const stale = await a.call('PUT', { version: 2, expectedRevision: 0, tabs: [], desk: { sections: defaultDeskSections() } });
    expect(stale?.status).toBe(409);
    expect((await a.read()).state?.desk.sections).toEqual(custom());
  });
  it('keeps the Desk layout when saved view shortcuts are reset', async () => {
    const a = await fixture();
    await a.call('PUT', { version: 2, expectedRevision: 0, tabs: [tab], desk: { sections: custom() } });
    expect((await a.call('POST', { expectedRevision: 1, confirm: true }, '/api/workspace-tabs/reset'))?.status).toBe(200);
    const state = (await a.read()).state!;
    expect(state.tabs).toEqual([]); expect(state.desk.sections).toEqual(custom());
  });
  it('keeps the side panel layout per workspace and refuses to hide approval or recovery surfaces', async () => {
    const a = await fixture();
    expect((await a.read()).state!.shell).toBeUndefined();
    const shell = { ...defaultShellLayout(), panelWidth: 420 };
    expect((await a.call('PUT', { version: 2, expectedRevision: 0, tabs: [], desk, shell }))?.status).toBe(200);
    expect((await a.read()).state!.shell).toEqual(shell);
    // Bud's version 2 writes and tab-only writes keep the stored panel layout.
    expect((await a.call('PUT', { version: 2, expectedRevision: 1, tabs: [tab], desk }))?.status).toBe(200);
    expect((await a.call('PUT', { version: 1, expectedRevision: 2, tabs: [] }))?.status).toBe(200);
    expect((await a.read()).state!.shell).toEqual(shell);
    const hidden = { ...shell, panels: shell.panels.map(panel => panel.id === 'approvals' ? { ...panel, visible: false } : panel) };
    const refused = await a.call('PUT', { version: 2, expectedRevision: 3, tabs: [], desk, shell: hidden });
    expect(refused?.status).toBe(400);
    expect((refused?.body as { code: string }).code).toBe('invalid_shell');
    const noQueue = { sections: defaultDeskSections().map(section => section.id === 'queue' ? { ...section, visible: false } : section) };
    expect((await a.call('PUT', { version: 2, expectedRevision: 3, tabs: [], desk: noQueue }))?.status).toBe(400);
    for (const panelWidth of [279, 561, 300.5]) expect((await a.call('PUT', { version: 2, expectedRevision: 3, tabs: [], desk, shell: { ...shell, panelWidth } }))?.status).toBe(400);
    expect((await a.call('PUT', { version: 1, expectedRevision: 3, tabs: [], shell }))?.status).toBe(400);
    expect((await a.call('PUT', { version: 2, expectedRevision: 2, tabs: [], desk, shell }))?.status).toBe(409);
    expect((await a.read()).state!.revision).toBe(3);
  });
});
