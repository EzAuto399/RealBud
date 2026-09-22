import { homedir } from "node:os";
import { join } from "node:path";
/** Data is independent of the upstream executable and survives its updates. */
export function hermesHome(root, env = process.env) {
    if (root)
        return root;
    const owned = env.REALBUD_HERMES_HOME?.trim();
    if (owned)
        return owned;
    const data = env.REALBUD_DATA_DIR || env.OMB_DATA_DIR;
    if (data && env.REALBUD_USE_SHARED_HERMES !== "1")
        return join(data, "hermes");
    const home = env[process.platform === "win32" ? "USERPROFILE" : "HOME"]?.trim() || homedir();
    return env.HERMES_HOME?.trim() || join(home, ".realbud", "hermes");
}
export function runtimeCli(home, platform = process.platform) {
    return join(home, "hermes-agent", "venv", platform === "win32" ? "Scripts" : "bin", platform === "win32" ? "hermes.exe" : "hermes");
}
