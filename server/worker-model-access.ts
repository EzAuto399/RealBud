/** Per-installation model gateway access issued by the vendor at enrolment.
 *
 * The key is a customer-scoped, revocable, spend-capped client key. It lives in
 * the encrypted private vault and, at worker launch, in the child process env —
 * never in config.json, the oplog, `/api/config`, or any report to the website.
 * The unencrypted companion record holds only operator references (key id, base
 * URL, app allowlist) so a support conversation can name the grant.
 */
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DATA_DIR, loadConfig as readConfigFromDisk, saveConfig as saveConfigToDisk, type AppConfig } from "./config.ts";
import { readPrivateJson, removePrivateJson, writePrivateJson } from "./private-json.ts";
import { createPrivateVault } from "./private-vault.ts";
import { currentWorkerProfile } from "./hermes-profile.ts";
import { writeServiceInstallation, removeServiceInstallation, serviceInstallationPresent, serviceInstallationBinding } from "./managed-service.ts";
import { applyManagedModelProfile, managedModelConfig, propertyProfileDir, MANAGED_MODEL_KEY_ENV, type ManagedModelApply } from "./hermes-pack.ts";
import { ensureProfileDirectory, readProfileFile } from "./hermes-profile-storage.ts";
import { DEFAULT_MANAGED_MODEL_CHOICE, isManagedModelChoice, type ManagedModelChoiceId } from "../shared/managed-model-choices.ts";
import { DEFAULT_MANAGED_APPS, type InstallationProvisioning } from "../shared/office-link.ts";

/** Vault entry name. Must match `^[a-z0-9-]{1,80}$` for the vault's own check. */
export const WORKER_MODEL_VAULT_ENTRY = "worker-model-access";

/**
 * The variable the pinned worker reads the granted key from. The profile's
 * `providers.realbud.key_env` names it (see `applyManagedModelProfile`), so it
 * works for any gateway host — including a loopback one, for which upstream
 * derives no host-gated key name at all. The base URL lives in the profile,
 * not the environment.
 */
export const WORKER_MODEL_ENV_NAMES = [MANAGED_MODEL_KEY_ENV] as const;

export function workerModelEnv(key: string): Record<string, string> {
  return { [MANAGED_MODEL_KEY_ENV]: key };
}

/** Operator-readable receipt for the profile write the grant performed. It
 * records that the profile now selects the gateway and whether a stale
 * `.env` provider key had to be removed. It never holds a credential. */
export interface ManagedModelReceipt {
  provider: string; apiMode: string; baseUrl: string; model: string | null; envKeyRemoved: boolean; appliedAt: string;
  /** Absent on receipts written before the three managed choices existed. */
  choice?: ManagedModelChoiceId;
}

export type ServiceProvisioningRecord =
  | { version: 1; state: "active"; installationId: string; companyId: string; hostInstallationId: string;
      provider: "modelvia"; projectId: string; keyId: string; baseUrl: string; spendCapLabel: string; apps: string[]; provisionedAt: string;
      /** Absent on records written before the profile attach existed. */
      modelProfile?: ManagedModelReceipt; connectorHash?: string }
  | { version: 1; state: "applying"; installationId: string; companyId: string; hostInstallationId: string;
      connectorHashes: string[]; startedAt: string }
  | { version: 1; state: "withdrawn"; installationId: string; withdrawnAt: string };

/**
 * Synchronous grant state for readers that cannot await a private-file read —
 * `modelStatus()`, the worker status card and the hands holds. It is published
 * by this module's own operations, so every path that resolves a grant (boot
 * refresh, apply, withdraw, reconcile, clear) keeps it in step. The default is
 * "none": not paired, so the worker has no model access.
 */
export type WorkerModelGrant =
  | { state: "none" }
  | { state: "active"; baseUrl: string; keyId: string; spendCapLabel: string }
  | { state: "withdrawn" };

let grantSnapshot: WorkerModelGrant = { state: "none" };
export function workerModelGrant(): WorkerModelGrant { return grantSnapshot; }
/** Test seam only; production callers get this through the access object. */
export function setWorkerModelGrant(grant: WorkerModelGrant): void { grantSnapshot = grant; }

