// Per-workflow Cua bounded session contract. Typed browser tools only.
import { computerLease } from "./computer-lease.ts";

export const CUA_PIN = "0.19.3";

export const FORBIDDEN_TOOLS = [
  "screenshot_desktop",
  "click_xy",
  "press_key",
  "type_enter",
  "javascript",
  "shell",
  "computer_exec",
  "computer_batch",
] as const;

export const ALLOWED_TOOLS = ["navigate", "read", "fill", "click_semantic"] as const;

export interface BoundedManifest {
  version: typeof CUA_PIN;
  mode: "bounded";
  profile: string;
  origins: string[];
  tools: readonly string[];
  forbidden: readonly string[];
  expiresAt: number;
  idleTimeoutMs: number;
  workItemId: string;
  recipeId: string;
  recipeVersion: number;
}

export function buildManifest(input: {
  profile: string;
  origins: string[];
  workItemId: string;
  recipeId: string;
  recipeVersion: number;
  now: number;
  ttlMs?: number;
}): BoundedManifest {
  return {
    version: CUA_PIN,
    mode: "bounded",
    profile: input.profile,
    origins: input.origins,
    tools: ALLOWED_TOOLS,
    forbidden: FORBIDDEN_TOOLS,
    expiresAt: input.now + (input.ttlMs ?? 15 * 60_000),
    idleTimeoutMs: 120_000,
    workItemId: input.workItemId,
    recipeId: input.recipeId,
    recipeVersion: input.recipeVersion,
  };
}

export function toolAllowed(_manifest: BoundedManifest, tool: string): boolean {
  if ((FORBIDDEN_TOOLS as readonly string[]).includes(tool)) return false;
  return (ALLOWED_TOOLS as readonly string[]).includes(tool);
}

export function originAllowed(manifest: BoundedManifest, url: string): boolean {
  try {
    const parsed = new URL(url);
    return manifest.origins.some((origin) => url.startsWith(origin) || parsed.origin === origin);
  } catch {
    return false;
  }
}

export function acquirePortalLease(workItemId: string, now: number): void {
  computerLease.hold("portal", now, 15 * 60_000, workItemId);
}

export function revokePortalLease(): void {
  computerLease.release("portal");
}

export function pinSupported(version: string): boolean {
  return version === CUA_PIN || version.startsWith(`${CUA_PIN}`);
}
