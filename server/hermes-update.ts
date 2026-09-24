import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { hermesHome, runtimeCli } from "./hermes-paths.ts";
import { applyPropertyPack, packInstalled } from "./hermes-pack.ts";
import { HERMES_RECOMMENDED, HERMES_RELEASES, type HermesRelease } from "./hermes-releases.ts";
import { hermesCli } from "./hermes-pin.ts";
import { adoptFirstRuntime, readRuntimeSelection, releaseHome, runtimeCommit, saveRuntimeSelection } from "./hermes-runtime-selection.ts";
import { installInFlight, startBootstrapInstall, type InstallJob } from "./hermes-bridge.ts";
import { acquireWorkerSetupLock, bootstrapChildRunning, finishWorkerBootstrap, runWorkerBootstrap, BootstrapError } from "./worker-bootstrap.ts";
import { verifyRuntime } from "./hermes-runtime-check.ts";
import { ensureProfileDirectory } from "./hermes-profile-storage.ts";

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
  const release: HermesRelease = options.release ?? HERMES_RECOMMENDED;
  if (!HERMES_RELEASES.some(entry => entry.commit === release.commit && entry.product === release.product && entry.tag === release.tag)) {
    throw new BootstrapError(`Hermes ${release.product} is not in the install catalog. Admit it there before staging it.`);
  }
  if (runtimeCommit(before.selected) === release.commit && !options.repair) throw Object.assign(new Error("The recommended agent is already selected. Restart RealBud if the update is waiting."), { status: 409 });
  // Establish the new owned home before bootstrap can recursively create it
  // with inherited Windows ACLs. Existing homes remain verify-only.
  ensureProfileDirectory(home);
  // Retry in a new directory. Upstream's repository stage updates existing
  // checkouts via main; it must never run over a selected or failed candidate.
  const candidateId = `${release.commit}-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const candidate = releaseHome(home, candidateId);
  const lockHome = join(home, ".runtime-install");
  return startBootstrapInstall({
    timeoutMs: options.timeoutMs, release,
    run: opts => (options.run ?? runWorkerBootstrap)({ ...opts, home: candidate, lockHome, release, privateRuntime: true }),
    verify: () => (options.verify ?? verifyRuntime)(candidate, release),
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
