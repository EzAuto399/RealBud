// Install the locked `property` profile into a Hermes home. File copy only —
// we never edit Hermes source or launch Hermes.app.
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

import { writeFileAtomic } from "./atomic.ts";
import { HERMES_PIN } from "./hermes-pin.ts";
import { hermesHome } from "./hermes-paths.ts";
export { hermesHome } from "./hermes-paths.ts";

export const PACK_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "pack", "property");

export function propertyProfileDir(root?: string): string {
  return join(hermesHome(root), "profiles", HERMES_PIN.profile);
}

/** One-shot: if Bud's hands are missing in the RealBud-owned home but still
 * live under the personal Hermes Desktop home, copy that profile only (never
 * personal / property-manager / other sibling profiles). */
export function migratePropertyProfileFromLegacyHermes(root?: string): { migrated: boolean; from?: string; to?: string } {
  const dest = propertyProfileDir(root);
  if (packInstalled(root)) return { migrated: false };
  const legacyHome = join(homedir(), ".hermes");
  const owned = hermesHome(root);
  if (resolvedPath(owned) === resolvedPath(legacyHome)) return { migrated: false };
  const from = join(legacyHome, "profiles", HERMES_PIN.profile);
  if (!existsSync(join(from, "SOUL.md"))) return { migrated: false };
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(from, dest, { recursive: true });
  // Stamp so Advanced can show the split happened once.
  try {
    writeFileSync(
      join(dest, ".realbud-migrated-from-legacy-hermes"),
      `${new Date().toISOString()}\nfrom=${from}\n`,
      { flag: "wx" },
    );
  } catch {
    /* already stamped or unwritable */
  }
  return { migrated: true, from, to: dest };
}

/** Official installer checkout — Hermes status calls this "Install directory". */
export function hermesAgentDir(root?: string): string {
  return join(hermesHome(root), "hermes-agent");
}

function resolvedPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    try {
      return join(realpathSync(dirname(absolute)), basename(absolute));
    } catch {
      return absolute;
    }
  }
}

/** True when `target` resolves strictly inside the Hermes home (never the home itself). */
export function isInsideHermesHome(target: string, root?: string): boolean {
  const home = resolvedPath(hermesHome(root));
  const resolved = resolvedPath(target);
  const rel = relative(home, resolved);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function packInstalled(root?: string): boolean {
  return existsSync(join(propertyProfileDir(root), "SOUL.md"));
}

function ensurePrivateRootAuth(root?: string): void {
  // An empty owned-home root prevents fallback to personal Hermes auth.
  const path = join(hermesHome(root), "auth.json");
  if (!existsSync(path)) writeFileAtomic(path, `${JSON.stringify({ version: 1, providers: {}, credential_pool: {} }, null, 2)}\n`);
}

/** Startup is initialization only. Existing profiles change through Repair. */
export function ensurePropertyPack(root?: string): { dir: string; wrote: string[] } {
  if (!packInstalled(root)) return applyPropertyPack(root);
  ensurePrivateRootAuth(root);
  return { dir: propertyProfileDir(root), wrote: [] };
}

/** Indented YAML map under `key:` (Hermes config style). */
export function yamlBlock(raw: string, key: string): string | null {
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  const start = lines.findIndex((line) => line === `${key}:` || line.startsWith(`${key}:`));
  if (start < 0) return null;
  const block = [lines[start]!];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length > 0 && !/^[ \t]/.test(line)) break;
    block.push(line);
  }
  return block.join("\n");
}

export function withYamlBlock(raw: string, key: string, block: string | null): string {
  const cleaned = raw.replace(/\s+$/, "\n");
  const existing = new RegExp(`^${key}:\\n(?:[ \\t].*\\n)*`, "m");
  if (!block) return cleaned.replace(existing, "");
  const next = block.endsWith("\n") ? block : `${block}\n`;
  return existing.test(cleaned) ? cleaned.replace(existing, next) : cleaned + next;
}

