// Per-workflow Cua bounded session contract. Typed browser tools only.
import { computerLease } from "./computer-lease.ts";

export const CUA_PIN = "0.19.3";

export const FORBIDDEN_TOOLS = [
  "list_windows",
  "get_desktop_state",
  "get_accessibility_tree",
  "get_window_state",
  "verify_state",
  "click",
  "double_click",
  "right_click",
  "drag",
  "scroll",
  "type_text",
  "press_key",
  "hotkey",
  "set_value",
  "page",
  "clipboard_read",
  "clipboard_write",
  "browser_download",
  "browser_set_input_files",
  "launch_app",
  "kill_app",
] as const;

export const ALLOWED_TOOLS = [
  "start_session",
  "end_session",
  "browser_prepare",
  "get_browser_state",
  "browser_navigate",
  "browser_click",
  "browser_type",
] as const;

export interface BoundedManifest {
  version: typeof CUA_PIN;
  mode: "bounded";
  profileKind: "isolated";
  origins: string[];
  tools: readonly string[];
  forbidden: readonly string[];
  expiresAt: number;
  idleTimeoutMs: number;
  workItemId: string;
  recipeId: string;
  recipeVersion: number;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

function normalizeOrigin(value: string): string {
  const parsed = new URL(value);
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  if (
    parsed.origin !== value ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    (parsed.protocol !== "https:" && !(loopback && parsed.protocol === "http:"))
  ) {
    throw new Error("Cua browser origin must be one exact HTTPS origin");
  }
  return parsed.origin;
}

export function buildManifest(input: {
  origins: string[];
  workItemId: string;
  recipeId: string;
  recipeVersion: number;
  now: number;
  ttlMs?: number;
}): BoundedManifest {
  const origins = input.origins.map(normalizeOrigin);
  if (!origins.length || origins.length > 8 || new Set(origins).size !== origins.length) {
    throw new Error("Cua browser origins are invalid");
  }
  if (!SAFE_ID.test(input.workItemId) || !SAFE_ID.test(input.recipeId)) {
    throw new Error("Cua work or recipe id is invalid");
  }
  if (!Number.isSafeInteger(input.recipeVersion) || input.recipeVersion < 1 || input.recipeVersion > 1_000_000) {
    throw new Error("Cua recipe version is invalid");
  }
  if (!Number.isSafeInteger(input.now) || input.now < 0) throw new Error("Cua clock is invalid");
  const ttlMs = input.ttlMs ?? 15 * 60_000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 60 * 60_000) {
    throw new Error("Cua session lifetime is invalid");
  }
  return {
    version: CUA_PIN,
    mode: "bounded",
    profileKind: "isolated",
    origins,
    tools: ALLOWED_TOOLS,
    forbidden: FORBIDDEN_TOOLS,
    expiresAt: input.now + ttlMs,
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
    return manifest.origins.includes(parsed.origin);
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
  return version === CUA_PIN;
}
