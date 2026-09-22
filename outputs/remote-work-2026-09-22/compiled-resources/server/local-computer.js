import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
let testOverride;
/** In-process test hook. `undefined` restores the normal file lookup. */
export function __setCuaConnectionForTests(value) {
    testOverride = value;
}
function decodeDescriptor(value) {
    if (!value || value.mode === "unavailable" || typeof value.mcpCommand !== "string")
        return null;
    if (value.mcpArgs !== undefined && !Array.isArray(value.mcpArgs))
        return null;
    if (value.mcpEnv !== undefined &&
        (!value.mcpEnv || typeof value.mcpEnv !== "object" || Array.isArray(value.mcpEnv))) {
        return null;
    }
    const args = value.mcpArgs ?? ["mcp"];
    if (!args.every((arg) => typeof arg === "string"))
        return null;
    const env = value.mcpEnv ?? {};
    if (!Object.values(env).every((entry) => typeof entry === "string"))
        return null;
    return {
        command: value.mcpCommand,
        args,
        env: env,
    };
}
export function readCuaConnection({ platform = process.platform, userData = process.env.OMB_USER_DATA, home = homedir(), } = {}) {
    if (testOverride !== undefined)
        return testOverride;
    const overridePath = process.env.REALBUD_CUA_DESCRIPTOR_PATH?.trim();
    if (overridePath && (platform !== "linux" || process.env.REALBUD_CUA_TEST_READY === "1")) {
        try {
            const decoded = decodeDescriptor(JSON.parse(readFileSync(overridePath, "utf8")));
            if (decoded)
                return decoded;
        }
        catch {
            // Missing or invalid override — fall through to the usual lookup.
        }
    }
    // Linux local automation is deliberately outside the Ubuntu baseline.
    // Ignore even a forged or stale descriptor until the CUA follow-up adds
    // session-aware readiness and end-to-end evidence.
    if (platform === "linux")
        return null;
    const candidates = userData ? [join(userData, "cua-connection.json")] : [];
    if (platform === "darwin" && !userData) {
        // Legacy/dev fallback. Packaged Electron passes its exact userData path.
        for (const dir of ["RealBud", "realbud", "OpenMausBot", "openmausbot", "OpenGrokBot", "opengrokbot"]) {
            candidates.push(join(home, "Library", "Application Support", dir, "cua-connection.json"));
        }
    }
    for (const file of [...new Set(candidates)]) {
        try {
            const decoded = decodeDescriptor(JSON.parse(readFileSync(file, "utf8")));
            if (decoded)
                return decoded;
        }
        catch {
            // Missing, invalid, or stale descriptors are simply unavailable.
        }
    }
    return null;
}
/** Attended portal runs require a supported host and a desktop helper. */
export function cuaAttendedReady() {
    if (testOverride !== undefined)
        return testOverride !== null;
    if (!["darwin", "win32"].includes(process.platform) && process.env.REALBUD_CUA_TEST_READY !== "1")
        return false;
    return readCuaConnection() !== null;
}
