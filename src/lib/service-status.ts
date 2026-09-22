import type { ServiceEntitlementStatus } from "../../shared/service-entitlement";

const LABELS = {
  unmanaged: "Development service",
  "not-required": "Service checks disabled",
  unconfigured: "Service setup needed",
  invalid: "Service access needs repair",
  "not-yet-valid": "Service access starts later",
  expired: "Service access expired",
  active: "Service access available",
} as const;

export function serviceStatusCopy(value: unknown): { title: string; detail: string; available: boolean; expiresAt: number | null } {
  const status = value as ServiceEntitlementStatus | null;
  if (!status || typeof status !== "object" || !Object.hasOwn(LABELS, status.state) ||
    typeof status.managed !== "boolean" || typeof status.required !== "boolean" ||
    (status.expiresAt !== null && (!Number.isSafeInteger(status.expiresAt) || status.expiresAt <= 0))) {
    throw new Error("Service status could not be verified.");
  }
  const available = ["active", "unmanaged", "not-required"].includes(status.state);
  return {
    title: LABELS[status.state], available, expiresAt: status.expiresAt,
    detail: status.state === "unmanaged" ? "This development checkout is not enrolled in managed service."
      : status.state === "not-required" ? "This installation is not enforcing paid service access. Contact RealBud support before office use."
      : available ? "Service access is checked separately from your work accounts and administrator sign-in."
      : "Contact RealBud support to restore managed assistance. Your saved work remains available; you can still stop running work and review results.",
  };
}

/** Lifecycle of the desk service child process, as reported by the main process. */
export interface ServiceLifecycle {
  state: string;
  restarts: number;
  lastExitCode: number | null;
  exhausted: boolean;
  /** The office service is answering on this computer. */
  running?: boolean;
  port?: number | null;
  /** It was already running when RealBud launched. */
  adopted?: boolean;
  /** RealBud started it, so RealBud can stop it. */
  manageable?: boolean;
  /** Running, but not started by this installation: report it, never own it. */
  external?: boolean;
}

/**
 * Staff-facing copy for the office service.
 *
 * This is deliberately separate from service *access*: access is about paid
 * assistance, this is about whether the office is running at all. A stopped
 * service previously produced only a log line, so a staff member saw an app that
 * quietly did nothing. Returns null when there is nothing worth interrupting
 * them about.
 *
 * `running` is the fact that matters, and it is reported first: the supervisor
 * states below it only ever described a development child, so treating them as
 * authoritative would have told staff the office was down while it was serving.
 */
export function serviceLifecycleCopy(value: unknown): { title: string; detail: string; canRetry: boolean } | null {
  const status = value as ServiceLifecycle | null;
  if (!status || typeof status !== "object" || typeof status.state !== "string") return null;
  const restarts = Number.isSafeInteger(status.restarts) && status.restarts > 0 ? status.restarts : 0;
  const attempts = restarts === 1 ? "once" : `${restarts} times`;

  // Availability does not establish control authority. Older services can
  // answer normally without the per-process capability used by this app.
  if (status.running === true) {
    if (status.manageable !== true || status.external === true) return {
      title: "This window cannot stop the running service",
      detail: "It may have been started by another RealBud window or an older installation. Use the app that started it, or ask RealBud support to identify it before stopping anything. This window has no verified permission to stop it.",
      canRetry: false,
    };
    return null;
  }

  // Running but started outside this installation: a truthful report, no controls.
  if (status.running === false && status.external === true) {
    return {
      title: "The office service connection needs checking",
      detail: "Another RealBud service may be using this computer. This window cannot manage it. Ask RealBud support to identify the running service before starting another one.",
      canRetry: false,
    };
  }

  // Not running at all.
  if (status.running === false) {
    return {
      title: "The office service is not running",
      detail: "RealBud cannot confirm the office service is available. Sharing and scheduled work may be interrupted. Check recent work and the connected system before retrying a job; its last action may already have completed.",
      canRetry: true,
    };
  }

  switch (status.state) {
    case "exhausted":
      return {
        title: "The office service has stopped",
        detail: "Automatic restart attempts have stopped. Review recent work and the connected system before retrying interrupted jobs to avoid duplicates. Start the service below; if it stops again, contact RealBud support.",
        canRetry: true,
      };
    case "failed":
      return {
        title: "The office service did not start",
        detail: `The start was not confirmed${restarts ? ` after retrying ${attempts}` : ""}. Start it below; if it fails again, contact RealBud support. Review recent work before retrying interrupted jobs.`,
        canRetry: true,
      };
    case "restarting":
      return { title: "Restarting the office service", detail: "RealBud is trying to bring the office back. Wait for its status before continuing. Review recent work before retrying an interrupted job.", canRetry: false };
    case "exited":
      return { title: "The office service stopped", detail: `RealBud is restarting it (attempt ${restarts}). Interrupted jobs may have an unknown result. Check recent work and the connected system before retrying them.`, canRetry: false };
    default:
      return null;
  }
}

/** A successful request alone is insufficient: require the resulting state. */
export function serviceActionFeedback(action: "start" | "stop", result: unknown): { ok: boolean; message: string } {
  const value = result as { ok?: unknown; status?: { running?: unknown } } | null;
  const ok = value?.ok === true && value.status?.running === (action === "start");
  if (!ok) return {
    ok: false,
    message: action === "stop"
      ? "The service stop was not confirmed. It may still be running. Check its status before closing this computer; review interrupted work before retrying it."
      : "The service start was not confirmed. Check its status again. If it remains unavailable, contact RealBud support before retrying interrupted work.",
  };
  return { ok: true, message: action === "stop"
    ? "The office service has stopped. Review recent work before restarting interrupted jobs; their last result may be unknown."
    : "The office service is running. Review recent work before retrying interrupted jobs to avoid duplicates." };
}
