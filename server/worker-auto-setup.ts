/**
 * Automatic Bud setup after an approved office link.
 *
 * Authority: an ACTIVE service provisioning (the billing owner approved this
 * computer on realbud.app and the service grant is in force) lets the RealBud
 * service itself perform the reviewed worker setup: the pinned catalog release
 * through `installOrRepairWorker`, the property safeguards, the managed model
 * profile, and one private readiness check. No caller chooses a release,
 * profile or path, and every other privileged action keeps its administrator
 * gate. The check lives here, server-side, and is repeated after every long
 * await: a grant withdrawn or a link revoked mid-run stops the run.
 *
 * Attempts persist in private storage so a restart continues the backoff
 * rather than hammering a busy download server. Retries are capped; a final
 * failure holds until the office approves again or someone presses Try again.
 * Status text is fixed product copy chosen by code, never raw error text.
 */
import { join } from "node:path";
import { readPrivateJson, writePrivateJson } from "./private-json.ts";
import { redactSecretsInText } from "./redact.ts";
import type { InstallJob } from "./hermes-bridge.ts";
import type { HermesStatus } from "./hermes-status.ts";
import type { WorkerInstallOutcome } from "./hermes-update.ts";

export type WorkerAutoSetupState = "idle" | "installing" | "verifying" | "ready" | "waiting_retry" | "held";
export type WorkerAutoSetupCode =
  | "installing" | "safeguards" | "model" | "readiness" | "ready" | "retry"
  | "held_exhausted" | "held_failed" | "held_recovery" | "held_restart" | "held_unavailable";
export interface WorkerAutoSetupStatus { state: WorkerAutoSetupState; code?: WorkerAutoSetupCode; step: number; total: number; nextRetryAt?: number; detail: string }
export type WorkerAutoSetupReason = "provisioned" | "boot" | "periodic" | "retry" | "manual";

export interface WorkerAutoSetupDeps {
  directory: string;
  /** Active provisioning on a linked, unrevoked office link. */
  active: () => Promise<boolean>;
  /** Worker status with the saved hands receipt applied. */
  status: () => Promise<HermesStatus>;
  installOrRepair: () => Promise<WorkerInstallOutcome>;
  installInFlight: () => boolean;
  installStatus: () => InstallJob;
  waitForInstall: () => Promise<void>;
  /** Stop an install this module started (withdrawal, revoked link). */
  cancelInstall?: () => void;
  ensurePack: () => void;
  reconcileProfile: () => Promise<unknown>;
  syncBud: () => void;
  readinessPing: () => Promise<{ ok: boolean; detail: string }>;
  /** An operator-managed worker path: automatic setup stays out of it. */
  customRuntime?: () => boolean;
  runInContext?: <T>(fn: () => Promise<T>) => Promise<T>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => { cancel: () => void };
  log?: (message: string) => void;
}

type HeldCode = Extract<WorkerAutoSetupCode, `held_${string}`>;
interface Attempts { version: 1; attempts: number; nextRetryAt: number | null; held: HeldCode | null; stageRetried: boolean }

export const AUTO_SETUP_FILE = "worker-auto-setup.json";
export const AUTO_SETUP_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000] as const;
export const AUTO_SETUP_MAX_ATTEMPTS = 5;
export const AUTO_SETUP_PERIOD_MS = 10 * 60_000;
const TOTAL = 4;
const FRESH: Attempts = { version: 1, attempts: 0, nextRetryAt: null, held: null, stageRetried: false };
const HELD: readonly HeldCode[] = ["held_exhausted", "held_failed", "held_recovery", "held_restart", "held_unavailable"];

/** The only words a person sees. */
export const AUTO_SETUP_COPY: Record<WorkerAutoSetupCode, string> = {
  installing: "Installing Bud",
  safeguards: "Applying Bud’s safeguards",
  model: "Connecting Bud’s model",
  readiness: "Running the private readiness check",
  ready: "Bud is ready.",
  retry: "Bud’s setup will try again shortly.",
  held_exhausted: "Bud couldn’t finish setting up on this computer. RealBud support has the details; try again later.",
  held_failed: "Bud’s setup stopped before it finished. Your files are kept. Try again, or contact RealBud support.",
  held_recovery: "Bud’s setup record needs recovery. Your files are kept; contact RealBud support.",
  held_restart: "Bud’s update is installed. Restart RealBud to use it.",
  held_unavailable: "Automatic Bud setup is not available on this computer yet.",
};

