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
  | "checking" | "installing" | "safeguards" | "model" | "readiness" | "ready" | "retry"
  | "held_exhausted" | "held_failed" | "held_recovery" | "held_restart" | "held_unavailable";
export interface WorkerAutoSetupStatus { state: WorkerAutoSetupState; code?: WorkerAutoSetupCode; step: number; total: number; nextRetryAt?: number; detail: string }
export type WorkerAutoSetupReason = "provisioned" | "boot" | "periodic" | "retry" | "manual" | "stale" | "documents";

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
/** `step`: the setup step a hold stopped at, so its copy survives a restart. */
interface Attempts { version: 1; attempts: number; nextRetryAt: number | null; held: HeldCode | null; stageRetried: boolean; step?: number }

export const AUTO_SETUP_FILE = "worker-auto-setup.json";
export const AUTO_SETUP_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000] as const;
export const AUTO_SETUP_MAX_ATTEMPTS = 5;
export const AUTO_SETUP_PERIOD_MS = 10 * 60_000;
/** A readiness proof that went stale is re-checked at most once per changed
 * setup, and never twice within this long. */
export const AUTO_SETUP_STALE_RECHECK_MS = 60_000;
/** And at most this many stale re-checks an hour, each setup fingerprint once
 * an hour, so a profile flipping between two setups cannot run the paid check
 * every minute. */
export const AUTO_SETUP_STALE_RECHECKS_PER_HOUR = 6;
const TOTAL = 4;
const FRESH: Attempts = { version: 1, attempts: 0, nextRetryAt: null, held: null, stageRetried: false };
const HELD: readonly HeldCode[] = ["held_exhausted", "held_failed", "held_recovery", "held_restart", "held_unavailable"];

