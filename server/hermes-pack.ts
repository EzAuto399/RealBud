// Install the locked `property` profile into a Hermes home. File copy only —
// we never edit Hermes source or launch Hermes.app.
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

import { writeFileAtomic } from "./atomic.ts";
import { HERMES_PIN } from "./hermes-pin.ts";

export const PACK_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "pack", "property");

export function hermesHome(root?: string): string {
  return root ?? process.env.HERMES_HOME ?? join(homedir(), ".hermes");
}

export function propertyProfileDir(root?: string): string {
  return join(hermesHome(root), "profiles", HERMES_PIN.profile);
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

/** Indented YAML map under `key:` (Hermes config style). */
export function yamlBlock(raw: string, key: string): string | null {
  const match = raw.match(new RegExp(`^${key}:\\n(?:[ \\t].*\\n)*`, "m"));
  return match?.[0] ?? null;
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

export function applyPropertyPack(root?: string): { dir: string; wrote: string[] } {
  const home = hermesHome(root);
  const dest = propertyProfileDir(root);
  mkdirSync(dest, { recursive: true });
  const wrote: string[] = [];
  const destConfig = join(dest, "config.yaml");
  const existingModel = yamlBlock(readIf(destConfig), "model") ?? yamlBlock(readIf(join(home, "config.yaml")), "model");

  for (const name of ["SOUL.md", "config.yaml", "distribution.yaml", "profile.yaml"]) {
    const from = join(PACK_DIR, name);
    if (!existsSync(from)) continue;
    let body = readFileSync(from, "utf8");
    if (name === "config.yaml") body = withYamlBlock(body, "model", existingModel);
    writeFileAtomic(join(dest, name), body);
    wrote.push(name);
  }
  const skillsFrom = join(PACK_DIR, "skills");
  if (existsSync(skillsFrom)) {
    cpSync(skillsFrom, join(dest, "skills"), { recursive: true });
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
    const raw = readFileSync(join(propertyProfileDir(root), "config.yaml"), "utf8");
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
