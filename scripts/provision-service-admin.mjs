#!/usr/bin/env node
// Trusted developer/installer setup. Never expose this through an HTTP route.
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { constants, chmodSync, closeSync, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { createServiceAdminPasswordVerifier } from "../server/service-admin.ts";

const MAX_PASSWORD_BYTES = 1024;
const POLICY_NAME = "service-admin.json";
const LOCK_NAME = ".service-admin-provision.lock";
const HELP = `Trusted RealBud service administrator provisioning (Node 24+).
Usage: node scripts/provision-service-admin.mjs --data-dir /absolute/private/path [--rotate]
       node scripts/provision-service-admin.mjs --data-dir /absolute/private/path --password-stdin [--rotate]
       node scripts/provision-service-admin.mjs --data-dir /absolute/private/path --migrate-care [--rotate]
       node scripts/provision-service-admin.mjs --data-dir /absolute/private/path --generate-password-file /private/operator/new-file [--rotate]

Interactive input is hidden and confirmed. Choose a unique 12–512 character password.
--password-stdin explicitly reads at most 1024 UTF-8 bytes, then end of input.
--migrate-care explicitly reads care.json's unlock field and preserves that file.
--generate-password-file creates a random password in a new private operator file,
outside the installation data directory. Move it to your password manager; never
ship that file to staff. Existing files are never overwritten.
An existing service-admin.json requires --rotate. No password arguments, environment
variables, default password or automatic legacy migration are supported.
This is trusted developer/installer setup, not a normal staff setup screen.
`;

class ProvisionError extends Error {}
const fail = message => { throw new ProvisionError(message); };

export function parseArguments(args) {
  if (args.length === 1 && args[0] === "--help") return { help: true };
  const result = { dataDir: "", rotate: false, passwordStdin: false, migrateCare: false, generatePasswordFile: "" };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (seen.has(flag)) fail("Each provisioning option may be supplied only once.");
    seen.add(flag);
    if (flag === "--data-dir") {
      const value = args[++index];
      if (!value || value.startsWith("--") || !isAbsolute(value) || value.includes("\0")) fail("Supply an explicit absolute --data-dir.");
      result.dataDir = resolve(value);
    } else if (flag === "--generate-password-file") {
      const value = args[++index];
      if (!value || value.startsWith("--") || !isAbsolute(value) || value.includes("\0")) fail("Supply an explicit absolute private operator file.");
      result.generatePasswordFile = resolve(value);
    } else if (flag === "--rotate") result.rotate = true;
    else if (flag === "--password-stdin") result.passwordStdin = true;
    else if (flag === "--migrate-care") result.migrateCare = true;
    else fail("Unknown provisioning option. Use --help; never pass a password as an argument.");
  }
  if (!result.dataDir || result.dataDir === parse(result.dataDir).root) fail("Supply an explicit private --data-dir, not a filesystem root.");
  if (result.passwordStdin && result.migrateCare) fail("Choose either --password-stdin or --migrate-care, not both.");
  if (result.generatePasswordFile && (result.passwordStdin || result.migrateCare)) fail("Generated passwords cannot be combined with another password input.");
  return result;
}

// Windows mode bits are not an ACL. Use the built-in ACL API without placing a
// password, verifier or interpolated path in a command, its output, or arguments.
const WINDOWS_ACL = `
$ErrorActionPreference = 'Stop'
$path = $env:REALBUD_PROVISION_ACL_PATH
$directory = $env:REALBUD_PROVISION_ACL_KIND -eq 'directory'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
if ($env:REALBUD_PROVISION_ACL_ACTION -eq 'restrict') {
  if ($directory) { $acl = [System.Security.AccessControl.DirectorySecurity]::new() }
  else { $acl = [System.Security.AccessControl.FileSecurity]::new() }
  # Writing an owner needs WRITE_OWNER even when it does not change, and the .NET
  # call enables no privilege for it; the owner's implicit WRITE_DAC is enough for
  # the descriptor itself, so an object already owned by the caller keeps its owner.
  if ($directory) { $owned = ([System.IO.DirectoryInfo]::new($path)).GetAccessControl([System.Security.AccessControl.AccessControlSections]::Owner) }
  else { $owned = ([System.IO.FileInfo]::new($path)).GetAccessControl([System.Security.AccessControl.AccessControlSections]::Owner) }
  if ($owned.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { $acl.SetOwner($sid) }
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($principal in @($sid, $system)) {
    if ($directory) { $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($principal, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow') }
    else { $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($principal, 'FullControl', 'Allow') }
    $acl.AddAccessRule($rule)
  }
  if ($directory) { ([System.IO.DirectoryInfo]::new($path)).SetAccessControl($acl) }
  else { ([System.IO.FileInfo]::new($path)).SetAccessControl($acl) }
}
if ($directory) { $actual = ([System.IO.DirectoryInfo]::new($path)).GetAccessControl() }
else { $actual = ([System.IO.FileInfo]::new($path)).GetAccessControl() }
$allowed = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
if ($allowed -notcontains $actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value) { exit 2 }
$usable = $false
foreach ($rule in $actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq 'Allow') {
    if ($allowed -notcontains $rule.IdentityReference.Value) { exit 3 }
    if ($rule.IdentityReference.Value -eq $sid.Value -and (($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl)) { $usable = $true }
  }
}
if (-not $usable) { exit 4 }
`;

