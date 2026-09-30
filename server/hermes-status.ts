import { currentWorkerProfile } from "./hermes-profile.ts";
import { bootstrapPending } from "./worker-bootstrap.ts";
// Read-only worker checks. Hermes is independently installed; RealBud owns
// the supported adapter contract and its private property profile.
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { augmentedPath } from "./env-path.ts";
import { execCli } from "./procs.ts";
import { HERMES_PIN, HERMES_COMPATIBLE_RELEASES, hermesCli, hermesInstallCommand, hermesMatchesPin, hermesIsCompatible, parseHermesVersion } from "./hermes-pin.ts";
import { approvalsAreManual, hermesHome, MANAGED_MODEL_API_MODE, MANAGED_MODEL_KEY_ENV, MANAGED_MODEL_PROVIDER, managedModelProfile, packInstalled, propertyProfileDir, propertyWorkroomReady } from "./hermes-pack.ts";
import { workerModelGrant } from "./worker-model-access.ts";
import type { HandsLast } from "./hands-last.ts";
import { readRuntimeSelection } from "./hermes-runtime-selection.ts";

export function workerSetupPending(root?: string): boolean {
  return !readRuntimeSelection(hermesHome(root)).selected && bootstrapPending(hermesHome(root));
}

export type VersionProbe = { state: "ok" | "missing" | "timeout" | "error"; text: string | null };

/** Product-facing name for the Hermes `property` profile — never rename the pin. */
export const BUD_HANDS_LABEL = "Bud's hands";

export interface HermesStatus {
  pin: { product: string; tag: string; commit: string; profile: string };
  /** Office-facing label for the worker profile (`property` stays internal). */
  handsLabel: string;
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
  modelAccess?: ModelAccessStatus;
}

/** How this installation's model access is held. `managed` installations never
 * collect a provider key; `withdrawn` is a hold, not "nothing attached". */
export interface ModelAccessStatus {
  managed: boolean;
  withdrawn: boolean;
  /** A managed grant is only attached once the profile actually selects the
   * gateway, names a model and has no `.env` key left to shadow the grant. */
  attached: boolean;
  detail: string;
}

/** Office-facing wording. The protocol name stays out of it. */
export function modelAccessStatus(root?: string): ModelAccessStatus {
  const grant = workerModelGrant();
  if (grant.state === "withdrawn") {
    return { managed: false, withdrawn: true, attached: false,
      detail: "Model access was withdrawn for this computer. Your records are kept. Ask service support to restore access." };
  }
  // Not paired: no model access at all. Setup shows the pairing path.
  if (grant.state !== "active") return { managed: false, withdrawn: false, attached: false, detail: "" };
  const profile = managedModelProfile(root);
  const selects = profile.provider === MANAGED_MODEL_PROVIDER && profile.baseUrl === grant.baseUrl &&
    profile.keyEnv === MANAGED_MODEL_KEY_ENV && profile.apiMode === MANAGED_MODEL_API_MODE;
  if (!selects || profile.envKeyPresent) {
    return { managed: true, withdrawn: false, attached: false,
      detail: "Model access is managed by RealBud service (Modelvia), but Bud's private setup has not taken it up yet. Repair Bud to finish." };
  }
  if (!profile.choice) {
    return { managed: true, withdrawn: false, attached: false,
      detail: "Model access: managed by RealBud service (Modelvia). Choose which model Bud should use to finish setup." };
  }
  return { managed: true, withdrawn: false, attached: true,
    detail: "Model access: managed by RealBud service (Modelvia). No provider key is stored on this computer." };
}

/** A passing check belongs to this worker and profile, never an earlier setup.
 * Only the digest leaves this function; file contents and keys stay private. */
export function hermesReadinessFingerprint(version: string, root?: string): string {
  const hash = createHash("sha256").update(version.trim());
  const profile = propertyProfileDir(root);
  let location = profile;
  try { location = realpathSync(profile); } catch { /* Missing profiles remain unready. */ }
  hash.update(`\0${process.platform}\0${process.arch}\0${location}\0`);
  for (const file of ["config.yaml", ".env", "auth.json", "SOUL.md"]) {
    hash.update(`\0${file}\0`);
    let bytes: Buffer;
    try { bytes = readFileSync(join(propertyProfileDir(root), file)); }
    catch { hash.update("missing"); continue; }
    hash.update(file === "auth.json" ? authPolicy(bytes) : bytes);
  }
  return hash.digest("hex");
}

