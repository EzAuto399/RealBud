/**
 * Vendor-side installation provisioning.
 *
 * One call gives an office installation everything it needs and nothing more:
 * the company's Composio project (created once, its `ak_` key kept on this
 * protected service), a revocable `rbc_` connector credential for the bounded
 * read-only adapters, and a per-installation Modelvia project and model key whose
 * caps are copied from the office's Modelvia customer account. Modelvia is the
 * only source of AI rates, caps, usage and invoices; nothing here bills.
 *
 * Rules this file exists to keep:
 *   - Authority is the verified portal principal. The body may *confirm* a
 *     companyId but never asserts one.
 *   - Secret material is returned exactly once. The stored descriptor has none,
 *     so a later read, an audit line and an error response are all secret-free.
 *   - Every external effect is journalled before it is attempted. A lost outcome
 *     is resumed only once the attempt that lost it can no longer be running,
 *     and only through what can be attributed to this installation: the same
 *     Composio project, the connector device that attempt admitted, and the one
 *     Modelvia key carrying this installation's label, rotated rather than
 *     duplicated. Anything else is held for an operator, never retried into a
 *     second project, a second credential or a second live key.
 *   - No default transport. The Composio org client, the Modelvia client and the
 *     secret store are all injected. Nothing here is deployed.
 */
import { composioAuthConfigClient, GMAIL_AUTH_CONFIG_NAME, oauthAppsFromEnv, TOOLKIT_SLUG, type ComposioAuthConfigClient } from './composio-auth-config.ts';
import { serialized } from './serialized.ts';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { canonical, exact, GatewayError, id, object, requireThat, type PortalPrincipal } from './contracts.ts';
import { connectorRegistry, newConnectorCredential, validateConnectorDevices, type ConnectorDevice } from './connectors.ts';
import { issueDesktopServiceEntitlement, serviceIssuerFromEnv, type DesktopServiceBundle, type ServiceIssuer, type ServiceIssuerState } from './service-entitlement-issuer.ts';
import type { UsageLedger } from './ledger.ts';
import { carryMailboxGrant } from './office-mailbox.ts';
import { composioOrgClient, type ComposioOrgClient, type HttpTransport } from './composio-org.ts';
import { hasCustomerTerms, modelviaKeyClient, ModelviaRotationRefused, type ModelviaCaps, type ModelviaClient, type ModelviaCustomer, type ModelviaMintedKey, type ModelviaRotatedKey, type ModelviaOperatorClient, type ModelviaTermsClient } from './modelvia-keys.ts';

// ---------------------------------------------------------------------------
// Registry file (shared with the provision-connector CLI)
// ---------------------------------------------------------------------------

/** Resolve the nearest existing ancestor too: an output file need not exist yet,
 * and aliased parents must not turn two destinations into one. */
export function physicalPath(path: string): string {
  let ancestor = resolve(path); const tail: string[] = [];
  while (!existsSync(ancestor)) {
    tail.unshift(basename(ancestor)); const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error('Output location is unavailable.');
    ancestor = parent;
  }
  return join(realpathSync(ancestor), ...tail);
}

/** File operations behind every durable publication here; tests inject faults
 * (ENOSPC, a kill) at each boundary. */
export interface DurableIo {
  openSync: typeof openSync; writeSync: (fd: number, data: Buffer, offset: number) => number; fsyncSync: typeof fsyncSync;
  closeSync: typeof closeSync; renameSync: typeof renameSync; linkSync: typeof linkSync; unlinkSync: typeof unlinkSync;
}
export const nodeIo: DurableIo = { openSync, writeSync: (fd, data, offset) => writeSync(fd, data, offset), fsyncSync, closeSync, renameSync, linkSync, unlinkSync };

/** Write `data` to a fresh temp file beside `final`, fsync it, then publish it:
 * `replace` renames over the old file; otherwise a hard link creates the name
 * only if it is free (EEXIST otherwise). Either way the final name only ever
 * holds complete, fsynced bytes, and the directory entry is fsynced too. */
function publishFile(io: DurableIo, final: string, data: string, replace: boolean, temporary = join(dirname(final), `.${basename(final)}.${randomBytes(8).toString('hex')}.tmp`)) {
  const bytes = Buffer.from(data, 'utf8');
  let fd: number | undefined = io.openSync(temporary, 'wx', 0o600), published = false;
  try {
    for (let offset = 0; offset < bytes.length;) offset += io.writeSync(fd, bytes, offset);
    io.fsyncSync(fd); io.closeSync(fd); fd = undefined;
    if (replace) io.renameSync(temporary, final); else io.linkSync(temporary, final);
    published = true;
  } finally {
    if (fd !== undefined) try { io.closeSync(fd); } catch { /* retain original error */ }
    if (!published || !replace) try { io.unlinkSync(temporary); } catch { /* reconciled at next start */ }
  }
  if (process.platform === 'win32') return; // a directory cannot be opened for fsync there
  try {
    const directory = io.openSync(dirname(final), 'r');
    try { io.fsyncSync(directory); } finally { io.closeSync(directory); }
  } catch (error) {
    // A new name this call created but could not make durable is withdrawn, so
    // the caller's failure path (e.g. deleting a project whose key it could not
    // store) never leaves a value behind it.
    if (!replace) try { io.unlinkSync(final); } catch { /* retain original error */ }
    throw error;
  }
}
/** Reconciliation: a temp file is never a published value. One left by a killed
 * writer (it may hold a secret) is removed, never promoted. */
function removeOrphanTemps(directory: string, prefix: string) {
  let names: string[]; try { names = readdirSync(directory); } catch { return; }
  for (const name of names) if (name.startsWith(`.${prefix}`) && name.endsWith('.tmp')) rmSync(join(directory, name), { force: true });
}

