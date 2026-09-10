import { budAvailability } from "@/lib/bud-setup";
import { budReadinessCheck } from "@/lib/bud-readiness";
import type { HermesStatus } from "@/state/store";

let micWarmStarted = false;
let autoReadinessKey: string | null = null;

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

/** Test helper — reset one-shot guards between cases. */
export function resetBootHealForTests(): void {
  micWarmStarted = false;
  autoReadinessKey = null;
}
