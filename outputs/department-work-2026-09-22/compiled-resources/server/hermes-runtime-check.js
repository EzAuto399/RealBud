import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { augmentedPath } from "./env-path.js";
import { execCli, killCliTree, spawnCli } from "./procs.js";
import { runtimeCli } from "./hermes-paths.js";
import { BootstrapError } from "./worker-bootstrap.js";
import { windowsHermesGit, windowsHermesRuntimeEnv } from "./hermes-runtime-env.js";
function command(command, args, env) {
    return new Promise((resolve, reject) => execCli(command, args, { env, timeout: 30_000, maxBuffer: 64_000 }, (error, stdout) => {
        if (error)
            reject(new BootstrapError("The downloaded agent did not pass its integrity check. Your current agent is kept."));
        else
            resolve(String(stdout).trim());
    }));
}
/** No provider call or office profile access. Verify source and ACP startup. */
export async function verifyRuntime(home, release) {
    const scratch = mkdtempSync(join(tmpdir(), "realbud-runtime-check-"));
    let env = {
        PATH: augmentedPath(), HOME: scratch, HERMES_HOME: scratch, HERMES_MANAGED_DIR: scratch,
        ...(process.platform === "win32" ? { SYSTEMROOT: process.env.SYSTEMROOT, WINDIR: process.env.WINDIR, TEMP: scratch, TMP: scratch, USERPROFILE: scratch } : { TMPDIR: scratch }),
        HERMES_ACP_SKIP_CONFIGURED_MCP: "1", HERMES_SAFE_MODE: "1", PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1",
        LITELLM_LOCAL_MODEL_COST_MAP: "True", HF_HUB_OFFLINE: "1",
    };
    if (process.platform === "win32")
        env = windowsHermesRuntimeEnv(home, env);
    try {
        const repo = join(home, "hermes-agent");
        const git = process.platform === "win32" ? windowsHermesGit(home) : "git";
        if (await command(git, ["-C", repo, "rev-parse", "HEAD"], env) !== release.commit)
            throw new BootstrapError("The downloaded source does not match the reviewed release. Your current agent is kept.");
        // Upstream/environment contribution accounting can stamp email metadata
        // during an official install. It is not executable agent code.
        const changed = await command(git, ["-C", repo, "diff", "--name-only", "HEAD", "--"], env);
        if (changed.split("\n").filter(Boolean).some(path => !/^contributors\/emails\/[^/]+$/.test(path))) {
            throw new BootstrapError("The downloaded agent contains modified source files. Your current agent is kept.");
        }
        const version = await command(runtimeCli(home), ["--version"], env);
        await new Promise((resolve, reject) => {
            const child = spawnCli(runtimeCli(home), ["--toolsets", "realbud_runtime_check", "acp"], { env, cwd: scratch, stdio: ["pipe", "pipe", "pipe"] });
            let buffer = "";
            let passed = false;
            let failed = false;
            let forceStop;
            const stop = () => {
                killCliTree(child);
                if (!forceStop && process.platform !== "win32")
                    forceStop = setTimeout(() => {
                        if (!child.pid)
                            return;
                        try {
                            process.kill(-child.pid, "SIGKILL");
                        }
                        catch {
                            try {
                                child.kill("SIGKILL");
                            }
                            catch { }
                        }
                    }, 2000);
            };
            const timer = setTimeout(() => { failed = true; stop(); }, 30_000);
            child.stderr?.resume();
            child.stdin?.on("error", () => { failed = true; stop(); });
            child.stdout?.on("data", chunk => {
                buffer += String(chunk);
                if (buffer.length > 64_000) {
                    failed = true;
                    stop();
                    return;
                }
                let index;
                while ((index = buffer.indexOf("\n")) >= 0) {
                    const line = buffer.slice(0, index);
                    buffer = buffer.slice(index + 1);
                    try {
                        const response = JSON.parse(line);
                        if (response.id === 1) {
                            passed = response.result?.protocolVersion === 1;
                            failed = !passed;
                            stop();
                        }
                    }
                    catch {
                        failed = true;
                        stop();
                    }
                }
            });
            child.once("error", () => { clearTimeout(timer); if (forceStop)
                clearTimeout(forceStop); reject(new BootstrapError("The downloaded agent could not start. Your current agent is kept.")); });
            child.once("close", () => {
                clearTimeout(timer);
                if (forceStop)
                    clearTimeout(forceStop);
                if (passed && !failed)
                    resolve();
                else
                    reject(new BootstrapError("The downloaded agent did not pass the connection check. Your current agent is kept."));
            });
            child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "realbud-runtime-check", version: "1" } } }) + "\n");
        });
        return version;
    }
    finally {
        rmSync(scratch, { recursive: true, force: true });
    }
}