function publishGrant(record: ServiceProvisioningRecord | undefined): void {
  grantSnapshot = record?.state === "active"
    ? { state: "active", baseUrl: record.baseUrl, keyId: record.keyId, spendCapLabel: record.spendCapLabel }
    : record?.state === "withdrawn" ? { state: "withdrawn" } : { state: "none" };
}

const provisioningPath = (directory: string) => join(directory, "service-provisioning.json");
const provisioningMutations = new Map<string, Promise<void>>();
/** Receipt maintenance and grant removal share the same local write order. */
function mutateProvisioning<T>(directory: string, work: () => Promise<T>): Promise<T> {
  const key = resolve(directory);
  const next = (provisioningMutations.get(key) ?? Promise.resolve()).then(work);
  const settled = next.then(() => {}, () => {});
  provisioningMutations.set(key, settled);
  void settled.finally(() => { if (provisioningMutations.get(key) === settled) provisioningMutations.delete(key); });
  return next;
}
const connectorHash = (managed: { endpoint: string; credential: string; profile: string } | undefined): string | undefined =>
  managed ? createHash("sha256").update(JSON.stringify([managed.endpoint, managed.credential, managed.profile])).digest("hex") : undefined;

function validRecord(value: unknown): ServiceProvisioningRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (row.version !== 1 || typeof row.installationId !== "string" || !row.installationId) return undefined;
  if (row.state === "withdrawn") return typeof row.withdrawnAt === "string" ? row as ServiceProvisioningRecord : undefined;
  if (row.state === "applying") {
    return Object.keys(row).every(key => ["version", "state", "installationId", "companyId", "hostInstallationId", "connectorHashes", "startedAt"].includes(key)) &&
      ["companyId", "hostInstallationId", "startedAt"].every(key => typeof row[key] === "string" && row[key]) &&
      Array.isArray(row.connectorHashes) && row.connectorHashes.length > 0 && row.connectorHashes.length <= 2 &&
      row.connectorHashes.every(hash => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash)) ? row as ServiceProvisioningRecord : undefined;
  }
  if (row.state !== "active" || row.provider !== "modelvia") return undefined;
  if (["companyId", "hostInstallationId", "projectId", "keyId", "baseUrl", "spendCapLabel", "provisionedAt"].some(key => typeof row[key] !== "string" || !row[key])) return undefined;
  if (!Array.isArray(row.apps) || !row.apps.length || row.apps.some(app => typeof app !== "string")) return undefined;
  if (row.connectorHash !== undefined && (typeof row.connectorHash !== "string" || !/^[a-f0-9]{64}$/.test(row.connectorHash))) return undefined;
  if (row.modelProfile !== undefined) {
    const receipt = row.modelProfile as Record<string, unknown> | null;
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return undefined;
    if (["provider", "apiMode", "baseUrl", "appliedAt"].some(key => typeof receipt[key] !== "string" || !receipt[key])) return undefined;
    if (typeof receipt.envKeyRemoved !== "boolean") return undefined;
    if (receipt.model !== null && typeof receipt.model !== "string") return undefined;
    if (receipt.choice !== undefined && !isManagedModelChoice(receipt.choice)) return undefined;
  }
  return row as ServiceProvisioningRecord;
}

/** A damaged record is never silently discarded: it holds mutations so the
 * installation can be recovered rather than re-provisioned over. */
export async function readServiceProvisioning(directory = DATA_DIR): Promise<ServiceProvisioningRecord | undefined> {
  const raw = await readPrivateJson(provisioningPath(directory), 8_000);
  if (raw === undefined) return undefined;
  const record = validRecord(raw);
  if (!record) throw new Error("This computer's service setup needs recovery. Contact service support before linking again.");
  return record;
}

/** The receipt fields for one profile apply. Never holds a credential. */
export function managedModelReceipt(profile: ManagedModelApply): ManagedModelReceipt {
  return { provider: profile.provider, apiMode: profile.apiMode, baseUrl: profile.baseUrl, model: profile.model,
    envKeyRemoved: profile.envKeyRemoved, appliedAt: profile.appliedAt, choice: profile.choice };
}

/**
 * Keep the operator receipt in step with the profile after a later apply (a
 * model choice, or reconciling an upgraded profile). Only an active record is
 * rewritten; a withdrawn or absent one is left as it is. Returns whether it wrote.
 */
