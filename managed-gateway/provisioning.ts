/**
 * Vendor-side installation provisioning.
 *
 * One call gives an office installation everything it needs and nothing more:
 * the company's Composio project (created once, its `ak_` key kept on this
 * protected service), a revocable `rbc_` connector credential for the bounded
 * read-only adapters, and a per-installation Modelvia model key labelled with the
 * tenant's ledger spend cap.
 *
 * Rules this file exists to keep:
 *   - Authority is the verified portal principal. The body may *confirm* a
 *     companyId but never asserts one.
 *   - Secret material is returned exactly once. The stored descriptor has none,
 *     so a later read, an audit line and an error response are all secret-free.
 *   - Every external effect is journalled before it is attempted. A lost outcome
 *     is held for operator reconciliation, never retried into a second project,
 *     a second credential or a second minted key.
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
import { modelviaKeyClient, type ModelviaClient } from './modelvia-keys.ts';

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
  /** `projectId` is the installation's Modelvia project — where the ledger cap is
   * actually applied. `key` appears on the first response only. */
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
}
const MODELVIA_CUSTOMER = /^[A-Za-z0-9_.-]{1,128}$/;
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
}

export class InstallationProvisioning {
  private readonly options: ProvisioningOptions;
  private readonly endpoint: string;
  constructor(options: ProvisioningOptions) {
    const url = new URL(options.endpoint);
    requireThat(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'connector_endpoint_invalid', 503);
    requireThat(isAbsolute(options.registry), 'connector_registry_unavailable', 503);
    this.options = options; this.endpoint = url.origin;
    options.ledger.db.run('CREATE TABLE IF NOT EXISTS installation_provisioning (tenant TEXT NOT NULL, installation TEXT NOT NULL, state TEXT NOT NULL, body TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(tenant,installation))');
  }

