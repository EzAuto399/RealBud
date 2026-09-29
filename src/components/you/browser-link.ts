import { useEffect, useRef, useState } from "react";
import { api } from "@/state/store";
import { LINK_POLL_INTERVAL_MS, isLinkRequestIssued } from "@shared/installation-link";
import { isProvisioningSkipReason, type ProvisioningSkipReason } from "@shared/office-link";
import type { BrowserLinkRequest, BrowserLinkView, OfficeLinkStatus } from "../../../server/office-link";

// One browser-approval protocol for every surface that links this computer to
// the office's RealBud account: the You website card, first run, and Bud setup.

/** Where the browser approval stands on this screen. */
export type BrowserLinkPhase =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "waiting"; request: BrowserLinkRequest }
  | { kind: "cancelling"; request: BrowserLinkRequest }
  /** With a request: a status check failed. Without: starting failed. */
  | { kind: "unreachable"; message: string; request?: BrowserLinkRequest }
  | { kind: "failed"; message: string }
  | { kind: "declined" }
  | { kind: "expired" }
  | { kind: "linked"; agencyLabel: string };

export const UNREADABLE = "RealBud could not read the website link answer. Try again.";

function approval(value: Record<string, unknown>): BrowserLinkRequest | null {
  const { approvalUrl, displayCode, expiresAt } = value;
  let origin: string;
  try { origin = new URL(String(approvalUrl)).origin; } catch { return null; }
  const issued = { version: 1, purpose: "installation-link-issued", approvalUrl, displayCode, expiresAt };
  return isLinkRequestIssued(issued, origin) ? { approvalUrl: issued.approvalUrl, displayCode: issued.displayCode, expiresAt: issued.expiresAt } : null;
}

/** Re-validate a browser-link answer from the local service; anything malformed is null. */
export function readBrowserLinkView(value: unknown): BrowserLinkView | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const view = value as Record<string, unknown>;
  switch (view.state) {
    case "none": case "expired": case "declined": return { state: view.state };
    case "linked": return typeof view.agencyLabel === "string" ? { state: "linked", agencyLabel: view.agencyLabel } : null;
    case "pending": { const pending = approval(view); return pending ? { state: "pending", ...pending } : null; }
    default: return null;
  }
}

/** A pending approval the service saved, for resuming after a restart. */
export function savedBrowserRequest(status: OfficeLinkStatus | null): BrowserLinkRequest | null {
  const browser: unknown = status?.state === "pending" ? status.browser : undefined;
  return browser && typeof browser === "object" ? approval(browser as Record<string, unknown>) : null;
}

export function phaseFor(view: BrowserLinkView): BrowserLinkPhase {
  switch (view.state) {
    case "pending": return { kind: "waiting", request: { approvalUrl: view.approvalUrl, displayCode: view.displayCode, expiresAt: view.expiresAt } };
    case "linked": return { kind: "linked", agencyLabel: view.agencyLabel };
    case "expired": return { kind: "expired" };
    case "declined": return { kind: "declined" };
    default: return { kind: "idle" };
  }
}

/** The request a phase is waiting on, if any. */
export function pendingRequest(phase: BrowserLinkPhase): BrowserLinkRequest | null {
  return phase.kind === "waiting" || phase.kind === "cancelling" || (phase.kind === "unreachable" && phase.request) ? phase.request ?? null : null;
}

/**
 * Bud's model access after a link. Approval carries no credential: it arrives
 * with the first status report, so until that report settles it is being set
 * up. `skipped` is the account saying, by reason, why it issued none yet.
 */
export type ModelAccessState = "ready" | "setting-up" | "not-yet" | "failed" | "skipped";
export function modelAccessState(status: OfficeLinkStatus | null): ModelAccessState | null {
  if (status?.state !== "linked" || status.serviceWithdrawn) return null;
  if (status.provisioned === true) return "ready";
  if (status.provisioningSkipped) return "skipped";
  if (status.error) return "failed";
  return status.lastReportedAt ? "not-yet" : "setting-up";
}
/** The only way out once the account has recorded a delivery this computer never
 * received: the website replays nothing for a delivered installation. */
