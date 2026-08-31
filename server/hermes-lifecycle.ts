// Repair re-runs the pinned installer and re-applies the property pack.
// Remove deletes only the pinned worker files — the book stays.
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

export async function uninstallWorker(opts?: {
  root?: string;
  dataDir?: string;
  agentDir?: string;
  profileDir?: string;
}): Promise<HermesStatus> {
  const agentDir = opts?.agentDir ?? hermesAgentDir(opts?.root);
  const profileDir = opts?.profileDir ?? propertyProfileDir(opts?.root);
  if (!isInsideHermesHome(agentDir, opts?.root) || !isInsideHermesHome(profileDir, opts?.root)) {
    throw Object.assign(new Error("refusing to delete paths outside the worker home"), { status: 400 });
  }
  if (existsSync(agentDir)) rmSync(agentDir, { recursive: true, force: true });
  if (existsSync(profileDir)) rmSync(profileDir, { recursive: true, force: true });
  const dataDir = opts?.dataDir ?? DATA_DIR;
  removeIfPresent(handsPingPath(dataDir));
  removeIfPresent(handsLastPath(dataDir));
  clearHermesVersionCache();
  return hermesStatus({ root: opts?.root });
}