export async function recordManagedModelReceipt(profile: ManagedModelApply, directory = DATA_DIR): Promise<boolean> {
  return mutateProvisioning(directory, async () => {
    const record = await readServiceProvisioning(directory);
    if (record?.state !== "active") return false;
    await writePrivateJson(provisioningPath(directory), { ...record, modelProfile: managedModelReceipt(profile) });
    return true;
  });
}

/** Managed connections beyond Gmail are whatever this installation was granted.
 * An installation provisioned before the allowlist existed keeps Gmail only. */
export async function managedConnectorApps(directory = DATA_DIR): Promise<string[]> {
  let record: ServiceProvisioningRecord | undefined;
  try { record = await readServiceProvisioning(directory); } catch { record = undefined; }
  return record?.state === "active" ? [...record.apps] : [...DEFAULT_MANAGED_APPS];
}

export interface WorkerModelAccessOptions {
  directory: string;
  /** Protected private-state key, same one the company installation uses. */
  key?: Buffer;
  /** Injected so tests do not write the real ~/.realbud/config.json. */
  saveConfig?: (patch: Partial<AppConfig>) => void;
  /** The same reader the injected config writer uses. Never returns secrets to a caller. */
  readConfig?: () => AppConfig;
  /** Hermes home holding the private worker profile. Defaults to the resolved
   * one; tests point it at a fixture profile directory. */
  hermesRoot?: string;
}

export interface WorkerModelAccessState {
  provisioned: boolean;
  withdrawn: boolean;
  installationId?: string;
  projectId?: string;
  keyId?: string;
  baseUrl?: string;
  spendCapLabel?: string;
  apps?: string[];
}

