import { budAvailability } from "@/lib/bud-setup";
import { budReadinessCheck } from "@/lib/bud-readiness";
import type { HermesStatus } from "@/state/store";
import { api } from "@/state/store";

let micWarmStarted = false;
let autoReadinessKey: string | null = null;
let autoBookRecoveryAttempted = false;
let autoPinRestoreAttempted = false;

export type MicWarmResult = "granted" | "denied" | "skipped";

/** Ask once on boot when macOS has never decided. Denied stays denied until
 * the PM flips it in System Settings — we never spam the prompt. */
export async function warmMicrophoneAccess(): Promise<MicWarmResult> {
  if (micWarmStarted) return "skipped";
  if (typeof window === "undefined" || !window.ogb?.permStatus || !window.ogb?.permRequestMic) return "skipped";
  micWarmStarted = true;
  try {
    const status = await window.ogb.permStatus();
    if (status.mic === "granted") return "granted";
    if (status.mic === "denied") return "denied";
    const granted = await window.ogb.permRequestMic();
    return granted ? "granted" : "denied";
  } catch {
    return "skipped";
  }
}

export async function micAccessGranted(): Promise<boolean> {
  if (typeof window === "undefined" || !window.ogb?.permStatus) return false;
  try {
    const status = await window.ogb.permStatus();
    return status.mic === "granted";
  } catch {
    return false;
  }
}

function readinessKey(status: HermesStatus | null | undefined): string {
  const model = status?.model;
  return [
    status?.cli.installed ? "1" : "0",
    status?.pack.installed ? "1" : "0",
    status?.pack.workroomReady ? "1" : "0",
    model?.provider ?? "",
    model?.model ?? "",
    model?.attached ? "1" : "0",
  ].join("|");
}

/** True when Bud only needs the private hands ping — safe to run without a click. */
export function needsAutoReadiness(
  status: HermesStatus | null | undefined,
  connected: boolean,
  recovering = false,
): boolean {
  return budAvailability(status ?? null, connected, recovering).canVerify;
}

/** One automatic readiness attempt per model/setup fingerprint. Failed checks
 * stay manual ("Try again") so we do not hammer the worker. */
export async function autoRunBudReadiness(input: {
  status: HermesStatus | null | undefined;
  connected: boolean;
  recovering?: boolean;
  onStatus: (status: HermesStatus) => void;
}): Promise<{ ran: boolean; ok?: boolean; detail?: string }> {
  if (!needsAutoReadiness(input.status, input.connected, input.recovering)) {
    return { ran: false };
  }
  const key = readinessKey(input.status);
  if (autoReadinessKey === key) return { ran: false };
  autoReadinessKey = key;
  try {
    const result = await budReadinessCheck.run();
    input.onStatus(result.status);
    return { ran: true, ok: result.ok, detail: typeof result.detail === "string" ? result.detail : undefined };
  } catch (cause) {
    return {
      ran: true,
      ok: false,
      detail: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

/** When the book is locked, try the key already on this Mac once. Manual paste
 * remains the fallback when auto-heal cannot open a quarantine. */
export async function autoAttemptBookRecovery(input: {
  recovering: boolean;
  onSnapshot: (snapshot: unknown) => void;
}): Promise<{ ran: boolean; ok?: boolean; detail?: string }> {
  if (!input.recovering || autoBookRecoveryAttempted) return { ran: false };
  autoBookRecoveryAttempted = true;
  try {
    const result = await api("/api/desk/recovery/auto", { method: "POST", body: "{}" }, { timeoutMs: 20_000 });
    if (result?.ok) {
      const snapshot = await api("/api/desk", undefined, { timeoutMs: 15_000 });
      input.onSnapshot(snapshot);
      return { ran: true, ok: true, detail: typeof result.message === "string" ? result.message : undefined };
    }
    return {
      ran: true,
      ok: false,
      detail: typeof result?.error === "string" ? result.error : "Could not restore the book automatically.",
    };
  } catch (cause) {
    return {
      ran: true,
      ok: false,
      detail: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

/** When Hermes drifted past RealBud's support list, re-run the pinned installer once.
 * Soft profile repair refuses incompatible CLIs — this is the self-heal path. */
export async function autoRestoreBudPin(input: {
  status: HermesStatus | null | undefined;
}): Promise<{ ran: boolean; ok?: boolean; detail?: string }> {
  const status = input.status;
  if (!status?.cli.installed || (status.cli.compatible ?? status.cli.matchesPin)) return { ran: false };
  if (!(status.installerAvailable ?? Boolean(status.installCommand))) return { ran: false };
  if (autoPinRestoreAttempted) return { ran: false };
  autoPinRestoreAttempted = true;
  try {
    const result = await api("/api/hermes/install", { method: "POST", body: "{}" }, { timeoutMs: 20_000 });
    const job = result?.install as { state?: string; error?: string | null } | undefined;
    if (job?.state === "failed") {
      return { ran: true, ok: false, detail: typeof job.error === "string" ? job.error : "Could not restore Bud’s supported build." };
    }
    return {
      ran: true,
      ok: true,
      detail: "Restoring Bud’s supported build. Keep RealBud open until setup finishes.",
    };
  } catch (cause) {
    return {
      ran: true,
      ok: false,
      detail: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

/** Test helper — reset one-shot guards between cases. */
export function resetBootHealForTests(): void {
  micWarmStarted = false;
  autoReadinessKey = null;
  autoBookRecoveryAttempted = false;
  autoPinRestoreAttempted = false;
}
