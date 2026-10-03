import { chmodSync, linkSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { serviceInstallationBinding, serviceInstallationPath, serviceInstallationPresent } from './managed-service.ts';
import { privateFixtureRoot, writePrivateFixtureFile } from './testing/private-profile-fixture.ts';

const roots: string[] = [];
const binding = { schema: 1, companyId: 'fictional-office', hostInstallationId: 'fictional-host' };
function fixture() {
  const root = privateFixtureRoot(join(tmpdir(), 'realbud-binding-recovery-'));
  roots.push(root);
  return { root, path: serviceInstallationPath(root) };
}
function held(root: string) {
  for (const read of [serviceInstallationBinding, serviceInstallationPresent]) {
    expect(() => read(root)).toThrow(expect.objectContaining({ code: 'service_installation_recovery_required', status: 503 }));
  }
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('service installation entry recovery', () => {
  it('distinguishes a missing binding from a valid private binding', () => {
    const { root, path } = fixture();
    expect(serviceInstallationBinding(root)).toBeNull();
    expect(serviceInstallationPresent(root)).toBe(false);
    writePrivateFixtureFile(path, JSON.stringify(binding));
    expect(serviceInstallationBinding(root)).toEqual({ companyId: binding.companyId, hostInstallationId: binding.hostInstallationId });
    expect(serviceInstallationPresent(root)).toBe(true);
  });

  it.each([
    JSON.stringify({ ...binding, extra: true }),
    JSON.stringify({ ...binding, companyId: 'not an accepted id' }),
    JSON.stringify([]),
    '{broken',
    ' '.repeat(2049),
  ])('holds invalid content instead of reporting absence (%#)', content => {
    const { root, path } = fixture();
    writePrivateFixtureFile(path, content);
    held(root);
  });

  it('holds directories and multiply-linked records', () => {
    const directory = fixture();
    mkdirSync(directory.path);
    held(directory.root);
    const linked = fixture();
    writePrivateFixtureFile(linked.path, JSON.stringify(binding));
    linkSync(linked.path, join(linked.root, 'other-binding.json'));
    held(linked.root);
  });

  it.skipIf(process.platform === 'win32')('holds dangling links, valid links and loose private permissions', () => {
    const dangling = fixture();
    symlinkSync(join(dangling.root, 'absent.json'), dangling.path);
    held(dangling.root);
    const linked = fixture();
    const target = join(linked.root, 'target.json');
    writePrivateFixtureFile(target, JSON.stringify(binding));
    symlinkSync(target, linked.path);
    held(linked.root);
    const loose = fixture();
    writePrivateFixtureFile(loose.path, JSON.stringify(binding));
    chmodSync(loose.path, 0o644);
    held(loose.root);
  });
});
