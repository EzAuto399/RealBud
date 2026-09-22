import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const { DISK_FULL_MESSAGE, DiskFullError, readPrivateJson, writePrivateJson } = await import('./private-json.ts');

let directory = '';
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'realbud-private-json-')); fault.at = null; fault.code = 'ENOSPC'; });
afterEach(() => { fault.at = null; rmSync(directory, { recursive: true, force: true }); });

const file = () => join(directory, 'state', 'record.json');
const leftovers = () => readdirSync(join(directory, 'state')).filter(name => name.endsWith('.tmp'));

describe('private JSON writes on a full disk', () => {
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
    chmodSync(file(), 0o644);
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
