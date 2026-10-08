// Per-workflow Cua bounded session contract. Typed browser tools only.
import { computerLease, type ComputerLease } from "./computer-lease.ts";

export const CUA_PIN = "0.34.0";

/** Cua tools Bud never runs in any turn, fenced or not. `install_extension`
 * installs the perception extension, which bundles OmniParser (AGPL-3.0);
 * `parse_visual_regions` is that extension's only consumer. The 0.34.0
 * driver's other self-changing tools: `install_ffmpeg` installs a package
 * through the system package manager, `set_config` persists driver
 * configuration, and `check_for_update` calls out for a new driver (RealBud
 * pins the driver and turns that check off). `replay_trajectory` re-runs a
 * recorded batch of clicks inside the driver, past the per-action fence, and
 * `start_recording` writes screen captures to disk; RealBud uses neither.
 * Enforced in
 * server/drivers/acp/core.ts (every turn) and the portal fence. */
export const CUA_NEVER_TOOLS = ["install_extension", "parse_visual_regions", "install_ffmpeg", "set_config", "check_for_update", "replay_trajectory", "start_recording"] as const;

export const FORBIDDEN_TOOLS = [
  "screenshot_desktop",
  "click_xy",
  "press_key",
  "type_enter",
  "javascript",
  "shell",
  "computer_exec",
  "computer_batch",
  ...CUA_NEVER_TOOLS,
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
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return false;
    return manifest.origins.some((origin) => {
      try {
        const allowed = new URL(origin);
        return ["http:", "https:"].includes(allowed.protocol)
          && !allowed.username
          && !allowed.password
          && allowed.origin === parsed.origin;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

export function acquirePortalLease(workItemId: string, now: number, revision: number): ComputerLease {
  return computerLease.hold("portal", now, 15 * 60_000, workItemId, revision);
}

export function revokePortalLease(lease: ComputerLease): void {
  computerLease.release(lease);
}

export function pinSupported(version: string): boolean {
  return version === CUA_PIN;
}