function validAttempts(value: unknown): Attempts {
  const row = value as Record<string, unknown> | null;
  if (!row || typeof row !== "object" || Array.isArray(row) || row.version !== 1
    || Object.keys(row).some(key => !["version", "attempts", "nextRetryAt", "held", "stageRetried"].includes(key))
    || !Number.isInteger(row.attempts) || (row.attempts as number) < 0
    || !(row.nextRetryAt === null || (typeof row.nextRetryAt === "number" && Number.isFinite(row.nextRetryAt)))
    || !(row.held === null || HELD.includes(row.held as HeldCode))
    || typeof row.stageRetried !== "boolean") throw new Error("damaged auto-setup record");
  return row as unknown as Attempts;
}

const usable = (status: HermesStatus) => status.cli.installed && (status.cli.compatible ?? status.cli.matchesPin) && !status.bootstrapPending;
const busyElsewhere = (error: unknown) => (error as { status?: number } | null)?.status === 409 && /already running|still running/i.test(error instanceof Error ? error.message : "");

export function createWorkerAutoSetup(deps: WorkerAutoSetupDeps) {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return { cancel: () => clearTimeout(timer) }; });
  const inContext = deps.runInContext ?? (<T>(fn: () => Promise<T>) => fn());
  const path = join(deps.directory, AUTO_SETUP_FILE);
  let current: WorkerAutoSetupStatus = { state: "idle", step: 0, total: TOTAL, detail: "" };
  let running: Promise<void> | null = null;
  let rerun: WorkerAutoSetupReason | null = null;
  let retryTimer: { cancel: () => void } | null = null;
  let periodic: ReturnType<typeof setInterval> | null = null;
  /** Holds only a restart or another platform can clear: not re-probed on the tick. */
  let parked = false;
  /** The install in flight was started by this module, so it may stop it. */
  let ownInstall = false;

  const set = (state: WorkerAutoSetupState, step: number, code?: WorkerAutoSetupCode, nextRetryAt?: number) => {
    current = { state, step, total: TOTAL, detail: code ? AUTO_SETUP_COPY[code] : "", ...(code ? { code } : {}), ...(nextRetryAt ? { nextRetryAt } : {}) };
  };
  const read = async (): Promise<Attempts> => { const raw = await readPrivateJson(path, 4_000); return raw === undefined ? { ...FRESH } : validAttempts(raw); };
  const save = async (next: Attempts, saved: Attempts) => { if (JSON.stringify(next) !== JSON.stringify(saved)) await writePrivateJson(path, next); };
  const cancelRetry = () => { retryTimer?.cancel(); retryTimer = null; };
  const scheduleRetry = (at: number) => {
    cancelRetry();
    retryTimer = setTimer(() => { retryTimer = null; void ensure("retry"); }, Math.max(0, at - now()));
  };
  const note = (message: string) => deps.log?.(redactSecretsInText(message).slice(0, 300));

  function halt() {
    cancelRetry();
    parked = false;
    if (ownInstall && deps.installInFlight()) deps.cancelInstall?.();
    ownInstall = false;
    set("idle", 0);
  }
  /** Authority again, after an await that may have outlived it. */
  async function stillActive(): Promise<boolean> {
    if (await deps.active()) return true;
    halt();
    return false;
  }

  async function ready(saved: Attempts) {
    cancelRetry();
    await save({ ...FRESH }, saved);
    set("ready", TOTAL, "ready");
  }
  async function hold(saved: Attempts, code: HeldCode, reason: string) {
    await save({ ...saved, nextRetryAt: null, held: code }, saved);
    cancelRetry();
    set("held", current.step, code);
    note(`automatic Bud setup is held (${code}): ${reason}`);
  }
  async function fail(saved: Attempts, kind: "retry" | "once" | "final", reason: string) {
    if (kind === "final" || (kind === "once" && saved.stageRetried)) return hold(saved, "held_failed", reason);
    const attempts = saved.attempts + 1;
    if (attempts >= AUTO_SETUP_MAX_ATTEMPTS) return hold({ ...saved, attempts }, "held_exhausted", reason);
    const nextRetryAt = now() + AUTO_SETUP_BACKOFF_MS[Math.min(attempts - 1, AUTO_SETUP_BACKOFF_MS.length - 1)]!;
    await save({ ...saved, attempts, nextRetryAt, held: null, stageRetried: saved.stageRetried || kind === "once" }, saved);
    set("waiting_retry", current.step, "retry", nextRetryAt);
    scheduleRetry(nextRetryAt);
    note(`automatic Bud setup will retry (attempt ${attempts}): ${reason}`);
  }

  async function run(reason: WorkerAutoSetupReason): Promise<void> {
    if (!(await deps.active()) || deps.customRuntime?.()) { halt(); return; }
    if (reason === "periodic" && parked) return;
    parked = false;
    let saved: Attempts;
    try { saved = await read(); }
    catch { cancelRetry(); set("held", 0, "held_recovery"); return; }
    // A fresh approval or an explicit Try again starts from the top.
    if ((reason === "provisioned" || reason === "manual") && (saved.held || saved.attempts || saved.stageRetried)) { await save({ ...FRESH }, saved); saved = { ...FRESH }; }
    if (saved.held) {
      // Held until someone repairs it; a repaired, ready worker clears the hold.
      if ((await deps.status()).ready) return ready(saved);
      set("held", current.step, saved.held);
      return;
    }
    if (saved.nextRetryAt !== null && now() < saved.nextRetryAt) {
      set("waiting_retry", current.step, "retry", saved.nextRetryAt);
      if (!retryTimer) scheduleRetry(saved.nextRetryAt);
      return;
    }
    cancelRetry();
    try {
      // An administrator's install already running: follow it, never start another.
      if (deps.installInFlight()) {
        set("installing", 1, "installing");
        await deps.waitForInstall();
        if (!(await stillActive())) return;
      }
      let status = await deps.status();
      if (status.ready) return ready(saved);
      if (!usable(status)) {
        set("installing", 1, "installing");
        const outcome = await deps.installOrRepair();
        if (outcome.kind === "awaiting_restart" || outcome.kind === "unavailable") {
          parked = true;
          set("held", 1, outcome.kind === "awaiting_restart" ? "held_restart" : "held_unavailable");
          return;
        }
        if (outcome.kind === "running" || outcome.kind === "started") {
          ownInstall = outcome.kind === "started";
          try { await deps.waitForInstall(); } finally { ownInstall = false; }
          if (!(await stillActive())) return;
          const job = deps.installStatus();
          if (job.state !== "done") return fail(saved, job.failureKind ?? "final", job.error ?? "install failed");
        } else if (!(await stillActive())) return;
      }
      set("verifying", 2, "safeguards");
      deps.ensurePack();
      set("verifying", 3, "model");
      await deps.reconcileProfile();
      if (!(await stillActive())) return;
      deps.syncBud();
      status = await deps.status();
      if (status.ready) return ready(saved);
      if (!usable(status)) return fail(saved, "once", "worker still unusable after setup");
      set("verifying", 4, "readiness");
      if (!(await stillActive())) return;
      const ping = await deps.readinessPing();
      if (ping.ok) return ready(saved);
      return fail(saved, "retry", ping.detail);
    } catch (error) {
      return fail(saved, busyElsewhere(error) ? "retry" : "final", error instanceof Error ? error.message : "setup error");
    }
  }

  /** Serialized: a concurrent call joins the run in progress. A fresh
   * approval or Try again arriving mid-run is evaluated once it finishes. */
  function ensure(reason: WorkerAutoSetupReason): Promise<void> {
    if (running) {
      if (reason === "provisioned" || reason === "manual") rerun = reason;
      return running;
    }
    running = inContext(() => run(reason))
      .catch(() => { set("held", current.step, "held_failed"); })
      .finally(() => {
        running = null;
        const next = rerun; rerun = null;
        if (next) void ensure(next);
      });
    return running;
  }

  function status(): WorkerAutoSetupStatus {
    if (current.state === "installing" && deps.installInFlight()) {
      const progress = deps.installStatus().progress;
      if (progress?.detail) return { ...current, detail: progress.detail };
    }
    return { ...current };
  }

  return {
    ensure, status,
    /** Try again after a hold. Authority is re-checked inside the run. */
    retry: () => ensure("manual"),
    /** Grant withdrawn or link released: stop what this module started. */
    halt,
    start() {
      void ensure("boot");
      if (periodic) return;
      periodic = setInterval(() => { if (current.state !== "ready") void ensure("periodic"); }, AUTO_SETUP_PERIOD_MS);
      periodic.unref?.();
    },
    stop() { if (periodic) clearInterval(periodic); periodic = null; cancelRetry(); },
  };
}
