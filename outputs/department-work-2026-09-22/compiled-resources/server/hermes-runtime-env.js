import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { runtimeCli } from "./hermes-paths.js";
import { selectedHermesCli } from "./hermes-runtime-selection.js";
/** Runtime dependencies live beside the installed engine, not in a staff
 * profile. Installer PATH changes never refresh a running Electron parent. */
export function windowsHermesRuntimeEnv(home, source) {
    const env = { ...source };
    const originalPath = env.PATH ?? Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
    for (const key of Object.keys(env))
        if (key.toUpperCase() === "PATH")
            delete env[key];
    const dirs = [join(home, "hermes-agent", "venv", "Scripts"), join(home, "node"), join(home, "bin"),
        join(home, "git", "cmd"), join(home, "git", "usr", "bin"), join(home, "git", "bin")].filter(existsSync);
    env.PATH = [...dirs, originalPath].filter(Boolean).join(";");
    const bash = [join(home, "git", "usr", "bin", "bash.exe"), join(home, "git", "bin", "bash.exe")].find(existsSync);
    if (bash)
        env.HERMES_GIT_BASH_PATH = bash;
    env.PYTHONIOENCODING = "utf-8";
    env.PYTHONUTF8 = "1";
    return env;
}
export function windowsHermesGit(home) {
    const owned = join(home, "git", "cmd", "git.exe");
    return existsSync(owned) ? owned : "git";
}
/** Resolve the process-cached CLI, so a staged update cannot redirect a live
 * worker's dependencies to the next release or to a personal Hermes home. */
export function selectedWindowsRuntimeHome(home) {
    const cli = selectedHermesCli(home, "win32");
    if (cli === runtimeCli(home, "win32"))
        return home;
    const candidate = dirname(dirname(dirname(dirname(cli))));
    return dirname(candidate) === join(home, "runtimes") && /^[a-f0-9]{40}(?:-[a-f0-9]{12})?$/.test(basename(candidate)) &&
        cli === runtimeCli(candidate, "win32") ? candidate : null;
}
