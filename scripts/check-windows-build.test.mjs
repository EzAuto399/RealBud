import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { findCsc, findSystemSpeech } from "../electron/build-speech-helper-win.mjs";
import {
  checkWindowsBuild, findWindowsApplication, formatWindowsBuildReceipt, versionInvocation,
} from "./check-windows-build.mjs";

const manifest = { engines: { node: ">=24" }, packageManager: "pnpm@10.33.0" };
const root = "C:\\Windows Space";
const toolDirectory = "C:\\Users\\Fictional Builder\\Tools & More %value%!\\bin";
const framework = win32.join(root, "Microsoft.NET", "Framework64", "v4.0.30319");
const speech = win32.join("C:\\Program Files (x86)", "Reference Assemblies", "Microsoft", "Framework", ".NETFramework", "v4.8", "System.Speech.dll");
const paths = {
  pnpm: win32.join(toolDirectory, "pnpm.cmd"),
  git: win32.join(toolDirectory, "git.exe"),
  powershell: win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  tar: win32.join(root, "System32", "tar.exe"),
  csc: win32.join(framework, "csc.exe"),
  speech,
  pwsh: win32.join(toolDirectory, "pwsh.exe"),
  python: win32.join(toolDirectory, "python.exe"),
};

function fixture({ missing = [], output = {}, reject = [] } = {}) {
  const files = new Set(Object.entries(paths).filter(([key]) => !missing.includes(key)).map(([, value]) => value.toLowerCase()));
  const calls = [];
  const stdout = {
    pnpm: "10.33.0\r\n", git: "git version 2.51.0.windows.1\r\n",
    powershell: "5.1.26100.6725\r\n", tar: "bsdtar 3.8.1 - libarchive 3.8.1\r\n",
    csc: "Microsoft (R) Visual C# Compiler version 4.8\r\nCompiler Options\r\n",
    speech: "System.Speech\r\n", pwsh: "7.5.3\r\n", python: "Python 3.13.7\r\n",
    ...output,
  };
  const options = {
    platform: "win32", arch: "x64", hostMachine: "x86_64", nodeVersion: "24.9.0", manifest,
    env: { SystemRoot: root, WINDIR: root, "ProgramFiles(x86)": "C:\\Program Files (x86)", Path: `"${toolDirectory}"`, PATHEXT: ".COM;.EXE;.BAT;.CMD", SECRET: "PRIVATE_TOKEN" },
    exists: file => files.has(file.toLowerCase()),
    list: () => [],
    execute: async (command, args, opts) => {
      calls.push({ command, args, options: opts });
      const target = opts.env.REALBUD_PREFLIGHT_COMMAND || command;
      let key = Object.keys(paths).find(candidate => paths[candidate].toLowerCase() === target.toLowerCase());
      if (key === "powershell" && args.at(-1).includes("AssemblyName")) key = "speech";
      assert.ok(key, "Tests must never launch an unrecognised command");
      if (reject.includes(key)) throw new Error("PRIVATE_TOKEN C:\\Users\\Fictional Builder\\secret.txt");
      return { stdout: stdout[key], stderr: "" };
    },
  };
  return { options, calls, files };
}

const byId = (result, id) => result.checks.find(check => check.id === id);

test("complete injected build host passes only the prerequisite layer", async () => {
  const f = fixture();
  const result = await checkWindowsBuild(f.options);
  assert.equal(result.passed, true);
  assert.equal(result.proofLayer, "build-host-prerequisites");
  assert.equal(result.scope, "build-tools");
  assert.equal(result.checks.length, 8);
  assert.ok(result.limits.some(limit => limit.includes("has not been compiled")));
  assert.ok(result.checks.every(check => check.status === "pass"));
  assert.ok(!f.calls.some(call => call.command === paths.python || call.command === paths.pwsh));
});