/** The only words a person sees. */
export const AUTO_SETUP_COPY: Record<WorkerAutoSetupCode, string> = {
  checking: "Checking Bud on this computer",
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
/** Plain words for the four setup steps, so a hold says where it stopped. */
const STAGE_WORDS: Record<number, string> = { 1: "installing Bud", 2: "applying Bud’s safeguards", 3: "connecting Bud’s model", 4: "running the private readiness check" };
/** A stopped setup names the step it stopped at, when that step is known. */
export function autoSetupDetail(code: WorkerAutoSetupCode, step: number): string {
  const stage = STAGE_WORDS[step];
  if (stage && code === "held_failed") return `Bud’s setup stopped while ${stage}. Your files are kept. Try again, or contact RealBud support.`;
  if (stage && code === "held_exhausted") return `Bud couldn’t finish setting up on this computer. It stopped while ${stage}. RealBud support has the details; try again later.`;
  return AUTO_SETUP_COPY[code];
}

function validAttempts(value: unknown): Attempts {
  const row = value as Record<string, unknown> | null;
  if (!row || typeof row !== "object" || Array.isArray(row) || row.version !== 1
    || Object.keys(row).some(key => !["version", "attempts", "nextRetryAt", "held", "stageRetried", "step"].includes(key))
    || (row.step !== undefined && (!Number.isInteger(row.step) || (row.step as number) < 0 || (row.step as number) > TOTAL))
    || !Number.isInteger(row.attempts) || (row.attempts as number) < 0
    || !(row.nextRetryAt === null || (typeof row.nextRetryAt === "number" && Number.isFinite(row.nextRetryAt)))
    || !(row.held === null || HELD.includes(row.held as HeldCode))
    || typeof row.stageRetried !== "boolean") throw new Error("damaged auto-setup record");
  return row as unknown as Attempts;
}

const usable = (status: HermesStatus) => status.cli.installed && (status.cli.compatible ?? status.cli.matchesPin) && !status.bootstrapPending;
/** An installed worker whose RealBud-owned policy predates this release (an
 * upgrade changed the pack): the reviewed Repair path re-applies it. Missing
 * document libraries join only on boot, a fresh approval, Try again or a
 * changed setup, never on the periodic tick, and never hold readiness. */
const policyStale = (status: HermesStatus) => status.pack.installed && (!status.pack.workroomReady || !status.pack.approvalsManual);
const needsReviewedRepair = (status: HermesStatus, reason: WorkerAutoSetupReason) =>
  policyStale(status) || (reason !== "periodic" && status.documentTools === "needs_repair");
const busyElsewhere = (error: unknown) => (error as { status?: number } | null)?.status === 409 && /already running|still running/i.test(error instanceof Error ? error.message : "");

export function createWorkerAutoSetup(deps: WorkerAutoSetupDeps) {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return { cancel: () => clearTimeout(timer) }; });
  const inContext = deps.runInContext ?? (<T>(fn: () => Promise<T>) => fn());
  const path = join(deps.directory, AUTO_SETUP_FILE);
  let current: WorkerAutoSetupStatus = { state: "idle", step: 0, total: TOTAL, detail: "" };
  let running: Promise<void> | null = null;
  /** Withdrawal permanently invalidates the old run, even if a new office
   * becomes active before its pending probe or installer admission returns. */
  let epoch = 0;
  let rerun: WorkerAutoSetupReason | null = null;
  let retryTimer: { cancel: () => void } | null = null;
  let periodic: ReturnType<typeof setInterval> | null = null;
  let lastDocumentsRepair: number | null = null;
  /** Holds only a restart or another platform can clear: not re-probed on the tick. */
  let parked = false;
  /** The install in flight was started by this module, so it may stop it. */
  let ownInstall = false;
  /** Stale re-checks in the last hour, by setup fingerprint and time. */
  let staleRechecks: Array<{ fingerprint: string; at: number }> = [];

  const set = (state: WorkerAutoSetupState, step: number, code?: WorkerAutoSetupCode, nextRetryAt?: number) => {
    current = { state, step, total: TOTAL, detail: code ? autoSetupDetail(code, step) : "", ...(code ? { code } : {}), ...(nextRetryAt ? { nextRetryAt } : {}) };
  };
  const read = async (): Promise<Attempts> => { const raw = await readPrivateJson(path, 4_000); return raw === undefined ? { ...FRESH } : validAttempts(raw); };
  const save = async (next: Attempts, saved: Attempts) => { if (JSON.stringify(next) !== JSON.stringify(saved)) await writePrivateJson(path, next); };
  const cancelRetry = () => { retryTimer?.cancel(); retryTimer = null; };
  const scheduleRetry = (at: number, runEpoch: number) => {
    cancelRetry();
    retryTimer = setTimer(() => { retryTimer = null; if (epoch === runEpoch) void ensure("retry"); }, Math.max(0, at - now()));
  };
  const note = (message: string) => deps.log?.(redactSecretsInText(message).slice(0, 300));

  function halt() {
    epoch++;
    rerun = null;
    cancelRetry();
    parked = false;
    if (ownInstall && deps.installInFlight()) deps.cancelInstall?.();
    ownInstall = false;
    set("idle", 0);
  }
  /** Authority again, after an await that may have outlived it. */
  async function stillActive(runEpoch: number): Promise<boolean> {
    if (runEpoch !== epoch) return false;
    let active: boolean;
    try { active = await deps.active(); }
    catch {
      // An unreadable authority must stop our install just like a withdrawal.
      if (runEpoch === epoch) halt();
      return false;
    }
    if (runEpoch !== epoch) return false;
    if (active) return true;
    halt();
    return false;
  }

  async function ready(saved: Attempts, runEpoch: number) {
    if (!(await stillActive(runEpoch))) return;
    cancelRetry();
    await save({ ...FRESH }, saved);
    if (!(await stillActive(runEpoch))) return;
    set("ready", TOTAL, "ready");
  }
  async function hold(saved: Attempts, code: HeldCode, reason: string, runEpoch: number) {
    if (!(await stillActive(runEpoch))) return;
    await save({ ...saved, nextRetryAt: null, held: code, step: current.step }, saved);
    if (!(await stillActive(runEpoch))) return;
    cancelRetry();
    set("held", current.step, code);
    note(`automatic Bud setup is held (${code}): ${reason}`);
  }
  async function fail(saved: Attempts, kind: "retry" | "once" | "final", reason: string, runEpoch: number) {
    if (!(await stillActive(runEpoch))) return;
    if (kind === "final" || (kind === "once" && saved.stageRetried)) return hold(saved, "held_failed", reason, runEpoch);
    const attempts = saved.attempts + 1;
    if (attempts >= AUTO_SETUP_MAX_ATTEMPTS) return hold({ ...saved, attempts }, "held_exhausted", reason, runEpoch);
    const nextRetryAt = now() + AUTO_SETUP_BACKOFF_MS[Math.min(attempts - 1, AUTO_SETUP_BACKOFF_MS.length - 1)]!;
    await save({ ...saved, attempts, nextRetryAt, held: null, stageRetried: saved.stageRetried || kind === "once" }, saved);
    if (!(await stillActive(runEpoch))) return;
    set("waiting_retry", current.step, "retry", nextRetryAt);
    scheduleRetry(nextRetryAt, runEpoch);
    note(`automatic Bud setup will retry (attempt ${attempts}): ${reason}`);
  }

  async function run(reason: WorkerAutoSetupReason, runEpoch: number): Promise<void> {
    if (!(await stillActive(runEpoch))) return;
    if (deps.customRuntime?.()) { halt(); return; }
    if (reason === "periodic" && parked) return;
    parked = false;
    // Visible at once: the first status probe can take a while.
    if (current.state === "idle" || current.state === "ready") set("verifying", 0, "checking");
    let saved: Attempts;
    try { saved = await read(); }
    catch { if (await stillActive(runEpoch)) { cancelRetry(); set("held", 0, "held_recovery"); } return; }
    if (!(await stillActive(runEpoch))) return;
    // A fresh approval or an explicit Try again starts from the top.
    if ((reason === "provisioned" || reason === "manual") && (saved.held || saved.attempts || saved.stageRetried)) {
      await save({ ...FRESH }, saved);
      if (!(await stillActive(runEpoch))) return;
      saved = { ...FRESH };
    }
    if (saved.held) {
      // Held until someone repairs it; a repaired, ready worker clears the hold.
      const status = await deps.status();
      if (!(await stillActive(runEpoch))) return;
      if (status.ready) return ready(saved, runEpoch);
      set("held", saved.step ?? 0, saved.held);
      return;
    }
    if (saved.nextRetryAt !== null && now() < saved.nextRetryAt) {
      set("waiting_retry", current.step, "retry", saved.nextRetryAt);
      if (!retryTimer) scheduleRetry(saved.nextRetryAt, runEpoch);
      return;
    }
    cancelRetry();
    try {
      // An administrator's install already running: follow it, never start another.
      if (deps.installInFlight()) {
        set("installing", 1, "installing");
        await deps.waitForInstall();
        if (!(await stillActive(runEpoch))) return;
      }
      let status = await deps.status();
      if (!(await stillActive(runEpoch))) return;
      if (status.ready && !needsReviewedRepair(status, reason)) return ready(saved, runEpoch);
      if (!usable(status) || needsReviewedRepair(status, reason)) {
        set("installing", 1, "installing");
        const outcome = await deps.installOrRepair();
        // Admission itself can await a probe. A halt in that interval cannot
        // know that this run will own an install until the outcome arrives.
        ownInstall = outcome.kind === "started";
        if (!(await stillActive(runEpoch))) {
          if (ownInstall && deps.installInFlight()) deps.cancelInstall?.();
          ownInstall = false;
          return;
        }
        if (outcome.kind === "awaiting_restart" || outcome.kind === "unavailable") {
          parked = true;
          set("held", 1, outcome.kind === "awaiting_restart" ? "held_restart" : "held_unavailable");
          return;
        }
        if (outcome.kind === "running" || outcome.kind === "started") {
          try { await deps.waitForInstall(); } finally { ownInstall = false; }
          if (!(await stillActive(runEpoch))) return;
          const job = deps.installStatus();
          if (job.state !== "done") return fail(saved, job.failureKind ?? "final", job.error ?? "install failed", runEpoch);
        }
      }
      if (!(await stillActive(runEpoch))) return;
      set("verifying", 2, "safeguards");
      deps.ensurePack();
      set("verifying", 3, "model");
      await deps.reconcileProfile();
      if (!(await stillActive(runEpoch))) return;
      deps.syncBud();
      status = await deps.status();
      if (!(await stillActive(runEpoch))) return;
      if (status.ready) return ready(saved, runEpoch);
      if (!usable(status)) return fail(saved, "once", "worker still unusable after setup", runEpoch);
      if (policyStale(status)) return fail(saved, "once", "Bud's private policy could not be updated", runEpoch);
      set("verifying", 4, "readiness");
      if (!(await stillActive(runEpoch))) return;
      const ping = await deps.readinessPing();
      if (!(await stillActive(runEpoch))) return;
      if (!ping.ok) return fail(saved, "retry", ping.detail, runEpoch);
      // A passing ping is not readiness: report ready only when the full status agrees.
      status = await deps.status();
      if (!(await stillActive(runEpoch))) return;
      return status.ready ? ready(saved, runEpoch) : fail(saved, "once", status.detail, runEpoch);
    } catch (error) {
      return fail(saved, busyElsewhere(error) ? "retry" : "final", error instanceof Error ? error.message : "setup error", runEpoch);
    }
  }

  /** Serialized: a concurrent call joins the run in progress. A fresh
   * approval or Try again arriving mid-run is evaluated once it finishes. */
  function ensure(reason: WorkerAutoSetupReason): Promise<void> {
    if (running) {
      if (reason === "provisioned" || reason === "manual") rerun = reason;
      return running;
    }
    const runEpoch = epoch;
    running = inContext(() => run(reason, runEpoch))
      .catch(async () => { if (await stillActive(runEpoch)) set("held", current.step, "held_failed"); })
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

  /**
   * Bud reached ready once, and a later status says the readiness proof no
   * longer matches this setup (a changed profile or release). On a linked
   * office the service re-runs its own check instead of asking for an
   * administrator: each setup at most once an hour, at most once a minute, and
   * at most `AUTO_SETUP_STALE_RECHECKS_PER_HOUR` times an hour. The run
   * re-checks authority and persists its own backoff on failure.
   */
  function noteStatus(observed: { ready: boolean; workerFingerprint?: string | null; documentTools?: HermesStatus["documentTools"] }): void {
    // The document check finishes after boot's first status read ("unknown"),
    // so a newly locked library is only seen here: run the reviewed Repair once,
    // then at most hourly so a failing install never loops.
    if (current.state === "ready" && observed.documentTools === "needs_repair" && !running) {
      const at = now();
      if (lastDocumentsRepair === null || at - lastDocumentsRepair >= 60 * 60_000) { lastDocumentsRepair = at; void ensure("documents"); }
      return;
    }
    if (observed.ready || current.state !== "ready" || !observed.workerFingerprint) return;
    const at = now();
    staleRechecks = staleRechecks.filter(entry => at - entry.at < 60 * 60_000);
    const last = staleRechecks[staleRechecks.length - 1];
    if (staleRechecks.some(entry => entry.fingerprint === observed.workerFingerprint) || staleRechecks.length >= AUTO_SETUP_STALE_RECHECKS_PER_HOUR
      || (last && at - last.at < AUTO_SETUP_STALE_RECHECK_MS)) return;
    staleRechecks.push({ fingerprint: observed.workerFingerprint, at });
    set("verifying", 0, "checking");
    void ensure("stale");
  }

  return {
    ensure, status,
    noteStatus,
    /** Try again after a hold. Authority is re-checked inside the run. */
    retry: () => ensure("manual"),
    /** Grant withdrawn or link released: stop what this module started. */
    halt,
    start() {
      void ensure("boot");
      if (periodic) return;
      periodic = setInterval(() => {
        if (current.state !== "ready") { void ensure("periodic"); return; }
        // A proof that went stale while nobody looked is found here too.
        const observedEpoch = epoch;
        void deps.status().then(status => { if (observedEpoch === epoch) noteStatus(status); }).catch(() => {});
      }, AUTO_SETUP_PERIOD_MS);
      periodic.unref?.();
    },
    stop() { if (periodic) clearInterval(periodic); periodic = null; cancelRetry(); },
  };
}
