// Zero-terminal worker bridge: RealBud installs the pinned Hermes worker and
// writes its private profile programmatically. The user never sees a terminal
// and never runs the hermes CLI. Model access is managed-only: the paired
// grant supplies provider, endpoint and key; the office picks one of three
// models (`shared/managed-model-choices.ts`).
import { existsSync } from "node:fs";
import { join } from "node:path";

import { normalizeManagedModelChoiceRequest, type ManagedModelChoiceId } from "../shared/managed-model-choices.ts";
import { verifyProfileDirectory } from "./hermes-profile-storage.ts";
import { resetPathCache } from "./env-path.ts";
import { hermesCli } from "./hermes-pin.ts";
import { applyManagedModelProfile, hermesHome, MANAGED_MODEL_API_MODE, MANAGED_MODEL_KEY_ENV, MANAGED_MODEL_PROVIDER, managedModelProfile, packInstalled, propertyProfileDir } from "./hermes-pack.ts";
import { recordManagedModelReceipt, workerModelGrant } from "./worker-model-access.ts";
import { normalizedGatewayUrl } from "./hermes-runtime-env.ts";
import { clearHermesVersionCache, probeHermesVersion } from "./hermes-status.ts";
import { BootstrapError, bootstrapFailureKind, finishWorkerBootstrap, runWorkerBootstrap } from "./worker-bootstrap.ts";
import { HERMES_RECOMMENDED, type HermesRelease } from "./hermes-releases.ts";
import { parseHermesVersion } from "./hermes-pin.ts";

// ── install job (singleton: one worker install at a time) ────────────────

export interface InstallJob {
  state: "idle" | "preflight" | "running" | "verifying" | "done" | "failed";
  lines: string[];
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  progress?: { detail: string; step: number; total: number };
  /** Set on failure: how automatic setup may follow up on its own. */
  failureKind?: "retry" | "once" | "final";
}

const installJob: InstallJob = { state: "idle", lines: [], startedAt: null, finishedAt: null, error: null };
let bootstrapAbort: AbortController | null = null;
let bootstrapCompletion: Promise<void> = Promise.resolve();
export function waitForBootstrapStop() { return bootstrapCompletion; }

export function startBootstrapInstall(opts?: { timeoutMs?: number; onSuccess?: () => void | Promise<void>; commit?: () => void; release?: HermesRelease; run?: typeof runWorkerBootstrap; verify?: () => Promise<string | null> }): InstallJob {
  if (installInFlight()) return installStatus();
  // Resolve once, here. Previously an omitted `release` fell through to
  // `runWorkerBootstrap`'s default (the 0.20.3 compatibility floor) while
  // verification fell back to `hermesMatchesPin` (also 0.20.3) — so a caller
  // that forgot the argument installed the rollback build. The recommended
  // release is now the default for both the install and its verification.
  const release = opts?.release ?? HERMES_RECOMMENDED;
  const controller = new AbortController();
  bootstrapAbort = controller;
  Object.assign(installJob, { state: "preflight", lines: [], startedAt: Date.now(), finishedAt: null, error: null, progress: undefined, failureKind: undefined });
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 30 * 60_000);
  bootstrapCompletion = (async () => {
    let finalized = false;
    try {
      await (opts?.run ?? runWorkerBootstrap)({ release, home: hermesHome(), signal: controller.signal, progress: (detail, step, total) => {
        installJob.state = "running";
        installJob.progress = { detail, step, total };
        installJob.lines = [...installJob.lines.slice(-39), detail];
      }, finalize: async () => {
        controller.signal.throwIfAborted();
        installJob.state = "verifying";
        resetPathCache(); clearHermesVersionCache();
        const version = await (opts?.verify ?? (() => probeHermesVersion(hermesCli())))();
        controller.signal.throwIfAborted();
        const parsed = parseHermesVersion(version ?? "");
        const matches = parsed.product === release.product && parsed.calendar === release.tag.slice(1);
        if (!matches) throw new BootstrapError("Bud was downloaded but could not verify its installed version. Retry setup before starting work.");
        try { await opts?.onSuccess?.(); }
        catch { throw new BootstrapError("Bud is installed, but its private property setup could not be saved. Check available space and try setup again."); }
        controller.signal.throwIfAborted();
        if (!opts?.run) finishWorkerBootstrap(hermesHome());
        // Promote while the installer still holds its cross-process lock.
        // No await separates the last cancellation check and selection write.
        opts?.commit?.();
        finalized = true;
      } });
      if (!finalized) {
        controller.signal.throwIfAborted();
        throw new BootstrapError("Agent setup ended before verification. Your current agent is kept; retry setup.");
      }
      installJob.state = "done";
    } catch (error) {
      installJob.state = "failed";
      // A stop (shutdown, timeout or cancel) is retried later; so is a network miss.
      installJob.failureKind = controller.signal.aborted ? "retry" : bootstrapFailureKind(error);
      installJob.error = controller.signal.aborted ? "Setup stopped before it finished. Your property data is kept. Try again when you’re ready." : error instanceof BootstrapError ? error.message : "Bud setup could not finish. Check your connection, available space and folder permissions, then try again.";
    } finally {
      clearTimeout(timer); bootstrapAbort = null; installJob.finishedAt = Date.now();
    }
  })();
  return installStatus();
}

