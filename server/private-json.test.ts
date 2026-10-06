import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A full disk is injected at the file handle, the only place a real write can
// hit it, so the production write path runs unchanged around the failure.
const fault = vi.hoisted(() => ({ at: null as null | 'open' | 'write' | 'sync', code: 'ENOSPC' }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const failure = () => Object.assign(new Error(`${fault.code}: synthetic disk failure`), { code: fault.code });
  const open = async (...args: Parameters<typeof real.open>): Promise<FileHandle> => {
    const temporary = String(args[0]).endsWith('.tmp');
    if (temporary && fault.at === 'open') throw failure();
    const handle = await real.open(...args);
    if (!temporary || !fault.at) return handle;
    return new Proxy(handle, {
      get(target, key) {
        if (key === 'writeFile' && fault.at === 'write') {
          // Part of the payload lands before the disk fills, as it would.
          return async (data: string) => { await target.writeFile(data.slice(0, 4)); throw failure(); };
        }
        if (key === 'sync' && fault.at === 'sync') return async () => { throw failure(); };
        const value = Reflect.get(target, key) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  return { ...real, default: { ...real, open }, open };
});

const { DISK_FULL_MESSAGE, DiskFullError, PrivateStorageError, StoreTooLargeError, privateDirectory, readPrivateJson, readPrivateJsonWithFallback, trimOldestToBytes, writePrivateJson } = await import('./private-json.ts');

let directory = '';
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'realbud-private-json-')); fault.at = null; fault.code = 'ENOSPC'; });
afterEach(() => { fault.at = null; rmSync(directory, { recursive: true, force: true }); });

const file = () => join(directory, 'state', 'record.json');
const leftovers = () => readdirSync(join(directory, 'state')).filter(name => name.endsWith('.tmp'));

describe('private JSON writes on a full disk', () => {
  it('supports readable worker input without changing private admission or atomic recovery', async () => {
    await writePrivateJson(file(), { rows: [{ value: 'fictional' }] }, undefined, 'readable');
    const before = readFileSync(file(), 'utf8');
    expect(before.split('\n').length).toBeGreaterThan(3);
    expect(await readPrivateJson(file())).toEqual({ rows: [{ value: 'fictional' }] });
    fault.at = 'write';
    await expect(writePrivateJson(file(), { rows: [] }, undefined, 'readable')).rejects.toBeInstanceOf(DiskFullError);
    expect(readFileSync(file(), 'utf8')).toBe(before);
    expect(leftovers()).toEqual([]);
  });
  it.each([
    ['ENOSPC', 'write'],
    ['EDQUOT', 'sync'],
    ['ENOSPC', 'open'],
  ] as const)('reports %s during %s as out of disk space and keeps the saved file', async (code, at) => {
    await writePrivateJson(file(), { revision: 1 });
    fault.code = code; fault.at = at;

    const failure = await writePrivateJson(file(), { revision: 2 }).then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(DiskFullError);
    expect(failure).toMatchObject({ message: DISK_FULL_MESSAGE, status: 507, code: 'disk_full' });
    expect((failure as Error).message).toBe('This computer is out of disk space. Free some space, then try again.');
    expect(((failure as Error).cause as NodeJS.ErrnoException).code).toBe(code);
    expect(leftovers()).toEqual([]);
    fault.at = null;
    expect(await readPrivateJson(file())).toEqual({ revision: 1 });
    // Once space is free the same write succeeds; nothing was held for recovery.
    await writePrivateJson(file(), { revision: 2 });
    expect(await readPrivateJson(file())).toEqual({ revision: 2 });
  });

  it.skipIf(process.platform === 'win32')('still reports real damage as needing recovery and preserves it', async () => {
    await writePrivateJson(file(), { revision: 1 });
    linkSync(file(), join(directory, 'second-name.json'));
    fault.at = 'write';

    const failure = await writePrivateJson(file(), { revision: 2 }).then(() => null, (error: unknown) => error);

    expect(failure).not.toBeInstanceOf(DiskFullError);
    expect((failure as Error).message).toBe('Private state file needs recovery.');
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({ revision: 1 });
    expect(leftovers()).toEqual([]);
  });

  it('leaves other write failures unchanged', async () => {
    writeFileSync(join(directory, 'blocker'), '');
    const failure = await writePrivateJson(join(directory, 'blocker', 'record.json'), {}).then(() => null, (error: unknown) => error);
    expect(failure).not.toBeInstanceOf(DiskFullError);
    expect((failure as NodeJS.ErrnoException).code).toMatch(/^(EEXIST|ENOTDIR)$/);
  });
});

