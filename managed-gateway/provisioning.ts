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
import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { canonical, GatewayError, id, object, requireThat, type PortalPrincipal } from './contracts.ts';
import { newConnectorCredential, validateConnectorDevices, type ConnectorDevice } from './connectors.ts';
import type { UsageLedger } from './ledger.ts';
import { composioOrgClient, type ComposioOrgClient, type HttpTransport } from './composio-org.ts';
import { modelviaKeyClient, type ModelviaCaps, type ModelviaClient, type ModelviaCustomer, type ModelviaMintedKey, type ModelviaOperatorClient } from './modelvia-keys.ts';

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

/** Read → change → publish the device registry under an exclusive lock file.
 * `work` proposes the next registry; the proposal is validated (duplicate ids and
 * duplicate credential hashes are rejected here) before the optional `commit`
 * callback runs, so a caller may write its own private artifact — an issued
 * client credential — only once admission is certain and always before the
 * registry publishes its hash. A failed change leaves the previous registry
 * byte-for-byte intact. */
export function updateRegistry<T>(registry: string, work: (devices: ConnectorDevice[]) => { devices: ConnectorDevice[]; commit?: () => T }): T {
  if (typeof registry !== 'string' || !isAbsolute(registry)) throw new Error('Use an explicit absolute registry path.');
  const path = physicalPath(registry);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.lock`, lockFd = openSync(lock, 'wx', 0o600);
  let temporary: string | undefined;
  try {
    let devices: ConnectorDevice[] = [];
    if (existsSync(path)) {
      const bytes = readFileSync(path);
      if (bytes.length > 1_000_000) throw new Error('Registry too large.');
      devices = validateConnectorDevices(JSON.parse(bytes.toString('utf8')));
    }
    const outcome = work(devices);
    const next = validateConnectorDevices({ version: 1, devices: outcome.devices });
    const result = outcome.commit ? outcome.commit() : (undefined as T);
    temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, devices: next }, null, 2), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path); temporary = undefined;
    return result;
  } finally {
    if (temporary) try { unlinkSync(temporary); } catch { /* best effort */ }
    closeSync(lockFd); unlinkSync(lock);
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
      writeFileSync(clientPath, JSON.stringify({ version: 1, endpoint: url.origin, credential: credential.token, profile: device.profile }, null, 2), { flag: 'wx', mode: 0o600 });
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
export function fileSecretStore(directory: string): SecretStore {
  requireThat(typeof directory === 'string' && isAbsolute(directory), 'gateway_secrets_dir_invalid', 503);
  const path = (name: string) => { requireThat(SECRET_NAME.test(name), 'invalid_connector_secret_reference'); return join(directory, name); };
  const ensure = () => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') chmodSync(directory, 0o700);
  };
  return {
    read(name) {
      const file = path(name);
      if (!existsSync(file)) return undefined;
      const stats = statSync(file);
      // A loose mode means the value may already have been read by someone else.
      requireThat(stats.isFile() && (process.platform === 'win32' || (stats.mode & 0o077) === 0), 'gateway_secret_permissions', 503);
      requireThat(stats.size <= 8192, 'gateway_secret_unreadable', 503);
      const value = readFileSync(file, 'utf8').trim();
      return value || undefined;
    },
    write(name, value) {
      requireThat(typeof value === 'string' && value.trim().length > 0 && value.length <= 8192, 'gateway_secret_unwritable', 503);
      ensure();
      // `wx`: never silently replace a secret an installation may already use.
      writeFileSync(path(name), `${value.trim()}\n`, { flag: 'wx', mode: 0o600 });
    },
    remove(name) { rmSync(path(name), { force: true }); },
  };
}

// ---------------------------------------------------------------------------
// Installation provisioning
// ---------------------------------------------------------------------------

/** Apps with an admitted read-only adapter in this service. Unknown apps are
 * refused; adding one needs its own reviewed OAuth configuration and adapter. */
export const ADMITTED_APPS = ['gmail'] as const;

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
  state: 'pending' | 'ready' | 'revoked';
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
  /** Legacy, written by the removed cap sync before 24 September 2026. Old ready
   * records still carry it and still parse; nothing reads or writes it now. */
  modelviaCaps?: unknown;
}
export const MODELVIA_CUSTOMER = /^[A-Za-z0-9_.-]{1,128}$/;
/** A pending attempt younger than this may still be running, so it is not
 * resumed. It comfortably exceeds `ATTEMPT_EFFECT_DEADLINE_MS` plus one bounded
 * Modelvia call (30 s), so a resumed attempt never races the one it replaces. */
export const PENDING_RESUME_AFTER_MS = 10 * 60_000;
/** An attempt that has not reached its model-key step by then stops before it,
 * leaving the key to a later resume rather than to two concurrent writers. */
const ATTEMPT_EFFECT_DEADLINE_MS = 5 * 60_000;
/** Default per-request cap: A$1 in nanoAUD. `REALBUD_MODELVIA_REQUEST_CAP_NANO_AUD`
 * overrides it. */
export const DEFAULT_REQUEST_CAP_NANO_AUD = '1000000000';
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
  /** app → the reviewed read-only OAuth configuration id admitted for it. */
  authConfigs: Readonly<Record<string, string>>;
  /** Per-request cap in nanoAUD, a positive integer string. Default A$1. */
  requestCapNanoAud?: string;
}

export class InstallationProvisioning {
  private readonly options: ProvisioningOptions;
  private readonly endpoint: string;
  constructor(options: ProvisioningOptions) {
    const url = new URL(options.endpoint);
    requireThat(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'connector_endpoint_invalid', 503);
    requireThat(isAbsolute(options.registry), 'connector_registry_unavailable', 503);
    requireThat(options.requestCapNanoAud === undefined || NANO_AUD.test(options.requestCapNanoAud), 'modelvia_request_cap_invalid', 503);
    this.options = options; this.endpoint = url.origin;
    ensureProvisioningTable(options.ledger);
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
   * Idempotent per installationId. The call that reaches `ready` returns the
   * secret material; every later call returns the same descriptor with none and
   * touches nothing at Modelvia. An interrupted call leaves a `pending` record.
   * A retry while that attempt may still be running is refused; a later retry
   * resumes it (see `resume`) and repeats each step against what the earlier
   * attempt left behind, so a lost reply yields a fresh secret, not a second one.
   */
  async provision(actor: PortalPrincipal, value: unknown): Promise<{ provisioning: ProvisioningDescriptor }> {
    const body = this.scope(actor, value, ['companyId', 'installationId', 'customerId', 'profile', 'apps']);
    const companyId = actor.companyId, installationId = body.installationId as string;
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
    const apps = body.apps === undefined ? [...ADMITTED_APPS] : body.apps;
    requireThat(Array.isArray(apps) && apps.length > 0 && apps.length <= 8 && new Set(apps).size === apps.length, 'invalid_connector_apps');
    for (const app of apps as unknown[]) requireThat(typeof app === 'string' && (ADMITTED_APPS as readonly string[]).includes(app) && this.options.authConfigs[app], 'connector_app_not_admitted', 403);
    // One device carries one reviewed OAuth configuration, so a device is
    // provisioned for exactly the app that configuration covers. A second app
    // needs its own device and its own reviewed configuration.
    requireThat((apps as string[]).length === 1, 'connector_app_not_admitted', 403);
    const app = (apps as string[])[0]!;

    // Service entitlement, from the operator's entitlement record
    // (entitlement-cli.ts). A company without one is `tenant_unavailable`.
    const tenant = this.options.ledger.tenant(companyId);
    const entitled = this.options.ledger.now();
    requireThat(tenant.active && tenant.serviceExpiresAt > entitled && entitled >= tenant.goLiveAt, 'service_unavailable', 402);

    const recorded = (): StoredRecord | undefined => {
      const existing = this.saved(companyId, installationId);
      if (!existing) return undefined;
      requireThat(existing.state !== 'revoked', 'installation_revoked', 409);
      requireThat(existing.state === 'ready' ? Boolean(existing.descriptor) : existing.state === 'pending', 'installation_provisioning_outcome_unknown', 409);
      requireThat(existing.profile === profile && canonical(existing.apps) === canonical(apps) && existing.customerId === customerId, 'installation_provisioning_conflict', 409);
      return existing;
    };
    // Delivered once already: never rotate or mint again for a repeat, and never
    // ask Modelvia anything.
    const delivered = recorded();
    if (delivered?.state === 'ready') return { provisioning: delivered.descriptor! };
    // The office's Modelvia customer must be able to serve before anything is
    // created or journalled: a read, never an effect. Its caps become the project's.
    const caps = projectCaps(readyCustomer(await this.options.modelvia.findCustomer(customerId)), this.options.requestCapNanoAud);

    // Read again: another call may have started or finished while Modelvia answered.
    const existing = recorded();
    if (existing?.state === 'ready') return { provisioning: existing.descriptor! };
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
    const projectName = `realbud-${companyId}`;
    const projectKeyEnv = `REALBUD_COMPOSIO_PROJECT_${companyId.toUpperCase().replace(/[^A-Z0-9]/g, '_').slice(0, 80)}`;
    requireThat(SECRET_NAME.test(projectKeyEnv), 'invalid_connector_secret_reference');
    // One office project, shared by every installation of the company. Two first
    // installations provisioning at once must not both find none and create two:
    // the read-create-store step runs one at a time per company in this process.
    // Across processes the store's exclusive write is the guard (below).
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
      projectKeyEnv, authConfigId: this.options.authConfigs[app]!, userId: `installation-${installationId}`,
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
    const ready: StoredRecord = { state: 'ready', profile, apps: apps as string[], customerId, descriptor, deviceId: device.id, projectId, projectKeyEnv, keyId: minted.keyId, modelProjectId: modelProject.projectId };
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
    // Already revoked: return the recorded outcome rather than repeating an
    // irreversible act nobody asked for twice.
    if (saved!.state === 'revoked') return { revoked: saved!.revocation ?? { companyId, installationId } };
    requireThat(saved!.state === 'ready' && saved!.deviceId && saved!.keyId && saved!.projectId, 'installation_provisioning_outcome_unknown', 409);
    // The Composio project and its key are the office's, shared by every
    // installation of the company. Deleting them for one computer would cut off
    // every other one, so it is refused, before any effect, while another
    // installation is ready or still being provisioned. Revoke the others first.
    if (deleteProject) {
      const others = this.options.ledger.db.get<{ count: number }>("SELECT count(*) AS count FROM installation_provisioning WHERE tenant=? AND installation<>? AND state IN ('ready','pending')", companyId, installationId)!.count;
      requireThat(others === 0, 'connector_project_in_use', 409);
    }

    // 1. Stop new reads before anything irreversible.
    updateRegistry(this.options.registry, devices => ({ devices: devices.map(entry => entry.id === saved!.deviceId ? { ...entry, active: false } : entry) }));
    // 2. Mark the model key for revocation. The installation's Modelvia project
    // is deliberately LEFT IN PLACE: it holds the usage and billing history the
    // ledger reconciles against, and its caps stop any key under it regardless.
    // Removing a project is an operator action at Modelvia, not a side effect here.
    await this.options.modelvia.revoke(saved!.keyId!);
    // 3. Optional, irreversible, explicit.
    let revokeJobId: string | undefined, projectAlreadyAbsent = false;
    if (deleteProject) {
      // A retry after a delete whose reply (or the record write after it) was
      // lost finds the project gone. Deleting it again would be refused upstream
      // and leave this revocation stuck, so an absent project counts as deleted.
      projectAlreadyAbsent = !(await this.options.org.listProjects()).some(project => project.id === saved!.projectId);
      if (!projectAlreadyAbsent) revokeJobId = (await this.options.org.deleteProject(saved!.projectId!)).revokeJobId;
      if (saved!.projectKeyEnv) this.options.secrets.remove(saved!.projectKeyEnv);
    }
    const revocation = { companyId, installationId, connectorDeactivated: true, modelKeyRevoked: true, modelKeyId: saved!.keyId!,
      modelProjectRetained: saved!.modelProjectId ?? null, projectDeleted: deleteProject, ...(revokeJobId ? { revokeJobId } : {}),
      ...(projectAlreadyAbsent ? { projectAlreadyAbsent: true } : {}) };
    this.options.ledger.db.transaction(() => {
      this.store(companyId, installationId, { ...saved!, state: 'revoked', revocation });
      // One audit line for the whole revocation, with no secret in it.
      this.options.ledger.db.append(companyId, 'installation_revoked', null, this.options.ledger.now(), revocation);
    });
    return { revoked: revocation };
  }
}

/** Never let an unexpected failure inside provisioning become a 502 with detail. */
export function provisioningError(error: unknown): GatewayError {
  return error instanceof GatewayError ? error : new GatewayError('installation_provisioning_failed', 502);
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
const capQueues = new Map<string, Promise<unknown>>();
export function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
  const run = (capQueues.get(key) ?? Promise.resolve()).then(work, work);
  const tail = run.then(() => undefined, () => undefined);
  capQueues.set(key, tail);
  void tail.then(() => { if (capQueues.get(key) === tail) capQueues.delete(key); });
  return run;
}

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
        let caps = customers.get(record.customerId);
        if (!caps) {
          caps = modelvia.findCustomer(record.customerId).then(customer => projectCaps(readyCustomer(customer), options.requestCapNanoAud));
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
  'REALBUD_COMPOSIO_ORG_KEY', 'REALBUD_COMPOSIO_AUTH_CONFIG_GMAIL',
  'REALBUD_MODELVIA_BASE_URL', 'REALBUD_MODELVIA_OPERATOR_SECRET', 'REALBUD_MODELVIA_OPERATOR_SUBJECT',
  'REALBUD_MODELVIA_CLIENT_ID',
] as const;

/** The variables the Modelvia operator client needs, for `/ready`. Presence only;
 * nothing here reads a value into a response or calls Modelvia. */
export const MODELVIA_OPERATOR_ENV = ['REALBUD_MODELVIA_BASE_URL', 'REALBUD_MODELVIA_OPERATOR_SECRET', 'REALBUD_MODELVIA_OPERATOR_SUBJECT', 'REALBUD_MODELVIA_CLIENT_ID'] as const;
export function modelviaOperatorState(env: NodeJS.ProcessEnv): 'configured' | 'missing' {
  const value = (name: string) => (env[name] ?? '').trim();
  return MODELVIA_OPERATOR_ENV.every(name => value(name)) && value('REALBUD_MODELVIA_OPERATOR_SECRET').length >= 32 ? 'configured' : 'missing';
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
  // Modelvia requires a non-empty allowedModels on a project. `auto` is its
  // catalogue-routed default; a deployment may pin exact model ids instead.
  const allowedModels = (value('REALBUD_MODELVIA_MODELS') || 'auto').split(',').map(entry => entry.trim()).filter(Boolean);
  if (!allowedModels.length) return { unavailable: 'provisioning_unconfigured:REALBUD_MODELVIA_MODELS' };
  // Modelvia's verifier refuses a secret under 32 characters; name it now rather
  // than at the first request.
  if (value('REALBUD_MODELVIA_OPERATOR_SECRET').length < 32) return { unavailable: 'provisioning_unconfigured:REALBUD_MODELVIA_OPERATOR_SECRET' };
  const requestCapNanoAud = value('REALBUD_MODELVIA_REQUEST_CAP_NANO_AUD') || DEFAULT_REQUEST_CAP_NANO_AUD;
  if (!NANO_AUD.test(requestCapNanoAud)) return { unavailable: 'provisioning_unconfigured:REALBUD_MODELVIA_REQUEST_CAP_NANO_AUD' };
  try {
    return { requestCapNanoAud, modelvia: modelviaKeyClient({
      serviceOrigin: value('REALBUD_MODELVIA_BASE_URL'),
      environment,
      clientId: value('REALBUD_MODELVIA_CLIENT_ID'),
      allowedModels,
      // A fresh HMAC bearer is minted per request; a static token would 401.
      operatorSecret: () => env.REALBUD_MODELVIA_OPERATOR_SECRET,
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
export function composeProvisioning(options: { env: NodeJS.ProcessEnv; ledger: UsageLedger; fetch: HttpTransport; org?: ComposioOrgClient; modelvia?: ModelviaClient }): ProvisioningComposition {
  const env = options.env;
  const value = (name: string) => (env[name] ?? '').trim();
  if (value('REALBUD_ENABLE_PROVIDER') !== '1') return { unavailable: 'provisioning_disabled' };
  for (const name of PROVISIONING_ENV) if (!value(name)) return { unavailable: `provisioning_unconfigured:${name}` };
  const model = composeModelvia({ env, fetch: options.fetch });
  if ('unavailable' in model) return model;
  try {
    const secrets = fileSecretStore(value('REALBUD_GATEWAY_SECRETS_DIR'));
    return { secrets, provisioning: new InstallationProvisioning({
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
      authConfigs: { gmail: value('REALBUD_COMPOSIO_AUTH_CONFIG_GMAIL') },
      requestCapNanoAud: model.requestCapNanoAud,
    }) };
  } catch (error) {
    // A malformed value (not a missing one) — report the code, never the value.
    return { unavailable: `provisioning_unconfigured:${error instanceof GatewayError ? error.code : 'invalid_configuration'}` };
  }
}
