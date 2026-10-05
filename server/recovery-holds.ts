// The person's side of two safety holds (session-gated in server/index.ts):
// - a pressed pay/sign/send/notice whose result is unknown stays held against
//   repeats until a person checks the site and records "confirmed" or
//   "not-done" (BrowserApprovalStore.reconcile is the only release);
// - worker launches stay held while a group from an earlier run may be alive.
//   "Check again" re-runs the liveness check and clears nothing by itself;
//   resolveWorkerCustody (a blind clear) is deliberately not reachable here.
import { browserApprovalCardFrom } from "./browser-approval-card.ts";
import { browserApprovalHeld, browserApprovals, type BrowserApprovalStore } from "./browser-authority.ts";
import { redactSecretsInText } from "./redact.ts";
import { WORKER_CUSTODY_DAMAGED, WORKER_CUSTODY_HELD, WORKER_CUSTODY_UNSAVED, workerCustodyRefusal } from "./worker-custody.ts";
import type { BrowserApprovalCard } from "../shared/browser-approval-card.ts";

export const HELD_STEPS_PATH = "/api/browser/held";
export const HELD_STEP_RECONCILE_PATH = "/api/browser/held/reconcile";
export const WORKER_CUSTODY_PATH = "/api/worker-issues/custody";
export const WORKER_CUSTODY_CHECK_PATH = "/api/worker-issues/custody/check";

export interface HeldBrowserStep {
  id: string;
  /** Host name of the site where the step was pressed. */
  host: string;
  summary: string;
  /** The facts the approval showed; null when they can no longer be shown. */
  approval: BrowserApprovalCard | null;
  /** Epoch ms of the approval decision. */
  at: number;
}

export async function heldBrowserSteps(store: BrowserApprovalStore): Promise<HeldBrowserStep[]> {
  return (await store.list()).filter(browserApprovalHeld).sort((a, b) => b.createdAt - a.createdAt).map(row => {
    let approval: BrowserApprovalCard | null = null;
    try {
      approval = browserApprovalCardFrom({ approval: { id: row.id, kind: row.kind, facts: row.facts, expiresAt: row.expiresAt }, url: row.url, label: row.control.label }) ?? null;
    } catch { /* shown without facts; still reconcilable */ }
    let host = "the site";
    try { host = new URL(row.origin).hostname; } catch { /* keep the generic name */ }
    return { id: row.id, host, summary: redactSecretsInText(row.summary), approval, at: row.decidedAt ?? row.createdAt };
  });
}

export type WorkerCustodyState = "clear" | "held" | "unsaved" | "damaged";
/** Re-reads custody: earlier groups now confirmed gone are released by the check itself. */
export function workerCustodyState(): WorkerCustodyState {
  const refusal = workerCustodyRefusal();
  return refusal === null ? "clear" : refusal === WORKER_CUSTODY_HELD ? "held" : refusal === WORKER_CUSTODY_UNSAVED ? "unsaved" : "damaged";
}
const STILL_HELD: Record<Exclude<WorkerCustodyState, "clear">, string> = {
  held: "Bud can still see that earlier work running, so nothing was cleared. Restart this computer, then try again.",
  unsaved: WORKER_CUSTODY_UNSAVED,
  damaged: WORKER_CUSTODY_DAMAGED,
};

type Reply = { status: number; body: unknown };
const failed = (error: unknown): Reply => ({ status: (error as { status?: number }).status ?? 500, body: { error: error instanceof Error ? error.message : String(error) } });

export async function recoveryRoute(path: string, method: string, contentType: string | undefined, readBody: () => Promise<unknown>,
  approvals: () => BrowserApprovalStore = browserApprovals): Promise<Reply | null> {
  if (method !== "GET" && method !== "POST") return null;
  if (path === HELD_STEPS_PATH && method === "GET") {
    try { return { status: 200, body: { steps: await heldBrowserSteps(approvals()) } }; } catch (error) { return failed(error); }
  }
  if (path === WORKER_CUSTODY_PATH && method === "GET") return { status: 200, body: { state: workerCustodyState() } };
  if (method !== "POST" || (path !== HELD_STEP_RECONCILE_PATH && path !== WORKER_CUSTODY_CHECK_PATH)) return null;
  if (!String(contentType ?? "").toLowerCase().startsWith("application/json")) return { status: 415, body: { error: "content-type must be application/json" } };
  if (path === WORKER_CUSTODY_CHECK_PATH) {
    const state = workerCustodyState();
    return state === "clear" ? { status: 200, body: { state } } : { status: 409, body: { state, error: STILL_HELD[state] } };
  }
  let body: unknown;
  try { body = await readBody(); } catch { return { status: 400, body: { error: "This request could not be read." } }; }
  const { id, result } = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id) || (result !== "confirmed" && result !== "not-done")) {
    return { status: 400, body: { error: "Choose whether it happened for one browser step." } };
  }
  try {
    const store = approvals();
    await store.reconcile(id, result);
    return { status: 200, body: { result, steps: await heldBrowserSteps(store) } };
  } catch (error) { return failed(error); }
}
