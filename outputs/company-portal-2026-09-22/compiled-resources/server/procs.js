// Cross-platform process spawning for the agent CLIs. Three Windows
// differences are exposed to drivers through this module:
//   1. CreateProcess can't exec npm .cmd/.bat shims or node-shebang scripts
//      directly. env-path resolves those to their real .exe / `node script`
//      entry without a shell, so quoting-sensitive JSON argv stays intact.
//   2. No process-group kill (kill(-pid) is POSIX) — taskkill /T reaps the
//      whole tree, CLI + its spawned MCP proxies alike.
//   3. Console apps spawned from the GUI shell flash a console window
//      unless windowsHide is set.
import { spawn, execFile, } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter } from "node:path";
import { join } from "node:path";
import { resolveCliSpawn } from "./env-path.js";
import { stripServiceSecrets } from "./service-child-env.js";
/** Harness-only authority must never reach a CLI, installer or its tools. */
export function cliEnvironment(source = process.env) {
    const env = { ...source };
    stripServiceSecrets(env);
    delete env.REALBUD_CUA_CONTROL_TOKEN;
    delete env.REALBUD_CUA_CONTROL_URL;
    delete env.REALBUD_DESK_KEY;
    return env;
}
function posixCommandExists(command, env) {
    const paths = command.includes("/")
        ? [command]
        : String(env?.PATH ?? process.env.PATH ?? "")
            .split(delimiter)
            .filter(Boolean)
            .map((dir) => join(dir, command));
    return paths.some((path) => {
        try {
            accessSync(path, constants.X_OK);
            return true;
        }
        catch {
            return false;
        }
    });
}
export function resolveCli(cli, args = []) {
    return resolveCliSpawn(cli, args);
}
export function spawnCli(cli, args, opts) {
    const resolved = resolveCli(cli, args);
    const { privateFiles = false, ...spawnOptions } = opts;
    // Preserve the useful native ENOENT path when a CLI is missing. Wrapping a
    // missing command in `sh` would turn setup guidance into a vague exit 127.
    const usePrivateWrapper = privateFiles && process.platform !== "win32" && posixCommandExists(resolved.command, spawnOptions.env);
    const command = usePrivateWrapper ? "/bin/sh" : resolved.command;
    const spawnArgs = usePrivateWrapper
        ? ["-c", 'umask 077; exec "$@"', "realbud-private-workroom", resolved.command, ...resolved.args]
        : resolved.args;
    const child = spawn(command, spawnArgs, {
        ...spawnOptions,
        env: cliEnvironment(spawnOptions.env),
        // posix: own process group so kill(-pid) reaps child MCP servers;
        // win32: taskkill /T does the reaping instead (see killCliTree)
        ...(process.platform === "win32" ? { windowsHide: true } : { detached: true }),
    }); // callers always pipe all three
    // A write to a dying child's stdin fails asynchronously on Windows
    // (taskkill is a subprocess). An unlistened stream error kills the
    // harness. Drivers already settle the turn on `close`.
    child.stdin?.on("error", () => { });
    return child;
}
export function execCli(cli, args, opts, cb) {
    const resolved = resolveCli(cli, args);
    execFile(resolved.command, resolved.args, { ...opts, env: cliEnvironment(opts.env), windowsHide: true }, (err, stdout) => cb(err, typeof stdout === "string" ? stdout : String(stdout)));
}
/** Like execCli but keeps stderr and returns the child for timeout kills. */
export function execFileCli(cli, args, opts, cb) {
    const resolved = resolveCli(cli, args);
    return execFile(resolved.command, resolved.args, { ...opts, env: cliEnvironment(opts.env), windowsHide: true }, (err, stdout, stderr) => cb(err, typeof stdout === "string" ? stdout : String(stdout), typeof stderr === "string" ? stderr : String(stderr)));
}
/** Human wording for a failed CLI spawn.
 *
 * Node reports these as bare errno strings — "spawn grok ENOENT" — which
 * reads as a crash. On a CLI spawn the common codes mean exactly one thing
 * each, and both are setup problems the user can fix, so say which. The
 * `setup` flag lets the UI offer "Install" instead of a "Retry" that is
 * guaranteed to fail the same way. */
export function describeSpawnFailure(err, cli) {
    if (err.code === "ENOENT")
        return { message: `\`${cli}\` isn't installed, or isn't on this app's PATH`, setup: true };
    if (err.code === "EACCES" || err.code === "EPERM")
        return { message: `\`${cli}\` isn't executable — check its file permissions`, setup: true };
    return { message: `spawn failed: ${err.message}`, setup: false };
}
/** Stop a CLI and every process it spawned (MCP proxies included). */
export function killCliTree(child) {
    const pid = child.pid;
    if (!pid || child.exitCode !== null || child.signalCode !== null)
        return;
    if (process.platform === "win32") {
        execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, (err) => {
            if (!err)
                return;
            try {
                // taskkill is unavailable or the tree lookup failed. At least stop
                // the process we own instead of leaving the entire turn running.
                child.kill();
            }
            catch {
                /* already gone */
            }
        });
        return;
    }
    try {
        process.kill(-pid, "SIGTERM");
    }
    catch {
        try {
            child.kill("SIGTERM");
        }
        catch {
            /* already gone */
        }
    }
}
/** Per-turn broker channel: unix socket on POSIX, named pipe on Windows
 * (Node can't listen on a filesystem socket path there — EACCES). */
export function brokerSocketPath(dataDir, tag) {
    return process.platform === "win32"
        // Named pipes share a global namespace; DATA_DIR cannot isolate two
        // concurrent app instances the way a POSIX socket directory does.
        ? `\\\\.\\pipe\\realbud-perm-${process.pid}-${tag}`
        : join(dataDir, `perm-${tag}.sock`);
}
