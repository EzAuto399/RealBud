import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, chmodSync, linkSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createBackupTransferStore, BACKUP_TRANSFER_CHUNK_BYTES as CHUNK, BACKUP_TRANSFER_MAX_BYTES, BACKUP_TRANSFER_CANCEL_RETENTION_MS, BACKUP_TRANSFER_JOURNAL_BYTES } from './private-backup-transfer.ts';

const sha = (v: Uint8Array | string) => createHash('sha256').update(v).digest('hex');
const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const paths: string[] = [], stores: Awaited<ReturnType<typeof createBackupTransferStore>>[] = [], children: ChildProcess[] = [];
const folder = () => { const path = mkdtempSync(join(realpathSync(tmpdir()), 'RealBud upload Ω ')); paths.push(path); return path; };
async function store(options: Partial<Parameters<typeof createBackupTransferStore>[0]> = {}) {
  const settings = { directory: join(folder(), 'transfers'), key: randomBytes(32), workspaceId, ...options };
  const value = await createBackupTransferStore(settings); stores.push(value); return { value, settings };
}
afterEach(async () => {
  for (const value of stores.splice(0)) await value.close().catch(() => {});
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGKILL'); await done; }
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});
async function upload(value: Awaited<ReturnType<typeof createBackupTransferStore>>, parts: Buffer[], id = randomUUID()) {
  await value.start(id, parts.reduce((size, p) => size + p.length, 0));
  const tuples: [number, number, string][] = []; let offset = 0;
  for (const data of parts) { await value.append(id, offset, data, sha(data)); tuples.push([offset, data.length, sha(data)]); offset += data.length; }
  return { id, commitment: sha(JSON.stringify(tuples)) };
}