  private saved(companyId: string, installationId: string): StoredRecord | undefined {
    const row = this.options.ledger.db.get<{ body: string }>('SELECT body FROM installation_provisioning WHERE tenant=? AND installation=?', companyId, installationId);
    return row ? JSON.parse(row.body) as StoredRecord : undefined;
  }
  private store(companyId: string, installationId: string, record: StoredRecord) {
    this.options.ledger.db.run('UPDATE installation_provisioning SET state=?,body=? WHERE tenant=? AND installation=?', record.state, canonical(record), companyId, installationId);
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
   * Idempotent per installationId. The first call returns the secret material;
   * every later call returns the same descriptor with none. An interrupted first
   * call leaves a `pending` record and is held for an operator: retrying blind
   * could create a second project, a second device or a second minted key.
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

    const now = this.options.ledger.now();
    const tenant = this.options.ledger.tenant(companyId);
    requireThat(tenant.active && tenant.serviceExpiresAt > now && now >= tenant.goLiveAt, 'service_unavailable', 402);

    const existing = this.saved(companyId, installationId);
    if (existing) {
      requireThat(existing.state !== 'revoked', 'installation_revoked', 409);
      requireThat(existing.state === 'ready' && existing.descriptor, 'installation_provisioning_outcome_unknown', 409);
      requireThat(existing.profile === profile && canonical(existing.apps) === canonical(apps) && existing.customerId === customerId, 'installation_provisioning_conflict', 409);
      return { provisioning: existing.descriptor! };
    }

    // Journal the intent before the first external effect, so a lost outcome is
    // recoverable rather than repeatable. The audit line carries no customerId.
    const pending: StoredRecord = { state: 'pending', profile, apps: apps as string[], customerId };
    this.options.ledger.db.transaction(() => {
      this.options.ledger.db.run('INSERT INTO installation_provisioning(tenant,installation,state,body,created) VALUES(?,?,?,?,?)', companyId, installationId, 'pending', canonical(pending), now);
      this.options.ledger.db.append(companyId, 'installation_provision_requested', null, now, { installationId, profile, apps });
    });

    // (a) The company's Composio project, and its `ak_` key in the secret store.
    const projectName = `realbud-${companyId}`;
    const projectKeyEnv = `REALBUD_COMPOSIO_PROJECT_${companyId.toUpperCase().replace(/[^A-Z0-9]/g, '_').slice(0, 80)}`;
    requireThat(SECRET_NAME.test(projectKeyEnv), 'invalid_connector_secret_reference');
    const held = this.options.secrets.read(projectKeyEnv);
    const found = (await this.options.org.listProjects()).find(project => project.name === projectName);
    let projectId: string;
    if (found) {
      // The project exists but its key was never stored (or was lost). Do not
      // regenerate: that invalidates the key any existing installation is using.
      requireThat(held, 'connector_project_key_unavailable', 409);
      projectId = found.id;
    } else {
      // A stored key with no project is an unresolved earlier attempt, not a
      // reason to create a second project.
      requireThat(!held, 'connector_project_key_orphaned', 409);
      const created = await this.options.org.createProject(projectName);
      this.options.secrets.write(projectKeyEnv, created.apiKey);
      projectId = created.id;
    }

    // (b) The revocable `rbc_` connector credential, admitted by hash only.
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
    updateRegistry(this.options.registry, devices => {
      requireThat(!devices.some(entry => entry.id === device.id), 'connector_device_exists', 409);
      return { devices: [...devices, device] };
    });

    // (c) One Modelvia project per installation, under the company's customer
    // account. Caps live on the project, not on keys, so this is where the
    // ledger tenant's cap is actually applied rather than merely described.
    const requestCapNanoAud = (BigInt(tenant.requestCapNanoAud) < BigInt(tenant.monthlyCapNanoAud) ? tenant.requestCapNanoAud : tenant.monthlyCapNanoAud);
    const spendCapLabel = `monthly-cap ${tenant.monthlyCapNanoAud} nanoAUD, request-cap ${requestCapNanoAud} nanoAUD, max-concurrent ${tenant.maxConcurrent}`;
    const modelProject = await this.options.modelvia.createProject({
      projectId: `rb-${installationId}`, name: `RealBud installation ${installationId}`.slice(0, 200), customerId,
      monthlyCapNanoAud: tenant.monthlyCapNanoAud, requestCapNanoAud, maxConcurrent: tenant.maxConcurrent,
    });
    // Modelvia already holds this project, so a key may already exist under it and
    // its operator surface has no key listing to check. Hold it for an operator
    // rather than risk a second live key for the same installation.
    requireThat(modelProject.created, 'modelvia_project_already_exists', 409);
    const minted = await this.options.modelvia.mint({ projectId: modelProject.projectId, label: `${companyId}:${installationId}` });

    const descriptor: ProvisioningDescriptor = {
      version: 1,
      service: { companyId, hostInstallationId: installationId },
      connector: { endpoint: this.endpoint, profile, apps: apps as string[], projectId },
      model: { provider: 'modelvia', baseUrl: minted.baseUrl, keyId: minted.keyId, projectId: modelProject.projectId, spendCapLabel },
    };
    const ready: StoredRecord = { state: 'ready', profile, apps: apps as string[], customerId, descriptor, deviceId: device.id, projectId, projectKeyEnv, keyId: minted.keyId, modelProjectId: modelProject.projectId };
    this.options.ledger.db.transaction(() => {
      this.store(companyId, installationId, ready);
      // Audit line carries identifiers only: no project key, no connector
      // credential, no model key, and no Modelvia customer id.
      this.options.ledger.db.append(companyId, 'installation_provisioned', null, this.options.ledger.now(), { installationId, profile, apps, projectId, projectKeyEnv, modelKeyId: minted.keyId, spendCapLabel });
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
   * revokes the office's upstream OAuth credentials at the provider.
   */
  async revoke(actor: PortalPrincipal, value: unknown): Promise<{ revoked: Record<string, unknown> }> {
    const body = this.scope(actor, value, ['companyId', 'installationId', 'deleteProject']);
    const companyId = actor.companyId, installationId = body.installationId as string;
    requireThat(body.deleteProject === undefined || typeof body.deleteProject === 'boolean', 'invalid_fields');
    const deleteProject = body.deleteProject === true;
    const saved = this.saved(companyId, installationId);
    requireThat(saved, 'installation_not_provisioned', 404);
    // Already revoked: return the recorded outcome rather than repeating an
    // irreversible act nobody asked for twice.
    if (saved!.state === 'revoked') return { revoked: saved!.revocation ?? { companyId, installationId } };
    requireThat(saved!.state === 'ready' && saved!.deviceId && saved!.keyId && saved!.projectId, 'installation_provisioning_outcome_unknown', 409);

    // 1. Stop new reads before anything irreversible.
    updateRegistry(this.options.registry, devices => ({ devices: devices.map(entry => entry.id === saved!.deviceId ? { ...entry, active: false } : entry) }));
    // 2. Mark the model key for revocation. The installation's Modelvia project
    // is deliberately LEFT IN PLACE: it holds the usage and billing history the
    // ledger reconciles against, and its caps stop any key under it regardless.
    // Removing a project is an operator action at Modelvia, not a side effect here.
    await this.options.modelvia.revoke(saved!.keyId!);
    // 3. Optional, irreversible, explicit.
    let revokeJobId: string | undefined;
    if (deleteProject) {
      revokeJobId = (await this.options.org.deleteProject(saved!.projectId!)).revokeJobId;
      if (saved!.projectKeyEnv) this.options.secrets.remove(saved!.projectKeyEnv);
    }
    const revocation = { companyId, installationId, connectorDeactivated: true, modelKeyRevoked: true, modelKeyId: saved!.keyId!,
      modelProjectRetained: saved!.modelProjectId ?? null, projectDeleted: deleteProject, ...(revokeJobId ? { revokeJobId } : {}) };
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

export type ProvisioningComposition = { provisioning: InstallationProvisioning } | { unavailable: string };

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
  const environment = value('REALBUD_MODELVIA_ENVIRONMENT') || 'production';
  if (environment !== 'production' && environment !== 'development') return { unavailable: 'provisioning_unconfigured:REALBUD_MODELVIA_ENVIRONMENT' };
  // Modelvia requires a non-empty allowedModels on a project. `auto` is its
  // catalogue-routed default; a deployment may pin exact model ids instead.
  const allowedModels = (value('REALBUD_MODELVIA_MODELS') || 'auto').split(',').map(entry => entry.trim()).filter(Boolean);
  if (!allowedModels.length) return { unavailable: 'provisioning_unconfigured:REALBUD_MODELVIA_MODELS' };
  // Modelvia's verifier refuses a secret under 32 characters; name it now rather
  // than at the first request.
  if (value('REALBUD_MODELVIA_OPERATOR_SECRET').length < 32) return { unavailable: 'provisioning_unconfigured:REALBUD_MODELVIA_OPERATOR_SECRET' };
  try {
    return { provisioning: new InstallationProvisioning({
      ledger: options.ledger,
      registry: value('REALBUD_GATEWAY_CONNECTOR_REGISTRY'),
      endpoint: value('REALBUD_GATEWAY_PUBLIC_ORIGIN'),
      secrets: fileSecretStore(value('REALBUD_GATEWAY_SECRETS_DIR')),
      org: options.org ?? composioOrgClient({
        // Read per call: the value is never captured into a field.
        orgKey: () => env.REALBUD_COMPOSIO_ORG_KEY,
        fetch: options.fetch,
        ...(value('REALBUD_COMPOSIO_API_BASE') ? { base: value('REALBUD_COMPOSIO_API_BASE') } : {}),
      }),
      modelvia: options.modelvia ?? modelviaKeyClient({
        serviceOrigin: value('REALBUD_MODELVIA_BASE_URL'),
        environment,
        clientId: value('REALBUD_MODELVIA_CLIENT_ID'),
        allowedModels,
        // A fresh HMAC bearer is minted per request; a static token would 401.
        operatorSecret: () => env.REALBUD_MODELVIA_OPERATOR_SECRET,
        operatorSubject: value('REALBUD_MODELVIA_OPERATOR_SUBJECT'),
        fetch: options.fetch,
      }),
      authConfigs: { gmail: value('REALBUD_COMPOSIO_AUTH_CONFIG_GMAIL') },
    }) };
  } catch (error) {
    // A malformed value (not a missing one) — report the code, never the value.
    return { unavailable: `provisioning_unconfigured:${error instanceof GatewayError ? error.code : 'invalid_configuration'}` };
  }
}
