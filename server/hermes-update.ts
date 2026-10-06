import { existsSync, lstatSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { hermesHome, runtimeCli } from "./hermes-paths.ts";
import { applyPropertyPack, packInstalled } from "./hermes-pack.ts";
import { HERMES_RECOMMENDED, HERMES_RELEASES, type HermesRelease } from "./hermes-releases.ts";
import { hermesCli } from "./hermes-pin.ts";
import { adoptFirstRuntime, readRuntimeSelection, releaseHome, runtimeCommit, saveRuntimeSelection } from "./hermes-runtime-selection.ts";
import { installInFlight, installStatus, startBootstrapInstall, type InstallJob } from "./hermes-bridge.ts";
import { acquireWorkerSetupLock, bootstrapChildRunning, bootstrapPending, bootstrapPlan, finishWorkerBootstrap, runWorkerBootstrap, BootstrapError } from "./worker-bootstrap.ts";
import { hermesStatus, type HermesStatus } from "./hermes-status.ts";
import { repairExistingProfile } from "./hermes-lifecycle.ts";
import { verifyRuntime } from "./hermes-runtime-check.ts";
import { ensureProfileDirectory, verifyProfileDirectory } from "./hermes-profile-storage.ts";
import { privateDirectory, readPrivateJson, writePrivateJson } from "./private-json.ts";

type CompletedRuntime = { version: 1; candidateId: string; commit: string; product: string; tag: string; installerSha256: string };
function completedRuntime(value: unknown): CompletedRuntime | undefined {
  if (value === undefined) return undefined;
  const row = value as Record<string, unknown> | null;
  if (!row || typeof row !== "object" || Array.isArray(row) ||
    Object.keys(row).sort().join(",") !== "candidateId,commit,installerSha256,product,tag,version" || row.version !== 1 ||
    typeof row.commit !== "string" || !/^[a-f0-9]{40}$/.test(row.commit) || typeof row.candidateId !== "string" ||
    !new RegExp(`^${row.commit}-[a-f0-9]{12}$`).test(row.candidateId) || typeof row.product !== "string" || typeof row.tag !== "string" ||
    typeof row.installerSha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.installerSha256)) {
    throw new BootstrapError("Bud’s saved download needs recovery. Existing files are kept; contact RealBud support.");
  }
  return row as CompletedRuntime;
}

/**
 * A failed installer run leaves a fresh, never-receipted candidate of several
 * hundred MB; each retry makes a new one. Remove it, but only when it is
 * neither the selected nor the previous runtime (before this attempt or now)
 * and no installer child may still be writing to it. Anything doubtful is kept. Links are unlinked, never
 * followed. A file Windows refuses to remove (locked, or deeper than the
 * runtime can reach) only leaves the folder in place, as before.
 */
