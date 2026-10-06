import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { augmentedPath } from "./env-path.ts";
import { execCli, killCliTree, spawnCli } from "./procs.ts";
import { runtimeCli } from "./hermes-paths.ts";
import type { HermesRelease } from "./hermes-releases.ts";
import { BootstrapError } from "./worker-bootstrap.ts";
import { windowsHermesGit, windowsHermesRuntimeEnv } from "./hermes-runtime-env.ts";
import { documentToolsStatus, type DocumentToolsStatus } from "./hermes-document-deps.ts";
import { DATA_DIR } from "./config.ts";
import { sandboxedLaunch, type SandboxedLaunch } from "./worker-network-sandbox.ts";

function command(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => execCli(command, args, { env, timeout: 30_000, maxBuffer: 64_000 }, (error, stdout) => {
    if (error) reject(new BootstrapError("The downloaded agent did not pass its integrity check. Your current agent is kept."));
    else resolve(String(stdout).trim());
  }));
}

/** The downloaded agent runs its checks as a worker would: no network,
 * writes only to the scratch folder, reads of RealBud's data only for the
 * release being checked. A refusing sandbox fails the check. */
function checkedLaunch(home: string, scratch: string, cli: string, args: string[], env: NodeJS.ProcessEnv): SandboxedLaunch {
  try { return sandboxedLaunch(cli, args, env, { loopbackPorts: [], writable: [scratch], reads: [["deny", DATA_DIR], ["allow", home]] }); }
  catch { throw new BootstrapError("The downloaded agent could not be checked in isolation. Your current agent is kept."); }
}

/** No provider call or office profile access. Verify source and ACP startup.
 * Document libraries are import-checked for `documentTools` only: their
 * absence reads "Document tools need Repair." and never fails the worker. */
export async function verifyRuntime(home: string, release: HermesRelease, options: {
  documentTools?: (status: DocumentToolsStatus) => void; checkDocuments?: typeof documentToolsStatus;
} = {}): Promise<string> {
  const scratch = mkdtempSync(join(tmpdir(), "realbud-runtime-check-"));
  let env: NodeJS.ProcessEnv = {
    PATH: augmentedPath(), HOME: scratch, HERMES_HOME: scratch, HERMES_MANAGED_DIR: scratch,
    ...(process.platform === "win32" ? { SYSTEMROOT: process.env.SYSTEMROOT, WINDIR: process.env.WINDIR, TEMP: scratch, TMP: scratch, USERPROFILE: scratch } : { TMPDIR: scratch }),
    HERMES_ACP_SKIP_CONFIGURED_MCP: "1", HERMES_SAFE_MODE: "1", PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1",
    LITELLM_LOCAL_MODEL_COST_MAP: "True", HF_HUB_OFFLINE: "1",
  };
  if (process.platform === "win32") env = windowsHermesRuntimeEnv(home, env);
  try {
    const repo = join(home, "hermes-agent");
    const git = process.platform === "win32" ? windowsHermesGit(home) : "git";
    // The checkout has files past Windows' MAX_PATH; without longpaths Git cannot
    // read them and reports them as modified (seen once on a fresh Windows 11).
    const repoGit = ["-c", "core.longpaths=true", "-C", repo];
    if (await command(git, [...repoGit, "rev-parse", "HEAD"], env) !== release.commit) throw new BootstrapError("The downloaded source does not match the reviewed release. Your current agent is kept.");
    // Upstream/environment contribution accounting can stamp email metadata
    // during an official install. It is not executable agent code.
    const changed = await command(git, [...repoGit, "diff", "--name-only", "HEAD", "--"], env);
    const modified = changed.split("\n").filter(Boolean).filter(path => !/^contributors\/emails\/[^/]+$/.test(path));
    if (modified.length) {
      // Repository-relative names only, so a one-off on a customer machine can be traced.
      console.warn(`[${new Date().toISOString()}] Bud runtime check: ${modified.length} modified source file(s): ${modified.slice(0, 5).join(", ").slice(0, 300)}`);
      throw new BootstrapError("The downloaded agent contains modified source files. Your current agent is kept.");
    }
    const versionLaunch = checkedLaunch(home, scratch, runtimeCli(home), ["--version"], env);
    const version = await command(versionLaunch.command, versionLaunch.args, env).finally(() => versionLaunch.release());
    const acpLaunch = checkedLaunch(home, scratch, runtimeCli(home), ["--toolsets", "realbud_runtime_check", "acp"], env);
    await new Promise<void>((resolve, reject) => {
      const child = spawnCli(acpLaunch.command, acpLaunch.args, { env, cwd: scratch, stdio: ["pipe", "pipe", "pipe"] });
      let buffer = ""; let passed = false; let failed = false;
      let forceStop: ReturnType<typeof setTimeout> | undefined;
      const stop = () => {
        killCliTree(child);
        if (!forceStop && process.platform !== "win32") forceStop = setTimeout(() => {
          if (!child.pid) return;
          try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
        }, 2000);
      };
      const timer = setTimeout(() => { failed = true; stop(); }, 30_000);
      child.stderr?.resume();
      child.stdin?.on("error", () => { failed = true; stop(); });
      child.stdout?.on("data", chunk => {
        buffer += String(chunk);
        if (buffer.length > 64_000) { failed = true; stop(); return; }
        let index: number;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          try {
            const response = JSON.parse(line);
            if (response.id === 1) { passed = response.result?.protocolVersion === 1; failed = !passed; stop(); }
          } catch { failed = true; stop(); }
        }
      });
      child.once("error", () => { clearTimeout(timer); if (forceStop) clearTimeout(forceStop); acpLaunch.release(); reject(new BootstrapError("The downloaded agent could not start. Your current agent is kept.")); });
      child.once("close", () => {
        clearTimeout(timer);
        if (forceStop) clearTimeout(forceStop);
        acpLaunch.release();
        if (passed && !failed) resolve();
        else reject(new BootstrapError("The downloaded agent did not pass the connection check. Your current agent is kept."));
      });
      child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "realbud-runtime-check", version: "1" } } }) + "\n");
    });
    if (options.documentTools) options.documentTools(await (options.checkDocuments ?? documentToolsStatus)(home));
    return version;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
