// Honest work-item state machine. Approval never means sent.
import type { WorkState } from "../shared/contracts.ts";

export const LEGAL_TRANSITIONS: Readonly<Record<WorkState, readonly WorkState[]>> = {
  proposed: ["approved", "denied", "held", "stale", "superseded"],
  approved: ["preparing", "waiting", "denied", "stale", "superseded"],
  denied: [],
  held: ["proposed", "stale", "superseded", "cancelled"],
  // A process restart while an external preparation is in flight cannot
  // prove whether the remote side observed the action. Recovery must record
  // that uncertainty rather than retrying or pretending nothing happened.
  preparing: ["handoff-ready", "failed", "effect-unknown"],
  "handoff-ready": ["confirmed", "effect-unknown", "handoff-expired"],
  confirmed: [],
  failed: ["proposed", "cancelled"],
  stale: [],
  superseded: [],
  cancelled: [],
  waiting: ["proposed", "confirmed", "cancelled"],
  "effect-unknown": ["confirmed", "cancelled"],
  "handoff-expired": ["proposed", "cancelled"],
};

export function canTransition(from: WorkState, to: WorkState): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: WorkState, to: WorkState): void {
  if (!canTransition(from, to)) {
    throw Object.assign(new Error(`illegal work transition ${from} → ${to}`), { status: 409 });
  }
}

export function draftStatusFor(state: WorkState): "pending" | "allowed" | "denied" | "stale" {
  if (state === "denied") return "denied";
  if (state === "stale" || state === "superseded" || state === "cancelled") return "stale";
  if (state === "proposed" || state === "held") return "pending";
  return "allowed";
}

export function workStateFromV1Draft(status: "pending" | "allowed" | "denied" | "stale"): WorkState {
  if (status === "pending") return "proposed";
  if (status === "denied") return "denied";
  if (status === "stale") return "stale";
  return "approved";
}

export function occurrenceKey(propertyId: string, kind: string, periodDueAt: number): string {
  return `${propertyId}:${kind}:${periodDueAt}`;
}

export function proposalHash(input: {
  propertyId: string;
  kind: string;
  periodDueAt: number;
  body: string;
  to: string;
  channel: string;
}): string {
  const payload = [
    input.propertyId,
    input.kind,
    String(input.periodDueAt),
    input.body,
    input.to,
    input.channel,
  ].join("\n");
  let h = 2166136261;
  for (let i = 0; i < payload.length; i++) {
    h ^= payload.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `ph-${(h >>> 0).toString(16)}`;
}