test("all non-native targets fail before any Windows filesystem or subprocess probe", async () => {
  for (const host of [
    { platform: "darwin", arch: "arm64", hostMachine: "arm64" },
    { platform: "linux", arch: "x64", hostMachine: "x86_64" },
    { platform: "win32", arch: "arm64", hostMachine: "arm64" },
    { platform: "win32", arch: "x64", hostMachine: "ARM64" },
    { platform: "win32", arch: "ia32", hostMachine: "x86_64" },
  ]) {
    const result = await checkWindowsBuild({ ...fixture().options, ...host,
      exists: () => assert.fail("Unsupported host must not inspect Windows tools"),
      execute: () => assert.fail("Unsupported host must not run Windows tools"),
    });
    assert.equal(result.passed, false);
    assert.equal(byId(result, "host").status, "fail");
    assert.match(byId(result, "host").message, /native Windows x64/);
  }
});

test("old and prerelease Node versions block; newer stable versions warn about CI alignment", async () => {
  for (const nodeVersion of ["22.19.0", "24.0.0-rc.1", "PRIVATE_TOKEN"]) {
    const result = await checkWindowsBuild({ ...fixture().options, nodeVersion });
    assert.equal(result.passed, false);
    assert.equal(byId(result, "node").status, "fail");
    assert.ok(!JSON.stringify(result).includes("PRIVATE_TOKEN"));
  }
  const result = await checkWindowsBuild({ ...fixture().options, nodeVersion: "26.1.0" });
  assert.equal(result.passed, true);
  assert.equal(byId(result, "node").status, "warn");
  assert.match(byId(result, "node").message, /Node 24/);
});

test("package.json remains the minimum Node and exact pnpm authority", async () => {
  const f = fixture({ output: { pnpm: "10.34.0" } });
  const result = await checkWindowsBuild({ ...f.options, manifest: { engines: { node: ">=26" }, packageManager: "pnpm@10.34.0" } });
  assert.equal(byId(result, "node").status, "fail");
  assert.equal(byId(result, "pnpm").status, "pass");
  for (const badManifest of [
    { engines: { node: ">=24" }, packageManager: "pnpm@latest" },
    { engines: { node: "garbage" }, packageManager: "pnpm@10.33.0" },
  ]) {
    const result = await checkWindowsBuild({ ...fixture().options, manifest: badManifest });
    assert.equal(byId(result, "toolchain-policy").status, "fail");
  }
});

test("each missing required build tool blocks", async () => {
  for (const [tool, id] of [
    ["pnpm", "pnpm"], ["git", "git"], ["powershell", "windows-powershell"],
    ["tar", "windows-tar"], ["csc", "framework-csc"], ["speech", "system-speech"],
  ]) {
    const result = await checkWindowsBuild(fixture({ missing: [tool] }).options);
    assert.equal(result.passed, false, tool);
    assert.equal(byId(result, id).status, "fail", tool);
  }
});

test("wrong pnpm, broken executables, invalid versions and unreadable assembly do not pass", async () => {
  for (const [output, id] of [
    [{ pnpm: "10.32.0" }, "pnpm"],
    [{ pnpm: "Downloading pnpm 10.33.0..." }, "pnpm"],
    [{ git: "PRIVATE_TOKEN C:\\Users\\Fictional Builder\\git.exe" }, "git"],
    [{ powershell: "4.0" }, "windows-powershell"],
    [{ tar: "not a tar version" }, "windows-tar"],
    [{ csc: "" }, "framework-csc"],
    [{ speech: "Other.Assembly" }, "system-speech"],
  ]) {
    const result = await checkWindowsBuild(fixture({ output }).options);
    assert.equal(result.passed, false);
    assert.equal(byId(result, id).status, "fail");
    assert.ok(!JSON.stringify(result).includes("PRIVATE_TOKEN"));
  }
  const result = await checkWindowsBuild(fixture({ reject: ["pnpm", "csc", "speech"] }).options);
  assert.equal(result.passed, false);
  assert.ok(!JSON.stringify(result).includes("PRIVATE_TOKEN"));
});

