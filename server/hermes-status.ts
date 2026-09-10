import { bootstrapPending } from "./worker-bootstrap.ts";
// Read-only worker checks. Hermes is independently installed; RealBud owns
// the supported adapter contract and its private property profile.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { augmentedPath } from "./env-path.ts";
import { execCli } from "./procs.ts";
import { HERMES_PIN, hermesCli, hermesInstallCommand, hermesMatchesPin, hermesIsCompatible, parseHermesVersion } from "./hermes-pin.ts";
import { approvalsAreManual, hermesHome, packInstalled, propertyProfileDir, propertyWorkroomReady } from "./hermes-pack.ts";
import type { HandsLast } from "./hands-last.ts";

export type VersionProbe = { state: "ok" | "missing" | "timeout" | "error"; text: string | null };
export interface HermesStatus {
  pin: { product: string; tag: string; commit: string; profile: string };
  cli: { installed: boolean; versionText: string | null; matchesPin: boolean; compatible?: boolean; probeState?: VersionProbe["state"] };
  pack: { installed: boolean; approvalsManual: boolean; workroomReady: boolean };
  homeDir: string;
  profileDir: string;
  installCommand: string | null;
  installerAvailable?: boolean;
  bootstrapPending?: boolean;
  signInCommand: string;
  detail: string;
  ready: boolean;
  workerFingerprint?: string;
  model?: { attached: boolean; provider: string | null; model: string | null };
}

/** A passing check belongs to this worker and profile, never an earlier setup.
 * Only the digest leaves this function; file contents and keys stay private. */
export function hermesReadinessFingerprint(version: string, root?: string): string {
  const hash = createHash("sha256").update(version.trim());
  for (const file of ["config.yaml", ".env", "SOUL.md"]) {
    hash.update(`\0${file}\0`);
    try { hash.update(readFileSync(join(propertyProfileDir(root), file))); }
    catch { hash.update("missing"); }
  }
  return hash.digest("hex");
}

export function applyHandsReadiness(status: HermesStatus, lastPing: HandsLast | null): HermesStatus {
  if (status.bootstrapPending || !status.cli.installed || !(status.cli.compatible ?? status.cli.matchesPin) ||
      !status.pack.installed || !status.pack.approvalsManual || !status.pack.workroomReady) return { ...status, ready: false };
  const version = parseHermesVersion(status.cli.versionText ?? "").product ?? "supported";
  if (lastPing?.kind === "ping" && lastPing.ok && status.workerFingerprint &&
      lastPing.workerFingerprint === status.workerFingerprint) {
    return { ...status, ready: true, detail: `Worker ${version} passed the hands test for this setup. Desk Recheck can ask it for the morning ledger.` };
  }
  return { ...status, ready: false, detail: `Worker ${version} and the pack are installed. Run the hands test before Recheck or Ask.` };
}

const VERSION_CACHE_MS = 60_000;
let cacheGeneration = 0;
const versionCache = new Map<string, { at: number; result: VersionProbe }>();
const inFlight = new Map<string, Promise<VersionProbe>>();
export function clearHermesVersionCache(): void {
  cacheGeneration++;
  versionCache.clear();
  inFlight.clear();
}

export function probeHermesCli(cli: string, timeoutMs = 8_000): Promise<VersionProbe> {
  const key = `${cli}\0${timeoutMs}`;
  const cached = versionCache.get(key);
  if (!process.env.VITEST && cached && Date.now() - cached.at < VERSION_CACHE_MS) return Promise.resolve(cached.result);
  const pending = inFlight.get(key);
  if (pending) return pending;
  const generation = cacheGeneration;
  const probe = new Promise<VersionProbe>((resolve) => {
    execCli(cli, ["--version"], { timeout: timeoutMs, env: { ...process.env, PATH: augmentedPath() } }, (err, stdout) => {
      const failure = err as (NodeJS.ErrnoException & { killed?: boolean }) | null;
      const result: VersionProbe = failure
        ? { state: failure.code === "ENOENT" ? "missing" : failure.killed ? "timeout" : "error", text: null }
        : stdout.trim() ? { state: "ok", text: String(stdout) } : { state: "error", text: null };
      // A transient miss must be retryable immediately, not sticky for a minute.
      if (result.state === "ok" && cacheGeneration === generation) {
        if (versionCache.size >= 8) versionCache.clear();
        versionCache.set(key, { at: Date.now(), result });
      }
      resolve(result);
    });
  }).finally(() => { if (inFlight.get(key) === probe) inFlight.delete(key); });
  inFlight.set(key, probe);
  return probe;
}

export async function probeHermesVersion(cli: string): Promise<string | null> {
  return (await probeHermesCli(cli)).text;
}

export async function hermesStatus(opts?: { root?: string; cli?: string; platform?: NodeJS.Platform; probeTimeoutMs?: number }): Promise<HermesStatus> {
  const probe = await probeHermesCli(opts?.cli ?? hermesCli(), opts?.probeTimeoutMs);
  const versionText = probe.text;
  const matchesPin = versionText != null && hermesMatchesPin(versionText);
  const compatible = versionText != null && hermesIsCompatible(versionText);
  const version = parseHermesVersion(versionText ?? "").product ?? "supported";
  const pack = { installed: packInstalled(opts?.root), approvalsManual: approvalsAreManual(opts?.root), workroomReady: propertyWorkroomReady(opts?.root) };
  let detail: string;
  if (probe.state === "missing") detail = `The worker is not installed. Install the supported v${HERMES_PIN.product} worker, then apply the property pack.`;
  else if (probe.state === "timeout") detail = "The installed worker took too long to report its version. Retry the check; reinstalling is not required by this result.";
  else if (probe.state === "error") detail = "The worker could not report its version. Check that Hermes starts, then retry the check.";
  else if (!compatible) detail = `This worker release has not been checked with RealBud. Supported releases are 0.20.3 (2026.8.16.2) and 0.21.0 (2026.8.31); the fallback pin is v${HERMES_PIN.product}.`;
  else if (!pack.installed) detail = `Worker ${version} is supported, but the "${HERMES_PIN.profile}" pack is not installed. Apply the property pack.`;
  else if (!pack.approvalsManual) detail = `Worker ${version} needs manual approvals on the property profile. Re-apply the pack.`;
  else if (!pack.workroomReady) detail = `Worker ${version} needs the current private workroom policy. Re-apply the property pack.`;
  else detail = `Worker ${version} and the pack are installed. Run the hands test before Recheck or Ask.`;
  return {
    pin: { ...HERMES_PIN }, cli: { installed: probe.state !== "missing", versionText, matchesPin, compatible, probeState: probe.state },
    pack, homeDir: hermesHome(opts?.root), profileDir: propertyProfileDir(opts?.root),
    installCommand: hermesInstallCommand(opts?.platform ?? process.platform), bootstrapPending: bootstrapPending(hermesHome(opts?.root)),
    installerAvailable: ["darwin", "linux", "win32"].includes(opts?.platform ?? process.platform), signInCommand: `hermes -p ${HERMES_PIN.profile} model`,
    detail, ready: false, ...(versionText ? { workerFingerprint: hermesReadinessFingerprint(versionText, opts?.root) } : {}),
  };
}
