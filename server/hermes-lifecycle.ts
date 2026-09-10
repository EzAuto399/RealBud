// Repair re-runs the pinned installer and re-applies the property pack.
// Remove disconnects RealBud's profile. The independent Hermes runtime stays.
import { existsSync, rmSync, unlinkSync } from "node:fs";

import { DATA_DIR } from "./config.ts";
import { installInFlight, startInstall, type InstallJob } from "./hermes-bridge.ts";
import {
  applyPropertyPack,
  hermesAgentDir,
  isInsideHermesHome,
  propertyProfileDir,
} from "./hermes-pack.ts";
import { clearHermesVersionCache, hermesStatus, type HermesStatus } from "./hermes-status.ts";
import { handsLastPath, handsPingPath } from "./hands-last.ts";

function removeIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

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
export async function repairExistingProfile(opts?: { root?: string; cli?: string }): Promise<HermesStatus | null> {
  if (installInFlight()) throw Object.assign(new Error("an install is already running"), { status: 409 });
  clearHermesVersionCache();
  const status = await hermesStatus(opts);
  if (!status.cli.installed) return null;
  if (!status.cli.compatible) throw Object.assign(new Error(`${status.detail} Your separate Hermes installation has been kept.`), { status: 409 });
  if (installInFlight()) throw Object.assign(new Error("an install is already running"), { status: 409 });
  applyPropertyPack(opts?.root);
  return hermesStatus(opts);
}

export async function uninstallWorker(opts?: {
  root?: string;
  dataDir?: string;
  agentDir?: string;
  profileDir?: string;
}): Promise<HermesStatus> {
  if (installInFlight()) throw Object.assign(new Error("Let Bud setup finish or stop it before removing its private setup."), { status: 409 });
  const agentDir = opts?.agentDir ?? hermesAgentDir(opts?.root);
  const profileDir = opts?.profileDir ?? propertyProfileDir(opts?.root);
  if (!isInsideHermesHome(agentDir, opts?.root) || !isInsideHermesHome(profileDir, opts?.root)) {
    throw Object.assign(new Error("refusing to delete paths outside the worker home"), { status: 400 });
  }
  // The CLI is shared with personal Hermes use and is not RealBud-owned.
  if (existsSync(profileDir)) rmSync(profileDir, { recursive: true, force: true });
  const dataDir = opts?.dataDir ?? DATA_DIR;
  removeIfPresent(handsPingPath(dataDir));
  removeIfPresent(handsLastPath(dataDir));
  clearHermesVersionCache();
  return hermesStatus({ root: opts?.root });
}