function readIf(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** Replace only RealBud-owned policy blocks; keep all other upstream settings. */
export function mergePropertyPolicy(existing: string, defaults: string): string {
  if (!existing.trim()) return defaults;
  const keys = ["approvals", "agent", "toolsets", "security", "delegation", "terminal", "file_read_max_chars", "tool_output"];
  let result = existing.replace(/\r\n/g, "\n");
  if (!/^[A-Za-z_][\w-]*:/m.test(result)) throw new Error("Bud’s profile settings could not be read. The existing file has been kept.");
  for (const key of keys) {
    const lines = result.split("\n");
    const starts = lines.flatMap((line, index) => line.startsWith(`${key}:`) ? [index] : []);
    if (starts.length > 1) throw new Error("Bud’s profile contains duplicate settings. The existing file has been kept.");
    const replacement = yamlBlock(defaults, key);
    if (!replacement) continue;
    if (starts.length) {
      const start = starts[0]!;
      let end = start + 1;
      while (end < lines.length && !/^[A-Za-z_][\w-]*:/.test(lines[end]!)) end++;
      lines.splice(start, end - start, replacement.trimEnd());
      result = lines.join("\n");
    } else result = `${result.trimEnd()}\n${replacement.trimEnd()}\n`;
  }
  return `${result.trimEnd()}\n`;
}

export function applyPropertyPack(root?: string): { dir: string; wrote: string[] } {
  const dest = propertyProfileDir(root);
  const destConfig = join(dest, "config.yaml");
  let existing = "";
  try { existing = readFileSync(destConfig, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Bud’s existing profile could not be read. Its files have been kept."); }
  const config = mergePropertyPolicy(existing, readFileSync(join(PACK_DIR, "config.yaml"), "utf8"));
  mkdirSync(dest, { recursive: true });
  ensurePrivateRootAuth(root);
  const wrote: string[] = [];

  for (const name of ["SOUL.md", "config.yaml", "distribution.yaml", "profile.yaml"]) {
    const from = join(PACK_DIR, name);
    if (!existsSync(from)) continue;
    let body = readFileSync(from, "utf8");
    if (name === "config.yaml") body = config;
    writeFileAtomic(join(dest, name), body);
    wrote.push(name);
  }
  const skillsFrom = join(PACK_DIR, "skills");
  if (existsSync(skillsFrom)) {
    cpSync(skillsFrom, join(dest, "skills"), { recursive: true, force: false, errorOnExist: false });
    wrote.push("skills/");
  }
  return { dir: dest, wrote };
}

export function approvalsAreManual(root?: string): boolean {
  try {
    const raw = readFileSync(join(propertyProfileDir(root), "config.yaml"), "utf8");
    return /approvals:[\s\S]*?mode:\s*manual/.test(raw) && !/mode:\s*(off|smart|yolo)/.test(raw.split("approvals:")[1] ?? "");
  } catch {
    return false;
  }
}

/** The supported property profile must provide a usable local workroom while
 * keeping subprocess credentials isolated from the user's normal HOME. */
export function propertyWorkroomReady(root?: string): boolean {
  try {
    const raw = readIf(join(propertyProfileDir(root), "config.yaml")).replace(/\r\n/g, "\n");
    const terminal = yamlBlock(raw, "terminal") ?? "";
    const agent = yamlBlock(raw, "agent") ?? "";
    const security = yamlBlock(raw, "security") ?? "";
    const toolsets = yamlBlock(raw, "toolsets") ?? "";
    const maxTurns = Number(agent.match(/^\s+max_turns:\s*(\d+)\s*$/m)?.[1] ?? 0);
    const requiredToolsets = ["web", "terminal", "file", "vision", "todo", "session_search", "delegation"];
    return (
      /^\s+backend:\s*local\s*$/m.test(terminal) &&
      /^\s+home_mode:\s*profile\s*$/m.test(terminal) &&
      /^\s+env_passthrough:\s*\[\]\s*$/m.test(terminal) &&
      /^\s+redact_secrets:\s*true\s*$/m.test(security) &&
      requiredToolsets.every((name) => new RegExp(`^\\s+-\\s*${name}\\s*$`, "m").test(toolsets)) &&
      !/^\s+-\s*(code_execution|computer_use|cronjob|skills)\s*$/m.test(toolsets) &&
      maxTurns >= 60
    );
  } catch {
    return false;
  }
}
