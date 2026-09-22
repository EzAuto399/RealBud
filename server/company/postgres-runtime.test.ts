// Admission rules for the office database runtime. These tests assert the
// security-relevant decisions (which directory may host the company database)
// without starting PostgreSQL; `openOwnedPostgres` has its own suite for the
// startup path.
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  PostgresRuntimeError,
  appResourcesDirectory,
  inspectPostgresRuntime,
  resolvePostgresRuntime,
  type PostgresRuntimeSource,
} from './postgres-runtime.ts';

const created: string[] = [];
afterEach(async () => {
  for (const directory of created.splice(0)) await rm(directory, { recursive: true, force: true });
});

/** A fake runtime directory. Files are real so the lstat/executable rules apply. */
async function fakeRuntime(binaries: string[], version = 'postgres (PostgreSQL) 16.15 (Homebrew)') {
  const directory = await mkdtemp(join(tmpdir(), 'rb-pg-admit-'));
  created.push(directory);
  for (const name of binaries) {
    const path = join(directory, name);
    await writeFile(path, '#!/bin/sh\nexit 0\n');
    if (process.platform !== 'win32') await chmod(path, 0o755);
  }
  const readVersion = async () => version;
  return { directory, readVersion: readVersion as (binary: string) => Promise<string> };
}

const ALL = ['postgres', 'initdb', 'pg_ctl'];

describe('admitted PostgreSQL runtime', () => {
  it('admits a runtime that provides every required executable and reports 16', async () => {
    const { directory, readVersion } = await fakeRuntime(ALL);
    const runtime = await inspectPostgresRuntime(directory, 'bundled', { readVersion, platform: 'darwin' });
    expect(runtime).toMatchObject({ source: 'bundled', version: expect.stringContaining('16.15') });
    // Admission returns the canonical path: on macOS the temp dir is reached
    // through /var but lives at /private/var, and callers need the real tree.
    expect(runtime?.binaryDirectory).toBe(await realpath(directory));
  });

  it('rejects a runtime missing any required executable', async () => {
    for (const missing of ALL) {
      const { directory, readVersion } = await fakeRuntime(ALL.filter(name => name !== missing));
      await expect(inspectPostgresRuntime(directory, 'bundled', { readVersion, platform: 'darwin' })).resolves.toBeNull();
    }
  });

  it('rejects a non-16 runtime rather than adopting a newer or older cluster', async () => {
    for (const version of ['postgres (PostgreSQL) 15.8', 'postgres (PostgreSQL) 17.2', 'not postgres']) {
      const { directory, readVersion } = await fakeRuntime(ALL, version);
      await expect(inspectPostgresRuntime(directory, 'bundled', { readVersion, platform: 'darwin' })).resolves.toBeNull();
    }
  });

  it('rejects a symlinked executable so an update cannot repoint the database binary', async () => {
    const { directory, readVersion } = await fakeRuntime([]);
    const real = join(directory, 'real-postgres');
    await writeFile(real, '#!/bin/sh\nexit 0\n');
    if (process.platform !== 'win32') await chmod(real, 0o755);
    await writeFile(join(directory, 'initdb'), '#!/bin/sh\nexit 0\n');
    await writeFile(join(directory, 'pg_ctl'), '#!/bin/sh\nexit 0\n');
    try {
      await symlink(real, join(directory, 'postgres'));
    } catch {
      return; // symlink creation unavailable in this environment
    }
    await expect(inspectPostgresRuntime(directory, 'bundled', { readVersion, platform: 'darwin' })).resolves.toBeNull();
  });

  it('rejects a directory that does not exist', async () => {
    await expect(inspectPostgresRuntime(join(tmpdir(), 'rb-absent-runtime'), 'bundled', { platform: 'darwin' })).resolves.toBeNull();
  });

  it.each(['bundled', 'configured', 'system'] as PostgresRuntimeSource[])('reports the %s source it admitted', async source => {
    const { directory, readVersion } = await fakeRuntime(ALL);
    await expect(inspectPostgresRuntime(directory, source, { readVersion, platform: 'darwin' })).resolves.toMatchObject({ source });
  });
});

describe('runtime discovery order', () => {
  it('lets an explicit override win over a bundled runtime and never probes PATH', async () => {
    const bundled = await fakeRuntime(ALL);
    const configured = await fakeRuntime(ALL);
    const resources = join(bundled.directory, '..');
    const runtime = await resolvePostgresRuntime({
      resourcesDirectory: resources,
      configuredDirectory: configured.directory,
      platform: 'darwin',
      readVersion: async () => 'postgres (PostgreSQL) 16.15 (Homebrew)',
    });
    expect(runtime.source).toBe('configured');
    expect(runtime.binaryDirectory).toBe(await realpath(configured.directory));
  });

  it('fails closed with staff-facing copy when no runtime is admitted', async () => {
    await expect(resolvePostgresRuntime({
      resourcesDirectory: join(tmpdir(), 'rb-absent-resources'),
      configuredDirectory: join(tmpdir(), 'rb-absent-configured'),
      platform: 'linux',
      readVersion: async () => { throw new Error('should not run'); },
    })).rejects.toBeInstanceOf(PostgresRuntimeError);
  });

  it('names the missing runtime without telling staff to use a terminal', async () => {
    // Use a platform with no system fallback so CI Linux hosts that already
    // have /usr/lib/postgresql cannot satisfy this "absent" case.
    await expect(resolvePostgresRuntime({
      resourcesDirectory: join(tmpdir(), 'rb-absent-resources'),
      configuredDirectory: join(tmpdir(), 'rb-absent-configured'),
      platform: 'win32',
    })).rejects.toThrow(/Reinstall RealBud|service support/);
  });
});

describe('resources directory resolution', () => {
  it('derives the resources root from the UI directory Electron passes', () => {
    // Paths resolve natively: on Windows a rooted path gains the current drive.
    expect(appResourcesDirectory({ OMB_STATIC_DIR: '/Applications/RealBud.app/Contents/Resources/ui' } as NodeJS.ProcessEnv))
      .toBe(resolve('/Applications/RealBud.app/Contents/Resources'));
  });

  it('honours an explicit resources override for staged installers', () => {
    expect(appResourcesDirectory({ REALBUD_RESOURCES_DIR: '/stage/Resources', OMB_STATIC_DIR: '/ignored/ui' } as NodeJS.ProcessEnv))
      .toBe(resolve('/stage/Resources'));
  });

  it('reports no bundled location when the server runs outside the desktop app', () => {
    expect(appResourcesDirectory({} as NodeJS.ProcessEnv)).toBeUndefined();
  });
});

describe('untrusted runtime layout', () => {
  it('does not read a version from a directory that only looks like a runtime', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rb-pg-fake-'));
    created.push(directory);
    await mkdir(join(directory, 'postgres'), { recursive: true });
    await expect(inspectPostgresRuntime(directory, 'bundled', { platform: 'darwin' })).resolves.toBeNull();
  });
});
