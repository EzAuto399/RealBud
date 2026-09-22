// Real Windows ACL/process acceptance. A skip on another OS is not native proof.
import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { attachModel } from './hermes-bridge.ts';
import { ensurePropertyPack, propertyProfileDir, propertyWorkroomReady } from './hermes-pack.ts';
import { ensureProfileDirectories, writeProfileFiles } from './hermes-profile-storage.ts';
import { windowsFilePrivacySync } from './windows-file-privacy.ts';
import { addFixtureUsersRead, privateFixtureDirectory, privateFixtureRoot, profileAclWitness, writePrivateFixtureFile, WINDOWS_PROFILE_TEST_OPTIONS } from './testing/private-profile-fixture.ts';

const roots: string[] = [];
const fixture = () => {
  const root = privateFixtureRoot(join(tmpdir(), 'realbud-native-profile-'));
  roots.push(root);
  return root;
};
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe.skipIf(process.platform !== 'win32')('native Windows profile setup', WINDOWS_PROFILE_TEST_OPTIONS, () => {
  it('creates a private profile, attaches and replaces a fictional key, and preserves it after a fresh process starts', () => {
    const root = fixture(), home = join(root, 'owned-home');
    expect(existsSync(home)).toBe(false);
    const installed = ensurePropertyPack(home), profile = propertyProfileDir(home);
    expect(installed.wrote).toContain('config.yaml');
    expect(propertyWorkroomReady(home)).toBe(true);
    const parents = [root, home, join(home, 'profiles'), profile];
    const paths = [join(home, 'auth.json'), ...['SOUL.md', 'config.yaml', 'distribution.yaml', 'profile.yaml'].map(name => join(profile, name))];
    for (const witness of profileAclWitness([...parents, ...paths])) expect(witness).toMatchObject({
      protected: true, currentOwner: true, onlyPrivateGrants: true, currentFullControl: true, hasDeny: false,
    });

    expect(attachModel({ providerId: 'xai', apiKey: 'fictional-first-key', model: 'grok-4' }, { root: home }))
      .toMatchObject({ provider: 'xai', model: 'grok-4', keyPresent: true });
    expect(attachModel({ providerId: 'xai', apiKey: 'fictional-replacement-key', model: 'grok-4' }, { root: home }))
      .toMatchObject({ keyPresent: true });
    const envPath = join(profile, '.env');
    paths.push(envPath);
    const savedEnv = readFileSync(envPath, 'utf8');
    expect(savedEnv).toContain('fictional-replacement-key');
    expect(savedEnv).not.toContain('fictional-first-key');
    expect(savedEnv.match(/^XAI_API_KEY=/gm)).toHaveLength(1);
    const before = paths.map(path => ({ data: readFileSync(path), stat: statSync(path, { bigint: true }) }));
    const aclBefore = profileAclWitness([...parents, ...paths]);
    expect(aclBefore.every(witness => witness.protected && witness.currentOwner && witness.onlyPrivateGrants && witness.currentFullControl && !witness.hasDeny)).toBe(true);

    const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: root, USERPROFILE: root, REALBUD_HERMES_HOME: home, REALBUD_DATA_DIR: join(root, 'data') };
    for (const key of Object.keys(childEnv)) if (/API_KEY$|_TOKEN$|_SECRET$|_PASSWORD$/.test(key)) delete childEnv[key];
    const moduleUrl = new URL('./hermes-pack.ts', import.meta.url).href;
    const script = `const { ensurePropertyPack } = await import(${JSON.stringify(moduleUrl)}); process.stdout.write(JSON.stringify(ensurePropertyPack(${JSON.stringify(home)}).wrote));`;
    const output = execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], {
      cwd: fileURLToPath(new URL('..', import.meta.url)), env: childEnv,
      windowsHide: true, shell: false, timeout: 60_000, maxBuffer: 4096,
    });
    expect(JSON.parse(output.toString('utf8'))).toEqual([]);
    paths.forEach((path, index) => {
      expect(readFileSync(path).equals(before[index]!.data)).toBe(true);
      const stat = statSync(path, { bigint: true });
      expect([stat.dev, stat.ino, stat.mtimeNs, stat.ctimeNs]).toEqual(
        [before[index]!.stat.dev, before[index]!.stat.ino, before[index]!.stat.mtimeNs, before[index]!.stat.ctimeNs],
      );
    });
    expect(profileAclWitness([...parents, ...paths])).toEqual(aclBefore);
  });

  it('refuses an existing inherited home without repairing it or creating descendants', () => {
    const root = fixture(), home = join(root, 'inherited-home');
    mkdirSync(home);
    const before = profileAclWitness([root, home]);
    expect(before[1]!.protected).toBe(false);
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(() => ensurePropertyPack(home)).toThrow(/windows-acl:inheritance-not-protected/);
      expect(readdirSync(home)).toEqual([]);
      expect(() => windowsFilePrivacySync(home, 'directory')).toThrow(/windows-acl:inheritance-not-protected/);
      expect(profileAclWitness([root, home])).toEqual(before);
    }
  });

  it.each(['inherited', 'users-read'] as const)('refuses %s config before changing credentials and preserves its rejected ACL', kind => {
    const root = fixture(), home = join(root, 'owned-home');
    ensurePropertyPack(home);
    attachModel({ providerId: 'xai', apiKey: 'fictional-retained-key', model: 'grok-4' }, { root: home });
    const profile = propertyProfileDir(home), config = join(profile, 'config.yaml'), env = join(profile, '.env');
    const configBytes = readFileSync(config), envBytes = readFileSync(env);
    if (kind === 'inherited') {
      unlinkSync(config);
      writeFileSync(config, configBytes); // Deliberately inherited, never fixture-repaired.
    } else addFixtureUsersRead(config);
    const aclPaths = [root, home, join(home, 'profiles'), profile, config, env];
    const before = profileAclWitness(aclPaths);
    if (kind === 'inherited') expect(before[4]!.protected).toBe(false);
    else expect(before[4]).toMatchObject({ protected: true, onlyPrivateGrants: false, currentFullControl: true, hasDeny: false });
    const diagnostic = kind === 'inherited' ? /windows-acl:inheritance-not-protected/ : /windows-acl:grant-not-allowed/;
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(() => attachModel({ providerId: 'xai', apiKey: 'fictional-refused-key', model: 'grok-4' }, { root: home }))
        .toThrow(diagnostic);
      expect(() => ensurePropertyPack(home)).toThrow(diagnostic);
      expect(readFileSync(config).equals(configBytes)).toBe(true);
      expect(readFileSync(env).equals(envBytes)).toBe(true);
      expect(profileAclWitness(aclPaths)).toEqual(before);
      expect(readdirSync(profile).some(name => name.startsWith('.realbud-profile-'))).toBe(false);
    }
  });

  it('creates a directory chain privately under one admitted root, then protects the rest together', () => {
    const root = fixture(), home = join(root, 'owned-home');
    privateFixtureDirectory(home);
    const middle = join(home, 'profiles'), target = join(middle, 'property');
    // What the batched chain relies on: a directory created inside a protected
    // directory inherits its DACL, so it is private from birth even though its
    // own descriptor is not yet protected — and RealBud's admission still
    // refuses that inherited descriptor, which is why the restrict follows.
    mkdirSync(middle);
    expect(profileAclWitness([middle])[0]).toMatchObject({
      protected: false, currentOwner: true, onlyPrivateGrants: true, currentFullControl: true, hasDeny: false,
    });
    expect(() => windowsFilePrivacySync(middle, 'directory')).toThrow(/windows-acl:inheritance-not-protected/);
    rmSync(middle, { recursive: true });

    ensureProfileDirectories([home, middle, target]);
    for (const witness of profileAclWitness([home, middle, target])) expect(witness).toMatchObject({
      protected: true, currentOwner: true, onlyPrivateGrants: true, currentFullControl: true, hasDeny: false,
    });
    expect(readdirSync(target)).toEqual([]);
  });

  it('publishes a file set in one batch privately, and refuses the set on one bad destination', () => {
    const root = fixture(), profile = join(root, 'owned-home', 'profiles', 'property');
    privateFixtureDirectory(profile);
    const paths = ['SOUL.md', 'config.yaml', '.env'].map(name => join(profile, name));
    expect(writeProfileFiles(paths.map((path, index) => ({ path, bytes: `fictional body ${index}\n` }))))
      .toEqual(paths.map(path => ({ path, state: 'published' })));
    for (const witness of profileAclWitness(paths)) expect(witness).toMatchObject({
      protected: true, currentOwner: true, onlyPrivateGrants: true, currentFullControl: true, hasDeny: false,
    });
    const before = paths.map(path => readFileSync(path));
    const acls = profileAclWitness(paths);

    addFixtureUsersRead(paths[1]!);
    expect(() => writeProfileFiles(paths.map(path => ({ path, bytes: 'fictional replacement\n' }))))
      .toThrow(/windows-acl:grant-not-allowed/);
    // The whole set refuses at the destination admission, so nothing is staged
    // and no other destination in the set is touched.
    paths.forEach((path, index) => { if (index !== 1) expect(readFileSync(path).equals(before[index]!)).toBe(true); });
    expect(readFileSync(paths[1]!).equals(before[1]!)).toBe(true);
    expect(readdirSync(profile).some(name => name.startsWith('.realbud-profile-'))).toBe(false);
    expect(profileAclWitness([paths[0]!, paths[2]!])).toEqual([acls[0], acls[2]]);
  });

  it.each(['hardlink', 'junction'] as const)('refuses a profile %s without changing the original target', kind => {
    const root = fixture(), home = join(root, 'owned-home'), profile = propertyProfileDir(home);
    privateFixtureDirectory(profile);
    writePrivateFixtureFile(join(profile, 'SOUL.md'), '# Fictional profile\n');
    writePrivateFixtureFile(join(profile, 'config.yaml'), 'approvals:\n  mode: manual\n');
    let actual = profile;
    if (kind === 'hardlink') linkSync(join(profile, 'config.yaml'), join(root, 'config-alias'));
    else {
      actual = join(home, 'original-profile');
      renameSync(profile, actual);
      symlinkSync(actual, profile, 'junction');
    }
    const config = join(actual, 'config.yaml'), data = readFileSync(config);
    const paths = [root, home, join(home, 'profiles'), actual, config];
    const before = profileAclWitness(paths);
    expect(() => attachModel({ providerId: 'xai', apiKey: 'fictional-refused-key', model: 'grok-4' }, { root: home })).toThrow(/recovery/);
    expect(readFileSync(config).equals(data)).toBe(true);
    expect(existsSync(join(actual, '.env'))).toBe(false);
    expect(profileAclWitness(paths)).toEqual(before);
  });
});
