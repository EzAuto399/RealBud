// Repair re-runs the pinned installer and re-applies the property pack.
// Automatic removal is held until all worker descendants can be proved stopped.
import { installInFlight, reconcileManagedModelProfile, startInstall, type InstallJob } from "./hermes-bridge.ts";
import {
  applyPropertyPack,
  hermesAgentDir,
  isInsideHermesHome,
  propertyProfileDir,
} from "./hermes-pack.ts";
import { clearHermesVersionCache, hermesStatus, type HermesStatus } from "./hermes-status.ts";
import { repairDocumentDeps } from "./hermes-document-deps.ts";
import { workerLaunchesHeld, WORKERS_HELD } from "./worker-network-sandbox.ts";

export function startRepair(command: string, opts?: { timeoutMs?: number }): InstallJob {
  if (installInFlight()) {
    throw Object.assign(new Error("an install is already running"), { status: 409 });
  }
  return startInstall(command, {
    timeoutMs: opts?.timeoutMs,
    onSuccess: () => {
      applyPropertyPack();
    },
  });
}

/** Repair the owned profile without downgrading/reinstalling a shared CLI.
 * Null means no CLI exists and the normal first-install flow may continue. */
export async function repairExistingProfile(opts?: { root?: string; cli?: string; documentDeps?: typeof repairDocumentDeps }): Promise<HermesStatus | null> {
  if (installInFlight()) throw Object.assign(new Error("an install is already running"), { status: 409 });
  clearHermesVersionCache();
  const status = await hermesStatus(opts);
  if (!status.cli.installed) return null;
  if (!status.cli.compatible) throw Object.assign(new Error(`${status.detail} Your separate Hermes installation has been kept.`), { status: 409 });
  if (installInFlight()) throw Object.assign(new Error("an install is already running"), { status: 409 });
  applyPropertyPack(opts?.root);
  await reconcileManagedModelProfile(opts?.root);
  // Adds the reviewed document libraries to RealBud's own runtime. A failure
  // here leaves the repaired profile in place and says what still needs Repair.
  const documents = await (opts?.documentDeps ?? repairDocumentDeps)(opts?.root);
  const repaired = await hermesStatus(opts);
  return documents ? { ...repaired, detail: `${repaired.detail} ${documents}` } : repaired;
}

export class WorkerCleanupUnprovenError extends Error {
  readonly status = 409;
  readonly code = "worker_cleanup_unproven";
  constructor() {
    super("Bud's private setup has been kept because RealBud cannot confirm every worker process has stopped. Automatic removal is unavailable. Use Repair to fix setup.");
    this.name = "WorkerCleanupUnprovenError";
  }
}

export async function uninstallWorker(opts?: {
  root?: string;
  dataDir?: string;
  agentDir?: string;
  profileDir?: string;
  /** Retained for callers; unavailable removal never invokes this hook. */
  stopWorkers?: () => Promise<void>;
}): Promise<HermesStatus> {
  if (installInFlight()) throw Object.assign(new Error("Let Bud setup finish or stop it before removing its private setup."), { status: 409 });
  // A refusal must not release an existing launch hold or stop active work.
  if (workerLaunchesHeld()) throw Object.assign(new Error(WORKERS_HELD), { status: 409 });
  const agentDir = opts?.agentDir ?? hermesAgentDir(opts?.root);
  const profileDir = opts?.profileDir ?? propertyProfileDir(opts?.root);
  if (!isInsideHermesHome(agentDir, opts?.root) || !isInsideHermesHome(profileDir, opts?.root)) {
    throw Object.assign(new Error("refusing to delete paths outside the worker home"), { status: 400 });
  }
  // A worker can detach into another process group. Original-group absence
  // cannot authorize deletion, including after a service restart loses its
  // in-memory child handles. Keep this unconditional until complete descendant
  // termination has an authoritative proof; do not add a PID-scan fallback.
  throw new WorkerCleanupUnprovenError();
}