const START_AGAIN_STEP = "remove this computer under Account → Computers on realbud.app, then link it again";
const START_AGAIN = `To start again, ${START_AGAIN_STEP}.`;
const CHECKS_AGAIN = "RealBud checks again with each status update.";
const SERVICE_NOT_SET_UP = `RealBud’s AI service isn’t set up yet. Contact RealBud support; ${CHECKS_AGAIN}`;
const SKIPPED: Record<ProvisioningSkipReason, string> = {
  no_platform_customer: `Bud’s model access is waiting on your office’s AI account, which RealBud support sets up. ${CHECKS_AGAIN}`,
  service_not_entitled: `AI isn’t turned on for your office yet. RealBud support turns it on; ${CHECKS_AGAIN}`,
  service_not_active: `Your office’s AI service isn’t active right now. Check your subscription on realbud.app or contact RealBud support; ${CHECKS_AGAIN}`,
  modelvia_customer_not_ready: `Your office’s AI account isn’t ready yet. RealBud support finishes it; ${CHECKS_AGAIN}`,
  provisioning_gateway_unconfigured: SERVICE_NOT_SET_UP,
  provisioning_gateway_same_as_platform: SERVICE_NOT_SET_UP,
  provisioning_gateway_wrong_service: SERVICE_NOT_SET_UP,
  provisioning_gateway_not_ready: SERVICE_NOT_SET_UP,
  provisioning_attempt_requires_review: `Bud’s model access needs review by RealBud support before it can arrive here. ${START_AGAIN}`,
};
const MODEL_ACCESS: Record<Exclude<ModelAccessState, "skipped">, string> = {
  ready: "Bud’s model access is set up.",
  "setting-up": "Setting up Bud’s model access…",
  "not-yet": `Bud’s model access has not arrived from your account yet. ${CHECKS_AGAIN} If it still hasn’t arrived after the next update, ${START_AGAIN_STEP}.`,
  failed: "Bud’s model access is not set up yet. Use Update status to try again.",
};
/** One plain sentence on where Bud's model access stands, with the next step. */
export function modelAccessMessage(status: OfficeLinkStatus | null): string | null {
  const access = modelAccessState(status);
  if (!access) return null;
  if (access !== "skipped") return MODEL_ACCESS[access];
  const reason = status?.provisioningSkipped ?? "";
  return isProvisioningSkipReason(reason) ? SKIPPED[reason]
    : `Bud’s model access was not set up by your account (it reported “${reason}”). Contact RealBud support; ${CHECKS_AGAIN}`;
}

/** The sentences the live region announces for a phase. */
export function browserLinkMessage(phase: BrowserLinkPhase): string {
  switch (phase.kind) {
    case "waiting": case "cancelling": return `Approve this computer in your browser. The page shows code ${phase.request.displayCode}.`;
    case "declined": return "This computer was declined in your browser. Nothing was linked.";
    case "expired": return "The approval page expired before this computer was approved. Nothing was linked.";
    case "linked": return `Linked to ${phase.agencyLabel}.`;
    default: return "";
  }
}