test("pnpm .cmd path is environment-passed with no interpolation or auto-download", async () => {
  const f = fixture();
  await checkWindowsBuild(f.options);
  const call = f.calls.find(call => call.options.env.REALBUD_PREFLIGHT_COMMAND);
  assert.equal(call.command, win32.join(root, "System32", "cmd.exe"));
  assert.deepEqual(call.args, ["/d", "/v:off", "/s", "/c", '""%REALBUD_PREFLIGHT_COMMAND%" --version"']);
  assert.equal(call.options.env.REALBUD_PREFLIGHT_COMMAND, paths.pnpm);
  assert.equal(call.options.env.COREPACK_ENABLE_NETWORK, "0");
  assert.equal(call.options.env.COREPACK_ENABLE_AUTO_PIN, "0");
  assert.equal(call.options.env.COREPACK_ENABLE_PROJECT_SPEC, "0");
  assert.equal(call.options.env.npm_config_manage_package_manager_versions, "false");
  assert.equal(call.options.cwd, win32.join(root, "System32"));
  assert.equal(call.options.windowsVerbatimArguments, true);
  assert.equal(call.options.shell, undefined);
  assert.ok(f.calls.every(call => call.options.timeout > 0 && call.options.maxBuffer > 0));
  const invocation = versionInvocation("C:\\Program Files\\pnpm\\pnpm.exe", win32.join(root, "System32"));
  assert.equal(invocation.command, "C:\\Program Files\\pnpm\\pnpm.exe");
  assert.deepEqual(invocation.args, ["--version"]);
});

test("PATH resolution handles quoted directories and spaces, and rejects relative and PowerShell shims", () => {
  const f = fixture();
  assert.equal(findWindowsApplication("pnpm", f.options.env, f.options.exists), paths.pnpm);
  assert.equal(findWindowsApplication("pnpm", { Path: ".;relative;/root", PATHEXT: ".CMD" }, () => assert.fail("Relative paths must not be probed")), null);
  assert.equal(findWindowsApplication("pnpm", { Path: toolDirectory, PATHEXT: ".PS1" }, () => assert.fail("PowerShell shims must not be probed")), null);
  assert.equal(findWindowsApplication("pnpm", { Path: "\\\\server\\share", PATHEXT: ".CMD" }, () => true), "\\\\server\\share\\pnpm.cmd");
});