export function discardFailedCandidate(home: string, candidateId: string, lockHome: string, before: { selected: string | null; previous: string | null }) {
  try {
    const candidate = releaseHome(home, candidateId);
    for (const selection of [before, readRuntimeSelection(home)]) if (candidateId === selection.selected || candidateId === selection.previous) return;
    if (bootstrapChildRunning(lockHome)) return;
    if (!lstatSync(candidate).isDirectory()) return;
    rmSync(candidate, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch {
    console.warn(`[${new Date().toISOString()}] Bud setup kept a failed download folder it could not remove.`);
  }
}

export function runtimeUpdateStatus(home = hermesHome()) {
  const selection = readRuntimeSelection(home);
  const selected = HERMES_RELEASES.find(r => r.commit === runtimeCommit(selection.selected));
  const owned = runtimeCli(home);
  const selectedCli = selection.selected ? runtimeCli(releaseHome(home, selection.selected)) : existsSync(owned) ? owned : "hermes";
  const customRuntime = Boolean(process.env.REALBUD_HERMES_CLI?.trim());
  return {
    recommended: { product: HERMES_RECOMMENDED.product, tag: HERMES_RECOMMENDED.tag },
    selected: selected ? { product: selected.product, tag: selected.tag } : null,
    restartRequired: !customRuntime && hermesCli() !== selectedCli,
    canRestorePrevious: !customRuntime && Boolean(selection.previousAvailable),
    customRuntime,
  };
}

/**
 * The recommended runtime is already installed and selected; only this
 * process still runs the executable it froze at boot. Reinstalling cannot
 * help — only a restart can — so automatic repair must not start another
 * download that ends in the same state.
 */
export function recommendedUpdateAwaitingRestart(home = hermesHome()): boolean {
  if (process.env.REALBUD_HERMES_CLI?.trim()) return false;
  const selection = readRuntimeSelection(home);
  if (!selection.selected || runtimeCommit(selection.selected) !== HERMES_RECOMMENDED.commit) return false;
  const selectedCli = runtimeCli(releaseHome(home, selection.selected));
  return existsSync(selectedCli) && hermesCli() !== selectedCli;
}

/** Official installer, isolated runtime, no PATH stage or personal CLI writes. */
export function startRuntimeUpdate(options: {
  home?: string; run?: typeof runWorkerBootstrap; verify?: typeof verifyRuntime; timeoutMs?: number; firstInstall?: boolean; repair?: boolean;
  /**
   * Which catalog release to stage. Defaults to HERMES_RECOMMENDED, which is the
   * only thing a person ever installs.
   *
   * This exists to break a circular dependency in the promotion procedure: the
   * procedure says smoke a candidate before recommending it, but staging used to be
   * hardcoded to HERMES_RECOMMENDED and line below refuses when that release is
   * already selected — so the only way to stage 0.21.3 was to make it recommended
   * first, i.e. promote the thing the smoke is supposed to gate. A release engineer
   * can now stage a catalog entry that is *not* recommended, smoke it, and only then
   * move HERMES_RECOMMENDED_VERSION.
   *
   * Deliberately not reachable from an HTTP route: a caller must not be able to
   * choose an arbitrary worker. The entry must already exist in the catalog.
   */
  release?: HermesRelease;
} = {}): InstallJob {
  if (installInFlight()) throw Object.assign(new Error("Bud setup is already running."), { status: 409 });
  if (process.env.REALBUD_HERMES_CLI?.trim()) throw Object.assign(new Error("This installation uses a custom agent path. Update that installation separately or remove the custom setting first."), { status: 409 });
  const home = options.home ?? hermesHome();
  const before = readRuntimeSelection(home);
  if (bootstrapChildRunning(home)) throw Object.assign(new Error("An earlier agent setup is still running. Wait for it to stop before starting a new installation."), { status: 409 });
  // Freeze this process's executable before preparing the next launch.
  hermesCli();
  const requested = options.release ?? HERMES_RECOMMENDED;
  const release = HERMES_RELEASES.find(entry => entry.commit === requested.commit && entry.product === requested.product && entry.tag === requested.tag);
  if (!release) {
    throw new BootstrapError(`Hermes ${requested.product} is not in the install catalog. Admit it there before staging it.`);
  }
  if (runtimeCommit(before.selected) === release.commit && !options.repair) throw Object.assign(new Error("The recommended agent is already selected. Restart RealBud if the update is waiting."), { status: 409 });
  // Establish the new owned home before bootstrap can recursively create it
  // with inherited Windows ACLs. Existing homes remain verify-only.
  ensureProfileDirectory(home);
  // Installer stages always use a fresh directory. Only a receipt written
  // after all stages finished may reuse a candidate for full verification.
  let candidateId = `${release.commit}-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  let candidate = releaseHome(home, candidateId);
  const lockHome = join(home, ".runtime-install");
  const completedPath = join(lockHome, "completed-runtime.json");
  const installerSha256 = bootstrapPlan(process.platform, release, true)?.sha256;
  if (!installerSha256) throw new BootstrapError("Automatic Bud setup is not available on this computer yet.");
  return startBootstrapInstall({
    timeoutMs: options.timeoutMs, release,
    run: async opts => {
      // Admit the lock folder before the lock creates it: a plain mkdir would
      // inherit an unprotected Windows ACL that this admission then refuses.
      await privateDirectory(lockHome);
      const unlock = acquireWorkerSetupLock(lockHome);
      try {
        opts.signal.throwIfAborted();
        if (bootstrapChildRunning(lockHome)) throw new BootstrapError("An earlier agent setup is still running. Wait for it to stop before starting a new installation.");
        const completed = completedRuntime(await readPrivateJson(completedPath, 2_000));
        if (completed && completed.commit === release.commit && completed.product === release.product && completed.tag === release.tag &&
          completed.installerSha256 === installerSha256 && completed.candidateId !== before.selected && completed.candidateId !== before.previous) {
          candidateId = completed.candidateId;
          candidate = releaseHome(home, candidateId);
          // Verify existing ownership/privacy, without following a planted
          // link or repairing a candidate somebody else changed.
          verifyProfileDirectory(candidate);
          await privateDirectory(candidate);
          if (!existsSync(runtimeCli(candidate))) throw new BootstrapError("Bud’s saved download is incomplete. Existing files are kept; contact RealBud support.");
          opts.signal.throwIfAborted();
          opts.progress("Checking already downloaded Bud", 1, 1);
          await opts.finalize?.();
          return;
        }
      } finally { unlock(); }
      opts.signal.throwIfAborted();
      ensureProfileDirectory(candidate);
      try {
        await (options.run ?? runWorkerBootstrap)({ ...opts, home: candidate, lockHome, release, privateRuntime: true });
      } catch (error) {
        // Decided by the receipt on disk: verification runs inside this call
        // (finalize) after writing it, and the next attempt re-verifies a
        // receipted candidate in full. An unreadable receipt keeps the folder.
        let receipted = true;
        try { receipted = completedRuntime(await readPrivateJson(completedPath, 2_000))?.candidateId === candidateId; } catch {}
        if (!receipted) discardFailedCandidate(home, candidateId, lockHome, before);
        throw error;
      }
    },
    verify: async () => {
      await privateDirectory(candidate);
      // This is proof that installation stages completed, never proof that
      // executable code is trusted. Every retry repeats verifyRuntime in full.
      await writePrivateJson(completedPath, { version: 1, candidateId, commit: release.commit, product: release.product, tag: release.tag, installerSha256 });
      return (options.verify ?? verifyRuntime)(candidate, release);
    },
    // Updating an existing profile never reapplies defaults or copies skills.
    onSuccess: () => { if (!packInstalled(home)) applyPropertyPack(home); },
    commit: () => {
      const current = readRuntimeSelection(home);
      if (JSON.stringify(current) !== JSON.stringify(before)) throw new BootstrapError("Another setup changed the selected agent. Your current selection is kept; retry the update.");
      finishWorkerBootstrap(lockHome);
      saveRuntimeSelection(home, { version: 1, selected: candidateId, previous: before.selected, previousAvailable: !options.firstInstall });
      if (options.firstInstall) adoptFirstRuntime(home);
    },
  });
}

export type WorkerInstallOutcome =
  | { kind: "running"; install: InstallJob }
  | { kind: "awaiting_restart" }
  | { kind: "repaired"; hermes: HermesStatus }
  | { kind: "started"; install: InstallJob }
  | { kind: "unavailable" };

/**
 * The one install-or-repair decision, shared by `POST /api/hermes/install`
 * (an administrator) and automatic setup after an approved office link, so the
 * two cannot drift. Only the pinned catalog release is ever staged; no caller
 * chooses a release, profile or path.
 *
 * A computer with no RealBud-selected runtime, or whose resolved worker is
 * missing, adopts the verified private runtime at once (no restart): nothing
 * usable ran before it (a compatible worker is repaired in place instead), so
 * there are no warm sessions to keep on an older executable. A personal or unsupported `hermes` on PATH does not block
 * that adoption and is never modified.
 */
export async function installOrRepairWorker(options: {
  home?: string; run?: typeof runWorkerBootstrap; verify?: typeof verifyRuntime; platform?: NodeJS.Platform;
  status?: () => Promise<HermesStatus>; repairExisting?: () => Promise<HermesStatus | null>;
} = {}): Promise<WorkerInstallOutcome> {
  if (installInFlight()) return { kind: "running", install: installStatus() };
  const home = options.home ?? hermesHome();
  const current = await (options.status ?? hermesStatus)();
  // Adopt at once only when no usable worker runs: the resolved one is
  // missing, or RealBud never selected its own and the one found is not
  // compatible. Otherwise the private runtime waits for the next restart.
  const compatibleCli = current.cli.compatible ?? current.cli.matchesPin;
  const firstInstall = () => current.cli.probeState === "missing" || (readRuntimeSelection(home).selected === null && !compatibleCli);
  const start = () => startRuntimeUpdate({ home, run: options.run, verify: options.verify, repair: true, firstInstall: firstInstall() });
  if (current.cli.installed && !(current.cli.compatible ?? current.cli.matchesPin)) {
    // The supported runtime is already installed for the next launch.
    // Another download would end in the same state, so say what finishes it.
    if (recommendedUpdateAwaitingRestart(home)) return { kind: "awaiting_restart" };
    // A personal or newer Hermes installation is never downgraded by
    // Repair. Prepare an independent supported runtime instead.
    return { kind: "started", install: start() };
  }
  // A partially installed, RealBud-owned runtime must finish its stages
  // before a working version command can be treated as a successful install.
  const existing = bootstrapPending(home) ? null : await (options.repairExisting ?? repairExistingProfile)();
  if (existing) return { kind: "repaired", hermes: existing };
  if (!bootstrapPlan(options.platform ?? process.platform)) return { kind: "unavailable" };
  return { kind: "started", install: start() };
}

export function restorePreviousRuntime(home = hermesHome()) {
  if (installInFlight()) throw Object.assign(new Error("Wait for agent setup to finish or stop it first."), { status: 409 });
  if (process.env.REALBUD_HERMES_CLI?.trim()) throw Object.assign(new Error("This installation uses a custom agent path. Manage that installation separately."), { status: 409 });
  const lockHome = join(home, ".runtime-install");
  const release = acquireWorkerSetupLock(lockHome);
  try {
    if (bootstrapChildRunning(lockHome) || bootstrapChildRunning(home)) throw Object.assign(new Error("An earlier agent setup is still running. Wait for it to stop before changing agents."), { status: 409 });
    const selected = readRuntimeSelection(home);
    if (!selected.previousAvailable) throw Object.assign(new Error("No previous runtime selection is available."), { status: 409 });
    if (selected.previous && !existsSync(runtimeCli(releaseHome(home, selected.previous)))) throw Object.assign(new Error("The previous agent is missing. The current selection has been kept."), { status: 409 });
    hermesCli();
    saveRuntimeSelection(home, { version: 1, selected: selected.previous, previous: selected.selected, previousAvailable: true });
    return { restartRequired: true };
  } finally { release(); }
}

/** Advisory only: upstream metadata cannot authorise executable downloads. */
export async function checkUpstreamRelease(request: typeof fetch = fetch) {
  const response = await request("https://api.github.com/repos/NousResearch/hermes-agent/releases/latest", {
    signal: AbortSignal.timeout(10_000), redirect: "error", headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) throw new Error("Could not check agent releases. Your installed agent is unchanged; try again later.");
  if (!response.body) throw new Error("Empty agent release response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 256_000) throw new Error("Unexpected agent release response.");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const text = Buffer.concat(chunks).toString("utf8");
  const data = JSON.parse(text);
  if (typeof data.tag_name !== "string" || !/^v\d{4}\.\d{1,2}\.\d{1,2}(?:\.\d+)?$/.test(data.tag_name) || data.draft || data.prerelease) throw new Error("No stable agent release was returned.");
  const supported = HERMES_RELEASES.some(r => r.tag === data.tag_name);
  return { latestTag: data.tag_name, supported, releaseUrl: `https://github.com/NousResearch/hermes-agent/releases/tag/${data.tag_name}` };
}