export function openApproval(url: string) {
  if (typeof window === "undefined") return;
  if (window.ogb?.openExternal) void window.ogb.openExternal(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

/** The office this computer is linked to, from the saved status or a just-finished approval. */
export function linkedOffice(status: OfficeLinkStatus | null, phase: BrowserLinkPhase): string | null {
  if (status?.state === "linked") return status.agencyLabel?.trim() || (phase.kind === "linked" ? phase.agencyLabel : "") || "your office";
  return phase.kind === "linked" ? phase.agencyLabel || "your office" : null;
}

/** A computer name the person never has to type: the service requires one. */
export function defaultComputerName(personName: string | undefined): string {
  const name = (personName ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return name ? `${name.slice(0, 64)}’s computer` : "Office computer";
}

export const WEBSITE_LINK_CHANGED = "realbud-website-link-changed";

/**
 * The browser-link state machine: read the saved link (resuming a saved
 * approval), start, poll while waiting, cancel, and link with a pasted code.
 */
export function useBrowserLink() {
  const [status, setStatus] = useState<OfficeLinkStatus | null>(null);
  const [phase, setPhase] = useState<BrowserLinkPhase>({ kind: "idle" });
  const [error, setError] = useState("");
  const polling = useRef<Promise<unknown> | null>(null);
  const changed = () => window.dispatchEvent(new Event(WEBSITE_LINK_CHANGED));
  /** Reads the link; with `resume`, an approval the service saved (after a restart) is picked up again. */
  const refresh = async (resume = false) => {
    const next = await api("/api/office-link") as OfficeLinkStatus;
    setStatus(next);
    const saved = resume ? savedBrowserRequest(next) : null;
    if (saved) setPhase({ kind: "waiting", request: saved });
    return next;
  };
  useEffect(() => { void refresh(true).catch(() => setError("Website link status could not be loaded. Try again.")); }, []);

  // Ask while this surface is open and an approval is waiting: at once, then every interval.
  const waitingFor = phase.kind === "waiting" ? phase.request : null;
  useEffect(() => {
    if (!waitingFor) return;
    let alive = true;
    let timer: number | undefined;
    const tick = async () => {
      const call = api("/api/office-link/browser-link", undefined, { timeoutMs: 30_000 });
      polling.current = call.catch(() => undefined);
      let next: BrowserLinkPhase;
      try {
        const view = readBrowserLinkView(await call);
        next = view ? phaseFor(view) : { kind: "unreachable", message: UNREADABLE, request: waitingFor };
      } catch (cause) {
        next = { kind: "unreachable", message: cause instanceof Error ? cause.message : UNREADABLE, request: waitingFor };
      } finally { polling.current = null; }
      if (!alive) return;
      if (next.kind === "waiting") { timer = window.setTimeout(() => void tick(), LINK_POLL_INTERVAL_MS); return; }
      setPhase(next);
      if (next.kind !== "unreachable") { void refresh().catch(() => {}); changed(); }
    };
    void tick();
    return () => { alive = false; window.clearTimeout(timer); };
  }, [waitingFor]);

  // Just linked: re-read the link until the first report settles model access.
  const settingUp = phase.kind === "linked" && modelAccessState(status) === "setting-up";
  useEffect(() => {
    if (!settingUp) return;
    // Once access settles, tell the rest of the app (Bud setup re-reads its model).
    const timer = window.setTimeout(() => void refresh().then(next => { if (modelAccessState(next) !== "setting-up") changed(); }).catch(() => {}), LINK_POLL_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [settingUp, status]);

  const start = async (label: string) => {
    setPhase({ kind: "starting" }); setError("");
    try {
      const view = readBrowserLinkView(await api("/api/office-link/browser-link", { method: "POST", body: JSON.stringify({ label }) }, { timeoutMs: 20_000 }));
      if (view?.state !== "pending") throw new Error(UNREADABLE);
      openApproval(view.approvalUrl);
      setPhase(phaseFor(view));
      void refresh().catch(() => {});
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : UNREADABLE;
      setPhase((cause as { code?: string })?.code === "website_unreachable" ? { kind: "unreachable", message } : { kind: "failed", message });
      // A lost answer may still have saved a request: pick it up instead of starting a second one.
      void refresh(true).catch(() => {});
    }
  };
  const cancel = async (waiting: BrowserLinkRequest) => {
    setPhase({ kind: "cancelling", request: waiting }); setError("");
    // A status check already in flight finishes first, so the two never race.
    await polling.current;
    try {
      const view = readBrowserLinkView(await api("/api/office-link/browser-link", { method: "DELETE", body: "{}" }, { timeoutMs: 20_000 }));
      setPhase(view?.state === "linked" ? phaseFor(view) : { kind: "idle" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The approval could not be cancelled. Try again.");
      setPhase({ kind: "waiting", request: waiting });
    } finally { void refresh().catch(() => {}); changed(); }
  };
  const retry = (waiting: BrowserLinkRequest) => { setError(""); setPhase({ kind: "waiting", request: waiting }); };
  /** Link with a pasted code. The service waits up to 60 s on the website to
   * redeem and then reports once, so this budget sits above both. Throws. */
  const linkCode = async (code: string, label: string) => {
    try {
      await api("/api/office-link", { method: "POST", body: JSON.stringify({ code, label }) }, { timeoutMs: 130_000 });
      setPhase({ kind: "idle" });
      await refresh();
    } finally { changed(); }
  };

  return { status, phase, error, setError, setPhase, refresh, start, cancel, retry, linkCode, changed };
}
