// Per-workflow Cua bounded session contract. Typed browser tools only.
import { computerLease } from "./computer-lease.js";
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
];
export const ALLOWED_TOOLS = ["navigate", "read", "fill", "click_semantic"];
export function buildManifest(input) {
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
export function toolAllowed(_manifest, tool) {
    if (FORBIDDEN_TOOLS.includes(tool))
        return false;
    return ALLOWED_TOOLS.includes(tool);
}
export function originAllowed(manifest, url) {
    try {
        const parsed = new URL(url);
        if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
            return false;
        return manifest.origins.some((origin) => {
            try {
                const allowed = new URL(origin);
                return ["http:", "https:"].includes(allowed.protocol)
                    && !allowed.username
                    && !allowed.password
                    && allowed.origin === parsed.origin;
            }
            catch {
                return false;
            }
        });
    }
    catch {
        return false;
    }
}
export function acquirePortalLease(workItemId, now, revision) {
    return computerLease.hold("portal", now, 15 * 60_000, workItemId, revision);
}
export function revokePortalLease(lease) {
    computerLease.release(lease);
}
export function pinSupported(version) {
    return version === CUA_PIN;
}