/**
 * The part of the worker's `auth.json` that is configuration rather than the
 * worker's own bookkeeping. The worker rewrites this file during ordinary turns
 * (`updated_at`, pool counters and refreshed tokens), and a passing readiness
 * check must survive that. The configured `providers`, any source suppressions
 * and which credentials the pool holds still count, canonically ordered. A file that does not parse as an object is
 * hashed whole, so damage still reads as a changed setup.
 */
function authPolicy(bytes: Buffer): Buffer | string {
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { return bytes; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return bytes;
  const store = parsed as Record<string, unknown>;
  return `policy:${canonicalJson({ providers: store.providers ?? null, suppressed_sources: store.suppressed_sources ?? null, pool: poolShape(store.credential_pool) })}`;
}
/** Which credentials the worker's pool holds, by provider and by each entry's
 * source and label: an adopted ambient login changes this and so stales the
 * proof. Counters, timestamps, ids and every token stay out. */
function poolShape(pool: unknown): unknown {
  if (!pool || typeof pool !== "object" || Array.isArray(pool)) return pool === undefined ? null : "unreadable";
  const shape: Record<string, string[]> = {};
  for (const [provider, entries] of Object.entries(pool as Record<string, unknown>)) {
    shape[provider] = (Array.isArray(entries) ? entries : []).map(entry => {
      const row = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
      return JSON.stringify([typeof row.source === "string" ? row.source : "", typeof row.label === "string" ? row.label : ""]);
    }).sort();
  }
  return shape;
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function applyHandsReadiness(status: HermesStatus, lastPing: HandsLast | null): HermesStatus {
  // A withdrawn grant is a hold with its own explanation, not "not attached":
  // nothing on this computer is broken and every record stays readable.
  if (status.modelAccess?.withdrawn) return { ...status, ready: false, detail: status.modelAccess.detail };
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
  const modelAccess = modelAccessStatus(opts?.root);
  let detail: string;
  if (modelAccess.withdrawn) detail = modelAccess.detail;
  else if (probe.state === "missing") detail = `The worker is not installed. Install the supported v${HERMES_PIN.product} worker, then apply Bud's hands safeguards.`;
  else if (probe.state === "timeout") detail = "The installed worker took too long to report its version. Retry the check; reinstalling is not required by this result.";
  else if (probe.state === "error") detail = "The worker could not report its version. Check that Bud starts, then retry the check.";
  else if (!compatible) detail = `This worker release has not been checked with RealBud. Supported releases are ${HERMES_COMPATIBLE_RELEASES.map(release => `${release.product} (${release.calendar})`).join(", ")}; the fallback pin is v${HERMES_PIN.product}.`;
  else if (!pack.installed) detail = `Worker ${version} is supported, but Bud's hands safeguards are not installed. Apply them in You → This office.`;
  else if (!pack.approvalsManual) detail = `Worker ${version} needs manual approvals on Bud's hands. Re-apply the safeguards.`;
  else if (!pack.workroomReady) detail = `Worker ${version} needs the current private workroom policy. Re-apply Bud's hands safeguards.`;
  else detail = `Worker ${version} and Bud's hands are installed. Run the hands test before Recheck or Ask.`;
  return {
    pin: { ...HERMES_PIN },
    handsLabel: BUD_HANDS_LABEL,
    cli: { installed: probe.state !== "missing", versionText, matchesPin, compatible, probeState: probe.state },
    pack, homeDir: hermesHome(opts?.root), profileDir: propertyProfileDir(opts?.root),
    installCommand: hermesInstallCommand(opts?.platform ?? process.platform), bootstrapPending: workerSetupPending(opts?.root),
    installerAvailable: ["darwin", "linux", "win32"].includes(opts?.platform ?? process.platform), signInCommand: `hermes -p ${currentWorkerProfile().profile} model`,
    detail, ready: false, modelAccess,
    ...(versionText ? { workerFingerprint: hermesReadinessFingerprint(versionText, opts?.root) } : {}),
  };
}