function windowsPrivacy(path, directory, restrict) {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !isAbsolute(systemRoot)) fail("Windows privacy verification is unavailable. Use the trusted installer account.");
  try {
    execFileSync(join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_ACL, "utf16le").toString("base64")],
      { env: { ...process.env, REALBUD_PROVISION_ACL_PATH: path, REALBUD_PROVISION_ACL_KIND: directory ? "directory" : "file", REALBUD_PROVISION_ACL_ACTION: restrict ? "restrict" : "verify" }, stdio: "pipe", windowsHide: true, timeout: 15_000, maxBuffer: 4096 });
  } catch { fail("Windows file privacy could not be verified. Use a private directory owned by the trusted installer account."); }
}

function privatePath(path, directory, restrict = false) {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)) fail("Provisioning requires a private real directory and ordinary, unlinked files.");
  if (process.platform === "win32") windowsPrivacy(path, directory, restrict);
  else {
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) fail("The provisioning directory and files must belong to the current trusted account.");
    if (restrict) chmodSync(path, directory ? 0o700 : 0o600);
    if ((lstatSync(path).mode & 0o777) !== (directory ? 0o700 : 0o600)) fail("Use a private data directory (0700) and administrator file (0600) before provisioning.");
  }
  return lstatSync(path);
}

function prepareDirectory(path) {
  if (!existsSync(path)) {
    const missing = [];
    for (let current = path; !existsSync(current); current = dirname(current)) missing.unshift(current);
    for (const current of missing) { mkdirSync(current, { mode: 0o700 }); privatePath(current, true, true); }
  }
  privatePath(path, true);
  return realpathSync(path);
}

function readLegacyPassword(dataDir) {
  const path = join(dataDir, "care.json");
  let fd;
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 65_536) throw new Error();
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > 65_536 || opened.ino !== info.ino || opened.dev !== info.dev) throw new Error();
    const config = JSON.parse(readFileSync(fd, "utf8"));
    if (!config || typeof config !== "object" || Array.isArray(config) || typeof config.unlock !== "string") throw new Error();
    return config.unlock;
  } catch { fail("Legacy migration requires a valid regular care.json with an unlock field in the selected data directory."); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export async function readBoundedPasswordStdin(input) {
  const chunks = [];
  let bytes = 0;
  try {
    for await (const chunk of input) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_PASSWORD_BYTES) fail("Password input exceeds 1024 bytes.");
      chunks.push(buffer);
    }
    const value = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    return value.replace(/\r?\n$/, "");
  } catch (cause) {
    if (cause instanceof ProvisionError) throw cause;
    fail("Password input could not be read as bounded UTF-8 text.");
  } finally { for (const buffer of chunks) buffer.fill(0); }
}

export function readHiddenPassword(input, output, prompt) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") fail("Use an interactive terminal, or explicitly choose --password-stdin for a trusted input stream.");
  return new Promise((resolvePassword, reject) => {
    let value = "";
    let finished = false;
    const decoder = new StringDecoder("utf8");
    const wasRaw = input.isRaw === true;
    const finish = (error, password) => {
      if (finished) return;
      finished = true;
      input.off("data", data); input.off("error", broken); input.off("end", ended);
      process.off("SIGINT", interrupted); process.off("SIGTERM", interrupted);
      input.setRawMode(wasRaw); input.pause(); output.write("\n");
      if (error) reject(error); else resolvePassword(password);
    };
    const broken = () => finish(new ProvisionError("Password input was interrupted."));
    const ended = () => finish(new ProvisionError("Password input ended before confirmation."));
    const interrupted = () => finish(new ProvisionError("Provisioning cancelled."));
    const data = chunk => {
      for (const character of decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))) {
        if (character === "\r" || character === "\n") { finish(null, value); return; }
        if (character === "\u0003" || character === "\u0004") { finish(new ProvisionError("Provisioning cancelled.")); return; }
        if (character === "\u007f" || character === "\b") { value = [...value].slice(0, -1).join(""); continue; }
        if (/[\u0000-\u001f]/.test(character)) { finish(new ProvisionError("Use printable password characters only.")); return; }
        value += character;
        if (Buffer.byteLength(value, "utf8") > MAX_PASSWORD_BYTES) { finish(new ProvisionError("Password input exceeds 1024 bytes.")); return; }
      }
    };
    input.setRawMode(true); input.on("data", data); input.once("error", broken); input.once("end", ended);
    process.once("SIGINT", interrupted); process.once("SIGTERM", interrupted);
    output.write(prompt); input.resume();
  });
}

