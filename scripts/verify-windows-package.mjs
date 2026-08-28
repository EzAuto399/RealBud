import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") throw new Error("verify-windows-package must run on Windows");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = path.resolve(process.argv[2] ?? path.join(root, "release"));

function executables(dir, depth = 0) {
  if (depth > 5 || !existsSync(dir)) return [];
  const files = [];
  for (const name of readdirSync(dir)) {
    const item = path.join(dir, name);
    const stat = statSync(item);
    if (stat.isDirectory()) files.push(...executables(item, depth + 1));
    else if (stat.isFile() && name.toLowerCase().endsWith(".exe")) files.push(item);
  }
  return files;
}

const files = executables(releaseDir);
if (!files.some((file) => file.includes("win-unpacked") && path.basename(file) === "RealBud.exe")) {
  throw new Error("signed verification found no unpacked RealBud.exe");
}
if (!files.some((file) => /setup\.exe$/i.test(file))) throw new Error("signed verification found no NSIS setup executable");

const subjects = new Set();
for (const file of files) {
  const script = [
    "$s = Get-AuthenticodeSignature -LiteralPath $env:REALBUD_VERIFY_FILE",
    "[pscustomobject]@{ Status = [string]$s.Status; Subject = [string]$s.SignerCertificate.Subject } | ConvertTo-Json -Compress",
  ].join("; ");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    env: { ...process.env, REALBUD_VERIFY_FILE: file },
  });
  if (result.status !== 0) throw new Error(`Authenticode inspection failed for ${path.basename(file)}`);
  const checked = JSON.parse(result.stdout.trim());
  if (checked.Status !== "Valid" || !checked.Subject) {
    throw new Error(`${path.basename(file)} does not have a valid Authenticode signature`);
  }
  subjects.add(checked.Subject);
}
if (subjects.size !== 1) throw new Error("packaged executables do not share one publisher certificate subject");

const updateMetadata = path.join(releaseDir, "latest.yml");
if (!statSync(updateMetadata, { throwIfNoEntry: false })?.isFile()) throw new Error("latest.yml is missing");
const metadata = readFileSync(updateMetadata, "utf8");
if (!/^path:\s*.+\.exe\s*$/m.test(metadata) || !/^sha512:\s*\S+/m.test(metadata)) {
  throw new Error("latest.yml is missing its signed installer path or digest");
}

console.log(`[verify-windows-package] OK: ${files.length} signed executables, one publisher subject, and update metadata`);
