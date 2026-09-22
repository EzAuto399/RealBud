/** Per-installation model gateway access issued by the vendor at enrolment.
 *
 * The key is a customer-scoped, revocable, spend-capped client key. It lives in
 * the encrypted private vault and, at worker launch, in the child process env —
 * never in config.json, the oplog, `/api/config`, or any report to the website.
 * The unencrypted companion record holds only operator references (key id, base
 * URL, app allowlist) so a support conversation can name the grant.
 */
import { join } from "node:path";
import { DATA_DIR, saveConfig as saveConfigToDisk, type AppConfig } from "./config.ts";
import { readPrivateJson, removePrivateJson, writePrivateJson } from "./private-json.ts";
import { createPrivateVault } from "./private-vault.ts";
import { currentWorkerProfile } from "./hermes-profile.ts";
import { writeServiceInstallation, removeServiceInstallation, serviceInstallationPresent } from "./managed-service.ts";
import { applyManagedModelProfile, type ManagedModelApply } from "./hermes-pack.ts";
import { DEFAULT_MANAGED_APPS, type InstallationProvisioning } from "../shared/office-link.ts";

/** Vault entry name. Must match `^[a-z0-9-]{1,80}$` for the vault's own check. */
export const WORKER_MODEL_VAULT_ENTRY = "worker-model-access";

/**
 * Variable names the pinned worker actually reads for an OpenAI-compatible
 * provider. Taken from the installed runtime, not assumed:
 *   hermes_cli/auth.py PROVIDER_REGISTRY row
 *     ("openai-api", "OpenAI API", "https://api.openai.com/v1",
 *      ("OPENAI_API_KEY",), "OPENAI_BASE_URL")
 *   agent/client_lifecycle.py resolves `base_url = env_url or default_base`,
 *   so the env base URL overrides the provider default at turn time.
 * `OPENAI_API_BASE` is not read by the worker; do not add it.
 */
export const WORKER_MODEL_ENV_NAMES = ["OPENAI_BASE_URL", "OPENAI_API_KEY"] as const;

/** The worker profile must select provider `openai-api` for these to be used;
 * a profile pinned to another provider ignores them rather than misrouting. */
export function workerModelEnv(baseUrl: string, key: string): Record<string, string> {
  return { OPENAI_BASE_URL: baseUrl, OPENAI_API_KEY: key };
}

/** Operator-readable receipt for the profile write the grant performed. It
 * records that the profile now selects the gateway and whether a stale
 * `.env` provider key had to be removed. It never holds a credential. */
export interface ManagedModelReceipt {
  provider: string; apiMode: string; baseUrl: string; model: string | null; envKeyRemoved: boolean; appliedAt: string;
}

export type ServiceProvisioningRecord =
  | { version: 1; state: "active"; installationId: string; companyId: string; hostInstallationId: string;
      provider: "modelvia"; projectId: string; keyId: string; baseUrl: string; spendCapLabel: string; apps: string[]; provisionedAt: string;
      /** Absent on records written before the profile attach existed. */
      modelProfile?: ManagedModelReceipt }
  | { version: 1; state: "withdrawn"; installationId: string; withdrawnAt: string };

