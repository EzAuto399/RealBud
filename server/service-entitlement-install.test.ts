import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalServiceEntitlementPayload, readServiceEntitlement } from './service-entitlement.ts';
import { installDesktopServiceEntitlement } from './service-entitlement-install.ts';
import { serviceEntitlementInstallLockPath, withServiceEntitlementInstallLock } from './service-entitlement-install-lock.ts';

const NOW = Date.now();
const DAY = 86_400_000;
const roots: string[] = [];

function fixture() {
  const data = mkdtempSync(join(tmpdir(), 'realbud-service-install-'));
  roots.push(data);
  const companyId = 'fictional-company', hostInstallationId = 'fictional-installation';
  writeFileSync(join(data, 'service-installation.json'), JSON.stringify({ schema: 1, companyId, hostInstallationId }), { mode: 0o600 });
  const keys = generateKeyPairSync('ed25519');
  const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const fingerprint = createHash('sha256').update(keys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  const bundlePath = join(data, 'transfer.json');
  const makeBundle = (patch: Record<string, unknown> = {}) => {
    const payload = canonicalServiceEntitlementPayload({ schema: 1, licenseId: 'fictional-license', companyId,
      hostInstallationId, issuedAt: NOW, notBefore: NOW, expiresAt: NOW + DAY, capabilities: ['reasoning', 'connected-tools'], ...patch });
    return { schema: 1, entitlement: { schema: 1, keyId: 'fictional-issuer', payload,
      signature: sign(null, Buffer.from(payload), keys.privateKey).toString('base64url') },
      trust: { schema: 1, keys: [{ keyId: 'fictional-issuer', publicKeyPem }] } };
  };
  const save = (bundle: unknown = makeBundle()) => writeFileSync(bundlePath, JSON.stringify(bundle), { mode: 0o600 });
  save();
  const install = (expectedPublicKeySha256 = fingerprint, retirePreviousKeys = false) => installDesktopServiceEntitlement({
    dataDirectory: data, bundlePath, expectedPublicKeySha256, retirePreviousKeys, now: NOW + 1000 });
  return { data, companyId, hostInstallationId, fingerprint, bundlePath, makeBundle, save, install };
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('local signed service handoff', () => {
  it('installs the verified public envelope and trust file for the already linked host', async () => {
    const f = fixture();
    await expect(f.install()).resolves.toMatchObject({ companyId: f.companyId, hostInstallationId: f.hostInstallationId, expiresAt: NOW + DAY });
    for (const file of ['service-entitlement.json', 'service-trust-keys.json']) {
      expect(statSync(join(f.data, file)).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(f.data, file), 'utf8')).not.toContain('PRIVATE KEY');
    }
    expect(readServiceEntitlement({ managed: true, path: join(f.data, 'service-entitlement.json'),
      trustedKeysPath: join(f.data, 'service-trust-keys.json'), companyId: f.companyId,
      hostInstallationId: f.hostInstallationId, now: NOW + 1000 }).state).toBe('active');
  });

  it('refuses a wrong fingerprint, wrong host, expired grant and tampered signature without replacing a good install', async () => {
    const f = fixture();
    await f.install();
    const original = readFileSync(join(f.data, 'service-entitlement.json'), 'utf8');
    await expect(f.install('0'.repeat(64))).rejects.toThrow();
    f.save(f.makeBundle({ hostInstallationId: 'foreign-installation' }));
    await expect(f.install()).rejects.toThrow();
    f.save(f.makeBundle({ issuedAt: NOW - 2 * DAY, notBefore: NOW - 2 * DAY, expiresAt: NOW - DAY }));
    await expect(f.install()).rejects.toThrow();
    const tampered = f.makeBundle();
    tampered.entitlement.signature = 'A'.repeat(86);
    f.save(tampered);
    await expect(f.install()).rejects.toThrow();
    expect(readFileSync(join(f.data, 'service-entitlement.json'), 'utf8')).toBe(original);
    expect(() => statSync(serviceEntitlementInstallLockPath(f.data))).toThrow();
  });

  it('rejects an altered key under a trusted key id and keeps the old grant', async () => {
    const f = fixture();
    await f.install();
    const original = readFileSync(join(f.data, 'service-entitlement.json'), 'utf8');
    const replacement = generateKeyPairSync('ed25519');
    const pem = replacement.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const fingerprint = createHash('sha256').update(replacement.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
    const bundle = f.makeBundle();
    bundle.trust.keys[0]!.publicKeyPem = pem;
    f.save(bundle);
    await expect(f.install(fingerprint)).rejects.toThrow();
    expect(readFileSync(join(f.data, 'service-entitlement.json'), 'utf8')).toBe(original);
  });

  it('merges a new signer on renewal without discarding the previous trust key', async () => {
    const f = fixture();
    await f.install();
    const replacement = generateKeyPairSync('ed25519');
    const pem = replacement.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const fingerprint = createHash('sha256').update(replacement.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
    const bundle = f.makeBundle();
    bundle.entitlement.keyId = 'fictional-issuer-v2';
    bundle.entitlement.signature = sign(null, Buffer.from(bundle.entitlement.payload), replacement.privateKey).toString('base64url');
    bundle.trust.keys = [{ keyId: 'fictional-issuer-v2', publicKeyPem: pem }];
    f.save(bundle);
    await expect(f.install(fingerprint)).resolves.toMatchObject({ expiresAt: NOW + DAY });
    expect(JSON.parse(readFileSync(join(f.data, 'service-trust-keys.json'), 'utf8')).keys).toHaveLength(2);
  });

  it('retires old trust only after the replacement grant is published', async () => {
    const f = fixture();
    await f.install();
    const oldGrant = readFileSync(join(f.data, 'service-entitlement.json'), 'utf8');
    const replacement = generateKeyPairSync('ed25519');
    const pem = replacement.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const fingerprint = createHash('sha256').update(replacement.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
    const bundle = f.makeBundle();
    bundle.entitlement.keyId = 'fictional-issuer-v2';
    bundle.entitlement.signature = sign(null, Buffer.from(bundle.entitlement.payload), replacement.privateKey).toString('base64url');
    bundle.trust.keys = [{ keyId: 'fictional-issuer-v2', publicKeyPem: pem }];
    f.save(bundle);
    await f.install(fingerprint, true);
    const trustPath = join(f.data, 'service-trust-keys.json');
    expect(JSON.parse(readFileSync(trustPath, 'utf8')).keys).toHaveLength(1);
    expect(readServiceEntitlement({ managed: true, path: join(f.data, 'service-entitlement.json'),
      trustedKeysPath: trustPath, companyId: f.companyId, hostInstallationId: f.hostInstallationId, now: NOW + 1000 }).state).toBe('active');
    const oldPath = join(f.data, 'old-signed-grant.json');
    writeFileSync(oldPath, oldGrant, { mode: 0o600 });
    expect(readServiceEntitlement({ managed: true, path: oldPath, trustedKeysPath: trustPath,
      companyId: f.companyId, hostInstallationId: f.hostInstallationId, now: NOW + 1000 }).state).toBe('invalid');
  });

  it('blocks a concurrent installer, removes its lock on completion, and permits a safe retry', async () => {
    const f = fixture();
    let release!: () => void;
    let signal!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { signal = resolve; });
    const first = withServiceEntitlementInstallLock(f.data, async () => { signal(); await held; });
    await entered;
    await expect(f.install()).rejects.toThrow(/already in progress/);
    expect(() => statSync(join(f.data, 'service-entitlement.json'))).toThrow();
    release();
    await first;
    expect(() => statSync(serviceEntitlementInstallLockPath(f.data))).toThrow();
    await expect(f.install()).resolves.toMatchObject({ companyId: f.companyId });
    expect(() => statSync(serviceEntitlementInstallLockPath(f.data))).toThrow();
  });

  it('leaves a stale crash lock for explicit recovery instead of guessing from a PID', async () => {
    const f = fixture();
    const lock = serviceEntitlementInstallLockPath(f.data);
    writeFileSync(lock, JSON.stringify({ schema: 1, pid: 1, startedAt: NOW - DAY, nonce: 'fictional-crash' }), { mode: 0o600 });
    await expect(f.install()).rejects.toThrow(/already in progress/);
    expect(readFileSync(lock, 'utf8')).toContain('fictional-crash');
    unlinkSync(lock); // operator recovery after confirming no installer runs
    await expect(f.install()).resolves.toMatchObject({ companyId: f.companyId });
  });

  it('requires an existing linked installation before writing either file', async () => {
    const f = fixture();
    unlinkSync(join(f.data, 'service-installation.json'));
    await expect(f.install()).rejects.toThrow();
    expect(() => statSync(join(f.data, 'service-entitlement.json'))).toThrow();
    expect(() => statSync(join(f.data, 'service-trust-keys.json'))).toThrow();
  });
});
