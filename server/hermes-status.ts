import { currentWorkerProfile } from "./hermes-profile.ts";
import { bootstrapPending } from "./worker-bootstrap.ts";
// Read-only worker checks. Hermes is independently installed; RealBud owns
// the supported adapter contract and its private property profile.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { augmentedPath } from "./env-path.ts";
import { execCli } from "./procs.ts";
import { hermesWorkerSandbox } from "./drivers/acp/hermes.ts";
import { HERMES_PIN, HERMES_COMPATIBLE_RELEASES, hermesCli, hermesInstallCommand, hermesMatchesPin, hermesIsCompatible, parseHermesVersion } from "./hermes-pin.ts";
import { approvalsAreManual, hermesHome, MANAGED_MODEL_API_MODE, MANAGED_MODEL_KEY_ENV, MANAGED_MODEL_PROVIDER, managedModelProfile, packInstalled, propertyProfileDir, propertyWorkroomReady } from "./hermes-pack.ts";
import { workerModelGrant } from "./worker-model-access.ts";
import type { HandsLast } from "./hands-last.ts";
import { readRuntimeSelection, WORKER_HOLD_COPY, workerHold, type WorkerHold } from "./hermes-runtime-selection.ts";
import { DOCUMENT_TOOLS_UNSUPPORTED, documentToolsStatus, ownedRuntimeHome } from "./hermes-document-deps.ts";
import { checkRuntimeIntegrity, runtimeIdentity, runtimeIntegrity, RUNTIME_DAMAGED, type RuntimeIntegrity, type verifyRuntime } from "./hermes-runtime-check.ts";
import { workerIsolationRefusal } from "./worker-network-sandbox.ts";

export function workerSetupPending(root?: string): boolean {
  try { return !readRuntimeSelection(hermesHome(root)).selected && bootstrapPending(hermesHome(root)); }
  catch { return false; }
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
  /** Word, Excel and PDF libraries in RealBud's own runtime. Informational:
   * it never changes `ready` or `detail`. */
  documentTools?: DocumentToolsState;
  /** Source and connection check of the runtime this process launches. A
   * damaged runtime reads as not compatible, so Repair stages a replacement. */
  runtimeIntegrity?: RuntimeIntegrity;
  /** Nothing may launch: a removal awaits a restart, or the selection needs recovery. */
  hold?: WorkerHold;
  /** No installed engine or earlier ping can admit an absent OS boundary. */
  workerIsolation?: { state: "held"; platform: string; detail: string };
}

/** `unavailable_here`: no reviewed libraries for this computer, or Bud runs a
 * separate Hermes that Repair never changes. `unknown`: not checked yet. */
export type DocumentToolsState = "ready" | "needs_repair" | "unavailable_here" | "unknown";

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
      detail: "This computer's office access ended, so Bud can't answer here. Everything saved stays on this computer. Reconnect it in Workspace → Website account." };
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
  // The runtime on disk, not only its version: a replaced runtime of the same
  // version needs its own passing check.
  hash.update(`\0runtime\0${runtimeIdentity(hermesCli())}`);
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
  if (status.workerIsolation) return { ...status, ready: false, detail: status.workerIsolation.detail };
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
  documentResults.clear();
  documentChecks.clear();
}

// One import check per owned runtime and state of its site-packages folder: a
// new runtime selection or a Repair that installs anything re-checks once.
// Status polls only stat a folder; the check itself runs in the background
// and reads `unknown` until it settles. Repair clears this cache first.
const documentResults = new Map<string, DocumentToolsState>();
const documentChecks = new Map<string, Promise<void>>();

function sitePackagesStamp(runtime: string): string {
  const venv = join(runtime, "hermes-agent", "venv");
  try {
    const folders = process.platform === "win32" ? [join(venv, "Lib", "site-packages")]
      : readdirSync(join(venv, "lib")).filter(name => /^python\d/.test(name)).sort().map(name => join(venv, "lib", name, "site-packages"));
    return folders.map(folder => { try { return String(statSync(folder).mtimeMs); } catch { return "missing"; } }).join(",");
  } catch { return "missing"; }
}

export function documentToolsState(opts?: { root?: string; checkDocuments?: typeof documentToolsStatus }): DocumentToolsState {
  let runtime: string | null;
  try { runtime = ownedRuntimeHome(hermesHome(opts?.root)); } catch { return "unknown"; }
  if (!runtime) return process.env.REALBUD_HERMES_CLI?.trim() ? "unavailable_here" : "unknown";
  const key = `${runtime}\0${sitePackagesStamp(runtime)}`;
  const known = documentResults.get(key);
  if (known) return known;
  if (!documentChecks.has(key)) {
    const generation = cacheGeneration;
    const check = (opts?.checkDocuments ?? documentToolsStatus)(runtime)
      .then((result): DocumentToolsState => result.ready ? "ready" : result.detail === DOCUMENT_TOOLS_UNSUPPORTED ? "unavailable_here" : "needs_repair", (): DocumentToolsState => "needs_repair")
      .then(state => {
        if (generation !== cacheGeneration) return;
        if (documentResults.size >= 8) documentResults.clear();
        documentResults.set(key, state);
      })
      .finally(() => { if (documentChecks.get(key) === check) documentChecks.delete(key); });
    documentChecks.set(key, check);
  }
  return "unknown";
}

