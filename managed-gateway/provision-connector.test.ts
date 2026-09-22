import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('./provision-connector.mjs', import.meta.url));
const descriptor = (id = 'device-fictional') => ({ id, companyId: 'company-fictional', licenseId: 'license-fictional',
  memberId: 'member-fictional', installationId: `install-${id}`, profile: 'property-fixture', active: true,
  expiresAt: Date.UTC(2030, 0, 1), projectKeyEnv: 'REALBUD_COMPOSIO_PROJECT_FICTIONAL', authConfigId: 'auth-fictional', userId: 'user-fictional' });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'realbud-connector-provision-'));
  const registry = join(root, 'server', 'devices.json'), deviceFile = join(root, 'device.json'), clientOutput = join(root, 'client', 'access.json');
  writeFileSync(deviceFile, JSON.stringify(descriptor()), { mode: 0o600 });
  const args = (overrides: Record<string, string> = {}) => {
    const options = { registry, 'device-file': deviceFile, 'client-output': clientOutput, endpoint: 'https://service.example.invalid', ...overrides };
    return [cli, ...Object.entries(options).flatMap(([key, value]) => [`--${key}`, value])];
  };
  const env: NodeJS.ProcessEnv = { PATH: dirname(process.execPath), HOME: root, USERPROFILE: root, REALBUD_DATA_DIR: join(root, 'private-data'), TEMP: root, TMP: root, TMPDIR: root };
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR']) if (process.env[key]) env[key] = process.env[key];
  const run = (overrides: Record<string, string> = {}) => spawnSync(process.execPath, args(overrides), { env, cwd: root, encoding: 'utf8', timeout: 10_000 });
  return { root, registry, deviceFile, clientOutput, env, args, run, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('provisioning persists only a digest on the server and one private scoped client credential', () => {
  const f = fixture(); try {
    const result = f.run(); assert.equal(result.status, 0, result.stderr);
    const registryText = readFileSync(f.registry, 'utf8'), registry = JSON.parse(registryText);
    const client = JSON.parse(readFileSync(f.clientOutput, 'utf8'));
    assert.deepEqual(Object.keys(client).sort(), ['credential', 'endpoint', 'profile', 'version']);
    assert.equal(client.endpoint, 'https://service.example.invalid'); assert.equal(client.profile, 'property-fixture');
    assert.match(client.credential, /^rbc_[a-f0-9]{64}$/);
    assert.equal(registry.devices.length, 1);
    assert.equal(registry.devices[0].tokenHash, createHash('sha256').update(client.credential).digest('hex'));
    assert.ok(!registryText.includes(client.credential));
    assert.ok(!`${result.stdout}${result.stderr}`.includes(client.credential));
    assert.deepEqual(JSON.parse(result.stdout), { deviceId: 'device-fictional', companyId: 'company-fictional', clientOutput: f.clientOutput, registry: f.registry });
    assert.equal(existsSync(`${f.registry}.lock`), false);
    if (process.platform !== 'win32') {
      assert.equal(statSync(f.clientOutput).mode & 0o777, 0o600); assert.equal(statSync(f.registry).mode & 0o777, 0o600);
      assert.equal(statSync(dirname(f.clientOutput)).mode & 0o777, 0o700);
    }
  } finally { f.close(); }
});

test('duplicate IDs and repeat client destinations preserve already issued credentials and registry', () => {
  const f = fixture(); try {
    assert.equal(f.run().status, 0);
    const before = readFileSync(f.registry), issued = readFileSync(f.clientOutput);
    const alternate = join(f.root, 'duplicate-client.json');
    assert.notEqual(f.run({ 'client-output': alternate }).status, 0);
    assert.equal(existsSync(alternate), false); assert.deepEqual(readFileSync(f.registry), before);
    writeFileSync(f.deviceFile, JSON.stringify(descriptor('device-other')));
    assert.notEqual(f.run().status, 0); assert.deepEqual(readFileSync(f.clientOutput), issued); assert.deepEqual(readFileSync(f.registry), before);
  } finally { f.close(); }
});

test('invalid descriptors, secrets and endpoints produce no credential or registry', () => {
  const f = fixture(); try {
    for (const bad of [null, [], {}, { ...descriptor(), token: 'fictional-secret-must-not-print' }, { ...descriptor(), tokenHash: 'a'.repeat(64) },
      { ...descriptor(), projectKeyEnv: 'PATH' }, { ...descriptor(), profile: '../other' }, { ...descriptor(), accountId: '../account' },
      { ...descriptor(), expiresAt: -1 }]) {
      writeFileSync(f.deviceFile, JSON.stringify(bad));
      const result = f.run(); assert.notEqual(result.status, 0); assert.ok(!`${result.stdout}${result.stderr}`.includes('fictional-secret-must-not-print'));
      assert.equal(existsSync(f.clientOutput), false); assert.equal(existsSync(f.registry), false);
    }
    writeFileSync(f.deviceFile, JSON.stringify(descriptor()));
    for (const endpoint of ['http://service.example.invalid', 'https://user:fictional-secret@service.example.invalid', 'https://service.example.invalid/path', 'https://service.example.invalid?key=fictional-secret']) {
      assert.notEqual(f.run({ endpoint }).status, 0); assert.equal(existsSync(f.clientOutput), false);
    }
    assert.notEqual(f.run({ registry: 'relative.json' }).status, 0);
    writeFileSync(f.deviceFile, 'x'.repeat(8193)); assert.notEqual(f.run().status, 0);
  } finally { f.close(); }
});

test('a registry lock owned by another writer is respected and never removed by a failed issuer', () => {
  const f = fixture(); try {
    mkdirSync(dirname(f.registry), { recursive: true });
    writeFileSync(`${f.registry}.lock`, 'fictional-other-writer', { flag: 'wx', mode: 0o600 });
    assert.notEqual(f.run().status, 0);
    assert.equal(readFileSync(`${f.registry}.lock`, 'utf8'), 'fictional-other-writer');
    assert.equal(existsSync(f.registry), false); assert.equal(existsSync(f.clientOutput), false);
  } finally { f.close(); }
});

test('two actual concurrent issuers cannot publish two credentials for the same device', async () => {
  const f = fixture(); try {
    const outputs = [join(f.root, 'one.json'), join(f.root, 'two.json')];
    const attempts = outputs.map(client => new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, f.args({ 'client-output': client }), { cwd: f.root, env: f.env, stdio: 'ignore' });
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); resolve(code); });
    }));
    const results = await Promise.all(attempts);
    assert.equal(results.filter(code => code === 0).length, 1);
    assert.equal(outputs.filter(path => existsSync(path)).length, 1);
    assert.equal(JSON.parse(readFileSync(f.registry, 'utf8')).devices.length, 1);
    assert.equal(existsSync(`${f.registry}.lock`), false);
  } finally { f.close(); }
});

test('malformed existing registry is preserved and the issuance lock is released', () => {
  const f = fixture(); try {
    mkdirSync(dirname(f.registry), { recursive: true }); writeFileSync(f.registry, '{invalid');
    assert.notEqual(f.run().status, 0); assert.equal(readFileSync(f.registry, 'utf8'), '{invalid');
    assert.equal(existsSync(f.clientOutput), false); assert.equal(existsSync(`${f.registry}.lock`), false);
  } finally { f.close(); }
});

test('aliased registry/client directories cannot overwrite the only issued credential', { skip: process.platform === 'win32' }, () => {
  const f = fixture(); try {
    const actual = join(f.root, 'actual'), alias = join(f.root, 'alias'); mkdirSync(actual); symlinkSync(actual, alias, 'dir');
    const registry = join(actual, 'same.json'), client = join(alias, 'same.json');
    assert.notEqual(f.run({ registry, 'client-output': client }).status, 0);
    assert.equal(existsSync(registry), false);
  } finally { f.close(); }
});
