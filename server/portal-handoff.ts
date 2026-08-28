// Bounded portal prefill. Bud may read and prefill. Submit stays with the PM.
import type { PortalCapability, PortalRecipe } from "../shared/contracts.ts";
import { acquirePortalLease, revokePortalLease } from "./cua-bounded.ts";
import { originAllowed } from "./handoff-auth.ts";
import { recipeAllows } from "./portal-recipe.ts";

export type PortalActor = "bud" | "human";
const PORTAL_STEP_TIMEOUT_MS = 10_000;

async function portalFetch(
  baseUrl: string,
  path: string,
  actor: PortalActor,
  init?: RequestInit,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    redirect: "manual",
    signal: init?.signal ?? AbortSignal.timeout(PORTAL_STEP_TIMEOUT_MS),
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
  /** The durable work owner marks its possible-effect boundary here, after
   * the read-only preflight and immediately before the first mutating call. */
  beforePrefill?: () => void | Promise<void>;
}): Promise<{ ok: true } | { ok: false; error: string; effect: "none" | "unknown" }> {
  if (opts.capability.usedAt || opts.capability.invalidatedAt) {
    return { ok: false, error: "portal capability missing or invalidated", effect: "none" };
  }
  if (opts.capability.expiresAt <= opts.now) return { ok: false, error: "portal capability expired", effect: "none" };
  if (
    opts.capability.operation !== "prefill-courtesy" ||
    opts.capability.recipeId !== opts.recipe.id ||
    opts.capability.recipeVersion !== opts.recipe.version
  ) {
    return { ok: false, error: "portal capability does not match the published recipe", effect: "none" };
  }
  if (!opts.body.trim() || opts.body.length > 4_000) {
    return { ok: false, error: "approved portal wording is invalid", effect: "none" };
  }
  let parsedBase: URL;
  try {
    parsedBase = new URL(opts.baseUrl);
  } catch {
    return { ok: false, error: "portal origin is not authorized", effect: "none" };
  }
  if (
    parsedBase.username ||
    parsedBase.password ||
    (parsedBase.pathname !== "/" && parsedBase.pathname !== "") ||
    parsedBase.search ||
    parsedBase.hash ||
    !originAllowed(opts.baseUrl, [opts.recipe.origin])
  ) {
    return { ok: false, error: "portal origin is not authorized", effect: "none" };
  }
  if (!recipeAllows(opts.recipe, "prefill-courtesy")) return { ok: false, error: "recipe forbids prefill", effect: "none" };
  let leaseAcquired = false;
  let prefillAttempted = false;
  try {
    acquirePortalLease(opts.capability.workItemId, opts.now);
    leaseAcquired = true;
    const read = await portalRead(opts.baseUrl, "bud");
    if (read.status !== 200) return { ok: false, error: "portal read failed", effect: "none" };
    await opts.beforePrefill?.();
    prefillAttempted = true;
    const prefill = await portalPrefill(opts.baseUrl, opts.body, "bud");
    if (prefill.status !== 200) return { ok: false, error: "portal prefill failed", effect: "unknown" };
    const revoked = await portalRevoke(opts.baseUrl);
    if (revoked.status !== 200) {
      return { ok: false, error: "portal handoff revoke failed", effect: "unknown" };
    }
    return { ok: true };
  } catch {
    return {
      ok: false,
      error: "portal request failed",
      effect: prefillAttempted ? "unknown" : "none",
    };
  } finally {
    if (leaseAcquired) revokePortalLease();
  }
}

export async function verifyPortalResult(baseUrl: string): Promise<"confirmed" | "effect-unknown"> {
  const read = await portalRead(baseUrl, "human");
  if (read.status === 200 && typeof read.body.submitted === "string" && read.body.submitted) {
    return "confirmed";
  }
  return "effect-unknown";
}