function syncDirectory(dataDir) {
  if (process.platform === "win32") return; // File sync is used; directory fsync is not supported by Node on Windows.
  const fd = openSync(dataDir, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export async function provisionServiceAdmin(options, io = { input: process.stdin, output: process.stderr }) {
  const dataDir = prepareDirectory(options.dataDir);
  const policyPath = join(dataDir, POLICY_NAME);
  const lockPath = join(dataDir, LOCK_NAME);
  let lock;
  let temporary;
  let generatedPath;
  let committed = false;
  try {
    try { lock = openSync(lockPath, "wx", 0o600); }
    catch { fail("Provisioning is already locked or the directory is not writable. Verify no provisioning process is running before removing a stale provisioning lock."); }
    privatePath(lockPath, false, true);
    const original = existsSync(policyPath) ? privatePath(policyPath, false) : null;
    if (original && !options.rotate) fail("Administrator credentials already exist. Use --rotate only for an intentional replacement.");
    let password;
    if (options.generatePasswordFile) {
      const operatorDir = prepareDirectory(dirname(options.generatePasswordFile));
      const withinData = relative(dataDir, operatorDir);
      if (!withinData || (!withinData.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && withinData !== ".." && !isAbsolute(withinData))) {
        fail("Store generated passwords outside the installation data directory, in your private operator account.");
      }
      const outputPath = join(operatorDir, basename(options.generatePasswordFile));
      let output;
      try { output = openSync(outputPath, "wx", 0o600); }
      catch { fail("The operator password file already exists or is not writable. Choose a new private file."); }
      generatedPath = outputPath;
      try {
        privatePath(outputPath, false, true);
        password = randomBytes(24).toString("base64url");
        writeFileSync(output, `${password}\n`, "utf8");
        fsyncSync(output);
      } finally { closeSync(output); }
      syncDirectory(operatorDir);
    } else if (options.migrateCare) password = readLegacyPassword(dataDir);
    else if (options.passwordStdin) password = await readBoundedPasswordStdin(io.input);
    else {
      password = await readHiddenPassword(io.input, io.output, "Unique service administrator password (12–512 characters): ");
      const confirmation = await readHiddenPassword(io.input, io.output, "Confirm administrator password: ");
      if (password !== confirmation) fail("The passwords did not match. No administrator credentials were changed.");
    }
    let passwordVerifier;
    try { passwordVerifier = await createServiceAdminPasswordVerifier(password); }
    catch { fail("Use a unique administrator password of 12–512 printable characters within 1024 UTF-8 bytes."); }
    password = undefined;
    privatePath(dataDir, true);
    if (original) {
      const current = privatePath(policyPath, false);
      if (current.ino !== original.ino || current.dev !== original.dev || current.size !== original.size || current.mtimeMs !== original.mtimeMs) fail("Administrator credentials changed during provisioning. No replacement was made.");
    } else if (existsSync(policyPath)) fail("Administrator credentials appeared during provisioning. No replacement was made.");
    temporary = join(dataDir, `.service-admin-${randomUUID()}.tmp`);
    const file = openSync(temporary, "wx", 0o600);
    try {
      privatePath(temporary, false, true);
      writeFileSync(file, `${JSON.stringify({ version: 1, passwordVerifier })}\n`, "utf8");
      fsyncSync(file);
    } finally { closeSync(file); }
    if (original) { renameSync(temporary, policyPath); committed = true; }
    else { linkSync(temporary, policyPath); committed = true; unlinkSync(temporary); }
    temporary = undefined;
    privatePath(policyPath, false);
    syncDirectory(dataDir);
    return { rotated: !!original, migratedCare: options.migrateCare, generated: !!generatedPath };
  } finally {
    if (generatedPath && !committed) { try { unlinkSync(generatedPath); } catch { /* Preserve private failure evidence without printing its content. */ } }
    if (temporary) { try { unlinkSync(temporary); } catch { /* A failed cleanup does not print file contents. */ } }
    if (lock !== undefined) { closeSync(lock); try { unlinkSync(lockPath); } catch { /* Preserve a failed cleanup for operator inspection. */ } }
  }
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) { process.stdout.write(HELP); return; }
    if (Number(process.versions.node.split(".")[0]) < 24) fail("Trusted provisioning requires Node 24 or newer.");
    const result = await provisionServiceAdmin(options);
    process.stdout.write(`Service administrator credentials ${result.rotated ? "rotated" : "provisioned"}. No password or verifier is printed.\n`);
    if (result.migratedCare) process.stdout.write("Legacy care.json was preserved unchanged. Review its separate secret-retention policy through trusted administration.\n");
    if (result.generated) process.stdout.write("A unique password was saved only to the selected private operator file. Transfer it to your password manager; keep it out of customer installers and backups.\n");
  } catch (cause) {
    process.stderr.write(`${cause instanceof ProvisionError ? cause.message : "Provisioning could not be completed. Check the selected private directory and trusted runtime."}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
