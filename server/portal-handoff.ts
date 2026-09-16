// Bounded portal prefill. Bud may read and prefill. Submit stays with the PM.
import type { PortalCapability, PortalRecipe } from "../shared/contracts.ts";
import { acquirePortalLease, revokePortalLease } from "./cua-bounded.ts";
import { recipeAllows } from "./portal-recipe.ts";
import { computerLease } from "./computer-lease.ts";

export type PortalActor = "bud" | "human";

async function portalFetch(
  baseUrl: string,
  path: string,
  actor: PortalActor,
  init?: RequestInit,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    signal: AbortSignal.timeout(30_000),
    headers: {
      "content-type": "application/json",
      "x-realbud-actor": actor,
      ...(init?.headers ?? {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

export function portalRead(baseUrl: string, actor: PortalActor = "bud") {
  return portalFetch(baseUrl, "/ledger", actor);
}

export function portalPrefill(baseUrl: string, body: string, actor: PortalActor = "bud") {
  return portalFetch(baseUrl, "/prefill", actor, { method: "POST", body: JSON.stringify({ body }) });
}

export function portalSubmit(baseUrl: string, actor: PortalActor) {
  return portalFetch(baseUrl, "/submit", actor, { method: "POST", body: "{}" });
}

export function portalRevoke(baseUrl: string) {
  return portalFetch(baseUrl, "/revoke", "human", { method: "POST", body: "{}" });
}

export async function runBoundedPrefill(opts: {
  baseUrl: string;
  body: string;
  capability: PortalCapability;
  recipe: PortalRecipe;
  now: number;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (opts.capability.usedAt || opts.capability.invalidatedAt) {
    return { ok: false, error: "portal capability missing or invalidated" };
  }
  if (opts.capability.expiresAt <= opts.now) return { ok: false, error: "portal capability expired" };
  if (!recipeAllows(opts.recipe, "prefill-courtesy")) return { ok: false, error: "recipe forbids prefill" };
  const lease = acquirePortalLease(opts.capability.workItemId, opts.now, opts.capability.revision);
  try {
    const read = await portalRead(opts.baseUrl, "bud");
    if (read.status !== 200) return { ok: false, error: "portal read failed" };
    computerLease.assertHeld(lease, Date.now());
    const prefill = await portalPrefill(opts.baseUrl, opts.body, "bud");
    if (prefill.status !== 200) return { ok: false, error: "portal prefill failed" };
    await portalRevoke(opts.baseUrl);
    const forbidden = await portalSubmit(opts.baseUrl, "bud");
    if (forbidden.status !== 403) return { ok: false, error: "Bud submit was not refused" };
    return { ok: true };
  } finally {
    revokePortalLease(lease);
  }
}

export async function verifyPortalResult(baseUrl: string): Promise<"confirmed" | "effect-unknown"> {
  const read = await portalRead(baseUrl, "human");
  if (read.status === 200 && typeof read.body.submitted === "string" && read.body.submitted) {
    return "confirmed";
  }
  return "effect-unknown";
}
