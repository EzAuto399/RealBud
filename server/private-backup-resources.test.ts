import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createPrivateBackupResources, type BackupResourceBinding, type PrivateBackupResourcesOptions } from './private-backup-resources.ts';
import { PrivateBackupCatalog } from './private-backup-catalog.ts';
import { emptyV3 } from '../shared/desk-v3.ts';
import { createBackupTransferStore } from './private-backup-transfer.ts';

const roots: string[] = [], closers: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function fixture(role: BackupResourceBinding['allocation']['role'] = 'archive', fault?: PrivateBackupResourcesOptions['fault']) {
  const root = await mkdtemp(join(realpathSync(tmpdir()), 'RealBud owned backup resource ')); roots.push(root);
  const directory = join(root, 'private-backup-v2'), key = randomBytes(32);
  let current: BackupResourceBinding = { workspaceId: randomUUID(), operationId: randomUUID(), allocation: { id: randomUUID(), nonce: randomUUID(), role, bytes: 32 * 1024 ** 2, state: 'allocated' } }, drained = true, admitted = true;
  const settings = { directory, key, fault, assertCurrent(b: BackupResourceBinding, action: 'read' | 'claim' | 'remove') {
    if (!admitted || JSON.stringify(b) !== JSON.stringify(current) || action === 'remove' && !drained) throw Object.assign(new Error('Fixture ownership or writer hold'), { status: 409 });
  } };
  const service = createPrivateBackupResources(settings); closers.push(() => service.close());
  return { root, directory, key, settings, service, get binding() { return structuredClone(current); },
    deleting() { current.allocation.state = 'deleting'; return structuredClone(current); }, drained(value: boolean) { drained = value; }, admitted(value: boolean) { admitted = value; },
    marker: () => join(directory, 'claims', `${current.allocation.id}.json`), candidate: () => join(directory, 'claims', `.${current.allocation.id}.${current.allocation.nonce}.tmp`) };
}
async function dataFile(directory: string, filename: string, value = 'Fictional owned encrypted data') { await mkdir(directory, { mode: 0o700 }); await writeFile(join(directory, filename), value, { mode: 0o600 }); }

