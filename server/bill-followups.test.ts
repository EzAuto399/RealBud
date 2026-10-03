import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBillFollowUps, createBillFollowUpsApi } from './bill-followups.ts';
import { removeFixture } from './testing/private-fixture.ts';
import type { RoutineFinding, RoutineResult } from '../shared/routine-result.ts';
import { readBillFollowUpPage } from '../shared/bill-followups.ts';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await removeFixture(dir); });
const finding = (n: number, state: RoutineFinding['state'] = 'missing-review'): RoutineFinding =>
  ({ id: `arrival-${n}`, propertyId: 'fictional-property', label: `Water · Fictional utility ${n}`, state, from: '2026-09-20', to: '2026-09-25', reason: 'Review the original sources.' });
function fixture() {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'rb-followups-')); dirs.push(dir);
  const file = join(dir, 'private', 'bill-followups.json');
  let latest: RoutineResult | null = null, run = 0, inRecovery = false;
  const options = { file, latest: () => latest, recovery: () => inRecovery, now: () => 1_000 };
  const publish = (findings: RoutineFinding[]) => { latest = { workflow: 'weekly-bills', runId: `run-${++run}`, findings } as RoutineResult; };
  return { file, options, publish, store: () => createBillFollowUps(options), setRecovery: (v: boolean) => { inRecovery = v; } };
}

describe('weekly bill follow-ups (fictional findings)', () => {
  it('pages every finding past twenty and keeps the file private', async () => {
    const f = fixture(); f.publish(Array.from({ length: 45 }, (_, i) => finding(i)));
    const store = f.store(), seen = new Set<string>();
    let page = await store.page();
    expect(page).toMatchObject({ total: 45, counts: { open: 45, resolved: 0 } });
    while (true) { page.items.forEach(i => seen.add(i.id)); if (!page.nextCursor) break; page = await store.page({ cursor: page.nextCursor }); }
    expect(seen.size).toBe(45);
    if (process.platform !== 'win32') expect(statSync(f.file).mode & 0o777).toBe(0o600);
  });
  it('assigns, dates, resolves and reopens with revision checks that survive a restart', async () => {
    const f = fixture(); f.publish([finding(1)]);
    let store = f.store(), [item] = (await store.page()).items;
    item = (await store.change({ id: item.id, expectedRevision: item.revision, action: 'plan', owner: 'Kevin', followUpOn: '2026-10-09' })).item;
    expect(item).toMatchObject({ owner: 'Kevin', followUpOn: '2026-10-09', revision: 2 });
    await expect(store.change({ id: item.id, expectedRevision: 1, action: 'resolve', note: '' })).rejects.toMatchObject({ status: 409 });
    item = (await store.change({ id: item.id, expectedRevision: 2, action: 'resolve', note: 'Fictional supplier confirmed it is late.' })).item;
    store = f.store(); // restart
    expect((await store.page({ filter: 'resolved' })).items[0]).toMatchObject({ status: 'resolved', owner: 'Kevin', revision: 3 });
    item = (await store.change({ id: item.id, expectedRevision: 3, action: 'reopen', note: 'Fictional: still missing.' })).item;
    expect(item.history.map(h => h.action)).toEqual(['planned', 'resolved', 'reopened']);
  });
  it('keeps decisions across unchanged reruns and reopens a resolved finding that recurs with new evidence', async () => {
    const f = fixture(); f.publish([finding(1, 'coverage-hold')]);
    const store = f.store(), [item] = (await store.page()).items;
    await store.change({ id: item.id, expectedRevision: item.revision, action: 'resolve', note: 'Fictional: checked by hand.' });
    f.publish([finding(1, 'coverage-hold')]);
    expect((await store.page({ filter: 'resolved' })).items[0]).toMatchObject({ status: 'resolved', revision: 2 });
    f.publish([finding(1, 'missing-review')]);
    const reopened = (await store.page()).items[0];
    expect(reopened).toMatchObject({ status: 'open', state: 'missing-review' });
    expect(reopened.history.at(-1)).toMatchObject({ action: 'recurred' });
    expect(reopened.history.at(-1)?.note).toContain('new evidence');
    // A finding that clears is kept (inactive); coming back after resolution reopens it too.
    await store.change({ id: item.id, expectedRevision: reopened.revision, action: 'resolve', note: '' });
    f.publish([]); expect((await store.page({ filter: 'all' })).items[0]).toMatchObject({ active: false, status: 'resolved' });
    f.publish([finding(1, 'missing-review')]); expect((await store.page()).items[0]).toMatchObject({ status: 'open', active: true });
  });
  it('holds a damaged file, refuses changes in recovery and answers through the API shape', async () => {
    const f = fixture(); f.publish([finding(1)]);
    const api = createBillFollowUpsApi(f.options), url = new URL('http://local/api/bill-register/followups?filter=open&limit=5');
    const got = await api(url, 'GET'); expect(got.status).toBe(200);
    const item = readBillFollowUpPage(got.body).items[0];
    expect((await api(url, 'PATCH', { id: item.id, expectedRevision: item.revision, action: 'plan', owner: 'Kevin' })).status).toBe(400);
    f.setRecovery(true);
    expect((await api(url, 'PATCH', { id: item.id, expectedRevision: item.revision, action: 'resolve', note: '' })).status).toBe(503);
    f.setRecovery(false);
    writeFileSync(f.file, '{"version":1,"broken":true}'); chmodSync(f.file, 0o600);
    expect((await api(url, 'GET')).status).toBe(503);
    expect((await api(url, 'PATCH', { id: item.id, expectedRevision: item.revision, action: 'resolve', note: '' })).status).toBe(503);
    expect(readFileSync(f.file, 'utf8')).toBe('{"version":1,"broken":true}');
  });
});