test("native cmd can run a version shim from a path with spaces and metacharacters", { skip: process.platform !== "win32" }, () => {
  const scratch = mkdtempSync(join(tmpdir(), "realbud-preflight "));
  try {
    const directory = join(scratch, "space & %PATH%!");
    mkdirSync(directory);
    const executable = join(directory, "pnpm.cmd");
    writeFileSync(executable, "@echo off\r\necho 10.33.0\r\n");
    const systemDirectory = win32.join(process.env.SystemRoot || process.env.WINDIR || "C:\\Windows", "System32");
    const invocation = versionInvocation(executable, systemDirectory);
    const child = spawnSync(invocation.command, invocation.args, {
      ...invocation.options, encoding: "utf8", timeout: 10_000, windowsHide: true,
      env: { ...process.env, ...invocation.options.env },
    });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0);
    assert.equal(child.stdout.trim(), "10.33.0");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("System.Speech path travels only in an environment value", async () => {
  const f = fixture();
  await checkWindowsBuild(f.options);
  const call = f.calls.find(call => call.options.env.REALBUD_PREFLIGHT_SPEECH);
  assert.equal(call.options.env.REALBUD_PREFLIGHT_SPEECH, speech);
  assert.ok(!call.args.join(" ").includes(speech));
  assert.match(call.args.at(-1), /\$env:REALBUD_PREFLIGHT_SPEECH/);
});

test("proof tools are optional for builds and mandatory with --proof; no CI flag is required", async () => {
  const base = fixture({ missing: ["pwsh", "python"] });
  assert.equal((await checkWindowsBuild(base.options)).passed, true);
  const missing = await checkWindowsBuild({ ...base.options, proof: true });
  assert.equal(missing.passed, false);
  assert.equal(byId(missing, "proof-powershell").status, "fail");
  assert.equal(byId(missing, "proof-python").status, "fail");
  const complete = await checkWindowsBuild({ ...fixture().options, proof: true });
  assert.equal(complete.passed, true);
  assert.equal(complete.scope, "build-and-installer-proof-tools");
  assert.equal(byId(complete, "proof-powershell").status, "pass");
  assert.equal(byId(complete, "proof-python").status, "pass");
  assert.ok(complete.limits.some(limit => limit.includes("CI/RUNNER_TEMP")));
});

test("old Python, Store aliases and PowerShell 5 cannot satisfy installer proof", async () => {
  for (const output of [
    { python: "Python 3.10.9", pwsh: "5.1" },
    { python: "Python was not found; run without arguments to install from the Microsoft Store", pwsh: "unknown" },
  ]) {
    const result = await checkWindowsBuild({ ...fixture({ output }).options, proof: true });
    assert.equal(byId(result, "proof-python").status, "fail");
    assert.equal(byId(result, "proof-powershell").status, "fail");
  }
});

test("receipts and human output contain no environment values, paths or raw errors", async () => {
  const result = await checkWindowsBuild({ ...fixture({ reject: ["pnpm", "git", "powershell", "tar", "csc", "python", "pwsh"] }).options, proof: true });
  const output = JSON.stringify(result) + formatWindowsBuildReceipt(result);
  for (const forbidden of ["Fictional Builder", "PRIVATE_TOKEN", "Windows Space", "Tools & More", "C:\\"]) {
    assert.ok(!output.includes(forbidden), forbidden);
  }
  assert.match(formatWindowsBuildReceipt(result), /BLOCKED/);
});

test("shared Framework locators preserve targeting-pack and fallback order with injected files", () => {
  const f = fixture();
  const options = { exists: f.options.exists, paths: win32, list: () => [] };
  assert.equal(findCsc(f.options.env, options), paths.csc);
  assert.equal(findSystemSpeech(f.options.env, options), speech);
  f.files.delete(paths.csc.toLowerCase());
  const fallback = "C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe";
  f.files.add(fallback.toLowerCase());
  assert.equal(findCsc(f.options.env, options), fallback);
  f.files.delete(speech.toLowerCase());
  const gac = win32.join(root, "Microsoft.NET", "assembly", "GAC_MSIL", "System.Speech", "v4.0_test", "System.Speech.dll");
  f.files.add(gac.toLowerCase());
  assert.equal(findSystemSpeech(f.options.env, { ...options, list: () => ["v4.0_test"] }), gac);
  assert.equal(findSystemSpeech(f.options.env, { ...options, list: () => { throw new Error("unreadable"); } }), null);
});

test("CLI rejects unsupported flags without echoing their content", () => {
  const cli = fileURLToPath(new URL("./check-windows-build.mjs", import.meta.url));
  const child = spawnSync(process.execPath, [cli, "--json", "--PRIVATE_TOKEN=C:\\Users\\Fictional Builder"], { encoding: "utf8" });
  assert.equal(child.status, 2);
  const result = JSON.parse(child.stdout);
  assert.equal(result.passed, false);
  assert.equal(byId(result, "arguments").status, "fail");
  assert.ok(!child.stdout.includes("PRIVATE_TOKEN"));
});

test("CLI on this non-Windows host returns an explicit failure receipt", { skip: process.platform === "win32" }, () => {
  const cli = fileURLToPath(new URL("./check-windows-build.mjs", import.meta.url));
  const child = spawnSync(process.execPath, [cli, "--json", "--proof"], { encoding: "utf8" });
  assert.equal(child.status, 1);
  const result = JSON.parse(child.stdout);
  assert.equal(result.platform, process.platform);
  assert.equal(result.passed, false);
  assert.equal(byId(result, "host").status, "fail");
  assert.ok(!result.checks.some(check => check.id === "windows-powershell"));
});
