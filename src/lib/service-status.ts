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

  // The office is serving. Say nothing, whatever a development supervisor thinks.
  if (status.running === true) return null;

  // Running but started outside this installation: a truthful report, no controls.
  if (status.running === false && status.external === true) {
    return {
      title: "Another RealBud service is using this office's port",
      detail: "RealBud did not start it and will not stop it. Close the other RealBud, then start the office service again.",
      canRetry: false,
    };
  }

  // Not running at all.
  if (status.running === false) {
    return {
      title: "The office service is not running",
      detail: "RealBud is not sharing this office's records and scheduled work right now. Your saved work is safe and nothing was sent, paid or submitted.",
      canRetry: true,
    };
  }

  switch (status.state) {
    case "exhausted":
      return {
        title: "The office service has stopped",
        detail: "RealBud tried to restart it and gave up. Saved work is safe and nothing was sent, paid or submitted. Restart it below; if it stops again, contact RealBud support.",
        canRetry: true,
      };
    case "failed":
      return {
        title: "The office service did not start",
        detail: `It has not been running${restarts ? ` after ${attempts}` : ""}. Check that nothing else is using RealBud's ports, then restart it below.`,
        canRetry: true,
      };
    case "restarting":
      return { title: "Restarting the office service", detail: "RealBud is bringing the office back. This usually takes a few seconds.", canRetry: false };
    case "exited":
      return { title: "The office service stopped", detail: `RealBud is restarting it (attempt ${restarts}). Saved work is safe.`, canRetry: false };
    default:
      return null;
  }
}