export function createWorkerModelAccess(options: WorkerModelAccessOptions) {
  const vault = createPrivateVault(options.directory, options.key);
  const saveConfig = options.saveConfig ?? saveConfigToDisk;
  const readConfig = options.readConfig ?? readConfigFromDisk;
  const path = provisioningPath(options.directory);
  let withdrawalPending = false;
  const publish = (record: ServiceProvisioningRecord | undefined) => {
    if (withdrawalPending) grantSnapshot = { state: "withdrawn" };
    else publishGrant(record);
  };

  async function state(): Promise<WorkerModelAccessState> {
    const record = await readServiceProvisioning(options.directory);
    publish(record);
    if (withdrawalPending) return { provisioned: false, withdrawn: true, installationId: record?.installationId };
    if (!record) return { provisioned: false, withdrawn: false };
    if (record.state === "applying") return { provisioned: false, withdrawn: false, installationId: record.installationId };
    if (record.state === "withdrawn") return { provisioned: false, withdrawn: true, installationId: record.installationId };
    return { provisioned: true, withdrawn: false, installationId: record.installationId, projectId: record.projectId, keyId: record.keyId,
      baseUrl: record.baseUrl, spendCapLabel: record.spendCapLabel, apps: [...record.apps] };
  }

  async function active(installationId: string): Promise<boolean> {
    const current = await state();
    return current.provisioned && current.installationId === installationId;
  }

  /** Env for one worker launch. Returns `{}` when nothing is provisioned: the
   * worker then has no model access at all, and setup asks the office to pair
   * this computer. */
  async function env(): Promise<Record<string, string>> {
    if (withdrawalPending) return {};
    const record = await readServiceProvisioning(options.directory);
    // Published before the vault read, so a grant that needs recovery still
    // leaves the synchronous readers describing the state accurately.
    publish(record);
    if (withdrawalPending || record?.state !== "active") return {};
    const stored = await vault.read(WORKER_MODEL_VAULT_ENTRY) as { version?: number; keyId?: string; key?: string } | undefined;
    if (withdrawalPending) return {};
    if (!stored || stored.version !== 1 || typeof stored.key !== "string" || !stored.key) {
      throw new Error("The model access for this computer needs recovery. Contact service support.");
    }
    // A key that no longer belongs to the recorded grant must not be used: the
    // records say which key is spend-capped and revocable for this office.
    if (stored.keyId !== record.keyId) throw new Error("The model access for this computer needs recovery. Contact service support.");
    return workerModelEnv(stored.key);
  }

  /** Admit the local destinations before asking the website to issue or rotate
   * a credential. Existing damaged files remain available for recovery. */
  async function preflight(installationId?: string): Promise<void> {
    if (withdrawalPending) throw new Error("Service withdrawal needs recovery before linking again.");
    readConfig();
    const probe = join(options.directory, `.service-provisioning-check-${randomUUID()}.json`);
    const vaultProbe = `service-provisioning-check-${randomUUID()}`;
    try {
      const existing = await readServiceProvisioning(options.directory);
      if (installationId !== undefined && existing && existing.state !== "withdrawn" && existing.installationId !== installationId) {
        throw new Error("The previous installation must be released before linking again.");
      }
      // Read the same destinations and parsers apply uses, before an external
      // credential is rotated. The scratch vault entry also admits its key.
      await vault.read(WORKER_MODEL_VAULT_ENTRY);
      serviceInstallationBinding(options.directory);
      const profile = propertyProfileDir(options.hermesRoot);
      ensureProfileDirectory(profile);
      const config = readProfileFile(join(profile, "config.yaml"));
      readProfileFile(join(profile, ".env"));
      managedModelConfig(config?.toString("utf8") ?? "", "https://model-probe.invalid/v1", DEFAULT_MANAGED_MODEL_CHOICE);
      await vault.write(vaultProbe, { version: 1 });
      await vault.remove(vaultProbe);
      await writePrivateJson(probe, { version: 1 });
      await removePrivateJson(probe);
      if (withdrawalPending) throw new Error("Service withdrawal needs recovery before linking again.");
    } catch (cause) {
      throw new Error("This computer’s service setup needs local storage recovery. Existing settings are kept.", { cause });
    }
  }

  /** A different installation must release the previous office's grant first,
   * so a retry cannot silently orphan its revocable key or connector. */
  async function applyLocked(provisioning: InstallationProvisioning, installationId: string): Promise<void> {
    if (withdrawalPending) throw Object.assign(new Error("Service withdrawal needs recovery before linking again."), { status: 409 });
    const existing = await readServiceProvisioning(options.directory);
    // A withdrawn record holds no grant, so a fresh enrolment may replace it.
    if (existing && existing.state !== "withdrawn" && existing.installationId !== installationId) {
      throw Object.assign(new Error("This computer is already set up for another installation. Ask service support to release it before linking again."), { status: 409 });
    }
    const managed = { endpoint: provisioning.connector.endpoint, credential: provisioning.connector.credential, profile: provisioning.connector.profile };
    // The grant names a private worker profile. A grant for a different profile
    // is refused before anything is written, so a rejected enrolment never
    // leaves a half-configured installation behind. Endpoint and credential
    // shape were already checked by the contract validator.
    if (managed.profile !== currentWorkerProfile().profile) {
      throw Object.assign(new Error("This service setup is for a different private workspace on this computer. Contact service support."), { status: 403 });
    }

    const currentHash = connectorHash(readConfig().composio?.managed);
    const ownedHashes = existing?.state === "applying" ? existing.connectorHashes : existing?.state === "active"
      ? [existing.connectorHash ?? currentHash].filter((hash): hash is string => hash !== undefined) : [];
    const nextHash = connectorHash(managed)!;
    // An interrupted delivery remains identifiable without storing a secret.
    // Cleanup may remove only the connector this delivery actually installed.
    await writePrivateJson(path, { version: 1, state: "applying", installationId,
      companyId: provisioning.service.companyId, hostInstallationId: provisioning.service.hostInstallationId,
      connectorHashes: [...new Set([nextHash, ...(currentHash && ownedHashes.includes(currentHash) ? [currentHash] : [])])], startedAt: new Date().toISOString() });
    publish(undefined);

    await vault.write(WORKER_MODEL_VAULT_ENTRY, { version: 1, keyId: provisioning.model.keyId, key: provisioning.model.key });
    // The worker profile is pointed at the gateway next, before the grant is
    // recorded as live, keeping the office's saved choice (or `flash-high`).
    // This also drops any managed-key line left in the profile `.env`
    // (`MANAGED_MODEL_ENV_KEYS`): upstream prefers that dotenv over the launch
    // environment, so a stale line there would silently shadow the granted
    // key. The granted key itself is never written to the profile.
    const profile: ManagedModelApply = applyManagedModelProfile(provisioning.model.baseUrl, { root: options.hermesRoot });
    await writeServiceInstallation(options.directory, provisioning.service);
    const record: ServiceProvisioningRecord = {
      version: 1, state: "active", installationId,
      companyId: provisioning.service.companyId, hostInstallationId: provisioning.service.hostInstallationId,
      provider: provisioning.model.provider, projectId: provisioning.model.projectId, keyId: provisioning.model.keyId, baseUrl: provisioning.model.baseUrl,
      spendCapLabel: provisioning.model.spendCapLabel, apps: [...provisioning.connector.apps],
      provisionedAt: existing?.state === "active" ? existing.provisionedAt : new Date().toISOString(),
      modelProfile: managedModelReceipt(profile),
      connectorHash: nextHash,
    };
    // Complete the connector before publishing an active grant. The website
    // report uses that grant as its delivery receipt: publishing it first
    // would suppress redelivery after a config write failure, leaving the
    // model available but its managed apps permanently unconfigured.
    saveConfig({ composio: { managed, key: "", apiKey: "", url: "", selectedAccounts: {} } });
    await writePrivateJson(path, record);
    publish(record);
  }
  const apply = (provisioning: InstallationProvisioning, installationId: string): Promise<void> => mutateProvisioning(options.directory, () => applyLocked(provisioning, installationId));

  /**
   * One withdrawal: stop using the broker, destroy the model key, drop the
   * entitlement binding, and leave a state marker. Work records are untouched.
   */
  async function withdrawLocked(): Promise<boolean> {
    const record = await readServiceProvisioning(options.directory);
    if (!record || record.state === "withdrawn") {
      withdrawalPending = false;
      publishGrant(record);
      return false;
    }
    const currentHash = connectorHash(readConfig().composio?.managed);
    const owned = record.state === "applying" ? currentHash !== undefined && record.connectorHashes.includes(currentHash)
      : record.connectorHash === undefined || currentHash === record.connectorHash;
    if (owned) saveConfig({ composio: { managed: undefined, selectedAccounts: {} } });
    await vault.remove(WORKER_MODEL_VAULT_ENTRY);
    await removeServiceInstallation(options.directory);
    await writePrivateJson(path, { version: 1, state: "withdrawn", installationId: record.installationId, withdrawnAt: new Date().toISOString() });
    // The profile keeps naming the gateway: readiness reports the hold, and a
    // restored grant needs no repair. Nothing here can route a turn without the
    // key, which has just been destroyed.
    grantSnapshot = { state: "withdrawn" };
    withdrawalPending = false;
    return true;
  }
  function withdraw(): Promise<boolean> {
    // Revocation is effective now, including while a receipt write finishes.
    withdrawalPending = true;
    grantSnapshot = { state: "withdrawn" };
    return mutateProvisioning(options.directory, withdrawLocked);
  }

  /** The person disconnected this computer. Release everything, including the
   * withdrawn marker, so a later enrolment starts from a clean installation. */
  async function clear(): Promise<void> {
    withdrawalPending = true;
    grantSnapshot = { state: "withdrawn" };
    await mutateProvisioning(options.directory, async () => {
      // Keep the recovery records until withdrawal has actually completed.
      await withdrawLocked();
      await removePrivateJson(path);
      grantSnapshot = { state: "none" };
    });
  }

  async function withdrawn(installationId?: string): Promise<boolean> {
    try {
      const record = await readServiceProvisioning(options.directory);
      publish(record);
      if (installationId !== undefined && record?.installationId !== installationId) return false;
      return withdrawalPending || record?.state === "withdrawn";
    } catch { return false; }
  }

  /**
   * A service administrator removing `service-installation.json` withdraws this
   * computer's access just as a website 403 does. Checked on the ordinary
   * status tick so a released installation stops using the grant promptly.
   */
  async function reconcile(): Promise<boolean> {
    let record: ServiceProvisioningRecord | undefined;
    try { record = await readServiceProvisioning(options.directory); } catch { return false; }
    if (record?.state !== "active" || serviceInstallationPresent(options.directory)) return false;
    return withdraw();
  }

  return { state, active, env, apply, preflight, withdraw, withdrawn, reconcile, clear };
}
