#!/usr/bin/env node
// Read-only build-host preflight. No installation, download, compiler output,
// execution-policy change or installer execution is performed here.
import { execFile } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { machine } from "node:os";
import { win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { findCsc, findSystemSpeech } from "../electron/build-speech-helper-win.mjs";
import { windowsTar } from "./package-files.mjs";

const run = promisify(execFile);
const ciNodeMajor = 24;
const psVersion = "$PSVersionTable.PSVersion.ToString()";
const psArgs = command => ["-NoProfile", "-NonInteractive", "-Command", command];
const numericVersion = value => /^(\d+)\.(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(String(value).trim());
const isFile = file => { try { return statSync(file).isFile(); } catch { return false; } };
const envValue = (env, key) => env[Object.keys(env).find(name => name.toLowerCase() === key.toLowerCase())] || "";
const absoluteWindowsPath = value => /^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$))/i.test(value);

// Resolve applications without a shell or PowerShell profile. Do not consider
// .ps1 shims: the preflight must work without changing execution policy.
export function findWindowsApplication(name, env, exists = isFile) {
  const extensions = (envValue(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD")
    .split(";").filter(extension => /^\.(?:exe|com|cmd|bat)$/i.test(extension));
  for (const rawDirectory of envValue(env, "PATH").split(";")) {
    const directory = rawDirectory.trim().replace(/^"(.*)"$/, "$1");
    if (!absoluteWindowsPath(directory)) continue;
    for (const extension of extensions) {
      const candidate = win32.join(directory, name + extension.toLowerCase());
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

// cmd cannot exec a .cmd file directly. Keep the command text fixed and pass
// the resolved filename through the environment, so spaces and shell syntax
// in an installation path never become command syntax. Disable delayed
// expansion and AutoRun; never use shell:true or interpolate the PATH value.
export function versionInvocation(executable, systemDirectory) {
  if (/\.(?:cmd|bat)$/i.test(executable)) {
    return {
      command: win32.join(systemDirectory, "cmd.exe"),
      args: ["/d", "/v:off", "/s", "/c", '""%REALBUD_PREFLIGHT_COMMAND%" --version"'],
      options: { windowsVerbatimArguments: true, env: { REALBUD_PREFLIGHT_COMMAND: executable } },
    };
  }
  return { command: executable, args: ["--version"], options: {} };
}

function receipt(checks, proof, platform, arch) {
  return {
    schemaVersion: 1,
    proofLayer: "build-host-prerequisites",
    scope: proof ? "build-and-installer-proof-tools" : "build-tools",
    platform: ["win32", "darwin", "linux", "freebsd", "openbsd", "aix", "sunos"].includes(platform) ? platform : "unknown",
    arch: ["x64", "arm64", "ia32", "arm", "ppc64", "s390x", "riscv64"].includes(arch) ? arch : "unknown",
    passed: checks.every(check => check.status !== "fail"),
    checks,
    limits: [
      "Host prerequisites only; RealBud has not been compiled or installed by this check.",
      "Dependency installation and pinned runtime downloads have not been exercised.",
      "Installed behaviour, Windows permissions, signing, live integrations and customer acceptance remain unverified.",
      proof
        ? "Installer proof still requires the existing disposable Windows CI harness and its CI/RUNNER_TEMP guards."
        : "Use --proof to also check PowerShell 7 and Python 3.11+ for the installer proof harness.",
    ],
  };
}

// All host facts, filesystem lookups and subprocess calls are injectable for
// unit tests. The CLI exposes no platform override or simulated success mode.
export async function checkWindowsBuild({
  proof = false, platform = process.platform, arch = process.arch, hostMachine = machine(),
  nodeVersion = process.versions.node, env = process.env,
  manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")),
  exists = isFile, list = readdirSync, execute = run,
} = {}) {
  const checks = [];
  const add = (id, status, message, version) => checks.push({ id, status, message, ...(version ? { version } : {}) });
  const native = platform === "win32" && arch === "x64" && /^(?:x86_64|amd64|x64)$/i.test(hostMachine);
  add("host", native ? "pass" : "fail", native
    ? "Native Windows x64 build host."
    : "Run this check on native Windows x64 with x64 Node.js. macOS, Linux, Windows ARM and emulated targets do not prove a Windows build.");

  const engine = /^>=(\d+)$/.exec(manifest?.engines?.node ?? "");
  const pinned = /^pnpm@(\d+\.\d+\.\d+)(?:\+sha\d+\.[a-f0-9]+)?$/.exec(manifest?.packageManager ?? "");
  if (!engine || !pinned) {
    add("toolchain-policy", "fail", "package.json must declare a minimum Node major and an exact pnpm version; review the preflight when changing this policy.");
    return receipt(checks, proof, platform, arch);
  }
  const node = /^(\d+)\.\d+\.\d+$/.exec(nodeVersion);
  if (!node || Number(node[1]) < Number(engine[1])) {
    add("node", "fail", `Install stable x64 Node.js ${engine[1]} or newer; Node ${ciNodeMajor} matches Windows CI.`);
  } else {
    add("node", Number(node[1]) === ciNodeMajor ? "pass" : "warn", Number(node[1]) === ciNodeMajor
      ? "Node.js matches the Windows CI major."
      : `Node.js meets package.json engines; use Node ${ciNodeMajor} to match Windows CI.`, nodeVersion);
  }
  if (!native) return receipt(checks, proof, platform, arch);

  const systemDirectory = win32.dirname(windowsTar(env));
  // Version checks run outside the repository so a pnpm/corepack shim cannot
  // select or auto-install a project's package manager. Network is explicitly
  // disabled for Corepack, and pnpm manager auto-selection is disabled too.
  const commandEnv = {
    ...env, COREPACK_ENABLE_NETWORK: "0", COREPACK_ENABLE_AUTO_PIN: "0",
    COREPACK_ENABLE_PROJECT_SPEC: "0", npm_config_manage_package_manager_versions: "false",
  };
  const probe = async (command, args, options = {}) => {
    try {
      const result = await execute(command, args, {
        timeout: 30_000, maxBuffer: 128 * 1024, windowsHide: true,
        cwd: systemDirectory, ...options, env: { ...commandEnv, ...options.env },
      });
      return String(result.stdout ?? "").trim();
    } catch {
      // Errors and subprocess streams can contain usernames, paths or secrets.
      // Receipts only contain fixed messages and validated version numbers.
      return null;
    }
  };
  const applicationVersion = async name => {
    const executable = findWindowsApplication(name, env, exists);
    if (!executable) return null;
    const invocation = versionInvocation(executable, systemDirectory);
    return probe(invocation.command, invocation.args, invocation.options);
  };

  const pnpm = await applicationVersion("pnpm");
  add("pnpm", pnpm === pinned[1] ? "pass" : "fail", pnpm === pinned[1]
    ? "pnpm matches the exact package.json pin."
    : `Install or activate pnpm ${pinned[1]} on PATH, then reopen PowerShell and retry. This check never downloads a missing package manager.`,
  /^\d+\.\d+\.\d+$/.test(pnpm ?? "") ? pnpm : undefined);

  const git = /^git version (\d+\.\d+\.\d+)(?:\.windows\.\d+)?$/.exec(await applicationVersion("git") ?? "");
  add("git", git ? "pass" : "fail", git ? "Git is available." : "Install Git for Windows with command-line tools on PATH, then reopen PowerShell.", git?.[1]);

  const powershell = win32.join(systemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe");
  const ps = exists(powershell) ? numericVersion(await probe(powershell, psArgs(psVersion))) : null;
  const psReady = ps && Number(ps[1]) === 5 && Number(ps[2]) >= 1;
  add("windows-powershell", psReady ? "pass" : "fail", psReady
    ? "System Windows PowerShell 5.1 is runnable."
    : "Repair or enable system Windows PowerShell 5.1. PowerShell 7 alone does not supply the system runtime used by RealBud.", ps?.[0]);

  const tarPath = windowsTar(env);
  const tar = exists(tarPath) ? /^bsdtar (\d+(?:\.\d+){1,3})\b/.exec(await probe(tarPath, ["--version"]) ?? "") : null;
  add("windows-tar", tar ? "pass" : "fail", tar ? "System Windows tar is runnable." : "Repair the Windows system tar.exe used to extract the pinned Windows runtimes.", tar?.[1]);

  const locatorOptions = { exists, list, paths: win32 };
  const csc = findCsc(env, locatorOptions);
  const compilerHelp = csc ? await probe(csc, ["/help"]) : null;
  const compilerReady = Boolean(compilerHelp);
  add("framework-csc", compilerReady ? "pass" : "fail", compilerReady
    ? ".NET Framework C# compiler is runnable; compilation remains a separate build step."
    : "Install the .NET Framework 4.8 developer pack/targeting pack, then retry; the modern dotnet SDK alone does not provide the Framework compiler used by build:speech:win.");

  const speech = findSystemSpeech(env, locatorOptions);
  const speechName = speech && psReady
    ? await probe(powershell, psArgs("[System.Reflection.AssemblyName]::GetAssemblyName($env:REALBUD_PREFLIGHT_SPEECH).Name"), { env: { REALBUD_PREFLIGHT_SPEECH: speech } })
    : null;
  add("system-speech", !speech ? "fail" : !psReady ? "skip" : speechName === "System.Speech" ? "pass" : "fail", !speech
    ? "Install the .NET Framework 4.8 developer pack/targeting pack with System.Speech.dll; the speech helper must compile before packaging."
    : !psReady ? "System.Speech assembly inspection requires working system Windows PowerShell."
      : speechName === "System.Speech" ? "System.Speech.dll is readable as a .NET assembly."
        : "Repair the .NET Framework targeting pack or GAC: the located System.Speech.dll could not be inspected.");

  if (proof) {
    const pwshPath = findWindowsApplication("pwsh", env, exists);
    // The installer harness is a PowerShell 7 script ($IsWindows). A system
    // PowerShell 5.1 pass above is not enough to execute that harness.
    const pwsh = pwshPath && /\.(?:exe|com)$/i.test(pwshPath)
      ? numericVersion(await probe(pwshPath, psArgs(psVersion))) : null;
    add("proof-powershell", pwsh && Number(pwsh[1]) >= 7 ? "pass" : "fail", pwsh && Number(pwsh[1]) >= 7
      ? "PowerShell 7 is available for the disposable installer proof harness."
      : "Install PowerShell 7 (pwsh.exe) on PATH to run the installer proof harness.", pwsh?.[0]);
    const python = /^Python (\d+)\.(\d+)\.(\d+)$/.exec(await applicationVersion("python") ?? "");
    const pythonReady = python && Number(python[1]) === 3 && Number(python[2]) >= 11;
    add("proof-python", pythonReady ? "pass" : "fail", pythonReady
      ? "Python 3.11+ is available for the installed memory primitive probe."
      : "Install Python 3.11+ as python.exe on PATH for installer proof; a py launcher or Microsoft Store alias alone is insufficient.", python ? python.slice(1).join(".") : undefined);
  }
  return receipt(checks, proof, platform, arch);
}

export function formatWindowsBuildReceipt(result) {
  return [
    `Windows build prerequisites: ${result.passed ? "PASS" : "BLOCKED"}`,
    ...result.checks.map(check => `[${check.status.toUpperCase()}] ${check.id}: ${check.message}${check.version ? ` (${check.version})` : ""}`),
    ...result.limits.map(limit => `Limit: ${limit}`),
  ].join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  if (args.some(arg => !["--json", "--proof", "--help"].includes(arg))) {
    const result = receipt([{ id: "arguments", status: "fail", message: "Use node scripts/check-windows-build.mjs [--proof] [--json]." }], false, process.platform, process.arch);
    console.log(json ? JSON.stringify(result, null, 2) : formatWindowsBuildReceipt(result));
    process.exitCode = 2;
    return;
  }
  if (args.includes("--help")) {
    console.log("Usage: node scripts/check-windows-build.mjs [--proof] [--json]\nRead-only Windows x64 tool check. --proof also checks PowerShell 7 and Python 3.11+.");
    return;
  }
  let result;
  try {
    result = await checkWindowsBuild({ proof: args.includes("--proof") });
  } catch {
    result = receipt([{ id: "preflight", status: "fail", message: "Unable to inspect local build prerequisites. Check that package.json is readable and rerun from an intact checkout." }], args.includes("--proof"), process.platform, process.arch);
  }
  console.log(json ? JSON.stringify(result, null, 2) : formatWindowsBuildReceipt(result));
  process.exitCode = result.passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