describe.skipIf(process.platform === 'win32')('owner-only private storage', () => {
  const quiet = () => vi.spyOn(console, 'warn').mockImplementation(() => {});

  it('tightens an owned folder that is only too open, keeping its contents', async () => {
    await writePrivateJson(file(), { revision: 1 });
    chmodSync(join(directory, 'state'), 0o755);
    const warn = quiet();
    try {
      await writePrivateJson(file(), { revision: 2 });
      expect(statSync(join(directory, 'state')).mode & 0o777).toBe(0o700);
      expect(await readPrivateJson(file())).toEqual({ revision: 2 });
      expect(warn.mock.calls.map(call => String(call[0]))).toEqual([
        '[storage] A RealBud storage folder was open to other accounts; RealBud limited it to this account.',
      ]);
    } finally { warn.mockRestore(); }
  });

  it('refuses a file other accounts could read: its secrets may already have been seen', async () => {
    await writePrivateJson(file(), { revision: 1 });
    chmodSync(file(), 0o644);
    await expect(readPrivateJson(file())).rejects.toThrow('Private state file needs recovery.');
    expect(statSync(file()).mode & 0o777).toBe(0o644);
  });

  it('still refuses a linked folder and a foreign owner with a plain, path-free reason', async () => {
    const real = join(directory, 'real'); mkdirSync(real, { mode: 0o700 });
    const linked = join(directory, 'linked'); symlinkSync(real, linked);
    const refusal = await privateDirectory(linked).then(() => null, (error: unknown) => error);
    expect(refusal).toBeInstanceOf(PrivateStorageError);
    expect((refusal as Error).message).toMatch(/^A RealBud storage folder is a shortcut to another location/);

    await writePrivateJson(file(), { revision: 1 });
    chmodSync(file(), 0o644);
    const uid = vi.spyOn(process, 'getuid').mockReturnValue((process.getuid?.() ?? 0) + 1);
    try {
      for (const attempt of [readPrivateJson(file()), privateDirectory(join(directory, 'state'))]) {
        const error = await attempt.then(() => null, (failure: unknown) => failure);
        expect(error).toMatchObject({ status: 503, code: 'private_storage_refused' });
        expect((error as Error).message).toMatch(/belongs to another account on this Mac/);
        expect((error as Error).message).not.toContain(directory);
      }
    } finally { uid.mockRestore(); }
    expect(statSync(file()).mode & 0o777).toBe(0o644);
  });
});

