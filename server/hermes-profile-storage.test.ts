import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { ensureProfileDirectories, ensureProfileDirectory, readProfileFile, readProfileFiles, writeProfileFile, writeProfileFiles } from './hermes-profile-storage.ts';
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

  it('protects a new chain root before its descendants, then restricts them in one process', () => {
    const root = fixture(), first = join(root, 'home'), middle = join(first, 'profiles'), target = join(middle, 'property');
    const emptyWhenRestricted: string[] = [];
    privacy.mockImplementation((path, _kind, restrict) => { if (restrict && !readdirSync(path).length) emptyWhenRestricted.push(path); });
    ensureProfileDirectories([first, middle, target]);
    // Same paths, same order, same actions as three per-path calls.
    expect(privacy.mock.calls.map(call => [call[0], call[1], call[2] === true])).toEqual([
      [first, 'directory', true], [middle, 'directory', true], [target, 'directory', true],
    ]);
    // Two launches: the chain root's own protect-before-create, then the pair
    // that was born private under it.
    expect(acl.processes).toEqual([
      [[first, 'directory', true]],
      [[middle, 'directory', true], [target, 'directory', true]],
    ]);
    // Only the root has to be empty at restrict time; the rest inherit its DACL.
    expect(emptyWhenRestricted).toEqual([first, target]);
    expect(readdirSync(target)).toEqual([]);
  });

  it('admits an existing root before creating anything inside it', () => {
    const root = fixture(), home = join(root, 'home'); mkdirSync(home);
    const target = join(home, 'profiles', 'property');
    privacy.mockImplementation(path => { if (path === home) throw refusal(); });
    expect(() => ensureProfileDirectories([home, join(home, 'profiles'), target])).toThrow('Private storage refused.');
    expect(readdirSync(home)).toEqual([]);
    expect(acl.processes).toEqual([[[home, 'directory', false]]]);

    privacy.mockReset(); acl.processes.length = 0;
    ensureProfileDirectories([home, join(home, 'profiles'), target]);
    // The existing directory is verified first, in its own process, and only
    // then are the two directories created inside it and restricted together.
    expect(acl.processes).toEqual([
      [[home, 'directory', false]],
      [[join(home, 'profiles'), 'directory', true], [target, 'directory', true]],
    ]);
  });

  it('reads several files in one admission process and never admits an absent one', () => {
    const root = fixture();
    writeFileSync(join(root, 'SOUL.md'), 'soul'); writeFileSync(join(root, 'config.yaml'), 'settings');
    const paths = ['SOUL.md', 'config.yaml', '.env'].map(name => join(root, name));
    expect(readProfileFiles(paths).map(value => value?.toString() ?? null)).toEqual(['soul', 'settings', null]);
    expect(acl.processes).toEqual([[[paths[0]!, 'file', false], [paths[1]!, 'file', false]]]);
    expect(readProfileFiles([])).toEqual([]);
    expect(() => readProfileFiles([join(root, 'absent-parent', '.env')])).toThrow(/recovery/);
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

  it('publishes a whole file set in three processes with bytes only after every restrict', () => {
    const root = fixture();
    const names = ['SOUL.md', 'config.yaml', '.env'];
    const paths = names.map(name => join(root, name));
    const bytesWhenRestricted: number[] = [];
    privacy.mockImplementation((path, kind, restrict) => {
      // Nothing may exist at a destination while any stage is still empty.
      if (kind === 'file' && restrict) {
        expect(readFileSync(path)).toHaveLength(0);
        bytesWhenRestricted.push(paths.filter(existsSync).length);
      }
    });
    const outcomes = writeProfileFiles(paths.map((path, index) => ({ path, bytes: `body ${index}\n` })));
    expect(outcomes).toEqual(paths.map(path => ({ path, state: 'published' })));
    expect(paths.map(path => readFileSync(path, 'utf8'))).toEqual(['body 0\n', 'body 1\n', 'body 2\n']);
    expect(readdirSync(root).sort()).toEqual([...names].sort());
    expect(bytesWhenRestricted).toEqual([0, 0, 0]);
    // One process admits the shared destination directory, one restricts all
    // three stages, one verifies all three published paths. The directory is
    // admitted once for the set, not once per file.
    const stages = privacy.mock.calls.slice(1, 4).map(call => call[0]);
    expect(stages.every(path => /^\.realbud-profile-.*\.tmp$/.test(basename(path)))).toBe(true);
    expect(acl.processes).toEqual([
      [[root, 'directory', false]],
      stages.map(path => [path, 'file', true]),
      paths.map(path => [path, 'file', false]),
    ]);
  });

  it('never reports a published file the verification batch did not reach', () => {
    const root = fixture();
    const paths = ['SOUL.md', 'config.yaml'].map(name => join(root, name));
    privacy.mockImplementation((path, kind, restrict) => { if (kind === 'file' && !restrict && path === paths[1]) throw refusal(); });
    let outcomes: unknown;
    expect(() => {
      try { writeProfileFiles(paths.map(path => ({ path, bytes: 'body\n' }))); }
      catch (error) { outcomes = (error as { profileWriteOutcomes?: unknown }).profileWriteOutcomes; throw error; }
    }).toThrow('Private storage refused.');
    // Both are at their destinations, and neither is claimed as published.
    expect(outcomes).toEqual(paths.map(path => ({ path, state: 'renamed-unverified' })));
    expect(paths.every(path => readFileSync(path, 'utf8') === 'body\n')).toBe(true);
  });

  it('leaves no destination and no stage behind when one stage restrict refuses', () => {
    const root = fixture();
    const paths = ['SOUL.md', 'config.yaml', '.env'].map(name => join(root, name));
    let seen = 0;
    privacy.mockImplementation((_path, kind, restrict) => { if (kind === 'file' && restrict && seen++ === 1) throw refusal(); });
    let outcomes: unknown;
    expect(() => {
      try { writeProfileFiles(paths.map(path => ({ path, bytes: 'FAKE_KEY=fictional\n' }))); }
      catch (error) { outcomes = (error as { profileWriteOutcomes?: unknown }).profileWriteOutcomes; throw error; }
    }).toThrow('Private storage refused.');
    expect(outcomes).toEqual(paths.map(path => ({ path, state: 'absent' })));
    expect(readdirSync(root)).toEqual([]);
  });

  it('refuses a no-clobber entry before creating any stage for the set', () => {
    const root = fixture(), kept = join(root, 'config.yaml');
    writeFileSync(kept, 'retained');
    expect(() => writeProfileFiles([
      { path: join(root, 'SOUL.md'), bytes: 'new' },
      { path: kept, bytes: 'replacement', overwrite: false },
    ])).toThrow(/recovery/);
    expect(readdirSync(root)).toEqual(['config.yaml']);
    expect(readFileSync(kept, 'utf8')).toBe('retained');
    expect(writeProfileFiles([])).toEqual([]);
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

  it('counts the cold PowerShell launches a pack apply and a startup would cost', () => {
    const root = fixture();
    applyPropertyPack(root);
    const fresh = { launches: acl.processes.length, admissions: privacy.mock.calls.length };
    privacy.mockClear(); acl.processes.length = 0;
    applyPropertyPack(root);
    const reapply = { launches: acl.processes.length, admissions: privacy.mock.calls.length };
    privacy.mockClear(); acl.processes.length = 0;
    expect(ensurePropertyPack(root).wrote).toEqual([]);
    const startup = { launches: acl.processes.length, admissions: privacy.mock.calls.length };
    // Measured at HEAD before the batched publication: 25/27, 21/33 and 3/8.
    // Six first publications cost eighteen of those twenty-five launches; the
    // whole pack now publishes in three. The three admissions that went away
    // are duplicate destination-directory verifies: one per file became one
    // per directory. No other path, kind or action changed.
    //
    // 2026-09-23: fresh 7 -> 5 and reapply 9 -> 7. `applyPropertyPack` plans
    // the skill tree from the read-only shipped pack before it admits
    // anything, so the skill directories join the profile's own two
    // directory processes and the skill files join its one read, instead of
    // costing two more cold launches. The admission counts are unchanged:
    // the same paths, kinds and actions, in the same order, in fewer
    // processes.
    expect({ fresh, reapply, startup }).toEqual({
      fresh: { launches: 5, admissions: 24 },
      reapply: { launches: 7, admissions: 30 },
      startup: { launches: 3, admissions: 8 },
    });
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
