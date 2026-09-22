import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { ensureProfileDirectory, readProfileFile, writeProfileFile } from './hermes-profile-storage.ts';
import { applyPropertyPack, ensurePropertyPack, migratePropertyProfileFromLegacyHermes, propertyProfileDir } from './hermes-pack.ts';
import { attachModel } from './hermes-bridge.ts';

type Operation = { path: string; kind: 'file' | 'directory'; action: 'restrict' | 'verify' };
// `privacy` keeps recording one entry per admitted path, batched or not, so the
// ordered admission list stays comparable; `processes` groups those entries by
// the PowerShell process that would have run them.
const acl = vi.hoisted(() => ({
  privacy: vi.fn<(path: string, kind: 'file' | 'directory', restrict?: boolean) => void>(),
  processes: [] as Array<Array<[string, 'file' | 'directory', boolean]>>,
}));
const privacy = acl.privacy;
vi.mock('./windows-file-privacy.ts', () => ({
  windowsFilePrivacySync: (path: string, kind: 'file' | 'directory', restrict = false) => {
    acl.processes.push([[path, kind, restrict]]);
    acl.privacy(path, kind, restrict);
  },
  windowsFilePrivacyBatchSync: (operations: Operation[]) => {
    acl.processes.push(operations.map(o => [o.path, o.kind, o.action === 'restrict'] as [string, 'file' | 'directory', boolean]));
    for (const o of operations) acl.privacy(o.path, o.kind, o.action === 'restrict');
    return operations.map(o => ({ ...o, applied: true }));
  },
}));
const roots: string[] = [];
const fixture = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'realbud-profile-storage-')));
  roots.push(root);
  return root;
};
const refusal = () => Object.assign(new Error('Private storage refused.'), { name: 'WindowsFilePrivacyError' });
beforeEach(() => { privacy.mockReset(); acl.processes.length = 0; });
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('profile storage with simulated ACL outcomes and real disposable files', () => {
  it('verifies existing objects without restricting their ACLs or changing mode/content', () => {
    const root = fixture(), file = join(root, 'config.yaml');
    writeFileSync(file, 'retained', { mode: 0o644 });
    const before = statSync(file);
    ensureProfileDirectory(root);
    expect(readProfileFile(file)?.toString()).toBe('retained');
    expect(statSync(file).mode).toBe(before.mode);
    expect(statSync(file).ino).toBe(before.ino);
    expect(privacy.mock.calls.every(call => call[2] !== true)).toBe(true);
  });

  it('establishes privacy on every new empty directory before creating descendants', () => {
    const root = fixture(), first = join(root, 'home'), target = join(first, 'profiles', 'property');
    privacy.mockImplementation((path, kind, restrict) => {
      expect(kind).toBe('directory'); expect(restrict).toBe(true);
      expect(readdirSync(path)).toEqual([]);
    });
    ensureProfileDirectory(target);
    expect(privacy.mock.calls.map(call => call[0])).toEqual([first, join(first, 'profiles'), target]);
  });

  it('stops new directory creation before descendants when ACL setup fails', () => {
    const root = fixture(), first = join(root, 'home');
    privacy.mockImplementation(() => { throw refusal(); });
    expect(() => ensureProfileDirectory(join(first, 'profiles', 'property'))).toThrow('Private storage refused.');
    expect(readdirSync(first)).toEqual([]);
  });

  it('restricts an exclusively created empty stage before writing credentials', () => {
    const root = fixture(), file = join(root, '.env');
    let observed = false;
    privacy.mockImplementation((path, kind, restrict) => {
      if (kind === 'file' && restrict) {
        observed = true;
        expect(basename(path)).toMatch(/^\.realbud-profile-.*\.tmp$/);
        expect(readFileSync(path)).toHaveLength(0);
        expect(existsSync(file)).toBe(false);
        expect(privacy.mock.calls.some(call => call[0] === root && call[1] === 'directory' && call[2] !== true)).toBe(true);
      }
    });
    writeProfileFile(file, 'FAKE_KEY=fictional\n');
    expect(observed).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('FAKE_KEY=fictional\n');
    expect(readdirSync(root)).toEqual(['.env']);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('preserves old bytes when existing-file or stage ACL admission fails', () => {
    for (const failed of ['existing', 'stage']) {
      const root = fixture(), file = join(root, '.env');
      writeFileSync(file, 'FAKE_KEY=old\n');
      const before = statSync(file);
      privacy.mockImplementation((path, kind, restrict) => {
        if (kind === 'file' && (failed === 'stage' ? restrict === true : path === file)) throw refusal();
      });
      expect(() => writeProfileFile(file, 'FAKE_KEY=new\n')).toThrow('Private storage refused.');
      expect(readFileSync(file, 'utf8')).toBe('FAKE_KEY=old\n');
      expect(statSync(file).ino).toBe(before.ino);
      expect(statSync(file).mode).toBe(before.mode);
      expect(readdirSync(root)).toEqual(['.env']);
    }
  });

  it('refuses first-publication races without overwriting the winner', () => {
    const root = fixture(), file = join(root, '.env');
    privacy.mockImplementation((_path, kind, restrict) => {
      if (kind === 'file' && restrict) writeFileSync(file, 'competing credential');
    });
    expect(() => writeProfileFile(file, 'new credential')).toThrow(/recovery/);
    expect(readFileSync(file, 'utf8')).toBe('competing credential');
    expect(readdirSync(root)).toEqual(['.env']);
  });

  it('refuses existing destination drift without restoring or overwriting foreign bytes', () => {
    const root = fixture(), file = join(root, 'config.yaml');
    writeFileSync(file, 'old settings');
    privacy.mockImplementation((_path, kind, restrict) => {
      if (kind === 'file' && restrict) writeFileSync(file, 'concurrent settings');
    });
    expect(() => writeProfileFile(file, 'new settings')).toThrow(/recovery/);
    expect(readFileSync(file, 'utf8')).toBe('concurrent settings');
  });

  it('does not write secrets to or clean up a replaced private stage', () => {
    const root = fixture(), file = join(root, '.env');
    let staged = '';
    privacy.mockImplementation((path, kind, restrict) => {
      if (kind === 'file' && restrict) {
        staged = path;
        renameSync(path, join(root, 'original-empty'));
        writeFileSync(path, 'foreign stage');
      }
    });
    expect(() => writeProfileFile(file, 'FAKE_SECRET=never')).toThrow(/recovery/);
    expect(readFileSync(staged, 'utf8')).toBe('foreign stage');
    expect(readFileSync(join(root, 'original-empty'))).toHaveLength(0);
    expect(existsSync(file)).toBe(false);
  });

  it('rejects hardlinks before reading or changing existing files', () => {
    const root = fixture(), file = join(root, '.env'), alias = join(root, 'alias');
    writeFileSync(file, 'retained'); linkSync(file, alias);
    expect(() => readProfileFile(file)).toThrow(/recovery/);
    expect(() => writeProfileFile(file, 'new')).toThrow(/recovery/);
    expect(readFileSync(alias, 'utf8')).toBe('retained');
    expect(lstatSync(file).nlink).toBe(2);
  });

  it.skipIf(process.platform === 'win32')('rejects leaf and ancestor symlinks while preserving their targets', () => {
    const root = fixture(), actual = join(root, 'actual'), alias = join(root, 'alias');
    mkdirSync(actual); const file = join(actual, '.env'); writeFileSync(file, 'retained');
    symlinkSync(actual, alias);
    expect(() => readProfileFile(join(alias, '.env'))).toThrow(/recovery/);
    const leaf = join(root, 'linked.env'); symlinkSync(file, leaf);
    expect(() => writeProfileFile(leaf, 'new')).toThrow(/recovery/);
    expect(readFileSync(file, 'utf8')).toBe('retained');
  });

  it('bounds file reads and denies a missing parent instead of treating it as empty', () => {
    const root = fixture(), file = join(root, 'large');
    writeFileSync(file, Buffer.alloc(2 * 1024 * 1024 + 1));
    expect(() => readProfileFile(file)).toThrow(/recovery/);
    expect(readProfileFile(join(root, 'absent'))).toBeNull();
    expect(() => readProfileFile(join(root, 'absent-parent', '.env'))).toThrow(/recovery/);
  });

  it('preserves a changed destination identity even when the replacement has identical bytes', () => {
    const root = fixture(), file = join(root, 'config.yaml'); writeFileSync(file, 'same');
    privacy.mockImplementation((_path, kind, restrict) => {
      if (kind === 'file' && restrict) {
        renameSync(file, join(root, 'old')); writeFileSync(file, 'same');
      }
    });
    expect(() => writeProfileFile(file, 'replacement')).toThrow(/recovery/);
    expect(readFileSync(file, 'utf8')).toBe('same');
  });

  it('refuses a stale caller snapshot before creating any new stage', () => {
    const root = fixture(), file = join(root, 'config.yaml'); writeFileSync(file, 'concurrent settings');
    expect(() => writeProfileFile(file, 'stale derived settings', true, Buffer.from('previous settings'))).toThrow(/recovery/);
    expect(readFileSync(file, 'utf8')).toBe('concurrent settings');
    expect(readdirSync(root)).toEqual(['config.yaml']);
    expect(privacy.mock.calls.every(call => call[2] !== true)).toBe(true);
  });

  it('admits the destination directory and the file it replaces in one PowerShell process', () => {
    const root = fixture(), file = join(root, 'config.yaml');
    writeFileSync(file, 'previous settings');
    privacy.mockReset(); acl.processes.length = 0;
    writeProfileFile(file, 'next settings');
    const stage = privacy.mock.calls[2]![0];
    expect(basename(stage)).toMatch(/^\.realbud-profile-.*\.tmp$/);
    // The same paths, kinds and actions, in the same order, as the per-path form.
    expect(privacy.mock.calls.map(call => [call[0], call[1], call[2] === true])).toEqual([
      [root, 'directory', false], [file, 'file', false], [stage, 'file', true],
      [file, 'file', false], [file, 'file', false],
    ]);
    // Five admissions, four cold powershell.exe launches: the pair that neither
    // gates the other shares one. The rest each gate the step that follows.
    expect(acl.processes).toEqual([
      [[root, 'directory', false], [file, 'file', false]],
      [[stage, 'file', true]], [[file, 'file', false]], [[file, 'file', false]],
    ]);
  });

  it('never batches a new stage behind the directory that must admit it first', () => {
    const root = fixture(), file = join(root, '.env');
    writeProfileFile(file, 'FAKE_KEY=fictional\n');
    // A first publication has nothing to verify at the destination, so its
    // directory admission is a batch of one and still returns before the stage
    // exists. Every process holds admissions for a single moment in the write.
    expect(acl.processes).toEqual([
      [[root, 'directory', false]],
      [[privacy.mock.calls[1]![0], 'file', true]],
      [[file, 'file', false]],
    ]);
  });

  it('keeps POSIX existing directory modes unchanged while new files are private', () => {
    const root = fixture(); if (process.platform !== 'win32') chmodSync(root, 0o750);
    const before = statSync(root).mode; ensureProfileDirectory(root);
    writeProfileFile(join(root, 'config.yaml'), 'settings');
    expect(statSync(root).mode).toBe(before);
    if (process.platform !== 'win32') expect(statSync(join(root, 'config.yaml')).mode & 0o777).toBe(0o600);
  });
});

describe('profile provisioning and model attachment privacy wiring', () => {
  it('startup verifies existing policy and credentials without rewriting or restricting them', () => {
    const root = fixture(); applyPropertyPack(root);
    const profile = propertyProfileDir(root), config = join(profile, 'config.yaml');
    writeFileSync(join(profile, '.env'), 'FAKE_KEY=retained\n');
    const before = readFileSync(config), identity = statSync(config).ino;
    privacy.mockClear();
    expect(ensurePropertyPack(root).wrote).toEqual([]);
    expect(privacy.mock.calls.some(call => call[0] === join(profile, '.env'))).toBe(true);
    expect(privacy.mock.calls.every(call => call[2] !== true)).toBe(true);
    expect(readFileSync(config)).toEqual(before); expect(statSync(config).ino).toBe(identity);
  });

  it('rejected config privacy prevents a credential from being stored', () => {
    const root = fixture(); applyPropertyPack(root);
    const profile = propertyProfileDir(root), env = join(profile, '.env'), config = join(profile, 'config.yaml');
    const before = readFileSync(config);
    privacy.mockImplementation((path) => { if (path === config) throw refusal(); });
    expect(() => attachModel({ providerId: 'xai', apiKey: 'fictional-new-key', model: 'grok-4' }, { root })).toThrow('Private storage refused.');
    expect(existsSync(env)).toBe(false); expect(readFileSync(config)).toEqual(before);
  });

  it('rejected existing credentials stop startup and explicit repair without modifying settings', () => {
    const root = fixture(); applyPropertyPack(root);
    const profile = propertyProfileDir(root), env = join(profile, '.env'), config = join(profile, 'config.yaml');
    writeFileSync(env, 'retained'); const before = readFileSync(config);
    privacy.mockImplementation((path) => { if (path === env) throw refusal(); });
    expect(() => ensurePropertyPack(root)).toThrow('Private storage refused.');
    expect(() => applyPropertyPack(root)).toThrow('Private storage refused.');
    expect(readFileSync(env, 'utf8')).toBe('retained'); expect(readFileSync(config)).toEqual(before);
  });

  it.skipIf(process.platform === 'win32')('refuses a linked skill destination before repairing policy or copying any skill', () => {
    const root = fixture(); applyPropertyPack(root);
    const profile = propertyProfileDir(root), config = join(profile, 'config.yaml');
    const before = readFileSync(config), outside = join(root, 'unrelated'); mkdirSync(outside);
    const skills = join(profile, 'skills');
    const subdirectory = readdirSync(skills, { withFileTypes: true }).find(entry => entry.isDirectory())!;
    expect(subdirectory).toBeDefined();
    rmSync(join(skills, subdirectory.name), { recursive: true }); symlinkSync(outside, join(skills, subdirectory.name));
    expect(() => applyPropertyPack(root)).toThrow(/recovery/);
    expect(readFileSync(config)).toEqual(before); expect(readdirSync(outside)).toEqual([]);
  });

  it('holds unused Windows legacy migration before creating or copying any destination', () => {
    const root = fixture(), before = readdirSync(root);
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    try {
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
      expect(() => migratePropertyProfileFromLegacyHermes(root)).toThrow(/migration on Windows needs administrator recovery/);
      expect(readdirSync(root)).toEqual(before);
      expect(privacy).not.toHaveBeenCalled();
    } finally { Object.defineProperty(process, 'platform', platform); }
  });
});
