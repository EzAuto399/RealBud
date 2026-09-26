/** Operator-only offline issuer for the desktop's local signed service gate.
 * The selectors identify an existing installation; every grant field comes from
 * the gateway's current tenant, ready provisioning record and active device.
 */
import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from 'node:crypto';
import { closeSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, unlinkSync, writeSync, constants } from 'node:fs';
import { isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalServiceEntitlementPayload } from '../server/service-entitlement.ts';
import { SERVICE_ENTITLEMENT_CAPABILITIES, type ServiceEntitlementPayload } from '../shared/service-entitlement.ts';
import { connectorRegistry } from './connectors.ts';
import { GatewayError, id, requireThat } from './contracts.ts';
import { LedgerDatabase } from './database.ts';
import { UsageLedger } from './ledger.ts';
import { ledgerPath, loadLocalEnv } from './local-env.ts';

const MAX_LIFETIME_MS = 366 * 24 * 60 * 60_000;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
type Body = { state: string; body: string };

export interface DesktopServiceBundle {
  schema: 1;
  entitlement: { schema: 1; keyId: string; payload: string; signature: string };
  trust: { schema: 1; keys: [{ keyId: string; publicKeyPem: string }] };
}

/** Call only from an operator process with access to the gateway's live ledger
 * and connector registry. It neither changes either source nor trusts a request
 * for licence, expiry or capabilities. */
export function issueDesktopServiceEntitlement(input: {
  ledger: UsageLedger; registryPath: string; companyId: string; hostInstallationId: string;
  keyId: string; privateKey: KeyObject;
}): { bundle: DesktopServiceBundle; publicKeySha256: string } {
  const { ledger, companyId, hostInstallationId, keyId } = input;
  id(companyId); id(hostInstallationId);
  requireThat(KEY_ID.test(keyId), 'invalid_service_key_id');
  requireThat(input.privateKey.type === 'private' && input.privateKey.asymmetricKeyType === 'ed25519', 'service_signing_key_invalid');
  const now = ledger.now();
  requireThat(Number.isSafeInteger(now) && now > 0, 'service_clock_invalid', 503);
  const tenant = ledger.tenant(companyId);
  requireThat(tenant.active && tenant.goLiveAt <= now && tenant.serviceExpiresAt > now, 'service_unavailable', 403);
  const row = ledger.db.get<Body>("SELECT state,body FROM installation_provisioning WHERE tenant=? AND installation=?", companyId, hostInstallationId);
  requireThat(row?.state === 'ready', 'service_installation_unavailable', 403);
  let record: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(row.body);
    requireThat(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed), 'service_installation_unavailable', 403);
    record = parsed as Record<string, unknown>;
  }
  catch { throw new GatewayError('service_installation_unavailable', 403); }
  const descriptor = record.descriptor as Record<string, unknown> | undefined;
  const service = descriptor?.service as Record<string, unknown> | undefined;
  requireThat(record.state === 'ready' && record.deviceId === hostInstallationId &&
    service?.companyId === companyId && service.hostInstallationId === hostInstallationId,
  'service_installation_unavailable', 403);
  const devices = connectorRegistry(input.registryPath);
  const device = devices.find(item => item.id === hostInstallationId);
  requireThat(device?.active && device.companyId === companyId && device.installationId === hostInstallationId &&
    device.licenseId === tenant.licenseId, 'service_host_unavailable', 403);
  const payload: ServiceEntitlementPayload = {
    schema: 1, licenseId: tenant.licenseId, companyId, hostInstallationId,
    issuedAt: now, notBefore: now, expiresAt: Math.min(tenant.serviceExpiresAt, now + MAX_LIFETIME_MS),
    capabilities: [...SERVICE_ENTITLEMENT_CAPABILITIES],
  };
  const canonical = canonicalServiceEntitlementPayload(payload);
  const publicKey = createPublicKey(input.privateKey);
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const publicKeySha256 = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  return { bundle: { schema: 1,
    entitlement: { schema: 1, keyId, payload: canonical, signature: sign(null, Buffer.from(canonical), input.privateKey).toString('base64url') },
    trust: { schema: 1, keys: [{ keyId, publicKeyPem }] } }, publicKeySha256 };
}