describe('store growth', () => {
  const admission = (maxBytes: number) => ({ maxBytes, validate: () => {}, keepPrevious: true });
  const names = () => readdirSync(join(directory, 'state')).sort();
  const strict = (value: unknown) => { if (!value || typeof value !== 'object' || !('revision' in value)) throw new Error('invalid'); };

  it('refuses a new value past the read cap before writing, so the saved file stays readable', async () => {
    await writePrivateJson(file(), { rows: ['a'] }, admission(200));
    const failure = await writePrivateJson(file(), { rows: ['x'.repeat(300)] }, admission(200)).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(StoreTooLargeError);
    expect(failure).toMatchObject({ status: 507, code: 'store_too_large' });
    expect((failure as Error).message).toMatch(/grown too large to save; older items need archiving/);
    expect(await readPrivateJson(file(), 200)).toEqual({ rows: ['a'] });
    expect(leftovers()).toEqual([]);
  });

  it('keeps the replaced version as .prev and restores it when the main file is damaged, keeping the damage', async () => {
    await writePrivateJson(file(), { revision: 1 }, admission(1000));
    await writePrivateJson(file(), { revision: 2 }, admission(1000));
    expect(JSON.parse(readFileSync(`${file()}.prev`, 'utf8'))).toEqual({ revision: 1 });
    expect(statSync(`${file()}.prev`).mode & 0o777).toBe(process.platform === 'win32' ? statSync(`${file()}.prev`).mode & 0o777 : 0o600);
    writeFileSync(file(), '{"revision": 2', { mode: 0o600 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await readPrivateJsonWithFallback(file(), 1000, strict)).toEqual({ revision: 1 });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally { warn.mockRestore(); }
    const damaged = names().find(name => name.startsWith('record.json.damaged-'));
    expect(damaged && readFileSync(join(directory, 'state', damaged), 'utf8')).toBe('{"revision": 2');
    expect(await readPrivateJson(file(), 1000)).toEqual({ revision: 1 });
    // A value that fails the store's own check falls back the same way.
    writeFileSync(file(), '{"other": true}', { mode: 0o600 });
    const quiet = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try { expect(await readPrivateJsonWithFallback(file(), 1000, strict)).toEqual({ revision: 1 }); } finally { quiet.mockRestore(); }
  });

  it('still reports recovery when there is no good .prev, leaving the damaged file in place', async () => {
    await writePrivateJson(file(), { revision: 1 }, admission(1000));
    writeFileSync(file(), 'not json', { mode: 0o600 });
    await expect(readPrivateJsonWithFallback(file(), 1000, strict)).rejects.toThrow();
    expect(readFileSync(file(), 'utf8')).toBe('not json');
  });

  it('sets aside a .prev left from before the main file went missing, never restoring it', async () => {
    await writePrivateJson(file(), { revision: 1 }, admission(1000));
    await writePrivateJson(file(), { revision: 2 }, admission(1000));
    rmSync(file());
    await writePrivateJson(file(), { revision: 9 }, admission(1000));
    expect(names().some(name => name === 'record.json.prev')).toBe(false);
    expect(names().some(name => name.startsWith('record.json.prev-'))).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('never uses .prev for a linked or foreign main file, or a linked .prev', async () => {
    await writePrivateJson(file(), { revision: 1 }, admission(1000));
    await writePrivateJson(file(), { revision: 2 }, admission(1000));
    const other = join(directory, 'other.json'); writeFileSync(other, 'garbage', { mode: 0o600 });
    rmSync(file()); symlinkSync(other, file());
    await expect(readPrivateJsonWithFallback(file(), 1000, strict)).rejects.toThrow('Private state file needs recovery.');
    expect(lstatSync(file()).isSymbolicLink()).toBe(true);
    expect(names().filter(name => name.includes('damaged'))).toEqual([]);
    rmSync(file()); writeFileSync(file(), 'garbage', { mode: 0o600 });
    const uid = vi.spyOn(process, 'getuid').mockReturnValue((process.getuid?.() ?? 0) + 1);
    try { await expect(readPrivateJsonWithFallback(file(), 1000, strict)).rejects.toBeInstanceOf(PrivateStorageError); } finally { uid.mockRestore(); }
    chmodSync(file(), 0o644);
    await expect(readPrivateJsonWithFallback(file(), 1000, strict)).rejects.toThrow('Private state file needs recovery.');
    chmodSync(file(), 0o600);
    const good = join(directory, 'good.json'); writeFileSync(good, '{"revision": 1}', { mode: 0o600 });
    rmSync(`${file()}.prev`); symlinkSync(good, `${file()}.prev`);
    await expect(readPrivateJsonWithFallback(file(), 1000, strict)).rejects.toThrow();
    expect(readFileSync(file(), 'utf8')).toBe('garbage');
    expect(names().filter(name => name.includes('damaged'))).toEqual([]);
  });

  it('trims the oldest droppable rows to the byte budget and keeps the rest', () => {
    const rows = Array.from({ length: 10 }, (_, index) => ({ index, keep: index % 3 === 0, pad: 'x'.repeat(90) }));
    const kept = trimOldestToBytes(rows, 800, row => !row.keep);
    expect(kept.map(row => row.index)).toEqual([0, 3, 6, 7, 8, 9]);
    expect(Buffer.byteLength(JSON.stringify(kept))).toBeLessThanOrEqual(800);
    // Rows that may not be dropped stay even when they alone exceed the budget.
    expect(trimOldestToBytes(rows, 10, row => !row.keep).map(row => row.index)).toEqual([0, 3, 6, 9]);
    expect(trimOldestToBytes(rows, 1_000_000, () => true)).toBe(rows);
  });
});
