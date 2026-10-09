// Real Windows ACL acceptance for the repair of an older install's data folder.
// A skip on another OS is not native proof. The data folder here has the shape
// found on a customer PC (installed 0.1.46): a plain folder under the user
// profile, so its DACL is unprotected and inherits SYSTEM, Administrators and
// the account, while every folder and file RealBud created inside it carries
// its own protected descriptor.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setOpLogPath } from './oplog.ts';
import { admitPrivateDirectorySync, readPrivateJson, removePrivateJson, writePrivateJson } from './private-json.ts';
import { windowsFilePrivacySync } from './windows-file-privacy.ts';
import {
  addFixtureInheritableGrant, privateFixtureDirectory, privateFixtureRoot, profileAclWitness, writePrivateFixtureFile,
  WINDOWS_PROFILE_TEST_OPTIONS,
} from './testing/private-profile-fixture.ts';

const roots: string[] = [];
const fixture = () => { const root = privateFixtureRoot(join(tmpdir(), 'realbud-inherited-data-')); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
// The log lives outside every fixture, so cleanup never races an append.
let logRoot = '';
const logPath = () => join(logRoot, 'realbud.log');
const logText = () => { try { return readFileSync(logPath(), 'utf8'); } catch { return ''; } };
beforeAll(() => { logRoot = mkdtempSync(join(tmpdir(), 'realbud-inherited-log-')); setOpLogPath(logPath()); });
afterAll(() => { rmSync(logRoot, { recursive: true, force: true }); });

/** A user-profile-like folder holding a plain (inherited) `.realbud`. */
function inheritedDataFolder(grant: 'administrators' | 'everyone'): { root: string; data: string } {
  const root = fixture(), profile = join(root, 'profile');
  privateFixtureDirectory(profile);
  addFixtureInheritableGrant(profile, grant);
  const data = join(profile, '.realbud');
  mkdirSync(data);
  return { root, data };
}

describe.skipIf(process.platform !== 'win32')('native Windows repair of an inherited data folder', WINDOWS_PROFILE_TEST_OPTIONS, () => {
  it('repairs a data folder that only inherits profile grants, admits the setup probe, and leaves its protected children alone', async () => {
    const { root, data } = inheritedDataFolder('administrators');
    const company = join(data, 'company-installation'), config = join(data, 'config.json');
    mkdirSync(company);
    windowsFilePrivacySync(company, 'directory', true);
    writePrivateFixtureFile(config, '{}');
    const [before, ...children] = profileAclWitness([data, company, config]);
    expect(before).toMatchObject({ protected: false, ownerAllowed: true, onlyPrivateGrants: true, currentFullControl: true, hasDeny: false });
    // The release that stranded the customer refused exactly here.
    expect(() => windowsFilePrivacySync(data, 'directory')).toThrow(/windows-acl:inheritance-not-protected/);

    const logged = logText().length;
    admitPrivateDirectorySync(data, "RealBud's data folder");
    // The office-link preflight's own probe (server/worker-model-access.ts).
    const probe = join(data, '.service-provisioning-check-fictional.json');
    await writePrivateJson(probe, { version: 1 });
    await removePrivateJson(probe);

    expect(profileAclWitness([data])[0]).toMatchObject({
      protected: true, currentOwner: true, onlyPrivateGrants: true, currentFullControl: true, hasDeny: false,
    });
    expect(profileAclWitness([company, config])).toEqual(children);
    expect(() => windowsFilePrivacySync(data, 'directory')).not.toThrow();
    const added = logText().slice(logged);
    expect(added.trim().split('\n')).toHaveLength(1);
    expect(added).toContain("RealBud's data folder");
    expect(added).toContain('windows-acl:inheritance-not-protected');
    expect(added).not.toContain(root);

    // Admitted from now on by plain verification: nothing more is logged.
    await writePrivateJson(probe, { version: 1 });
    await removePrivateJson(probe);
    expect(logText().slice(logged)).toBe(added);
  });

  it('still refuses an inherited data folder with an extra Everyone grant and leaves it unchanged', async () => {
    const { data } = inheritedDataFolder('everyone');
    const before = profileAclWitness([data]);
    expect(before[0]).toMatchObject({ protected: false, onlyPrivateGrants: false });
    const logged = logText().length;
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(writePrivateJson(join(data, '.service-provisioning-check-fictional.json'), { version: 1 }))
        .rejects.toThrow(/windows-acl:grant-not-allowed/);
      expect(readdirSync(data)).toEqual([]);
      expect(profileAclWitness([data])).toEqual(before);
    }
    expect(logText().slice(logged)).toBe('');
  });

  it('repairs a private file that only inherits its protected folder\'s grants, then reads it', async () => {
    const root = fixture(), data = join(root, 'data'), file = join(data, 'service-provisioning.json');
    privateFixtureDirectory(data);
    writeFileSync(file, JSON.stringify({ version: 1, state: 'withdrawn' })); // Deliberately inherited.
    expect(profileAclWitness([file])[0]).toMatchObject({ protected: false, onlyPrivateGrants: true });
    await expect(readPrivateJson(file)).resolves.toEqual({ version: 1, state: 'withdrawn' });
    expect(profileAclWitness([file])[0]).toMatchObject({
      protected: true, currentOwner: true, onlyPrivateGrants: true, currentFullControl: true, hasDeny: false,
    });
  });
});