describe('journal-bound backup resource ownership', () => {
  it('can cancel an allocation whose process stopped before any resource folder was created', async () => {
    const f = await fixture(); expect(existsSync(f.directory)).toBe(false);
    expect(await f.service.inspect(f.binding)).toMatchObject({ claimed: false, dataPresent: false, dataBytes: 0 });
    await f.service.remove(f.deleting()); expect(existsSync(f.directory)).toBe(false);
  });
  it('preserves an unreadable unpublished marker rather than treating it as an empty allocation', async () => {
    const f = await fixture(); await mkdir(join(f.directory, 'claims'), { recursive: true, mode: 0o700 });
    await writeFile(f.candidate(), 'Interrupted fixture marker', { mode: 0o600 });
    await expect(f.service.claim(f.binding)).rejects.toThrow('ownership');
    await expect(f.service.remove(f.deleting())).rejects.toThrow('ownership');
    expect(await readFile(f.candidate(), 'utf8')).toBe('Interrupted fixture marker');
  });
  it('claims before creation and removes an actual closed catalog without changing business files', async () => {
    const f = await fixture('capture'); await writeFile(join(f.root, 'business.csv'), 'Original business source', { mode: 0o600 });
    const claim = await f.service.claim(f.binding); expect(existsSync(claim.directory)).toBe(false);
    const savedMarker = await readFile(f.marker()); expect(savedMarker.includes(f.key)).toBe(false); expect(savedMarker.toString()).not.toContain(f.binding.workspaceId);
    const catalog = await PrivateBackupCatalog.create({ directory: claim.directory, key: f.key, workspaceId: f.binding.workspaceId, maxEntries: 10, maxBytes: 1024 ** 2 }); closers.push(() => catalog.close());
    catalog.addFile({ path: 'company-installation/workspace.json', encoding: 'bytes', data: Buffer.from(JSON.stringify({ version: 1, id: f.binding.workspaceId, workerMemberKey: null })) });
    catalog.addFile({ path: 'desk.json', encoding: 'json', data: Buffer.from(JSON.stringify(emptyV3({ name: 'Fictional resource office', timezone: 'UTC', jurisdictions: [] }))) }); catalog.seal();
    await expect(f.service.claim(f.binding)).resolves.toMatchObject({ existing: true });
    expect(await readFile(f.marker())).toEqual(savedMarker);
    expect(await f.service.inspect(f.binding)).toMatchObject({ claimed: true, dataPresent: true, files: 1, exceedsAllocation: false });
    const deleting = f.deleting(); f.drained(false);
    await expect(f.service.remove(deleting)).rejects.toMatchObject({ status: 409 }); expect(existsSync(claim.directory)).toBe(true);
    catalog.close(); f.drained(true); await f.service.remove(deleting); await f.service.remove(deleting);
    expect(existsSync(claim.directory)).toBe(false); expect(existsSync(f.marker())).toBe(false);
    expect(await readFile(join(f.root, 'business.csv'), 'utf8')).toBe('Original business source');
  });
  it('supports a per-operation upload store without rebinding historical workspace identity', async () => {
    const f = await fixture('upload'), claim = await f.service.claim(f.binding);
    const transfer = await createBackupTransferStore({ directory: claim.directory, key: f.key, workspaceId: f.binding.workspaceId }); closers.push(() => transfer.close());
    const bytes = Buffer.from('Fictional ciphertext'), hash = createHash('sha256').update(bytes).digest('hex');
    await transfer.start(f.binding.operationId, bytes.length); await transfer.append(f.binding.operationId, 0, bytes, hash);
    await transfer.seal(f.binding.operationId, createHash('sha256').update(JSON.stringify([[0, bytes.length, hash]])).digest('hex'));
    expect((await f.service.inspect(f.binding)).files).toBe(2);
    await transfer.close(); await f.service.remove(f.deleting()); expect(existsSync(claim.directory)).toBe(false);
  });
  it('requires persisted deleting intent and rejects stale or asynchronous ownership assertions', async () => {
    const f = await fixture(); await f.service.claim(f.binding);
    await expect(f.service.remove(f.binding)).rejects.toThrow('cleanup intent');
    const stale = f.binding; f.deleting(); await expect(f.service.claim(stale)).rejects.toThrow('ownership');
    const service = createPrivateBackupResources({ ...f.settings, async assertCurrent() { throw new Error('held'); } }); closers.push(() => service.close());
    await expect(service.inspect(f.binding)).rejects.toMatchObject({ status: 500 });
    expect(existsSync(f.marker())).toBe(true);
  });
  it('refuses pre-existing unclaimed data and malformed ownership records without overwriting them', async () => {
    const f = await fixture(), path = f.service.path(f.binding); await mkdir(path, { recursive: true, mode: 0o700 });
    await writeFile(join(path, 'archive.realbud-backup'), 'Keep original fixture', { mode: 0o600 });
    await expect(f.service.claim(f.binding)).rejects.toThrow('unclaimed');
    await expect(f.service.remove(f.deleting())).rejects.toThrow('no verified ownership');
    expect(await readFile(join(path, 'archive.realbud-backup'), 'utf8')).toBe('Keep original fixture');
  });
  it('preserves files when the marker is missing or its ciphertext changed', async () => {
    for (const mode of ['missing', 'changed']) {
      const f = await fixture(), { directory } = await f.service.claim(f.binding); await dataFile(directory, 'archive.realbud-backup');
      if (mode === 'missing') await unlink(f.marker());
      else { const envelope = JSON.parse(await readFile(f.marker(), 'utf8')); const ct = Buffer.from(envelope.ct, 'base64'); ct[0] ^= 1; envelope.ct = ct.toString('base64'); await writeFile(f.marker(), JSON.stringify(envelope), { mode: 0o600 }); }
      await expect(f.service.remove(f.deleting())).rejects.toThrow(/ownership/);
      expect(await readFile(join(directory, 'archive.realbud-backup'), 'utf8')).toBe('Fictional owned encrypted data');
    }
  });
  it('preflights every filename and preserves all contents when an unknown file appears', async () => {
    const f = await fixture(), { directory } = await f.service.claim(f.binding); await dataFile(directory, 'archive.realbud-backup');
    await writeFile(join(directory, 'unattributed.txt'), 'Unattributed fixture', { mode: 0o600 });
    await expect(f.service.remove(f.deleting())).rejects.toThrow('unexpected');
    expect((await readdir(directory)).sort()).toEqual(['archive.realbud-backup', 'unattributed.txt']); expect(existsSync(f.marker())).toBe(true);
  });
  it('never follows a substituted role-parent symlink while inspecting or removing resources', async () => {
    const f = await fixture(), { directory } = await f.service.claim(f.binding); await dataFile(directory, 'archive.realbud-backup');
    const parent = join(f.directory, 'exports'), other = join(f.root, 'other'); await rename(parent, other); await symlink(other, parent, 'dir');
    await expect(f.service.inspect(f.binding)).rejects.toThrow(); await expect(f.service.remove(f.deleting())).rejects.toThrow();
    expect(await readFile(join(other, f.binding.allocation.id, 'archive.realbud-backup'), 'utf8')).toBe('Fictional owned encrypted data');
  });
  it.each(['file-removed', 'directory-removed', 'claim-removed'] as const)('replays cleanup after interruption at %s', async point => {
    let stop = true;
    const f = await fixture('capture', p => { if (p === point && stop) { stop = false; throw new Error('Fixture interruption'); } });
    const { directory } = await f.service.claim(f.binding); await dataFile(directory, 'catalog.sqlite');
    await writeFile(join(directory, 'catalog.sqlite-journal'), 'Fictional journal', { mode: 0o600 }); const b = f.deleting();
    await expect(f.service.remove(b)).rejects.toThrow('Fixture interruption'); await f.service.remove(b);
    expect(existsSync(directory)).toBe(false); expect(existsSync(f.marker())).toBe(false);
  });
  it.each(['claim-ready', 'claim-linked'] as const)('recovers an authenticated claim after an actual killed publisher at %s', async point => {
    const f = await fixture();
    const program = `import {createPrivateBackupResources} from ${JSON.stringify(new URL('./private-backup-resources.ts', import.meta.url).href)}; let text='';for await(const c of process.stdin)text+=c;const v=JSON.parse(text);const s=createPrivateBackupResources({directory:v.directory,key:Buffer.from(v.key,'hex'),assertCurrent(){},fault(p){if(p===v.point){process.stdout.write('ready\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}}});await s.claim(v.binding);`;
    const envModule: string = '../scripts/service-smoke-env.mjs'; const { serviceSmokeEnv } = await import(envModule);
    const child = spawn(process.execPath, ['--input-type=module', '-e', program], { env: serviceSmokeEnv({ executable: process.execPath, home: f.root, data: f.root, scratch: f.root, port: 0 }), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', errors = '', timer: ReturnType<typeof setTimeout> | undefined;
    const closed = new Promise<void>((resolve, reject) => { child.once('close', () => resolve()); child.once('error', reject); }); child.stderr.on('data', c => { errors = (errors + c).slice(-1000); });
    const ready = new Promise<void>((resolve, reject) => { timer = setTimeout(() => reject(new Error(`Publisher did not initialize: ${errors}`)), 5000); child.stdout.on('data', c => { out = (out + c).slice(-100); if (out.includes('ready')) resolve(); }); void closed.then(() => reject(new Error(`Publisher exited: ${errors}`)), reject); });
    child.stdin.end(JSON.stringify({ directory: f.directory, key: f.key.toString('hex'), binding: f.binding, point }));
    try { await ready; } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; }
    const claim = await f.service.claim(f.binding); expect(existsSync(f.candidate())).toBe(false);
    expect(await f.service.inspect(f.binding)).toMatchObject({ claimed: true, dataPresent: false });
    await dataFile(claim.directory, 'archive.realbud-backup'); await f.service.remove(f.deleting()); expect(existsSync(f.marker())).toBe(false);
  }, 15_000);
});