export function cancelBootstrapInstall(): InstallJob {
  bootstrapAbort?.abort();
  return installStatus();
}

export function installStatus(): InstallJob {
  return { ...installJob, lines: installJob.lines.slice(-40) };
}

export function installInFlight(): boolean {
  return installJob.state === "running" || installJob.state === "verifying" || installJob.state === "preflight";
}

// ── managed model choice ─────────────────────────────────────────────────
//
// RealBud is managed-only (owner decision 29 Sep 2026). The provider, endpoint
// and credential all come from this computer's paired grant; the office picks
// one of three models and nothing else. There is no provider key, sign-in or
// free-text model path.

export interface ModelStatus {
  provider: string | null;
  model: string | null;
  /** The saved managed choice, or null while the profile holds none. */
  choice: ManagedModelChoiceId | null;
  /** True only while a managed grant is active: the key reaches the worker
   * from the grant, never from this computer's storage. */
  keyPresent: boolean;
  /** Office-facing line — never the key itself. */
  keyHint: string | null;
  /** This installation's model access comes from the RealBud service grant, so
   * no provider key is collected or stored on this computer. */
  managed: boolean;
  /** The grant was withdrawn. Records are kept; the worker cannot reason. */
  managedWithdrawn?: boolean;
}

/** Office-facing name for the managed model access. The protocol name belongs
 * only in Advanced diagnostics, never in this line. */
export const MANAGED_MODEL_LABEL = "RealBud service (Modelvia)";

export function modelStatus(root?: string): ModelStatus {
  const profile = managedModelProfile(root);
  const base = { provider: profile.provider, model: profile.model, choice: profile.choice };
  const grant = workerModelGrant();
  if (grant.state === "active") {
    return { ...base, keyPresent: true, keyHint: `Model access: managed by ${MANAGED_MODEL_LABEL}`, managed: true };
  }
  if (grant.state === "withdrawn") return { ...base, keyPresent: false, keyHint: null, managed: false, managedWithdrawn: true };
  // Not paired: whatever an old profile names, nothing can route a turn.
  return { ...base, keyPresent: false, keyHint: null, managed: false };
}

/** `POST /api/hermes/model`: exactly `{ choice }`, one of the three managed
 * choices, on a paired installation. A provider, key, base URL or model name is
 * refused with 400 rather than ignored. */
export async function setManagedModelChoice(body: unknown, opts?: { root?: string; dataDir?: string }): Promise<ModelStatus> {
  let choice: ManagedModelChoiceId;
  try { choice = normalizeManagedModelChoiceRequest(body); }
  catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { status: 400 }); }
  const grant = workerModelGrant();
  if (grant.state === "withdrawn") {
    throw Object.assign(new Error("Model access for this computer was withdrawn. Ask RealBud support to restore it."), { status: 409 });
  }
  if (grant.state !== "active") {
    throw Object.assign(new Error("This computer is not paired yet. Pair it from realbud.app, then choose Bud's model."), { status: 409 });
  }
  const profileDir = propertyProfileDir(opts?.root);
  if (!existsSync(join(profileDir, "SOUL.md"))) {
    throw Object.assign(new Error("Bud's workroom is not set up yet. Finish the earlier setup step first."), { status: 409 });
  }
  verifyProfileDirectory(profileDir);
  const applied = applyManagedModelProfile(grant.baseUrl, { root: opts?.root, choice });
  // The operator receipt follows the profile, never a stale earlier apply.
  await recordManagedModelReceipt(applied, opts?.dataDir);
  return modelStatus(opts?.root);
}

/**
 * Bring an installed profile onto the active grant when it does not select it
 * yet: an upgrade from the pre-29-Sep `openai-api` profile, the old `auto`
 * router model, a retired model id, or a stale `.env` key. The office's saved
 * choice is kept; anything else becomes `flash-high`. Returns whether it wrote.
 * No grant, a withdrawn grant or no installed pack changes nothing: an
 * unpaired computer is refused at launch instead (`managedModelLaunchRefusal`),
 * and its own files are left alone. The operator receipt is rewritten too.
 */
export async function reconcileManagedModelProfile(root?: string, opts?: { dataDir?: string }): Promise<boolean> {
  const grant = workerModelGrant();
  if (grant.state !== "active" || !packInstalled(root)) return false;
  const profile = managedModelProfile(root);
  if (profile.provider === MANAGED_MODEL_PROVIDER && profile.baseUrl !== null && normalizedGatewayUrl(profile.baseUrl) === normalizedGatewayUrl(grant.baseUrl) &&
    profile.keyEnv === MANAGED_MODEL_KEY_ENV && profile.apiMode === MANAGED_MODEL_API_MODE && profile.choice && !profile.envKeyPresent) return false;
  await recordManagedModelReceipt(applyManagedModelProfile(grant.baseUrl, { root }), opts?.dataDir);
  return true;
}