/**
 * Synchronous grant state for readers that cannot await a private-file read —
 * `modelStatus()`, the worker status card and the hands holds. It is published
 * by this module's own operations, so every path that resolves a grant (boot
 * refresh, apply, withdraw, reconcile, clear) keeps it in step. The default is
 * "none", which is exactly today's manually attached behaviour.
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

function validRecord(value: unknown): ServiceProvisioningRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (row.version !== 1 || typeof row.installationId !== "string" || !row.installationId) return undefined;
  if (row.state === "withdrawn") return typeof row.withdrawnAt === "string" ? row as ServiceProvisioningRecord : undefined;
  if (row.state !== "active" || row.provider !== "modelvia") return undefined;
  if (["companyId", "hostInstallationId", "projectId", "keyId", "baseUrl", "spendCapLabel", "provisionedAt"].some(key => typeof row[key] !== "string" || !row[key])) return undefined;
  if (!Array.isArray(row.apps) || !row.apps.length || row.apps.some(app => typeof app !== "string")) return undefined;
  if (row.modelProfile !== undefined) {
    const receipt = row.modelProfile as Record<string, unknown> | null;
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return undefined;
    if (["provider", "apiMode", "baseUrl", "appliedAt"].some(key => typeof receipt[key] !== "string" || !receipt[key])) return undefined;
    if (typeof receipt.envKeyRemoved !== "boolean") return undefined;
    if (receipt.model !== null && typeof receipt.model !== "string") return undefined;
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
  const path = provisioningPath(options.directory);

  async function state(): Promise<WorkerModelAccessState> {
    const record = await readServiceProvisioning(options.directory);
    publishGrant(record);
    if (!record) return { provisioned: false, withdrawn: false };
    if (record.state === "withdrawn") return { provisioned: false, withdrawn: true, installationId: record.installationId };
    return { provisioned: true, withdrawn: false, installationId: record.installationId, projectId: record.projectId, keyId: record.keyId,
      baseUrl: record.baseUrl, spendCapLabel: record.spendCapLabel, apps: [...record.apps] };
  }

  /** Env for one worker launch. Returns `{}` when nothing is provisioned, so a
   * manually attached model keeps working exactly as it does today. */
  async function env(): Promise<Record<string, string>> {
    const record = await readServiceProvisioning(options.directory);
    // Published before the vault read, so a grant that needs recovery still
    // leaves the synchronous readers describing the state accurately.
    publishGrant(record);
    if (record?.state !== "active") return {};
    const stored = await vault.read(WORKER_MODEL_VAULT_ENTRY) as { version?: number; keyId?: string; key?: string } | undefined;
    if (!stored || stored.version !== 1 || typeof stored.key !== "string" || !stored.key) {
      throw new Error("The model access for this computer needs recovery. Contact service support.");
    }
    // A key that no longer belongs to the recorded grant must not be used: the
    // records say which key is spend-capped and revocable for this office.
    if (stored.keyId !== record.keyId) throw new Error("The model access for this computer needs recovery. Contact service support.");
    return workerModelEnv(record.baseUrl, stored.key);
  }

  /**
   * Idempotent for the same installation id. A second redeem that names a
   * different installation changes nothing and holds for recovery — silently
   * replacing the grant would orphan the previous office's revocable key.
   */
  async function apply(provisioning: InstallationProvisioning, installationId: string): Promise<void> {
    const existing = await readServiceProvisioning(options.directory);
    // A withdrawn record holds no grant, so a fresh enrolment may replace it.
    if (existing?.state === "active" && existing.installationId !== installationId) {
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

    await vault.write(WORKER_MODEL_VAULT_ENTRY, { version: 1, keyId: provisioning.model.keyId, key: provisioning.model.key });
    // The worker profile is pointed at the gateway next, before the grant is
    // recorded as live. This also drops any `OPENAI_API_KEY` line left in the
    // profile `.env`: upstream prefers that dotenv over the launch environment,
    // so a stale line there would silently shadow the granted key. The granted
    // key itself is never written to the profile.
    const profile: ManagedModelApply = applyManagedModelProfile(provisioning.model.baseUrl, { root: options.hermesRoot });
    await writeServiceInstallation(options.directory, provisioning.service);
    const record: ServiceProvisioningRecord = {
      version: 1, state: "active", installationId,
      companyId: provisioning.service.companyId, hostInstallationId: provisioning.service.hostInstallationId,
      provider: provisioning.model.provider, projectId: provisioning.model.projectId, keyId: provisioning.model.keyId, baseUrl: provisioning.model.baseUrl,
      spendCapLabel: provisioning.model.spendCapLabel, apps: [...provisioning.connector.apps],
      provisionedAt: existing?.state === "active" ? existing.provisionedAt : new Date().toISOString(),
      modelProfile: {
        provider: profile.provider, apiMode: profile.apiMode, baseUrl: profile.baseUrl,
        model: profile.model, envKeyRemoved: profile.envKeyRemoved, appliedAt: profile.appliedAt,
      },
    };
    await writePrivateJson(path, record);
    publishGrant(record);
    // Last, because this is what switches the workspace onto the broker and
    // removes local Composio keys; an interrupted apply never gets that far.
    saveConfig({ composio: { managed, key: "", apiKey: "", url: "", selectedAccounts: {} } });
  }

  /**
   * One withdrawal: stop using the broker, destroy the model key, drop the
   * entitlement binding, and leave a state marker. Work records are untouched.
   */
  async function withdraw(): Promise<boolean> {
    const record = await readServiceProvisioning(options.directory);
    if (!record || record.state === "withdrawn") return false;
    saveConfig({ composio: { managed: undefined, selectedAccounts: {} } });
    await vault.remove(WORKER_MODEL_VAULT_ENTRY).catch(() => {});
    await removeServiceInstallation(options.directory);
    await writePrivateJson(path, { version: 1, state: "withdrawn", installationId: record.installationId, withdrawnAt: new Date().toISOString() });
    // The profile keeps naming the gateway: readiness reports the hold, and a
    // restored grant needs no repair. Nothing here can route a turn without the
    // key, which has just been destroyed.
    grantSnapshot = { state: "withdrawn" };
    return true;
  }

  /** The person disconnected this computer. Release everything, including the
   * withdrawn marker, so a later enrolment starts from a clean installation. */
  async function clear(): Promise<void> {
    await withdraw().catch(() => {});
    await removePrivateJson(path);
    grantSnapshot = { state: "none" };
  }

  async function withdrawn(): Promise<boolean> {
    try {
      const record = await readServiceProvisioning(options.directory);
      publishGrant(record);
      return record?.state === "withdrawn";
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

  return { state, env, apply, withdraw, withdrawn, reconcile, clear };
}