export function probeHermesCli(cli: string, timeoutMs = 8_000): Promise<VersionProbe> {
  const key = `${cli}\0${timeoutMs}`;
  const cached = versionCache.get(key);
  if (!process.env.VITEST && cached && Date.now() - cached.at < VERSION_CACHE_MS) return Promise.resolve(cached.result);
  const pending = inFlight.get(key);
  if (pending) return pending;
  const generation = cacheGeneration;
  const probe = new Promise<VersionProbe>((resolve) => {
    const env: Record<string, string | undefined> = { ...process.env, PATH: augmentedPath() };
    // The worker's own storage holds this binary, so even `--version` runs
    // under the worker sandbox: no network, no writes beyond its temp folder.
    let launch: ReturnType<typeof hermesWorkerSandbox>;
    try { launch = hermesWorkerSandbox("diagnostic", cli, ["--version"], env, []); }
    catch (error) { resolve({ state: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "error", text: null }); return; }
    execCli(launch.command, launch.args, { timeout: timeoutMs, env }, (err, stdout) => {
      launch.release();
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

/** `integrity`: "cached" (status polls) reads the last check and starts one in
 * the background; "await" waits for a current result; "force" re-runs it (Repair). */
export async function hermesStatus(opts?: { root?: string; cli?: string; platform?: NodeJS.Platform; probeTimeoutMs?: number; checkDocuments?: typeof documentToolsStatus;
  integrity?: "cached" | "await" | "force"; verifyRuntime?: typeof verifyRuntime }): Promise<HermesStatus> {
  const pack = { installed: packInstalled(opts?.root), approvalsManual: approvalsAreManual(opts?.root), workroomReady: propertyWorkroomReady(opts?.root) };
  const modelAccess = modelAccessStatus(opts?.root);
  const platform = opts?.platform ?? process.platform, isolation = workerIsolationRefusal(platform);
  const base = {
    pin: { ...HERMES_PIN }, handsLabel: BUD_HANDS_LABEL, pack, homeDir: hermesHome(opts?.root), profileDir: propertyProfileDir(opts?.root),
    installCommand: hermesInstallCommand(opts?.platform ?? process.platform),
    installerAvailable: !isolation && ["darwin", "linux", "win32"].includes(platform), signInCommand: `hermes -p ${currentWorkerProfile().profile} model`,
    modelAccess,
    ...(isolation ? { workerIsolation: { state: "held" as const, platform, detail: isolation } } : {}),
  };
  // Held: nothing is probed or launched, and status never throws.
  const hold = workerHold(hermesHome(opts?.root));
  if (hold) {
    return { ...base, cli: { installed: true, versionText: null, matchesPin: false, compatible: false, probeState: "error" },
      bootstrapPending: false, detail: modelAccess.withdrawn ? modelAccess.detail : WORKER_HOLD_COPY[hold], ready: false, hold, documentTools: "unknown" };
  }
  if (isolation) return { ...base, installerAvailable: false, bootstrapPending: false,
    cli: { installed: false, versionText: null, matchesPin: false, compatible: false, probeState: "error" },
    detail: isolation, ready: false, documentTools: "unknown", workerIsolation: { state: "held", platform, detail: isolation } };
  const cli = opts?.cli ?? hermesCli();
  const probe = await probeHermesCli(cli, opts?.probeTimeoutMs);
  const versionText = probe.text;
  const matchesPin = versionText != null && hermesMatchesPin(versionText);
  const integrityOptions = { cli, root: opts?.root, verify: opts?.verifyRuntime };
  const runtimeIntegrityState = probe.state !== "ok" ? undefined : opts?.integrity === "await" || opts?.integrity === "force"
    ? await checkRuntimeIntegrity({ ...integrityOptions, force: opts.integrity === "force" }) : runtimeIntegrity(integrityOptions);
  const damaged = runtimeIntegrityState === "damaged";
  const compatible = versionText != null && hermesIsCompatible(versionText) && !damaged;
  const version = parseHermesVersion(versionText ?? "").product ?? "supported";
  let detail: string;
  if (modelAccess.withdrawn) detail = modelAccess.detail;
  else if (damaged) detail = RUNTIME_DAMAGED;
  else if (probe.state === "missing") detail = `The worker is not installed. Install the supported v${HERMES_PIN.product} worker, then apply Bud's hands safeguards.`;
  else if (probe.state === "timeout") detail = "The installed worker took too long to report its version. Retry the check; reinstalling is not required by this result.";
  else if (probe.state === "error") detail = "The worker could not report its version. Check that Bud starts, then retry the check.";
  else if (!compatible) detail = `This worker release has not been checked with RealBud. Supported releases are ${HERMES_COMPATIBLE_RELEASES.map(release => `${release.product} (${release.calendar})`).join(", ")}; the fallback pin is v${HERMES_PIN.product}.`;
  else if (!pack.installed) detail = `Worker ${version} is supported, but Bud's hands safeguards are not installed. Apply them in You → This office.`;
  else if (!pack.approvalsManual) detail = `Worker ${version} needs manual approvals on Bud's hands. Re-apply the safeguards.`;
  else if (!pack.workroomReady) detail = `Worker ${version} needs the current private workroom policy. Re-apply Bud's hands safeguards.`;
  else detail = `Worker ${version} and Bud's hands are installed. Run the hands test before Recheck or Ask.`;
  return {
    ...base,
    cli: { installed: probe.state !== "missing", versionText, matchesPin, compatible, probeState: probe.state },
    bootstrapPending: workerSetupPending(opts?.root),
    detail, ready: false, documentTools: documentToolsState(opts),
    ...(runtimeIntegrityState ? { runtimeIntegrity: runtimeIntegrityState } : {}),
    ...(versionText ? { workerFingerprint: hermesReadinessFingerprint(versionText, opts?.root) } : {}),
  };
}