interface LockOwner { version: 1; host: string; pid: number; token: string }
function readLockOwner(lock: string): { raw: string; owner?: LockOwner } | undefined {
  let raw: string;
  try { raw = readFileSync(lock, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  try {
    const owner = JSON.parse(raw);
    if (owner?.version === 1 && typeof owner.host === 'string' && Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.token === 'string') return { raw, owner };
  } catch { /* unknown owner */ }
  return { raw };
}
/** Proved dead only on this host: our own pid (updateRegistry is synchronous, so
 * no holder in this process can be mid-change, and a restarted container often
 * gets the dead owner's pid back), or a pid the kernel says does not exist.
 * Another host, an unreadable lock or any live process (EPERM included) is never
 * proved dead. ponytail: a dead owner's pid reused by an unrelated live process
 * keeps the lock held for an operator; compare process start times if that is
 * ever seen in practice. */
function ownerProvedDead(owner: LockOwner | undefined): boolean {
  if (!owner || owner.host !== hostname()) return false;
  if (owner.pid === process.pid) return true;
  try { process.kill(owner.pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}
/** Take the registry lock, recording who holds it. A lock whose owner is proved
 * dead is moved aside and compared byte-for-byte before it is discarded, so a
 * live owner's lock is never removed; anything else refuses. */
function acquireRegistryLock(io: DurableIo, lock: string): string {
  const token = randomBytes(16).toString('hex');
  const record = JSON.stringify({ version: 1, host: hostname(), pid: process.pid, token } satisfies LockOwner);
  for (let attempt = 0; ; attempt++) {
    try { publishFile(io, lock, record, false, `${lock}.${token}.owner`); return token; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 1) throw error; }
    const held = readLockOwner(lock);
    if (!held) continue;
    if (!ownerProvedDead(held.owner)) throw new Error('Registry is locked by a live or unknown writer.');
    const aside = `${lock}.${token}.dead`;
    try { io.renameSync(lock, aside); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    if (readFileSync(aside, 'utf8') !== held.raw) {
      // Another recoverer replaced the dead lock first: put its live lock back.
      try { io.linkSync(aside, lock); } finally { io.unlinkSync(aside); }
      throw new Error('Registry is locked by a live or unknown writer.');
    }
    io.unlinkSync(aside);
  }
}

/** Read → change → publish the device registry under an exclusive lock file.
 * `work` proposes the next registry; the proposal is validated (duplicate ids and
 * duplicate credential hashes are rejected here) before the optional `commit`
 * callback runs, so a caller may write its own private artifact — an issued
 * client credential — only once admission is certain and always before the
 * registry publishes its hash. A failed change leaves the previous registry
 * byte-for-byte intact; a killed writer leaves the previous or the next registry,
 * never a torn one, and its lock is recovered once its owner is proved dead. */
export function updateRegistry<T>(registry: string, work: (devices: ConnectorDevice[]) => { devices: ConnectorDevice[]; commit?: () => T }, io: DurableIo = nodeIo): T {
  if (typeof registry !== 'string' || !isAbsolute(registry)) throw new Error('Use an explicit absolute registry path.');
  const path = physicalPath(registry);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.lock`, token = acquireRegistryLock(io, lock);
  try {
    removeOrphanTemps(dirname(path), `${basename(path)}.`);
    let devices: ConnectorDevice[] = [];
    if (existsSync(path)) {
      const bytes = readFileSync(path);
      if (bytes.length > 1_000_000) throw new Error('Registry too large.');
      devices = validateConnectorDevices(JSON.parse(bytes.toString('utf8')));
    }
    const outcome = work(devices);
    const next = validateConnectorDevices({ version: 1, devices: outcome.devices });
    const result = outcome.commit ? outcome.commit() : (undefined as T);
    publishFile(io, path, JSON.stringify({ version: 1, devices: next }, null, 2), true);
    return result;
  } finally {
    // Never remove a lock this call does not hold.
    if (readLockOwner(lock)?.owner?.token === token) io.unlinkSync(lock);
  }
}

/** Pure core of the operator CLI. Run only on the trusted service machine; it
 * makes no provider call. The registry stores a hash, the private client file
 * holds the one scoped credential. */
export function provisionConnector({ registry, deviceFile, clientOutput, endpoint }: { registry: string; deviceFile: string; clientOutput: string; endpoint: string }) {
  for (const path of [registry, deviceFile, clientOutput]) if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Use explicit absolute file paths.');
  const reportedPaths = { clientOutput, registry };
  const paths = [registry, deviceFile, clientOutput].map(physicalPath);
  // Reject ambiguous case/Unicode aliases conservatively on every host, not only
  // when the current filesystem happens to be case insensitive.
  if (new Set(paths.map(path => path.normalize('NFC').toLowerCase())).size !== 3) throw new Error('Use separate registry, descriptor and client output files.');
  const [registryPath, devicePath, clientPath] = paths as [string, string, string];
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Use an HTTPS service origin without credentials.');
  if (existsSync(clientPath)) throw new Error('Client output already exists; never overwrite an issued credential.');
  const raw = readFileSync(devicePath); if (raw.length > 8192) throw new Error('Device descriptor too large.');
  const device = JSON.parse(raw.toString('utf8'));
  if (!device || typeof device !== 'object' || Array.isArray(device) || Object.hasOwn(device, 'tokenHash')) throw new Error('Use a device descriptor without a token or tokenHash.');
  const credential = newConnectorCredential();
  const proposed = validateConnectorDevices({ version: 1, devices: [{ ...device, tokenHash: credential.tokenHash }] })[0]!;
  return updateRegistry(registryPath, devices => ({
    devices: [...devices, proposed],
    // Write the recoverable scoped client credential before publishing its hash.
    // Failed admission leaves an unusable artifact, never a lost secret.
    commit: () => {
      mkdirSync(dirname(clientPath), { recursive: true, mode: 0o700 });
      publishFile(nodeIo, clientPath, JSON.stringify({ version: 1, endpoint: url.origin, credential: credential.token, profile: device.profile }, null, 2), false);
      return { deviceId: device.id as string, companyId: device.companyId as string, ...reportedPaths };
    },
  }));
}

// ---------------------------------------------------------------------------
// Secret store
// ---------------------------------------------------------------------------

const SECRET_NAME = /^REALBUD_COMPOSIO_PROJECT_[A-Z0-9_]{1,80}$/;

/** Named vendor secrets, addressed by the same `projectKeyEnv` indirection the
 * device registry already uses. Values never appear in a response, a descriptor,
 * an audit line or an error. */
export interface SecretStore {
  read(name: string): string | undefined;
  write(name: string, value: string): void;
  remove(name: string): void;
}

/**
 * File-backed store: one 0600 file per name inside a 0700 directory.
 *
 * HOSTED DEPLOYMENT: swap this for the platform secret manager (a KMS-backed
 * secret store with its own audit trail and rotation). The file store exists so
 * the service runs next to an operator today; it inherits the trust of whoever
 * owns the filesystem, which is not a substitute for managed custody.
 */
export function fileSecretStore(directory: string, io: DurableIo = nodeIo): SecretStore {
  requireThat(typeof directory === 'string' && isAbsolute(directory), 'gateway_secrets_dir_invalid', 503);
  const path = (name: string) => { requireThat(SECRET_NAME.test(name), 'invalid_connector_secret_reference'); return join(directory, name); };
  const ensure = () => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') chmodSync(directory, 0o700);
  };
  // Startup reconciliation: an interrupted write leaves only a temp file, never
  // an admitted secret.
  removeOrphanTemps(directory, 'REALBUD_COMPOSIO_PROJECT_');
  return {
    read(name) {
      const file = path(name);
      if (!existsSync(file)) return undefined;
      const stats = statSync(file);
      // A loose mode means the value may already have been read by someone else.
      requireThat(stats.isFile() && (process.platform === 'win32' || (stats.mode & 0o077) === 0), 'gateway_secret_permissions', 503);
      requireThat(stats.size <= 8192, 'gateway_secret_unreadable', 503);
      const raw = readFileSync(file, 'utf8');
      // Every write ends in a newline; a file without one was cut short (a torn
      // write from before publication was atomic) and is never admitted.
      requireThat(raw.endsWith('\n'), 'gateway_secret_unreadable', 503);
      return raw.trim() || undefined;
    },
    write(name, value) {
      requireThat(typeof value === 'string' && value.trim().length > 0 && value.length <= 8192, 'gateway_secret_unwritable', 503);
      ensure();
      // Never silently replace a secret an installation may already use (EEXIST),
      // and never expose a partly written one: the name appears only once the
      // complete value is fsynced.
      publishFile(io, path(name), `${value.trim()}\n`, false);
    },
    remove(name) { rmSync(path(name), { force: true }); },
  };
}

// ---------------------------------------------------------------------------
// Installation provisioning
// ---------------------------------------------------------------------------

/** Apps a provisioning request admits when it names none. Any other Composio
 * toolkit is admitted on demand when the person asks Bud to connect it
 * (`connectors.ts` `admitApp`), so this is a default, not a catalogue. */
export const ADMITTED_APPS = ['gmail'] as const;
const MAX_PROVISIONED_APPS = 64;

export interface ProvisioningDescriptor {
  version: 1;
  service: { companyId: string; hostInstallationId: string };
  /** `projectId` is the Composio project id (`pr_…`), an identifier the portal
   * records as `composio_project_id`. It is never the project key. */
  connector: { endpoint: string; credential?: string; profile: string; apps: string[]; projectId: string };
  /** `projectId` is the installation's Modelvia project, capped from the office's
   * Modelvia customer. `key` appears on the first response only. */
  model: { provider: 'modelvia'; baseUrl: string; key?: string; keyId: string; projectId: string; spendCapLabel: string };
}
interface StoredRecord {
  state: 'pending' | 'ready' | 'revoking' | 'revoked';
  profile: string; apps: string[];
  /** Modelvia customer account id for this company. Stored beside the descriptor
   * because revocation needs it; kept out of responses and audit lines. */
  customerId: string;
  descriptor?: ProvisioningDescriptor;
  deviceId?: string; projectId?: string; projectKeyEnv?: string; keyId?: string; modelProjectId?: string;
  revocation?: Record<string, unknown>;
  /** Pending only: which attempt owns the record, and since when. A record
   * written before these existed falls back to its `created` column. */
  attempt?: string; attemptAt?: number;
  /** Pending only: hash of the connector credential that attempt admitted. A
   * hash, never the credential; it is what lets a resumed attempt prove the
   * registry device is its own and was never delivered. */
  deviceTokenHash?: string;
  /** Durable office-wide guard against retrying an uncertain config creation. */
  authConfigCreateProjectId?: string;
  /** The Gmail config name that create was for. Absent on records written
   * before `realbud-gmail-managed-v2`: those guarded the legacy managed or the
   * own-client config, never v2, so they do not hold back a v2 create. */
  authConfigCreateName?: string;
  /** Ready only, while a credential redelivery is running: which attempt owns
   * it and since when. Cleared when that redelivery is recorded. */
  redelivery?: { attempt: string; at: number; phase?: 'preparing' | 'rotating'; sourceKeyId?: string };
  /** All rotations whose responses remain unknown, including an older attempt
   * taken over by redelivery. Replacing a lease must not erase its remote effect. */
  pendingRotations?: { attempt: string; sourceKeyId: string }[];
  /** Returned successors that have not yet been confirmed revoked. Identifiers
   * only; retained even when a compensating provider call fails. */
  cleanupKeyIds?: string[];
  /** Durable revocation intent. A lease prevents concurrent cleanup workers;
   * losing that worker never restores delivery or erases an unknown rotation. */
  revocationWork?: {
    deleteProject: boolean;
    keyIds: string[];
    revokedKeyIds: string[];
    attempt?: { id: string; at: number };
    /** Set when revoke cancelled a pending provision: when that attempt began.
     * Its keys are listed by label only once it can no longer be running. */
    pendingSince?: number;
    /** That listing has been journalled into `keyIds`. */
    discovered?: true;
  };
  /** Legacy, written by the removed cap sync before 24 September 2026. Old ready
   * records still carry it and still parse; nothing reads or writes it now. */
  modelviaCaps?: unknown;
  /** Ready only: the last signed desktop service grant issued for this
   * installation (public material only) and the office terms it was issued
   * under, so a repeat returns the same grant until renewal is due. */
  serviceGrant?: StoredServiceGrant;
}
interface StoredServiceGrant {
  keyId: string; licenseId: string; serviceExpiresAt: number; expiresAt: number;
  publicKeySha256: string; bundle: DesktopServiceBundle;
}
/** What the desktop receives (`shared/office-link.ts` parses it exactly). */
export interface ServiceGrantDelivery {
  version: 1; purpose: 'desktop-service-entitlement';
  companyId: string; hostInstallationId: string; publicKeySha256: string; bundle: DesktopServiceBundle;
}
/** A stored grant closer than this to its expiry is replaced on the next ask. */
export const SERVICE_GRANT_RENEW_BEFORE_MS = 30 * 24 * 60 * 60_000;
const CONNECTOR_TOKEN = /^rbc_[a-f0-9]{64}$/;
/** Same bound the issuer applies: a grant never outlives 366 days. */
const SERVICE_GRANT_MAX_LIFETIME_MS = 366 * 24 * 60 * 60_000;
/** Per installation, in this process: asks beyond this answer 429. */
export const SERVICE_GRANT_ASKS_PER_HOUR = 30;
export const MODELVIA_CUSTOMER = /^[A-Za-z0-9_.-]{1,128}$/;
/** A pending attempt younger than this may still be running, so it is not
 * resumed. It comfortably exceeds `ATTEMPT_EFFECT_DEADLINE_MS` plus one bounded
 * Modelvia call (30 s), so a resumed attempt never races the one it replaces. */
export const PENDING_RESUME_AFTER_MS = 10 * 60_000;
/** An attempt that has not reached its model-key step by then stops before it,
 * leaving the key to a later resume rather than to two concurrent writers. */
const ATTEMPT_EFFECT_DEADLINE_MS = 5 * 60_000;
/**
 * Default per-request cap: A$4 in nanoAUD. `REALBUD_MODELVIA_REQUEST_CAP_NANO_AUD`
 * overrides it.
 *
 * Modelvia holds a request's bound before it runs, priced on the accepted card
 * (`key-gateway.ts` admission). On the r4 menu (`openrouter-2026-09-r4`) the
 * prompt share is sized from the prompt, reserved at input and cache read, and
 * the output share is `max_tokens` or the route's ceiling: a short prompt holds
 * about A$0.63 on `claude-sonnet-5.5` and A$0.11 on `deepseek-v4.1-flash`, and a
 * prompt near the window about A$4.74 and A$0.39. A request cap below a route's
 * hold drops that route (`auto` serves another; an explicit choice, or none
 * left, is 402 `project_request_cap_exceeded`). A$4 serves Sonnet for all but
 * the largest prompts and equals the request cap on RealBud's billing account
 * at Modelvia. Settlement charges what was generated, not the hold.
 */
export const DEFAULT_REQUEST_CAP_NANO_AUD = '4000000000';
const NANO_AUD = /^[1-9][0-9]{0,20}$/;
/**
 * The installation project's caps, copied from the office's Modelvia customer.
 * Modelvia holds a child project to its parent customer, so the project takes the
 * customer's monthly cap and concurrency as they are. The customer has no request
 * cap, so one request is held to the service's request cap, never above the
 * monthly cap (Modelvia refuses that). The ledger tenant's stored cap fields
 * drive nothing.
 */
export function projectCaps(customer: ModelviaCustomer, requestCapNanoAud: string = DEFAULT_REQUEST_CAP_NANO_AUD): ModelviaCaps {
  const monthly = BigInt(customer.monthlyCapNanoAud), request = BigInt(requestCapNanoAud);
  return { monthlyCapNanoAud: customer.monthlyCapNanoAud, requestCapNanoAud: (request < monthly ? request : monthly).toString(), maxConcurrent: customer.maxConcurrent };
}
/** Exact nanoAUD → "A$1,234.56", whole dollars without cents. BigInt
 * throughout and plain ASCII: no float, no locale data. */
function aud(nanoAud: string): string {
  const cents = (BigInt(nanoAud) + 5_000_000n) / 10_000_000n;
  const dollars = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','), rest = cents % 100n;
  return `A$${dollars}${rest === 0n ? '' : `.${rest.toString().padStart(2, '0')}`}`;
}
/**
 * The human label the descriptor carries, shown on the desktop as is. Printable
 * ASCII, and at most 80 characters for every cap Modelvia can hold (a 21-digit
 * nanoAUD figure prints as 22 characters; concurrency is at most 100), because
 * the desktop's contract (`shared/office-link.ts`) bounds the label it accepts.
 * The raw nanoAUD figures stay in the caps themselves, never in this label.
 */
export const SPEND_CAP_LABEL_MAX = 80;
export function spendCapLabel(caps: ModelviaCaps): string {
  return `${aud(caps.monthlyCapNanoAud)}/month, ${aud(caps.requestCapNanoAud)}/request, ${caps.maxConcurrent} at once`;
}
const capLabel = spendCapLabel;
/** Missing, inactive, another client's (reported as missing by the client) and
 * zero-cap customers are all one answer: the Modelvia side is not ready for this
 * office, which is Modelvia's operator's to fix, not a RealBud failure. */
function readyCustomer(customer: ModelviaCustomer | null): ModelviaCustomer {
  requireThat(customer && customer.active && BigInt(customer.monthlyCapNanoAud) > 0n && customer.maxConcurrent > 0, 'modelvia_customer_not_ready', 409);
  return customer!;
}
export interface ProvisioningOptions {
  ledger: UsageLedger;
  /** Absolute path of the connector device registry this service reads per request. */
  registry: string;
  /** HTTPS origin the desktop calls for `/v1/connectors/*`. */
  endpoint: string;
  secrets: SecretStore;
  org: ComposioOrgClient;
  modelvia: ModelviaClient;
  /** Project-key resolver that verifies the managed read-only Gmail config. */
  authConfigs: ComposioAuthConfigClient;
  /** Per-request cap in nanoAUD, a positive integer string. Default A$4. */
  requestCapNanoAud?: string;
  /** The customer's commercial terms at Modelvia, read before anything is
   * created. Always composed in production (`composeProvisioning`). */
  terms?: Pick<ModelviaTermsClient, 'customerTermsReadiness'>;
  /** The gateway's desktop grant signer (`serviceIssuerFromEnv`). Absent, no
   * desktop grant is issued and provisioning is otherwise unchanged. */
  serviceIssuer?: ServiceIssuer;
  /** For `/ready`; defaults to whether `serviceIssuer` is present. */
  serviceIssuerState?: ServiceIssuerState;
}

export class InstallationProvisioning {
  private readonly options: ProvisioningOptions;
  private readonly endpoint: string;
  /** Recent desktop grant asks per installation (in memory, per process). */
  private readonly grantAsks = new Map<string, number[]>();
  constructor(options: ProvisioningOptions) {
    const url = new URL(options.endpoint);
    requireThat(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'connector_endpoint_invalid', 503);
    requireThat(isAbsolute(options.registry), 'connector_registry_unavailable', 503);
    requireThat(options.requestCapNanoAud === undefined || NANO_AUD.test(options.requestCapNanoAud), 'modelvia_request_cap_invalid', 503);
    this.options = options; this.endpoint = url.origin;
    ensureProvisioningTable(options.ledger);
  }

  /** Configuration state for `/ready`; never the key, its path or its id. */
  get serviceIssuerState(): ServiceIssuerState {
    return this.options.serviceIssuerState ?? (this.options.serviceIssuer ? 'configured' : 'missing');
  }

  /**
   * The signed desktop service grant for the installation that holds `token`,
   * its own connector credential. The device the credential resolves to is the
   * only authority for company and installation; the body names neither.
   *
   * Idempotent: the stored grant is returned again unless a fresh one would
   * be different in substance: the signer or licence changed, the office's
   * service now ends before the stored grant does, the office's service expiry
   * moved and a new grant would last longer, or the stored grant is within
   * `SERVICE_GRANT_RENEW_BEFORE_MS` of expiry and a new one would last longer.
   * A grant capped by the office's own expiry is therefore signed once, not on
   * every ask in its last month. Asks are limited per installation. A suspended or expired office, a revoked or inactive installation
   * and a foreign device are refused, stored grant or not.
   */
  serviceEntitlement(token: unknown, value: unknown): ServiceGrantDelivery {
    requireThat(typeof token === 'string' && CONNECTOR_TOKEN.test(token), 'connector_unauthenticated', 401);
    object(value); exact(value, ['version', 'purpose']);
    requireThat(value.version === 1 && value.purpose === 'desktop-service-entitlement-request', 'invalid_fields');
    const issuer = this.options.serviceIssuer;
    requireThat(issuer, 'service_issuer_unconfigured', 503);
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const device = connectorRegistry(this.options.registry).find(entry => entry.tokenHash === tokenHash);
    requireThat(device && device.active && device.id === device.installationId, 'connector_access_denied', 403);
    const companyId = device!.companyId, installationId = device!.installationId;
    const ledger = this.options.ledger, now = ledger.now();
    const recent = (this.grantAsks.get(installationId) ?? []).filter(at => now - at < 60 * 60_000);
    requireThat(recent.length < SERVICE_GRANT_ASKS_PER_HOUR, 'rate_limited', 429);
    recent.push(now); this.grantAsks.set(installationId, recent);
    const saved = this.saved(companyId, installationId);
    requireThat(saved?.state === 'ready' && saved.deviceId === installationId, 'service_installation_unavailable', 403);
    const tenant = ledger.tenant(companyId);
    requireThat(tenant.active && tenant.goLiveAt <= now && tenant.serviceExpiresAt > now && tenant.licenseId === device!.licenseId, 'service_unavailable', 403);
    const held = saved!.serviceGrant;
    const deliver = (grant: StoredServiceGrant): ServiceGrantDelivery => ({ version: 1, purpose: 'desktop-service-entitlement',
      companyId, hostInstallationId: installationId, publicKeySha256: grant.publicKeySha256, bundle: grant.bundle });
    if (held) {
      const candidate = Math.min(tenant.serviceExpiresAt, now + SERVICE_GRANT_MAX_LIFETIME_MS);
      const longer = candidate > held.expiresAt;
      const reissue = held.keyId !== issuer!.keyId || held.licenseId !== tenant.licenseId || held.expiresAt > tenant.serviceExpiresAt
        || (held.serviceExpiresAt !== tenant.serviceExpiresAt && longer)
        || (held.expiresAt - now <= SERVICE_GRANT_RENEW_BEFORE_MS && longer);
      if (!reissue) return deliver(held);
    }
    // The issuer re-checks the tenant, the ready record and the active device.
    const issued = issueDesktopServiceEntitlement({ ledger, registryPath: this.options.registry, companyId, hostInstallationId: installationId,
      keyId: issuer!.keyId, privateKey: issuer!.privateKey });
    const grant: StoredServiceGrant = { keyId: issuer!.keyId, licenseId: tenant.licenseId, serviceExpiresAt: tenant.serviceExpiresAt,
      expiresAt: (JSON.parse(issued.bundle.entitlement.payload) as { expiresAt: number }).expiresAt, publicKeySha256: issued.publicKeySha256, bundle: issued.bundle };
    ledger.db.transaction(() => {
      const current = this.saved(companyId, installationId);
      requireThat(current?.state === 'ready', 'service_installation_unavailable', 403);
      this.store(companyId, installationId, { ...current!, serviceGrant: grant });
      // Identifiers only: the grant is public, the signer never leaves memory.
      ledger.db.append(companyId, 'desktop_service_grant_issued', null, now,
        { installationId, keyId: grant.keyId, publicKeySha256: grant.publicKeySha256, expiresAt: grant.expiresAt, ...(held ? { renewed: true } : {}) });
    });
    return deliver(grant);
  }

  /** Re-apply each ready installation's caps from its Modelvia customer. See
   * `applyCustomerCaps`; exposed to operators only through `caps-cli.ts`. */
  applyCustomerCaps(companyId: string): Promise<CapsApplied[]> {
    return applyCustomerCaps({ ledger: this.options.ledger, modelvia: this.options.modelvia, requestCapNanoAud: this.options.requestCapNanoAud }, companyId);
  }

  private saved(companyId: string, installationId: string): StoredRecord | undefined {
    const row = this.options.ledger.db.get<{ body: string }>('SELECT body FROM installation_provisioning WHERE tenant=? AND installation=?', companyId, installationId);
    return row ? JSON.parse(row.body) as StoredRecord : undefined;
  }
  private store(companyId: string, installationId: string, record: StoredRecord) {
    this.options.ledger.db.run('UPDATE installation_provisioning SET state=?,body=? WHERE tenant=? AND installation=?', record.state, canonical(record), companyId, installationId);
  }
  /** Write `next` only while `attempt` still owns the pending record. Callers run
   * inside a transaction, so the check and the write are one step. */
  private journal(companyId: string, installationId: string, attempt: string, next: StoredRecord) {
    const current = this.saved(companyId, installationId);
    requireThat(current?.state === 'pending' && current.attempt === attempt, 'installation_provisioning_superseded', 409);
    this.store(companyId, installationId, next);
  }
  /**
   * Take over a pending record whose attempt can no longer be running. The
   * record is claimed with a fresh attempt id under the ledger's write lock, so
   * of two concurrent retries exactly one proceeds.
   */
  private resume(companyId: string, installationId: string, existing: StoredRecord, now: number): StoredRecord {
    const since = existing.attemptAt ?? this.options.ledger.db.get<{ created: number }>('SELECT created FROM installation_provisioning WHERE tenant=? AND installation=?', companyId, installationId)!.created;
    requireThat(now - since >= PENDING_RESUME_AFTER_MS, 'installation_provisioning_in_progress', 409);
    const next: StoredRecord = { ...existing, attempt: randomBytes(12).toString('hex'), attemptAt: now };
    this.options.ledger.db.transaction(() => {
      const current = this.saved(companyId, installationId);
      requireThat(current && canonical(current) === canonical(existing), 'installation_provisioning_in_progress', 409);
      this.store(companyId, installationId, next);
      this.options.ledger.db.append(companyId, 'installation_provision_resumed', null, now, { installationId, pendingSince: since });
    });
    return next;
  }
  /** Shared gate: the portal principal is the authority; the body only confirms it. */
  private scope(actor: PortalPrincipal, value: unknown, fields: string[]): Record<string, unknown> {
    requireThat(actor.role === 'billing_owner', 'forbidden', 403);
    object(value);
    requireThat(Object.keys(value).every(key => fields.includes(key)), 'invalid_fields');
    id(value.companyId); id(value.installationId);
    requireThat(value.companyId === actor.companyId, 'company_scope_mismatch', 403);
    return value;
  }

  /**
   * The office's one Composio project and the secret-store name of its `ak_`
   * key: found, or created and stored. Idempotent and serialized per company in
   * this process; across processes the store's exclusive write is the guard.
   * Provisioning calls it at first link; it can equally be called when an office
   * is created, so the project exists before any installation links.
   * `installationId` only labels the audit line written on a failed key store.
   */
  async ensureOfficeProject(companyId: string, installationId = '', options: { requireTenant?: boolean } = {}): Promise<{ projectId: string; projectKeyEnv: string }> {
    id(companyId);
    // The operator route creates ahead of any link, but only for an office the
    // ledger knows (`tenant_unavailable` otherwise): no project for a typo.
    if (options.requireTenant) this.options.ledger.tenant(companyId);
    const projectName = `realbud-${companyId}`;
    const projectKeyEnv = `REALBUD_COMPOSIO_PROJECT_${companyId.toUpperCase().replace(/[^A-Z0-9]/g, '_').slice(0, 80)}`;
    requireThat(SECRET_NAME.test(projectKeyEnv), 'invalid_connector_secret_reference');
    // One office project, shared by every installation of the company. Two first
    // installations provisioning at once must not both find none and create two:
    // the read-create-store step runs one at a time per company in this process.
    const projectId = await serialized(`composio-project:${companyId}`, async () => {
      const held = this.options.secrets.read(projectKeyEnv);
      const named = (await this.options.org.listProjects()).filter(project => project.name === projectName);
      // Two projects with the office's name cannot be told apart by name alone,
      // and the stored key belongs to only one of them: an operator decides.
      requireThat(named.length <= 1, 'connector_project_ambiguous', 409);
      const found = named[0];
      if (found) {
        // The project exists but its key was never stored (or was lost). Do not
        // regenerate: that invalidates the key any existing installation is using.
        requireThat(held, 'connector_project_key_unavailable', 409);
        return found.id;
      }
      // A stored key with no project is an unresolved earlier attempt, not a
      // reason to create a second project.
      requireThat(!held, 'connector_project_key_orphaned', 409);
      const created = await this.options.org.createProject(projectName);
      try {
        this.options.secrets.write(projectKeyEnv, created.apiKey);
      } catch {
        // The key exists only in this reply. A project whose key was never stored
        // is unusable and would block every later attempt, so the project just
        // created (no installation and no connection in it yet) is deleted, and a
        // later resume starts clean. If that delete is not confirmed either, the
        // next attempt finds the project without a key and stops for an operator.
        let deleted = false;
        try { await this.options.org.deleteProject(created.id); deleted = true; } catch { /* reported below */ }
        try {
          this.options.ledger.db.transaction(() => this.options.ledger.db.append(companyId, 'connector_project_key_unwritable', null, this.options.ledger.now(),
            { installationId, projectId: created.id, projectDeleted: deleted }));
        } catch { /* the error below still stops this attempt */ }
        throw new GatewayError(deleted ? 'connector_project_key_unwritable' : 'connector_project_key_unavailable', deleted ? 503 : 409);
      }
      return created.id;
    });
    return { projectId, projectKeyEnv };
  }

  /**
   * Idempotent per installationId. The call that reaches `ready` returns the
   * secret material; every later call returns the same descriptor with none and
   * touches nothing at Modelvia, unless it asks for `redeliver: true` (see
   * `redeliver`). An interrupted call leaves a `pending` record.
   * A retry while that attempt may still be running is refused; a later retry
   * resumes it (see `resume`) and repeats each step against what the earlier
   * attempt left behind, so a lost reply yields a fresh secret, not a second one.
   */
  async provision(actor: PortalPrincipal, value: unknown): Promise<{ provisioning: ProvisioningDescriptor }> {
    const body = this.scope(actor, value, ['companyId', 'installationId', 'customerId', 'profile', 'apps', 'redeliver']);
    const companyId = actor.companyId, installationId = body.installationId as string;
    requireThat(body.redeliver === undefined || body.redeliver === true, 'invalid_fields');
    const redeliver = body.redeliver === true;
    requireThat(typeof body.profile === 'string' && /^[a-z0-9-]{1,64}$/.test(body.profile), 'invalid_connector_profile');
    const profile = body.profile as string;
    // The company's Modelvia customer account. Required, with no default: guessing
    // one would issue a model key against somebody else's account.
    requireThat(typeof body.customerId === 'string' && MODELVIA_CUSTOMER.test(body.customerId), 'invalid_modelvia_customer');
    const customerId = body.customerId as string;
    // The installation id becomes a Modelvia project id in its request paths.
    // `id()` admits ':' and '/'; a project id cannot carry them. Checked here so
    // an unusable installation id is refused before any external call.
    requireThat(MODELVIA_CUSTOMER.test(`rb-${installationId}`), 'installation_id_not_modelvia_safe');
    let apps = body.apps === undefined ? [...ADMITTED_APPS] : body.apps;
    requireThat(Array.isArray(apps) && apps.length > 0 && apps.length <= MAX_PROVISIONED_APPS && new Set(apps).size === apps.length, 'invalid_connector_apps');
    // Any Composio toolkit slug is admissible: its office auth config is created
    // on the person's first "connect <app>", in the office's own project. Only
    // Gmail's reviewed read-only config is resolved here, as before.
    for (const app of apps as unknown[]) requireThat(typeof app === 'string' && TOOLKIT_SLUG.test(app), 'connector_app_not_admitted', 403);

    // Service entitlement, from the operator's entitlement record
    // (entitlement-cli.ts). A company without one is `tenant_unavailable`.
    const tenant = this.options.ledger.tenant(companyId);
    const entitled = this.options.ledger.now();
    requireThat(tenant.active && tenant.serviceExpiresAt > entitled && entitled >= tenant.goLiveAt, 'service_unavailable', 402);
    // The customer's commercial terms at Modelvia: a read, never an effect. A
    // customer RealBud's client pays for serves nothing without an active policy
    // (409 `customer_terms_required` on every request), so no key is issued into
    // that state; to the office it is the same step as an unready customer. A
    // delivered installation is not re-checked: a repeat asks Modelvia nothing.
    if (this.options.terms && this.saved(companyId, installationId)?.state !== 'ready') {
      requireThat(await this.options.terms.customerTermsReadiness(customerId) !== 'terms_required', 'modelvia_customer_not_ready', 409);
    }

    const recorded = (): StoredRecord | undefined => {
      const existing = this.saved(companyId, installationId);
      if (!existing) return undefined;
      requireThat(existing.state !== 'revoked' && existing.state !== 'revoking', 'installation_revoked', 409);
      requireThat(existing.state === 'ready' ? Boolean(existing.descriptor) : existing.state === 'pending', 'installation_provisioning_outcome_unknown', 409);
      requireThat(existing.profile === profile && existing.customerId === customerId, 'installation_provisioning_conflict', 409);
      // The app list is not identity: apps are admitted on demand later, so a
      // repeat naming a different list continues with the list first recorded.
      apps = existing.apps;
      return existing;
    };
    // Delivered once already: a plain repeat never rotates or mints again and
    // never asks Modelvia anything. Only an explicit redelivery replaces keys.
    const delivered = recorded();
    if (delivered?.state === 'ready') return redeliver ? this.redeliver(companyId, installationId, delivered) : { provisioning: delivered.descriptor! };
    // The office's Modelvia customer must be able to serve before anything is
    // created or journalled: a read, never an effect. Its caps become the project's.
    const customer = await this.options.modelvia.findCustomer(customerId);
    // The body names the customer; only a customer bound to this office may be
    // provisioned into, or this office's spend would bill another one.
    if (customer) requireCustomerBound(this.options.ledger, companyId, customerId, customer);
    const caps = projectCaps(readyCustomer(customer), this.options.requestCapNanoAud);

    // Read again: another call may have started or finished while Modelvia answered.
    const existing = recorded();
    if (existing?.state === 'ready') return redeliver ? this.redeliver(companyId, installationId, existing) : { provisioning: existing.descriptor! };
    const now = this.options.ledger.now();
    let pending: StoredRecord;
    if (existing) {
      pending = this.resume(companyId, installationId, existing, now);
    } else {
      // Journal the intent before the first external effect, so a lost outcome is
      // recoverable rather than repeatable. The audit line carries no customerId.
      pending = { state: 'pending', profile, apps: apps as string[], customerId, attempt: randomBytes(12).toString('hex'), attemptAt: now };
      this.options.ledger.db.transaction(() => {
        this.options.ledger.db.run('INSERT INTO installation_provisioning(tenant,installation,state,body,created) VALUES(?,?,?,?,?)', companyId, installationId, 'pending', canonical(pending), now);
        this.options.ledger.db.append(companyId, 'installation_provision_requested', null, now, { installationId, profile, apps });
      });
    }
    const attempt = pending.attempt!, attemptAt = pending.attemptAt!;

    // (a) The company's Composio project, and its `ak_` key in the secret store.
    const { projectId, projectKeyEnv } = await this.ensureOfficeProject(companyId, installationId);

    const authConfigId = await serialized(`composio-auth-config:${companyId}`, async () => {
      const rows = this.options.ledger.db.all<{ body: string }>('SELECT body FROM installation_provisioning WHERE tenant=?', companyId);
      const name = this.options.authConfigs.gmailAuthConfigName?.();
      const attempted = rows.some(row => {
        const body = JSON.parse(row.body) as StoredRecord;
        if (body.authConfigCreateProjectId !== projectId) return false;
        if (!name || body.authConfigCreateName !== undefined) return body.authConfigCreateName === name;
        return name !== GMAIL_AUTH_CONFIG_NAME;
      });
      const projectKey = this.options.secrets.read(projectKeyEnv);
      requireThat(projectKey, 'connector_project_key_unavailable', 409);
      return this.options.authConfigs.resolveGmail({ projectKey: projectKey!, allowCreate: !attempted, beforeCreate: () => {
        requireThat(this.options.ledger.now() - attemptAt < ATTEMPT_EFFECT_DEADLINE_MS, 'installation_provisioning_expired', 409);
        pending = { ...pending, authConfigCreateProjectId: projectId, ...(name ? { authConfigCreateName: name } : {}) };
        this.options.ledger.db.transaction(() => this.journal(companyId, installationId, attempt, pending));
      } });
    });

    // (b) The revocable `rbc_` connector credential, admitted by hash only. A
    // resumed attempt replaces the device its predecessor admitted: that
    // credential was never delivered, because the record never reached `ready`.
    const credential = newConnectorCredential();
    const device: ConnectorDevice = {
      id: installationId, companyId, licenseId: tenant.licenseId,
      // At vendor provisioning time the installation is the seat. Splitting one
      // installation across members needs a separate device per member.
      memberId: installationId, installationId, profile,
      tokenHash: credential.tokenHash, active: true, expiresAt: tenant.serviceExpiresAt,
      projectKeyEnv, authConfigId, userId: `installation-${installationId}`,
      apps: apps as string[],
    };
    const admitted = pending.deviceTokenHash;
    this.options.ledger.db.transaction(() => {
      // Both steps are synchronous, so nothing interleaves between the registry
      // change and the journal line that records whose device it is.
      this.journal(companyId, installationId, attempt, { ...pending, deviceTokenHash: credential.tokenHash });
      updateRegistry(this.options.registry, devices => {
        const current = devices.find(entry => entry.id === device.id);
        if (!current) return { devices: [...devices, device] };
        requireThat(admitted !== undefined && current.tokenHash === admitted && current.active && current.companyId === companyId && current.installationId === installationId,
          'connector_device_exists', 409);
        return { devices: devices.map(entry => entry.id === device.id ? device : entry) };
      });
    });

    // (c) One Modelvia project per installation, under the company's customer
    // account, with that customer's caps (read above).
    const spendCapLabel = capLabel(caps);
    const modelvia = this.options.modelvia, modelProjectId = `rb-${installationId}`, label = `${companyId}:${installationId}`;
    const modelProject = await modelvia.createProject({ projectId: modelProjectId, name: `RealBud installation ${installationId}`.slice(0, 200), customerId, ...caps });
    // (d) The installation's model key. A project Modelvia already holds is an
    // earlier attempt whose reply was lost, or one this ledger no longer records.
    // It is adopted only when it sits under this office's customer, with the
    // customer's caps applied, and its keys are read before anything is minted.
    let live: { keyId: string; label?: string }[] = [];
    if (!modelProject.created) {
      const adopted = await modelvia.findProject(modelProjectId);
      requireThat(adopted && adopted.customerId === customerId && adopted.environments.includes(modelvia.environment), 'modelvia_project_scope_mismatch', 409);
      requireThat(adopted!.active, 'modelvia_project_inactive', 409);
      await modelvia.updateProjectCaps(modelProjectId, caps);
      const at = this.options.ledger.now();
      live = (await modelvia.listKeys(modelProjectId, modelvia.environment)).filter(key => key.revokedAt === undefined && (key.expiresAt === undefined || key.expiresAt > at));
      // One live key with this installation's label is ours, its secret lost with
      // an earlier reply: rotating it revokes that copy and returns a fresh one.
      // Two, or one we did not label, cannot be attributed: an operator decides.
      requireThat(live.length === 0 || (live.length === 1 && live[0]!.label === label), 'modelvia_keys_ambiguous', 409);
    }
    // Stop before a key effect this attempt may no longer own or be in time for.
    requireThat(this.options.ledger.now() - attemptAt < ATTEMPT_EFFECT_DEADLINE_MS, 'installation_provisioning_expired', 409);
    requireThat(this.saved(companyId, installationId)?.attempt === attempt, 'installation_provisioning_superseded', 409);
    let minted: ModelviaMintedKey, rotatedFrom: string | undefined;
    if (live.length) {
      const rotated = await modelvia.rotate(live[0]!.keyId);
      requireThat(rotated.projectId === modelProjectId, 'modelvia_key_scope_mismatch', 502);
      minted = rotated; rotatedFrom = rotated.replaced;
    } else {
      minted = await modelvia.mint({ projectId: modelProjectId, label });
    }

    const descriptor: ProvisioningDescriptor = {
      version: 1,
      service: { companyId, hostInstallationId: installationId },
      connector: { endpoint: this.endpoint, profile, apps: apps as string[], projectId },
      model: { provider: 'modelvia', baseUrl: minted.baseUrl, keyId: minted.keyId, projectId: modelProject.projectId, spendCapLabel },
    };
    const ready: StoredRecord = { state: 'ready', authConfigCreateProjectId: pending.authConfigCreateProjectId, ...(pending.authConfigCreateName ? { authConfigCreateName: pending.authConfigCreateName } : {}), profile, apps: apps as string[], customerId, descriptor, deviceId: device.id, projectId, projectKeyEnv, keyId: minted.keyId, modelProjectId: modelProject.projectId };
    this.options.ledger.db.transaction(() => {
      this.journal(companyId, installationId, attempt, ready);
      // Audit line carries identifiers only: no project key, no connector
      // credential, no model key, and no Modelvia customer id.
      this.options.ledger.db.append(companyId, 'installation_provisioned', null, this.options.ledger.now(), { installationId, profile, apps, projectId, projectKeyEnv, modelKeyId: minted.keyId, spendCapLabel,
        ...(rotatedFrom ? { modelKeyRotatedFrom: rotatedFrom } : {}), ...(modelProject.created ? {} : { modelProjectAdopted: true }) });
    });
    // The only response that carries secret material.
    return { provisioning: {
      ...descriptor,
      connector: { endpoint: descriptor.connector.endpoint, credential: credential.token, profile, apps: apps as string[], projectId },
      model: { ...descriptor.model, key: minted.key },
    } };
  }

  /**
   * Fresh credentials for a `ready` installation whose one secret-bearing reply
   * never reached the desktop. The portal asks only for the installation whose
   * own token it has just verified, so the caller is that installation.
   *
   * Nothing new is created: the installation's one connector device gets a new
   * credential hash (the previous credential stops working) and its one labelled
   * Modelvia key is rotated (the previous key is revoked). The claim is journalled
   * on the ready record before any effect, so a concurrent redelivery is refused
   * rather than rotating twice; one whose outcome was lost is taken over only
   * after `PENDING_RESUME_AFTER_MS`, and again rotates the one live labelled key.
   */
  private async redeliver(companyId: string, installationId: string, ready: StoredRecord): Promise<{ provisioning: ProvisioningDescriptor }> {
    requireThat(ready.descriptor && ready.deviceId && ready.modelProjectId && ready.keyId, 'installation_provisioning_outcome_unknown', 409);
    requireThat(ready.modelProjectId === `rb-${installationId}`, 'modelvia_project_scope_mismatch', 409);
    // A running redelivery is refused before Modelvia is asked anything; the
    // claim below re-checks it under the write lock.
    requireThat(!ready.redelivery || this.options.ledger.now() - ready.redelivery.at >= PENDING_RESUME_AFTER_MS, 'installation_provisioning_in_progress', 409);
    // A read before any effect: the key stays only under this office's customer.
    const customer = await this.options.modelvia.findCustomer(ready.customerId);
    requireThat(customer, 'modelvia_customer_not_ready', 409);
    requireCustomerBound(this.options.ledger, companyId, ready.customerId, customer!);
    const now = this.options.ledger.now();
    const attempt = randomBytes(12).toString('hex');
    const credential = newConnectorCredential();
    const label = `${companyId}:${installationId}`, modelProjectId = ready.modelProjectId!, deviceId = ready.deviceId!;
    const owned = (record: StoredRecord | undefined) => record?.state === 'ready' && record.redelivery?.attempt === attempt;
    // Claim, journal and replace the connector credential in one synchronous
    // step: of two concurrent redeliveries exactly one gets past here.
    this.options.ledger.db.transaction(() => {
      const current = this.saved(companyId, installationId);
      requireThat(current && canonical(current) === canonical(ready), 'installation_provisioning_in_progress', 409);
      requireThat(!current!.redelivery || now - current!.redelivery.at >= PENDING_RESUME_AFTER_MS, 'installation_provisioning_in_progress', 409);
      this.store(companyId, installationId, { ...current!, redelivery: { attempt, at: now, phase: 'preparing' } });
      this.options.ledger.db.append(companyId, 'installation_redelivery_requested', null, now, { installationId, ...(current!.redelivery ? { resumedSince: current!.redelivery.at } : {}) });
      updateRegistry(this.options.registry, devices => {
        const device = devices.find(entry => entry.id === deviceId);
        requireThat(device && device.active && device.companyId === companyId && device.installationId === installationId, 'connector_device_unavailable', 409);
        // Same installation, new credential: its office Gmail grant follows (rolled back if the registry write fails).
        carryMailboxGrant(this.options.ledger.db, device!, credential.tokenHash);
        return { devices: devices.map(entry => entry.id === deviceId ? { ...entry, tokenHash: credential.tokenHash } : entry) };
      });
    });
    const modelvia = this.options.modelvia;
    let replace: string;
    try {
      const at = this.options.ledger.now();
      const live = (await modelvia.listKeys(modelProjectId, modelvia.environment)).filter(key => key.revokedAt === undefined && (key.expiresAt === undefined || key.expiresAt > at));
      // Exactly one live key carrying this installation's label is the one to
      // replace. None, several, or someone else's: an operator decides.
      requireThat(live.length === 1 && live[0]!.label === label, 'modelvia_keys_ambiguous', 409);
      requireThat(this.options.ledger.now() - now < ATTEMPT_EFFECT_DEADLINE_MS, 'installation_provisioning_expired', 409);
      requireThat(owned(this.saved(companyId, installationId)), 'installation_provisioning_superseded', 409);
      replace = live[0]!.keyId;
      // The intent names the exact predecessor before the remote effect. A
      // missing response remains an unresolved rotation, even after a restart.
      this.options.ledger.db.transaction(() => {
        const current = this.saved(companyId, installationId);
        requireThat(owned(current), 'installation_provisioning_superseded', 409);
        this.store(companyId, installationId, { ...current!, redelivery: { attempt, at: now, phase: 'rotating', sourceKeyId: replace },
          pendingRotations: [...(current!.pendingRotations ?? []), { attempt, sourceKeyId: replace }] });
      });
    } catch (error) {
      // No key effect was attempted, so a later redelivery may start at once.
      try {
        this.options.ledger.db.transaction(() => {
          const current = this.saved(companyId, installationId);
          if (!owned(current)) return;
          const { redelivery: _released, ...rest } = current!;
          this.store(companyId, installationId, rest);
        });
      } catch { /* the marker expires after PENDING_RESUME_AFTER_MS */ }
      throw error;
    }
    let rotated: ModelviaRotatedKey;
    try { rotated = await modelvia.rotate(replace); }
    catch (error) {
      if (error instanceof ModelviaRotationRefused) {
        // Only Modelvia's definitive no-effect response settles this intent.
        // Network failures and unrecognized responses can conceal a successor.
        this.options.ledger.db.transaction(() => {
          const current = this.saved(companyId, installationId);
          if (!current) return;
          const next = { ...current, pendingRotations: (current.pendingRotations ?? []).filter(rotation => rotation.attempt !== attempt) };
          if (next.redelivery?.attempt === attempt) delete next.redelivery;
          this.store(companyId, installationId, next);
        });
      }
      throw error;
    }
    requireThat(rotated.projectId === modelProjectId, 'modelvia_key_scope_mismatch', 502);
    let descriptor: ProvisioningDescriptor | undefined, successorAlreadyRevoked = false;
    this.options.ledger.db.transaction(() => {
      const current = this.saved(companyId, installationId);
      const settled = current && { ...current, pendingRotations: (current.pendingRotations ?? []).filter(rotation => rotation.attempt !== attempt) };
      if (!owned(current)) {
        requireThat(current, 'installation_provisioning_superseded', 409);
        successorAlreadyRevoked = current!.revocationWork?.revokedKeyIds.includes(rotated.keyId) === true;
        const next = { ...settled!, cleanupKeyIds: [...new Set([...(current!.cleanupKeyIds ?? []), ...(successorAlreadyRevoked ? [] : [rotated.keyId])])] };
        // Recording the successor settles this rotation, but not its cleanup.
        // Never let failure of the following revoke lose the new identifier.
        if (next.redelivery?.attempt === attempt) delete next.redelivery;
        // A late response normally names a successor already reconciled from
        // Modelvia's listing. Never reopen that confirmed cleanup. An unexpected
        // identifier still becomes a durable obligation before compensation.
        if (next.state === 'revoked' && !successorAlreadyRevoked) { next.state = 'revoking'; delete next.revocation; }
        this.store(companyId, installationId, next);
        return;
      }
      const { redelivery: _done, ...rest } = settled!;
      descriptor = { ...rest.descriptor!, model: { ...rest.descriptor!.model, baseUrl: rotated.baseUrl, keyId: rotated.keyId } };
      this.store(companyId, installationId, { ...rest, keyId: rotated.keyId, descriptor });
      // Identifiers only: no credential, no model key, no Modelvia customer id.
      this.options.ledger.db.append(companyId, 'installation_credentials_redelivered', null, this.options.ledger.now(),
        { installationId, modelKeyId: rotated.keyId, modelKeyRotatedFrom: rotated.replaced });
    });
    if (!descriptor) {
      // Revoked (or taken over) while rotating: the fresh key must not outlive it.
      if (!successorAlreadyRevoked) try {
        await modelvia.revoke(rotated.keyId);
        this.options.ledger.db.transaction(() => {
          const current = this.saved(companyId, installationId);
          if (!current) return;
          const next = { ...current, cleanupKeyIds: (current.cleanupKeyIds ?? []).filter(keyId => keyId !== rotated.keyId) };
          if (next.revocationWork) next.revocationWork = { ...next.revocationWork,
            keyIds: [...new Set([...next.revocationWork.keyIds, rotated.keyId])],
            revokedKeyIds: [...new Set([...next.revocationWork.revokedKeyIds, rotated.keyId])] };
          this.store(companyId, installationId, next);
        });
      } catch { /* cleanupKeyIds is the durable retry obligation */ }
      throw new GatewayError('installation_provisioning_superseded', 409);
    }
    const delivered: ProvisioningDescriptor = descriptor;
    return { provisioning: {
      ...delivered,
      connector: { ...delivered.connector, credential: credential.token },
      model: { ...delivered.model, key: rotated.key },
    } };
  }

  /**
   * Deactivate the installation: the connector device stops serving first, then
   * the Modelvia key is marked for revocation. The Composio project is deleted
   * only on an explicit `deleteProject: true` — that call is irreversible and
   * revokes the office's upstream OAuth credentials at the provider. No service
   * entitlement is required: an expired or suspended office can still be shut off.
   */
  async revoke(actor: PortalPrincipal, value: unknown): Promise<{ revoked: Record<string, unknown> }> {
    const body = this.scope(actor, value, ['companyId', 'installationId', 'deleteProject']);
    const companyId = actor.companyId, installationId = body.installationId as string;
    requireThat(body.deleteProject === undefined || typeof body.deleteProject === 'boolean', 'invalid_fields');
    const deleteProject = body.deleteProject === true;
    const saved = this.saved(companyId, installationId);
    if (!saved) {
      // Nothing was ever journalled, so there is nothing to undo. Leave a
      // tombstone so a provision already past its first read (waiting on
      // Modelvia) meets `installation_revoked` on its re-read instead of minting
      // for a computer the office has already removed.
      const now = this.options.ledger.now();
      const tombstone: StoredRecord = { state: 'revoked', profile: '', apps: [], customerId: '', revocation: { companyId, installationId, neverProvisioned: true } };
      this.options.ledger.db.transaction(() => {
        if (this.saved(companyId, installationId)) return;
        this.options.ledger.db.run('INSERT INTO installation_provisioning(tenant,installation,state,body,created) VALUES(?,?,?,?,?)', companyId, installationId, 'revoked', canonical(tombstone), now);
        this.options.ledger.db.append(companyId, 'installation_revoked_unprovisioned', null, now, { installationId });
      });
    }
    // A tombstone answers exactly like the first removal, so the website clears
    // its pending cleanup the same way every time.
    requireThat(saved && saved.revocation?.neverProvisioned !== true, 'installation_not_provisioned', 404);
    // Only a completed record is idempotent success. A durable revoking record
    // still owes cleanup, even when its previous worker or response was lost.
    if (saved!.state === 'revoked') return { revoked: saved!.revocation ?? { companyId, installationId } };
    // A pending record (a provision whose outcome was lost) becomes a durable
    // cancellation: the claim below fences its attempt, and once that attempt can
    // no longer be running the keys it may have minted are found by label and revoked.
    const cancelling = saved!.state === 'pending' || saved!.revocationWork?.pendingSince !== undefined;
    requireThat(cancelling ? !deleteProject : (saved!.state === 'ready' || saved!.state === 'revoking') && saved!.deviceId && saved!.keyId && saved!.projectId, 'installation_provisioning_outcome_unknown', 409);
    // The Composio project and its key are the office's, shared by every
    // installation of the company. Deleting them for one computer would cut off
    // every other one, so it is refused, before any effect, while another
    // installation is ready or still being provisioned. Revoke the others first.
    if (deleteProject) {
      const others = this.options.ledger.db.get<{ count: number }>("SELECT count(*) AS count FROM installation_provisioning WHERE tenant=? AND installation<>? AND state IN ('ready','pending','revoking')", companyId, installationId)!.count;
      requireThat(others === 0, 'connector_project_in_use', 409);
    }

    const attempt = randomBytes(12).toString('hex'), now = this.options.ledger.now();
    this.options.ledger.db.transaction(() => {
      const current = this.saved(companyId, installationId);
      requireThat(current && canonical(current) === canonical(saved), 'installation_revocation_in_progress', 409);
      const previous = current!.revocationWork;
      requireThat(!previous || previous.deleteProject === deleteProject, 'installation_revocation_conflict', 409);
      requireThat(!previous?.attempt || now - previous.attempt.at >= PENDING_RESUME_AFTER_MS, 'installation_revocation_in_progress', 409);
      // Dropping the provision attempt id fences it: its pre-key ownership check
      // and every journal write now fail, so it can never mint after this point.
      const { attempt: _fenced, attemptAt, ...rest } = current!;
      const pendingSince = previous?.pendingSince ?? (current!.state === 'pending'
        ? attemptAt ?? this.options.ledger.db.get<{ created: number }>('SELECT created FROM installation_provisioning WHERE tenant=? AND installation=?', companyId, installationId)!.created
        : undefined);
      const next: StoredRecord = { ...(current!.state === 'pending' ? rest : current!), state: 'revoking', revocationWork: {
        deleteProject,
        keyIds: [...new Set([...(previous?.keyIds ?? []), ...(current!.keyId ? [current!.keyId] : []), ...(current!.redelivery?.sourceKeyId ? [current!.redelivery.sourceKeyId] : []),
          ...(current!.pendingRotations ?? []).map(rotation => rotation.sourceKeyId)])],
        revokedKeyIds: previous?.revokedKeyIds ?? [], attempt: { id: attempt, at: now },
        ...(pendingSince !== undefined ? { pendingSince } : {}), ...(previous?.discovered ? { discovered: true as const } : {}),
      } };
      // A preparing redelivery cannot start rotate after this transaction. Old
      // markers lack that proof and remain unknown until explicitly resolved.
      if (next.redelivery?.phase === 'preparing') delete next.redelivery;
      this.store(companyId, installationId, next);
      if (current!.state === 'ready') this.options.ledger.db.append(companyId, 'installation_revocation_requested', null, now, { installationId });
      if (current!.state === 'pending') this.options.ledger.db.append(companyId, 'installation_revocation_requested', null, now, { installationId, provisioningCancelled: true, pendingSince });
    });
    const currentWork = (): StoredRecord => {
      const current = this.saved(companyId, installationId);
      requireThat(current?.state === 'revoking' && current.revocationWork?.attempt?.id === attempt, 'installation_revocation_superseded', 409);
      return current!;
    };
    try {
      // Stop connector access before the first remote call. A failure leaves
      // the durable claim in place and cannot restore credential delivery.
      // A pending record has no deviceId yet; the device it may have admitted is
      // keyed by the installation id.
      const deviceId = saved!.deviceId ?? installationId;
      updateRegistry(this.options.registry, devices => ({ devices: devices.map(entry => entry.id === deviceId && entry.companyId === companyId ? { ...entry, active: false } : entry) }));
      for (;;) {
        const current = currentWork(), work = current.revocationWork!;
        if (work.pendingSince !== undefined && !work.discovered) {
          // The fenced attempt may still have a key call in flight until its own
          // deadline has passed; only then is a listing complete.
          requireThat(this.options.ledger.now() - work.pendingSince >= PENDING_RESUME_AFTER_MS, 'installation_revocation_in_progress', 409);
          const modelvia = this.options.modelvia, modelProjectId = `rb-${installationId}`, label = `${companyId}:${installationId}`;
          const project = await modelvia.findProject(modelProjectId);
          const listed = project ? await modelvia.listKeys(modelProjectId, modelvia.environment) : [];
          requireThat(listed.every(key => key.projectId === modelProjectId && key.environment === modelvia.environment), 'modelvia_key_scope_mismatch', 502);
          // Only keys carrying this installation's label are attributable to it.
          const ours = listed.filter(key => key.label === label);
          this.options.ledger.db.transaction(() => {
            const latest = currentWork(), held = latest.revocationWork!;
            this.store(companyId, installationId, { ...latest, ...(project ? { modelProjectId } : {}), revocationWork: { ...held, discovered: true,
              keyIds: [...new Set([...held.keyIds, ...ours.map(key => key.keyId)])],
              revokedKeyIds: [...new Set([...held.revokedKeyIds, ...ours.filter(key => key.revokedAt !== undefined).map(key => key.keyId)])] } });
          });
          continue;
        }
        const keys = [...new Set([...work.keyIds, ...(current.cleanupKeyIds ?? [])])];
        const keyId = keys.find(key => !work.revokedKeyIds.includes(key));
        if (!keyId) {
          if (!current.redelivery && !(current.pendingRotations ?? []).length) break;
          // Successful revokes fence every possible source: Modelvia serializes
          // revoke/rotate and cannot rotate an already-revoked predecessor. Its
          // project listing includes all committed keys (revoked ones too), with
          // no pagination. A fresh listing after these fences therefore captures
          // every possible successor even when the rotation response was lost.
          const rotations = [...(current.pendingRotations ?? [])];
          if (current.redelivery) {
            requireThat(current.redelivery.phase === 'rotating' && current.redelivery.sourceKeyId, 'installation_revocation_cleanup_pending', 409);
            rotations.push({ attempt: current.redelivery.attempt, sourceKeyId: current.redelivery.sourceKeyId });
          }
          const sources = [...new Set(rotations.map(rotation => rotation.sourceKeyId))];
          requireThat(current.modelProjectId && sources.every(source => work.revokedKeyIds.includes(source)), 'installation_revocation_cleanup_pending', 409);
          const listed = await this.options.modelvia.listKeys(current.modelProjectId, this.options.modelvia.environment);
          const label = `${companyId}:${installationId}`;
          requireThat(new Set(listed.map(key => key.keyId)).size === listed.length && listed.every(key => key.projectId === current.modelProjectId && key.environment === this.options.modelvia.environment), 'modelvia_key_scope_mismatch', 502);
          // An empty, stale or inconsistent listing is not proof: all fenced
          // source records must still be visible with the expected binding.
          requireThat(sources.every(source => listed.some(key => key.keyId === source && key.label === label && key.revokedAt !== undefined))
            && listed.every(key => !work.revokedKeyIds.includes(key.keyId) || key.revokedAt !== undefined), 'installation_revocation_cleanup_pending', 409);
          this.options.ledger.db.transaction(() => {
            const latest = currentWork(), held = latest.revocationWork!;
            const settled = new Set(rotations.map(rotation => rotation.attempt));
            const successors = listed.filter(key => key.label === label && key.revokedAt === undefined && !held.revokedKeyIds.includes(key.keyId)).map(key => key.keyId);
            const confirmed = listed.filter(key => key.label === label && key.revokedAt !== undefined).map(key => key.keyId);
            const next = { ...latest,
              pendingRotations: (latest.pendingRotations ?? []).filter(rotation => !settled.has(rotation.attempt)),
              cleanupKeyIds: [...new Set([...(latest.cleanupKeyIds ?? []), ...successors])],
              revocationWork: { ...held, keyIds: [...new Set([...held.keyIds, ...confirmed])], revokedKeyIds: [...new Set([...held.revokedKeyIds, ...confirmed])] } };
            if (next.redelivery && settled.has(next.redelivery.attempt)) delete next.redelivery;
            this.store(companyId, installationId, next);
          });
          continue;
        }
        // The per-key provider revoke does not cascade to a successor. Re-read
        // the journal after every await so a returned successor is also revoked.
        await this.options.modelvia.revoke(keyId);
        this.options.ledger.db.transaction(() => {
          const latest = currentWork(), held = latest.revocationWork!;
          this.store(companyId, installationId, { ...latest,
            cleanupKeyIds: (latest.cleanupKeyIds ?? []).filter(key => key !== keyId),
            revocationWork: { ...held, keyIds: [...new Set([...held.keyIds, keyId])], revokedKeyIds: [...new Set([...held.revokedKeyIds, keyId])] } });
        });
      }
      // The Modelvia project is retained for usage and billing history. Project
      // deletion below concerns only the explicitly requested Composio cleanup.
      let revokeJobId: string | undefined, projectAlreadyAbsent = false;
      if (deleteProject) {
        const others = this.options.ledger.db.get<{ count: number }>("SELECT count(*) AS count FROM installation_provisioning WHERE tenant=? AND installation<>? AND state IN ('ready','pending','revoking')", companyId, installationId)!.count;
        requireThat(others === 0, 'connector_project_in_use', 409);
        projectAlreadyAbsent = !(await this.options.org.listProjects()).some(project => project.id === saved!.projectId);
        if (!projectAlreadyAbsent) revokeJobId = (await this.options.org.deleteProject(saved!.projectId!)).revokeJobId;
        if (saved!.projectKeyEnv) this.options.secrets.remove(saved!.projectKeyEnv);
      }
      return this.options.ledger.db.transaction(() => {
        const current = currentWork(), work = current.revocationWork!;
        requireThat(!current.redelivery && !(current.pendingRotations ?? []).length && !(current.cleanupKeyIds ?? []).length && work.keyIds.every(key => work.revokedKeyIds.includes(key)), 'installation_revocation_cleanup_pending', 409);
        const revocation = { companyId, installationId, connectorDeactivated: true, modelKeyRevoked: true,
          ...(current.keyId ? { modelKeyId: current.keyId } : {}),
          ...(work.keyIds.length > 1 || (!current.keyId && work.keyIds.length) ? { modelKeyIds: work.keyIds } : {}),
          ...(work.pendingSince !== undefined ? { provisioningCancelled: true } : {}),
          modelProjectRetained: current.modelProjectId ?? null, projectDeleted: deleteProject, ...(revokeJobId ? { revokeJobId } : {}),
          ...(projectAlreadyAbsent ? { projectAlreadyAbsent: true } : {}) };
        const { attempt: _done, ...completed } = work;
        this.store(companyId, installationId, { ...current, state: 'revoked', revocationWork: completed, revocation });
        this.options.ledger.db.append(companyId, 'installation_revoked', null, this.options.ledger.now(), revocation);
        return { revoked: revocation };
      });
    } catch (error) {
      // Known failed workers release only their lease. Unconfirmed key effects
      // and the revoking state survive and can be inspected/retried after restart.
      this.options.ledger.db.transaction(() => {
        const current = this.saved(companyId, installationId);
        if (current?.state !== 'revoking' || current.revocationWork?.attempt?.id !== attempt) return;
        const { attempt: _failed, ...remaining } = current.revocationWork;
        this.store(companyId, installationId, { ...current, revocationWork: remaining });
      });
      throw error;
    }
  }
}

/** Never let an unexpected failure inside provisioning become a 502 with detail. */
export function provisioningError(error: unknown): GatewayError {
  return error instanceof GatewayError ? error : new GatewayError('installation_provisioning_failed', 502);
}

/**
 * Refuses unless `customerId` is `companyId`'s own Modelvia customer. Every path
 * that issues, rotates, adopts or re-caps an installation key goes through here.
 * A customer that pays Modelvia itself carries its billing account, which is the
 * office's company id, and must name this office. A customer RealBud's client
 * pays for carries none; then the operator binding recorded through the office
 * AI access route (`bindOfficeCustomer`) decides, and it is never inferred from
 * a request body: a customer bound to another office, or an office bound to
 * another customer, is 403 `modelvia_customer_not_bound`; an office with no
 * binding yet is 409 `office_customer_unbound` until an operator sets its office
 * AI access once (see DEPLOY.md).
 */
export function requireCustomerBound(ledger: UsageLedger, companyId: string, customerId: string, customer: ModelviaCustomer): void {
  if (customer.billingCompanyId !== undefined) return requireThat(customer.billingCompanyId === companyId, 'modelvia_customer_not_bound', 403);
  ensureCustomerBindingTable(ledger);
  const holder = ledger.db.get<{ tenant: string }>('SELECT tenant FROM office_modelvia_customer WHERE customer=?', customerId);
  requireThat(!holder || holder.tenant === companyId, 'modelvia_customer_not_bound', 403);
  const office = ledger.db.get<{ customer: string }>('SELECT customer FROM office_modelvia_customer WHERE tenant=?', companyId);
  requireThat(office, 'office_customer_unbound', 409);
  requireThat(office!.customer === customerId, 'modelvia_customer_not_bound', 403);
}
/** Operator-only: record that `customerId` is `companyId`'s Modelvia customer.
 * A customer already bound to another office is refused; an office may be
 * moved to a new customer by its operator, unless it has accepted AI resale
 * (409 `office_customer_rebind_blocked`) or any installation still holds keys
 * under a different customer (409 `office_customer_rebind_has_installations`):
 * an installation's Modelvia project stays under the customer it was made in,
 * so its keys would keep spending against whichever office holds that customer
 * next. Disconnect those computers first. */
export function bindOfficeCustomer(ledger: UsageLedger, companyId: string, customerId: string): void {
  id(companyId); requireThat(MODELVIA_CUSTOMER.test(customerId), 'invalid_modelvia_customer');
  ensureCustomerBindingTable(ledger);
  ensureProvisioningTable(ledger);
  ledger.db.transaction(() => {
    // In the same write transaction as the binding. Provisioning checks the
    // binding with no await before it journals its pending record, so one of the
    // two always sees the other. A revoking record still owes key cleanup.
    const crossed = ledger.db.all<{ tenant: string; body: string }>("SELECT tenant, body FROM installation_provisioning WHERE state<>'revoked'")
      .some(row => (row.tenant === companyId) !== ((JSON.parse(row.body) as StoredRecord).customerId === customerId));
    requireThat(!crossed, 'office_customer_rebind_has_installations', 409);
    const other = ledger.db.get<{ tenant: string }>('SELECT tenant FROM office_modelvia_customer WHERE customer=? AND tenant<>?', customerId, companyId);
    requireThat(!other, 'modelvia_customer_bound_elsewhere', 409);
    // An office that accepted AI resale is billed from its bound customer's
    // Modelvia invoices; moving it would strand that customer's unbilled AI.
    const current = ledger.db.get<{ customer: string }>('SELECT customer FROM office_modelvia_customer WHERE tenant=?', companyId);
    requireThat(!current || current.customer === customerId
      || !ledger.db.get("SELECT seq FROM events WHERE tenant=? AND kind='ai_resale_terms_accepted' LIMIT 1", companyId), 'office_customer_rebind_blocked', 409);
    ledger.db.run('INSERT INTO office_modelvia_customer(tenant,customer) VALUES(?,?) ON CONFLICT(tenant) DO UPDATE SET customer=excluded.customer', companyId, customerId);
  });
}
function ensureCustomerBindingTable(ledger: UsageLedger) {
  ledger.db.run('CREATE TABLE IF NOT EXISTS office_modelvia_customer (tenant TEXT PRIMARY KEY, customer TEXT NOT NULL UNIQUE)');
}

function ensureProvisioningTable(ledger: UsageLedger) {
  ledger.db.run('CREATE TABLE IF NOT EXISTS installation_provisioning (tenant TEXT NOT NULL, installation TEXT NOT NULL, state TEXT NOT NULL, body TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(tenant,installation))');
}

// ---------------------------------------------------------------------------
// Cap refresh (trusted operator only, via caps-cli.ts)
// ---------------------------------------------------------------------------

/** One installation's outcome. `error` is a code, never an upstream body or a
 * Modelvia customer id. */
export interface CapsApplied { installationId: string; state: 'applied' | 'failed'; error?: string }

/** One refresh per company at a time, within this process. Also used, under its
 * own key, by the operator office AI access route (office-ai-access.ts). */
export { serialized };

/**
 * Provisioning copies caps once. When an office's Modelvia customer changes its
 * monthly cap or concurrency, this re-applies them to every `ready` installation
 * project of that company: one customer read per distinct customer, the same
 * readiness rule as provisioning, then one `updateProjectCaps` per project.
 * Pending and revoked installations are not touched. A failure is reported per
 * installation and never stops the others. An applied installation's stored cap
 * label is updated, so a repeat provision reports the caps in force. Serialized
 * per company.
 */
export function applyCustomerCaps(options: { ledger: UsageLedger; modelvia: ModelviaClient; requestCapNanoAud?: string }, companyId: string): Promise<CapsApplied[]> {
  id(companyId);
  requireThat(options.requestCapNanoAud === undefined || NANO_AUD.test(options.requestCapNanoAud), 'modelvia_request_cap_invalid', 503);
  const { ledger, modelvia } = options;
  const code = (error: unknown) => error instanceof GatewayError ? error.code : 'modelvia_caps_failed';
  return serialized(companyId, async () => {
    ensureProvisioningTable(ledger);
    const rows = ledger.db.all<{ installation: string; body: string }>("SELECT installation, body FROM installation_provisioning WHERE tenant=? AND state='ready' ORDER BY installation", companyId)
      .map(row => ({ installationId: row.installation, record: JSON.parse(row.body) as StoredRecord }))
      .filter(row => typeof row.record.modelProjectId === 'string' && typeof row.record.customerId === 'string');
    // Journalled before any Modelvia call; identifiers only, no customer id.
    ledger.db.transaction(() => ledger.db.append(companyId, 'installation_caps_apply_requested', null, ledger.now(), { installationIds: rows.map(row => row.installationId) }));
    const customers = new Map<string, Promise<ModelviaCaps>>();
    const results: CapsApplied[] = [];
    for (const { installationId, record } of rows) {
      try {
        requireThat(record.modelProjectId === `rb-${installationId}`, 'modelvia_project_scope_mismatch', 409);
        let caps = customers.get(record.customerId);
        if (!caps) {
          caps = modelvia.findCustomer(record.customerId).then(customer => {
            if (customer) requireCustomerBound(ledger, companyId, record.customerId, customer);
            return projectCaps(readyCustomer(customer), options.requestCapNanoAud);
          });
          customers.set(record.customerId, caps);
        }
        const applied = await caps;
        await modelvia.updateProjectCaps(record.modelProjectId!, applied);
        results.push({ installationId, state: 'applied' });
        try {
          ledger.db.transaction(() => {
            const current = ledger.db.get<{ body: string }>("SELECT body FROM installation_provisioning WHERE tenant=? AND installation=? AND state='ready'", companyId, installationId);
            const saved = current && JSON.parse(current.body) as StoredRecord;
            if (!saved?.descriptor || saved.modelProjectId !== record.modelProjectId) return;
            const next: StoredRecord = { ...saved, descriptor: { ...saved.descriptor, model: { ...saved.descriptor.model, spendCapLabel: capLabel(applied) } } };
            ledger.db.run('UPDATE installation_provisioning SET body=? WHERE tenant=? AND installation=?', canonical(next), companyId, installationId);
          });
        } catch { /* Applied at Modelvia already; only the stored label is stale. */ }
      } catch (error) {
        results.push({ installationId, state: 'failed', error: code(error) });
      }
    }
    try { ledger.db.transaction(() => ledger.db.append(companyId, 'installation_caps_applied', null, ledger.now(), { results })); } catch { /* never lose the result */ }
    return results;
  });
}

// ---------------------------------------------------------------------------
// Production composition
// ---------------------------------------------------------------------------

/** Every variable the provisioning routes need. A deployment missing one is
 * named in the 503 reason; a *value* never is. */
export const PROVISIONING_ENV = [
  'REALBUD_GATEWAY_SECRETS_DIR', 'REALBUD_GATEWAY_CONNECTOR_REGISTRY', 'REALBUD_GATEWAY_PUBLIC_ORIGIN',
  'REALBUD_COMPOSIO_ORG_KEY',
  'REALBUD_MODELVIA_BASE_URL', 'REALBUD_MODELVIA_SCOPED_SECRET', 'REALBUD_MODELVIA_OPERATOR_SUBJECT',
  'REALBUD_MODELVIA_CLIENT_ID', 'REALBUD_MODELVIA_MODELS',
] as const;

/** The variables the Modelvia RealBud-scoped client needs, for `/ready`. Presence only;
 * nothing here reads a value into a response or calls Modelvia. */
export const MODELVIA_SCOPED_ENV = ['REALBUD_MODELVIA_BASE_URL', 'REALBUD_MODELVIA_SCOPED_SECRET', 'REALBUD_MODELVIA_OPERATOR_SUBJECT', 'REALBUD_MODELVIA_CLIENT_ID', 'REALBUD_MODELVIA_MODELS'] as const;
function scopedSecretConfigured(env: NodeJS.ProcessEnv): boolean {
  const secret = env.REALBUD_MODELVIA_SCOPED_SECRET ?? '';
  return secret.length >= 32 && secret === secret.trim() && !/[\r\n]/.test(secret)
    && !['REALBUD_GATEWAY_PORTAL_SECRET', 'REALBUD_GATEWAY_OPERATOR_SECRET', 'REALBUD_MODELVIA_OPERATOR_SECRET']
      .some(name => !!env[name] && secret === env[name]);
}
export function modelviaOperatorState(env: NodeJS.ProcessEnv): 'configured' | 'missing' {
  const value = (name: string) => (env[name] ?? '').trim();
  // The /ready `modelviaOperator` field is retained for existing consumers,
  // but it now describes only the scoped credential. The global secret is never
  // accepted as a fallback.
  return MODELVIA_SCOPED_ENV.every(name => value(name)) && scopedSecretConfigured(env) ? 'configured' : 'missing';
}

/** `secrets` is the one store provisioning writes the office project keys into;
 * the connector broker must read the same store (see `composition.ts`). */
export type ProvisioningComposition = { provisioning: InstallationProvisioning; secrets: SecretStore } | { unavailable: string };

/**
 * The Modelvia operator client and request cap, from the environment alone.
 * Shared by `composeProvisioning` and `caps-cli.ts`. Presence of the operator
 * variables is the caller's check; this validates their shape and the optional
 * ones, and reports a code naming the variable, never a value.
 */
export function composeModelvia(options: { env: NodeJS.ProcessEnv; fetch: HttpTransport }): { modelvia: ModelviaOperatorClient; requestCapNanoAud: string } | { unavailable: string } {
  const env = options.env;
  const value = (name: string) => (env[name] ?? '').trim();
  const environment = value('REALBUD_MODELVIA_ENVIRONMENT') || 'production';
  if (environment !== 'production' && environment !== 'development') return { unavailable: 'provisioning_unconfigured:REALBUD_MODELVIA_ENVIRONMENT' };
  // Modelvia matches a project's allowedModels against its real route ids, so
  // the list must name them. There is no default: `auto` is a value a request
  // may send, never an allowlist entry, and as one it admits no route at all
  // (an empty /v1/models and every chat refused). Named here at deploy time.
  const allowedModels = value('REALBUD_MODELVIA_MODELS').split(',').map(entry => entry.trim()).filter(Boolean);
  if (!allowedModels.length || allowedModels.some(model => model.toLowerCase() === 'auto')) return { unavailable: 'provisioning_unconfigured:REALBUD_MODELVIA_MODELS' };
  // Modelvia's scoped verifier refuses a secret under 32 characters; name it now rather
  // than at the first request.
  if (!scopedSecretConfigured(env)) return { unavailable: 'provisioning_unconfigured:REALBUD_MODELVIA_SCOPED_SECRET' };
  const requestCapNanoAud = value('REALBUD_MODELVIA_REQUEST_CAP_NANO_AUD') || DEFAULT_REQUEST_CAP_NANO_AUD;
  if (!NANO_AUD.test(requestCapNanoAud)) return { unavailable: 'provisioning_unconfigured:REALBUD_MODELVIA_REQUEST_CAP_NANO_AUD' };
  try {
    return { requestCapNanoAud, modelvia: modelviaKeyClient({
      serviceOrigin: value('REALBUD_MODELVIA_BASE_URL'),
      environment,
      clientId: value('REALBUD_MODELVIA_CLIENT_ID'),
      allowedModels,
      // A fresh HMAC bearer is minted per request; a static token would 401.
      scopedSecret: () => env.REALBUD_MODELVIA_SCOPED_SECRET,
      operatorSubject: value('REALBUD_MODELVIA_OPERATOR_SUBJECT'),
      fetch: options.fetch,
    }) };
  } catch (error) {
    return { unavailable: `provisioning_unconfigured:${error instanceof GatewayError ? error.code : 'invalid_configuration'}` };
  }
}

/**
 * Resolve the provisioning composition from the environment alone. Secrets are
 * read through getters so a value is never copied into a descriptor, a log or a
 * response; only names reach the failure reason.
 *
 * Fails closed: disabled unless `REALBUD_ENABLE_PROVIDER=1` (the same gate the
 * rest of `server.ts` uses for providers), and a misconfigured deployment yields
 * a 503 reason naming the one variable to fix rather than a half-built client.
 */
export function composeProvisioning(options: { env: NodeJS.ProcessEnv; ledger: UsageLedger; fetch: HttpTransport; org?: ComposioOrgClient; modelvia?: ModelviaClient; authConfigs?: ComposioAuthConfigClient }): ProvisioningComposition {
  const env = options.env;
  const value = (name: string) => (env[name] ?? '').trim();
  if (value('REALBUD_ENABLE_PROVIDER') !== '1') return { unavailable: 'provisioning_disabled' };
  for (const name of PROVISIONING_ENV) if (!value(name)) return { unavailable: `provisioning_unconfigured:${name}` };
  const model = composeModelvia({ env, fetch: options.fetch });
  if ('unavailable' in model) return model;
  try {
    const secrets = fileSecretStore(value('REALBUD_GATEWAY_SECRETS_DIR'));
    // Optional: without a signer the desktop receives no service grant, and
    // `/ready` says so. Never a reason to refuse provisioning.
    const signer = serviceIssuerFromEnv(env);
    return { secrets, provisioning: new InstallationProvisioning({
      ...(signer.issuer ? { serviceIssuer: signer.issuer } : {}), serviceIssuerState: signer.state,
      ledger: options.ledger,
      registry: value('REALBUD_GATEWAY_CONNECTOR_REGISTRY'),
      endpoint: value('REALBUD_GATEWAY_PUBLIC_ORIGIN'),
      secrets,
      org: options.org ?? composioOrgClient({
        // Read per call: the value is never captured into a field.
        orgKey: () => env.REALBUD_COMPOSIO_ORG_KEY,
        fetch: options.fetch,
        ...(value('REALBUD_COMPOSIO_API_BASE') ? { base: value('REALBUD_COMPOSIO_API_BASE') } : {}),
      }),
      modelvia: options.modelvia ?? model.modelvia,
      authConfigs: options.authConfigs ?? composioAuthConfigClient({ fetch: options.fetch, oauthApps: oauthAppsFromEnv(env), ...(value('REALBUD_COMPOSIO_API_BASE') ? { base: value('REALBUD_COMPOSIO_API_BASE') } : {}) }),
      requestCapNanoAud: model.requestCapNanoAud,
      // The composed client always reads terms; an injected one only if it can.
      ...(hasCustomerTerms(options.modelvia ?? model.modelvia) ? { terms: (options.modelvia ?? model.modelvia) as unknown as ModelviaTermsClient } : {}),
    }) };
  } catch (error) {
    // A malformed value (not a missing one) — report the code, never the value.
    return { unavailable: `provisioning_unconfigured:${error instanceof GatewayError ? error.code : 'invalid_configuration'}` };
  }
}
