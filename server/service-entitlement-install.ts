/** Local service administrator handoff for a signed desktop entitlement.
 * The office link has already written the trusted company/host binding. This
 * module has no HTTP route and cannot create or change that binding.
 */
import { createHash, createPublicKey, randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { readPrivateJson, removePrivateJson, writePrivateJson } from './private-json.ts';
import { readServiceEntitlement } from './service-entitlement.ts';
import { withServiceEntitlementInstallLock } from './service-entitlement-install-lock.ts';

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function fail(): never { throw new Error('Signed service handoff needs recovery.'); }

/** `expectedPublicKeySha256` comes from the operator's separate issuer receipt,
 * not the bundle. A self-signed bundle cannot choose its own trust anchor. */
export async function installDesktopServiceEntitlement(input: {
  dataDirectory: string; bundlePath: string; expectedPublicKeySha256: string; retirePreviousKeys?: boolean; now?: number;
}): Promise<{ companyId: string; hostInstallationId: string; expiresAt: number }> {
  if (!isAbsolute(input.dataDirectory) || !isAbsolute(input.bundlePath)) fail();
  if (input.retirePreviousKeys !== undefined && typeof input.retirePreviousKeys !== 'boolean') fail();
  if (!/^[a-f0-9]{64}$/.test(input.expectedPublicKeySha256)) fail();
  return withServiceEntitlementInstallLock(input.dataDirectory, () => installLocked(input));
}

async function installLocked(input: {
  dataDirectory: string; bundlePath: string; expectedPublicKeySha256: string; retirePreviousKeys?: boolean; now?: number;
}): Promise<{ companyId: string; hostInstallationId: string; expiresAt: number }> {
  const binding = await readPrivateJson(join(input.dataDirectory, 'service-installation.json'), 2048);
  if (!object(binding) || !exact(binding, ['schema', 'companyId', 'hostInstallationId']) || binding.schema !== 1 ||
    typeof binding.companyId !== 'string' || typeof binding.hostInstallationId !== 'string') fail();
  const bundle = await readPrivateJson(input.bundlePath, 64_000);
  if (!object(bundle) || !exact(bundle, ['schema', 'entitlement', 'trust']) || bundle.schema !== 1 ||
    !object(bundle.entitlement) || !object(bundle.trust) || !exact(bundle.trust, ['schema', 'keys']) ||
    bundle.trust.schema !== 1 || !Array.isArray(bundle.trust.keys) || bundle.trust.keys.length !== 1) fail();
  const entry: unknown = bundle.trust.keys[0];
  if (!object(entry) || !exact(entry, ['keyId', 'publicKeyPem']) || typeof entry.keyId !== 'string' ||
    typeof entry.publicKeyPem !== 'string' || bundle.entitlement.keyId !== entry.keyId) fail();
  let actualFingerprint: string;
  try {
    const key = createPublicKey(entry.publicKeyPem);
    if (key.asymmetricKeyType !== 'ed25519') fail();
    actualFingerprint = createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
  } catch { fail(); }
  if (actualFingerprint !== input.expectedPublicKeySha256) fail();

  const trustPath = join(input.dataDirectory, 'service-trust-keys.json');
  const grantPath = join(input.dataDirectory, 'service-entitlement.json');
  const existing = await readPrivateJson(trustPath, 64_000);
  let keys: unknown[] = [entry];
  if (existing !== undefined) {
    if (!object(existing) || !exact(existing, ['schema', 'keys']) || existing.schema !== 1 ||
      !Array.isArray(existing.keys) || existing.keys.length < 1 || existing.keys.length > 16) fail();
    const same = existing.keys.find((value: unknown) => object(value) && value.keyId === entry.keyId);
    if (same && (!object(same) || same.publicKeyPem !== entry.publicKeyPem)) fail();
    keys = same ? existing.keys : [...existing.keys, entry];
  }
  if (keys.length > 16) fail();
  const trust = { schema: 1, keys };

  // Validate the full signed bytes, lifetime and trusted local company/host
  // before replacing either active file. Scratch files are private and removed
  // even when a malformed handoff is refused.
  const nonce = randomUUID();
  const scratchTrust = join(input.dataDirectory, `.service-trust-${nonce}.json`);
  const scratchGrant = join(input.dataDirectory, `.service-grant-${nonce}.json`);
  try {
    await writePrivateJson(scratchTrust, trust);
    await writePrivateJson(scratchGrant, bundle.entitlement);
    const options = { managed: true, required: true, companyId: binding.companyId,
      hostInstallationId: binding.hostInstallationId, path: scratchGrant, trustedKeysPath: scratchTrust,
      now: input.now ?? Date.now() };
    const checked = readServiceEntitlement(options);
    if (checked.state !== 'active' || !checked.expiresAt) fail();
    // The app may unlink while the administrator validates the transferred
    // bundle. Never publish a grant against a stale local installation.
    const currentBinding = await readPrivateJson(join(input.dataDirectory, 'service-installation.json'), 2048);
    if (!object(currentBinding) || !exact(currentBinding, ['schema', 'companyId', 'hostInstallationId']) ||
      currentBinding.schema !== 1 || currentBinding.companyId !== binding.companyId ||
      currentBinding.hostInstallationId !== binding.hostInstallationId) fail();
    // Merge old keys first. An old grant stays verifiable between these two
    // atomic renames; the new grant is published only after its key is trusted.
    await writePrivateJson(trustPath, trust);
    await writePrivateJson(grantPath, bundle.entitlement);
    if (readServiceEntitlement({ ...options, path: grantPath, trustedKeysPath: trustPath }).state !== 'active') fail();
    if (input.retirePreviousKeys) {
      // Publish the new grant before removing the old trust anchor. A crash
      // before this last atomic write leaves the old key trusted and the lock
      // in place for explicit recovery; rerunning retirement finishes it.
      await writePrivateJson(trustPath, bundle.trust);
      if (readServiceEntitlement({ ...options, path: grantPath, trustedKeysPath: trustPath }).state !== 'active') fail();
    }
    return { companyId: binding.companyId, hostInstallationId: binding.hostInstallationId, expiresAt: checked.expiresAt };
  } finally {
    await removePrivateJson(scratchGrant).catch(() => {});
    await removePrivateJson(scratchTrust).catch(() => {});
  }
}