describe('durable bounded backup ciphertext uploads', () => {
  it('resumes an exact prefix after reopening, seals the full file and retains a staged upload', async () => {
    const { value, settings } = await store(), id = randomUUID(), first = Buffer.alloc(CHUNK, 7), last = Buffer.from('last ciphertext bytes');
    expect(await value.start(id, first.length + last.length)).toMatchObject({ offset: 0, prefixDigest: sha('[]') });
    const accepted = await value.append(id, 0, first, sha(first));
    expect(accepted.prefixDigest).toBe(sha(JSON.stringify([[0, first.length, sha(first)]])));
    await value.close();
    const { value: reopened } = await store(settings);
    expect(await reopened.status(id)).toEqual(accepted);
    expect(await reopened.append(id, 0, first, sha(first))).toEqual(accepted);
    await reopened.append(id, CHUNK, last, sha(last));
    const commitment = sha(JSON.stringify([[0, first.length, sha(first)], [CHUNK, last.length, sha(last)]]));
    const completed = await reopened.seal(id, commitment);
    expect(completed).toMatchObject({ state: 'uploaded', offset: first.length + last.length, digest: sha(Buffer.concat([first, last])), manifestDigest: commitment, prefixDigest: commitment });
    expect(await reopened.seal(id, commitment)).toEqual(completed);
    const artifact = await reopened.artifact(id); expect(readFileSync(artifact.path)).toEqual(Buffer.concat([first, last]));
    expect((await reopened.markStaged(id, completed.digest!)).state).toBe('staged');
    await expect(reopened.cancel(id)).rejects.toThrow(/staged/);
    expect(readFileSync(artifact.path)).toEqual(Buffer.concat([first, last]));
  });

  it.each(['intent-saved', 'data-written', 'data-synced', 'receipt-saved'] as const)('recovers exact retry after interruption at %s', async point => {
    let crashed = false;
    const { value, settings } = await store({ fault: at => { if (at === point && !crashed) { crashed = true; throw new Error('Fictional interruption'); } } });
    const id = randomUUID(), data = Buffer.from('ciphertext fixture'); await value.start(id, data.length);
    await expect(value.append(id, 0, data, sha(data))).rejects.toThrow('Fictional interruption'); await value.close();
    const { value: next } = await store({ ...settings, fault: undefined });
    const recovered = await next.status(id);
    expect(recovered.offset).toBe(point === 'intent-saved' ? 0 : data.length);
    const accepted = await next.append(id, 0, data, sha(data)); expect(accepted.offset).toBe(data.length);
    const sealed = await next.seal(id, sha(JSON.stringify([[0, data.length, sha(data)]]))); expect(sealed.digest).toBe(sha(data));
  });

  it('does not acknowledge cache-visible recovered bytes before the recovery fsync boundary', async () => {
    const { value, settings } = await store({ fault: point => { if (point === 'data-written') throw new Error('write before sync interrupted'); } });
    const id = randomUUID(), data = Buffer.from('full write without receipt'); await value.start(id, data.length);
    await expect(value.append(id, 0, data, sha(data))).rejects.toThrow('write before sync interrupted'); await value.close();
    const { value: held } = await store({ ...settings, fault: point => { if (point === 'recovery-before-sync') throw new Error('recovery sync unavailable'); } });
    await expect(held.status(id)).rejects.toThrow('recovery sync unavailable'); await held.close();
    const { value: recovered } = await store({ ...settings, fault: undefined }); expect((await recovered.status(id)).offset).toBe(data.length);
    expect((await recovered.seal(id, sha(JSON.stringify([[0, data.length, sha(data)]])))).digest).toBe(sha(data));
  });

  it('rejects same-size post-seal replacement before artifact use, seal replay or staging', async () => {
    const { value, settings } = await store(), data = Buffer.from('sealed ciphertext'), { id, commitment } = await upload(value, [data]);
    const sealed = await value.seal(id, commitment); writeFileSync(join(settings.directory, `${id}.ciphertext`), Buffer.alloc(data.length, 1));
    await expect(value.artifact(id)).rejects.toThrow(/bytes changed/);
    await expect(value.seal(id, commitment)).rejects.toThrow(/bytes changed/);
    await expect(value.markStaged(id, sealed.digest!)).rejects.toThrow(/bytes changed/);
    expect((await value.status(id)).state).toBe('uploaded'); // status is a receipt, not a fresh integrity claim
  });

  it('expires only old cancelled transport receipts, retaining active/staged work and bounded journal pages', async () => {
    let at = Date.now(); const { value, settings } = await store({ now: () => at });
    const cancelled = await upload(value, [Buffer.from('cancel')]); await value.cancel(cancelled.id);
    const staged = await upload(value, [Buffer.from('stage')]); const seal = await value.seal(staged.id, staged.commitment); await value.markStaged(staged.id, seal.digest!);
    const active = randomUUID(); await value.start(active, 5);
    expect(await value.pruneCancelled()).toBe(0); at += BACKUP_TRANSFER_CANCEL_RETENTION_MS + 1;
    expect(await value.pruneCancelled()).toBe(1); await expect(value.status(cancelled.id)).rejects.toMatchObject({ status: 404 });
    expect((await value.status(staged.id)).state).toBe('staged'); expect((await value.status(active)).state).toBe('uploading');
    const db = new DatabaseSync(join(settings.directory, 'transfers.sqlite'));
    try { expect(db.prepare('SELECT count(*) AS n FROM chunks WHERE id=?').get(cancelled.id)?.n).toBe(0); }
    finally { db.close(); }
    expect(statSync(join(settings.directory, 'transfers.sqlite')).size).toBeLessThan(BACKUP_TRANSFER_JOURNAL_BYTES);
  });

  it('holds partial writes without guessing receipt success, and explicit cancel only removes that copy', async () => {
    const root = folder(), directory = join(root, 'transfers'), original = join(root, 'original.backup');
    const data = Buffer.from('original encrypted file'); writeFileSync(original, data, { mode: 0o600 });
    const { value, settings } = await store({ directory, fault: (point, id) => { if (point === 'intent-saved') { appendFileSync(join(directory, `${id}.ciphertext`), data.subarray(0, 3)); throw new Error('partial write'); } } });
    const id = randomUUID(); await value.start(id, data.length); await expect(value.append(id, 0, data, sha(data))).rejects.toThrow('partial write'); await value.close();
    const { value: next } = await store({ ...settings, fault: undefined });
    await expect(next.status(id)).rejects.toThrow(/interrupted backup chunk/);
    expect(readFileSync(join(directory, `${id}.ciphertext`))).toEqual(data.subarray(0, 3));
    expect((await next.cancel(id)).state).toBe('cancelled'); expect(readFileSync(original)).toEqual(data);
    expect(() => statSync(join(directory, `${id}.ciphertext`))).toThrow();
  });

  it('replays a cancelled receipt after interruption before cleanup and never recreates cancelled data', async () => {
    const { value, settings } = await store({ fault: point => { if (point === 'cancel-saved') throw new Error('cancel interruption'); } });
    const { id } = await upload(value, [Buffer.from('ciphertext')]); await expect(value.cancel(id)).rejects.toThrow('cancel interruption'); await value.close();
    const { value: next } = await store({ ...settings, fault: undefined });
    expect((await next.status(id)).state).toBe('cancelled'); expect(() => statSync(join(settings.directory, `${id}.ciphertext`))).toThrow();
    await expect(next.start(id, 10)).rejects.toThrow(/already bound/);
  });

  it('refuses changed retries, gaps, short intermediate chunks and wrong hashes without advancing', async () => {
    const { value } = await store(), id = randomUUID(), data = Buffer.alloc(CHUNK, 1);
    await value.start(id, CHUNK + 3);
    await expect(value.append(id, 0, data.subarray(0, 10), sha(data.subarray(0, 10)))).rejects.toThrow(/saved upload position/);
    await expect(value.append(id, CHUNK, Buffer.alloc(3), sha(Buffer.alloc(3)))).rejects.toThrow(/saved upload position/);
    await expect(value.append(id, 0, data, '0'.repeat(64))).rejects.toThrow(/invalid/);
    await value.append(id, 0, data, sha(data));
    const changed = Buffer.alloc(CHUNK, 2); await expect(value.append(id, 0, changed, sha(changed))).rejects.toThrow(/differs/);
    expect((await value.status(id)).offset).toBe(CHUNK);
    await expect(value.seal(id, '0'.repeat(64))).rejects.toThrow(/not finished/);
  });

  it('serializes two tabs and copies input bytes before the queue admits them', async () => {
    const { value } = await store(), id = randomUUID(), data = Buffer.from('ciphertext'); await value.start(id, data.length);
    const original = Buffer.from(data), digest = sha(data);
    const first = value.append(id, 0, data, digest), second = value.append(id, 0, data, digest); data.fill(0);
    expect(await first).toEqual(await second);
    const completed = await value.seal(id, sha(JSON.stringify([[0, original.length, digest]])));
    expect(completed.digest).toBe(digest);
  });

  it('checks all accepted bytes when sealing and binds the client prefix commitment', async () => {
    const { value, settings } = await store(), data = Buffer.from('encrypted fixture'), { id, commitment } = await upload(value, [data]);
    await expect(value.seal(id, '0'.repeat(64))).rejects.toThrow(/differs/);
    const changed = Buffer.from(data); changed[0] ^= 1; writeFileSync(join(settings.directory, `${id}.ciphertext`), changed);
    await expect(value.seal(id, commitment)).rejects.toThrow(/chunk check/);
    expect((await value.status(id)).state).toBe('uploading');
  });

  it('rejects missing, oversized and altered journal data without removing evidence', async () => {
    const { value, settings } = await store(), id = randomUUID(); await value.start(id, 3);
    appendFileSync(join(settings.directory, `${id}.ciphertext`), 'changed'); await expect(value.status(id)).rejects.toThrow(/changed unexpectedly/);
    await value.close(); const db = new DatabaseSync(join(settings.directory, 'transfers.sqlite'));
    db.prepare('UPDATE operations SET payload=? WHERE id=?').run('{}', id); db.close();
    const { value: next } = await store(settings); await expect(next.status(id)).rejects.toThrow(/journal needs recovery/);
    expect(readFileSync(join(settings.directory, `${id}.ciphertext`), 'utf8')).toBe('changed');
  });

  it('admits only bounded operation sizes and four active copies, with private encrypted receipts', async () => {
    const { value, settings } = await store();
    for (const size of [0, -1, 1.5, BACKUP_TRANSFER_MAX_BYTES + 1]) await expect(value.start(randomUUID(), size)).rejects.toThrow(/1 GiB/);
    await expect(value.start('../escape', 10)).rejects.toThrow(/1 GiB/);
    const ids = Array.from({ length: 4 }, () => randomUUID()); for (const id of ids) await value.start(id, 1);
    await expect(value.start(randomUUID(), 1)).rejects.toThrow(/earlier backup transfer/);
    await value.cancel(ids[0]); await value.start(randomUUID(), 1);
    await expect(value.start(ids[1], 2)).rejects.toThrow(/another request/);
    const raw = readFileSync(join(settings.directory, 'transfers.sqlite')); expect(raw.includes(Buffer.from(workspaceId))).toBe(false); expect(raw.includes(Buffer.from(settings.key.toString('hex')))).toBe(false);
    if (process.platform !== 'win32') expect(statSync(join(settings.directory, 'transfers.sqlite')).mode & 0o077).toBe(0);
  });

  it('refuses a live owner and allows a graceful close without age-based takeover', async () => {
    const { value, settings } = await store(); await expect(createBackupTransferStore(settings)).rejects.toThrow(/running service/);
    await value.close(); const { value: next } = await store(settings); expect((await next.start(randomUUID(), 1)).state).toBe('uploading');
  });

  it('recovers a saved chunk after the owning service really exits', async () => {
    const directory = join(folder(), 'transfers'), key = randomBytes(32), id = randomUUID();
    const source = `import { createBackupTransferStore } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'server/private-backup-transfer.ts')).href)};
const chunks=[]; for await (const b of process.stdin) chunks.push(b); const p=JSON.parse(Buffer.concat(chunks));
const s=await createBackupTransferStore({...p,key:Buffer.from(p.key,'hex')}); await s.start(p.id,3); await s.append(p.id,0,Buffer.from('abc'),'${sha('abc')}'); console.log('ready'); setTimeout(()=>process.exit(4),30000);`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { env: { PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'pipe'] }); children.push(child);
    child.stdin!.end(JSON.stringify({ directory, key: key.toString('hex'), workspaceId, id }));
    let diagnostics = ''; child.stderr!.on('data', data => { diagnostics = (diagnostics + data).slice(-1000); });
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Fixture owner did not start: ' + diagnostics)), 10000); child.stdout!.once('data', () => { clearTimeout(timer); resolve(); }); child.once('error', error => { clearTimeout(timer); reject(error); }); });
    await expect(createBackupTransferStore({ directory, key, workspaceId })).rejects.toThrow(/running service/);
    const done = once(child, 'exit'); child.kill('SIGKILL'); await done;
    const { value } = await store({ directory, key }); expect((await value.status(id)).offset).toBe(3);
    expect((await value.seal(id, sha(JSON.stringify([[0, 3, sha('abc')]])))).digest).toBe(sha('abc'));
  });

  it.skipIf(process.platform === 'win32')('rejects symlinks, hardlinks and public permissions without repairing them', async () => {
    const { value, settings } = await store(), id = randomUUID(); await value.start(id, 1);
    const path = join(settings.directory, `${id}.ciphertext`), linked = join(folder(), 'linked'); linkSync(path, linked);
    await expect(value.status(id)).rejects.toThrow(/needs recovery/); expect(statSync(path).nlink).toBe(2);
    const root = folder(), actual = join(root, 'actual'); writeFileSync(actual, '{}', { mode: 0o600 }); symlinkSync(actual, join(root, 'transfers.sqlite'));
    await expect(createBackupTransferStore({ ...settings, directory: root })).rejects.toThrow(/needs recovery/);
    const other = folder(); chmodSync(other, 0o755); await expect(createBackupTransferStore({ ...settings, directory: other })).rejects.toThrow(/not private/); expect(statSync(other).mode & 0o077).toBe(0o055);
  });
});
