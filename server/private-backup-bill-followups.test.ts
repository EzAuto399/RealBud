import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { createPrivateWorkspaceBackup, applyStagedPrivateRestore } from './private-workspace-backup.ts';
import { PrivateBackupCatalog } from './private-backup-catalog.ts';
import { createBillFollowUps } from './bill-followups.ts';
import { encryptJson, decryptJson } from './desk-crypto.ts';
import { emptyV3 } from '../shared/desk-v3.ts';
import type { RoutineResult } from '../shared/routine-result.ts';
import type { PrivateWorkspaceBackup } from '../shared/private-workspace-backup.ts';
import { plantPrivateFiles, privateTempRoot, removeFixture } from './testing/private-fixture.ts';

const roots: string[] = [], phrase = 'Fictional follow-up backup phrase';
afterEach(async () => { await Promise.all(roots.splice(0).map(root => removeFixture(root))); });
function fixture() {
  const directory = privateTempRoot(join(realpathSync(tmpdir()), 'RealBud followup backup ')); roots.push(directory);
  const key = randomBytes(32), workspaceId = randomUUID();
  plantPrivateFiles([[join(directory, 'company-installation/workspace.json'), JSON.stringify({ version: 1, id: workspaceId, workerMemberKey: null })],
    [join(directory, 'desk.json'), JSON.stringify(encryptJson(key, emptyV3({ name: 'Fictional follow-up office', timezone: 'UTC', jurisdictions: [] })))]]);
  const service = createPrivateWorkspaceBackup({ directory, key: () => key, workspaceId, epoch: () => 'fixture', assertIdle: () => {}, assertFresh: () => {} });
  const file = join(directory, 'bill-followups.json');
  let latest: RoutineResult | null = null;
  const store = () => createBillFollowUps({ file, latest: () => latest, recovery: () => false, now: () => 1_000 });
  const publish = (ids: number[]) => { latest = { workflow: 'weekly-bills', runId: `run-${ids.join('-')}`,
    findings: ids.map(n => ({ id: `arrival-${n}`, propertyId: 'fictional-property', label: `Water · Fictional utility ${n}`, state: 'missing-review', from: '2026-09-20', to: '2026-09-25', reason: 'Review the original sources.' })) } as RoutineResult; };
  return { directory, key, workspaceId, file, service, store, publish };
}
type Snapshot = { files: { path: string; sha256: string; bytes: number; base64: string }[] };
function alterFollowUps(backup: PrivateWorkspaceBackup, change: (value: { items: Record<string, unknown>[] }) => void) {
  const key = scryptSync(phrase, Buffer.from(backup.salt, 'hex'), 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  try {
    const snapshot = decryptJson(key, backup.payload) as Snapshot, saved = snapshot.files.find(f => f.path === 'bill-followups.json')!;
    const value = JSON.parse(Buffer.from(saved.base64, 'base64').toString('utf8')); change(value);
    const data = Buffer.from(JSON.stringify(value));
    Object.assign(saved, { sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length, base64: data.toString('base64') });
    return { ...backup, payload: encryptJson(key, snapshot) };
  } finally { key.fill(0); }
}

describe('bill follow-ups through private backup (fictional)', () => {
  it('round-trips owners, notes, dates, resolve/reopen history and revisions exactly', async () => {
    const from = fixture(), to = fixture(); from.publish([1, 2]);
    const store = from.store(), [a, b] = (await store.page()).items;
    await store.change({ id: a.id, expectedRevision: a.revision, action: 'plan', owner: 'Fictional Kevin', followUpOn: '2026-10-09' });
    await store.change({ id: b.id, expectedRevision: b.revision, action: 'resolve', note: 'Fictional supplier confirmed.' });
    await store.change({ id: b.id, expectedRevision: b.revision + 1, action: 'reopen', note: 'Fictional: still missing.' });
    const before = readFileSync(from.file, 'utf8'), all = await store.page({ filter: 'all' });
    const exported = await from.service.exportBackup(phrase);
    expect(JSON.stringify(exported.backup)).not.toContain('Fictional Kevin');
    await to.service.stageRestore({ backup: exported.backup, passphrase: phrase, expectedDigest: exported.receipt.digest });
    await applyStagedPrivateRestore({ directory: to.directory, key: to.key });
    expect(readFileSync(to.file, 'utf8')).toBe(before);
    to.publish([1, 2]); // the same weekly result keeps every decision
    const restored = await to.store().page({ filter: 'all' });
    expect(restored).toEqual(all);
    expect(restored.items.find(i => i.id === b.id)).toMatchObject({ revision: b.revision + 2, status: 'open' });
  });

  it('restores an older backup without the file as an empty store', async () => {
    const from = fixture(), to = fixture();
    const exported = await from.service.exportBackup(phrase);
    await to.service.stageRestore({ backup: exported.backup, passphrase: phrase, expectedDigest: exported.receipt.digest });
    await applyStagedPrivateRestore({ directory: to.directory, key: to.key });
    expect((await to.store().page({ filter: 'all' })).total).toBe(0);
  });

  it('refuses a damaged or extended follow-up file at capture and at restore', async () => {
    const from = fixture(), to = fixture(); from.publish([1]);
    await from.store().page();
    const exported = await from.service.exportBackup(phrase);
    const extended = alterFollowUps(exported.backup, value => { value.items[0].unexpected = 'Fictional extra field'; });
    await expect(to.service.stageRestore({ backup: extended, passphrase: phrase, expectedDigest: 'x'.repeat(64) })).rejects.toThrow(/follow-ups need recovery/);
    const duplicated = alterFollowUps(exported.backup, value => { value.items.push(value.items[0]); });
    await expect(to.service.previewBackup(duplicated, phrase)).rejects.toThrow(/follow-ups need recovery/);
    const saved = JSON.parse(readFileSync(from.file, 'utf8')); saved.extra = true;
    writeFileSync(from.file, JSON.stringify(saved)); chmodSync(from.file, 0o600);
    await expect(from.service.exportBackup(phrase)).rejects.toThrow(/follow-ups need recovery/);
  });

  it('refuses an unknown follow-up field in the v2 catalog', async () => {
    const root = privateTempRoot(join(realpathSync(tmpdir()), 'RealBud followup catalog ')); roots.push(root);
    const workspaceId = randomUUID();
    const catalog = await PrivateBackupCatalog.create({ directory: join(root, 'catalog'), key: randomBytes(32), workspaceId, maxEntries: 100, maxBytes: 16 * 1024 * 1024 });
    try {
      const file = { version: 1, revision: 1, syncedRunId: 'run-1', items: [], unexpected: true };
      expect(() => catalog.addFile({ path: 'bill-followups.json', encoding: 'bytes', data: Buffer.from(JSON.stringify(file)) })).toThrow();
      const { unexpected: _, ...valid } = file;
      catalog.addFile({ path: 'bill-followups.json', encoding: 'bytes', data: Buffer.from(JSON.stringify(valid)) });
    } finally { catalog.close(); }
  });
});