/** Refuse links, loose permissions and non-owner files before loading a key. */
export function readOperatorSigningKey(path: string): KeyObject {
  requireThat(isAbsolute(path), 'service_signing_key_path_invalid');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    requireThat(stat.isFile() && stat.nlink === 1 && stat.size > 0 && stat.size <= 16_384 &&
      (stat.mode & 0o077) === 0 && stat.uid === process.getuid?.(), 'service_signing_key_permissions', 503);
    const bytes = Buffer.alloc(stat.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = readSync(fd, bytes, count, bytes.length - count, null);
      if (!read) break;
      count += read;
    }
    requireThat(count === stat.size, 'service_signing_key_invalid', 503);
    try {
      const key = createPrivateKey(bytes.subarray(0, count));
      requireThat(key.asymmetricKeyType === 'ed25519', 'service_signing_key_invalid', 503);
      return key;
    } finally { bytes.fill(0); }
  } finally { closeSync(fd); }
}

function parseArgs(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  const allowed = new Set(['--company', '--installation', '--key-id', '--key-file', '--out']);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    requireThat(key && allowed.has(key) && value && !flags[key], 'service_issuer_usage');
    flags[key] = value;
  }
  requireThat([...allowed].every(key => flags[key]), 'service_issuer_usage');
  return flags;
}

/** An output bundle is public cryptographic material, but keep the transfer
 * file private and create-only so a stale grant cannot be overwritten. */
function writeBundle(path: string, value: DesktopServiceBundle): void {
  requireThat(isAbsolute(path), 'service_bundle_path_invalid');
  const parent = lstatSync(dirname(path));
  requireThat(parent.isDirectory() && !parent.isSymbolicLink() && (parent.mode & 0o077) === 0 &&
    parent.uid === process.getuid?.(), 'service_bundle_directory_permissions', 503);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let completed = false;
  try {
    const bytes = Buffer.from(JSON.stringify(value));
    for (let offset = 0; offset < bytes.length;) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      requireThat(written > 0, 'service_bundle_write_failed', 503);
      offset += written;
    }
    fsyncSync(fd);
    completed = true;
  } finally {
    closeSync(fd);
    if (!completed) try { unlinkSync(path); } catch { /* retain original error */ }
  }
}

export function runServiceEntitlementIssuerCli(args: string[], env: NodeJS.ProcessEnv = process.env,
  out: (line: string) => void = console.log, err: (line: string) => void = console.error): number {
  let db: LedgerDatabase | undefined;
  try {
    const flags = parseArgs(args);
    loadLocalEnv(env);
    const path = ledgerPath(env);
    // LedgerDatabase initializes an absent path: refuse that for an operator.
    lstatSync(path);
    db = new LedgerDatabase(path);
    const registryPath = env.REALBUD_GATEWAY_CONNECTOR_REGISTRY;
    requireThat(registryPath && isAbsolute(registryPath), 'connector_registry_unavailable', 503);
    const result = issueDesktopServiceEntitlement({ ledger: new UsageLedger(db), registryPath,
      companyId: flags['--company']!, hostInstallationId: flags['--installation']!,
      keyId: flags['--key-id']!, privateKey: readOperatorSigningKey(flags['--key-file']!) });
    writeBundle(flags['--out']!, result.bundle);
    out(JSON.stringify({ result: 'issued', output: flags['--out'], publicKeySha256: result.publicKeySha256,
      expiresAt: JSON.parse(result.bundle.entitlement.payload).expiresAt }));
    return 0;
  } catch (error) {
    err(JSON.stringify({ error: error instanceof GatewayError ? error.code : 'service_issuer_failed' }));
    return 1;
  } finally { db?.close(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = runServiceEntitlementIssuerCli(process.argv.slice(2));
}
