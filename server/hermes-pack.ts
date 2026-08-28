// Install the locked `property` profile into a Hermes home. File copy only —
// we never edit Hermes source or launch Hermes.app.
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { HERMES_PIN } from "./hermes-pin.ts";
import { WORKER_HOME } from "./config.ts";

export const PACK_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "pack", "property");
const REQUIRED_PACK_FILES = [
  "SOUL.md",
  "config.yaml",
  "distribution.yaml",
  "profile.yaml",
  join("skills", "intake-properties", "SKILL.md"),
  join("skills", "morning-arrears", "SKILL.md"),
] as const;

export function hermesHome(root?: string): string {
  return root ?? WORKER_HOME;
}

export function propertyProfileDir(root?: string): string {
  return join(hermesHome(root), "profiles", HERMES_PIN.profile);
}

export function packInstalled(root?: string): boolean {
  const dest = propertyProfileDir(root);
  try {
    for (const name of ["SOUL.md", "distribution.yaml", "profile.yaml"]) {
      const installed = join(dest, name);
      if (!lstatSync(installed).isFile() || readFileSync(installed).compare(readFileSync(join(PACK_DIR, name))) !== 0) return false;
    }
    const installedConfig = join(dest, "config.yaml");
    if (!lstatSync(installedConfig).isFile()) return false;
    const expectedConfig = withYamlBlock(readFileSync(join(PACK_DIR, "config.yaml"), "utf8"), "model", null);
    const actualConfig = withYamlBlock(readFileSync(installedConfig, "utf8"), "model", null);
    if (actualConfig !== expectedConfig) return false;

    // Hermes may write bundled skills into this profile the first time the
    // worker answers. Those extras must not fail the pack: Save & test would
    // otherwise bounce the journey back to Connect model forever.
    const expectedSkills = regularFiles(join(PACK_DIR, "skills"));
    if (!expectedSkills) return false;
    for (const relative of expectedSkills) {
      const installed = join(dest, "skills", relative);
      if (!lstatSync(installed).isFile()) return false;
      if (readFileSync(join(PACK_DIR, "skills", relative)).compare(readFileSync(installed)) !== 0) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function regularFiles(root: string, relative = ""): string[] | null {
  const dir = relative ? join(root, relative) : root;
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const child = relative ? join(relative, entry.name) : entry.name;
    if (entry.isSymbolicLink()) return null;
    if (entry.isDirectory()) {
      const nested = regularFiles(root, child);
      if (!nested) return null;
      files.push(...nested);
    } else if (entry.isFile()) {
      files.push(child);
    } else {
      return null;
    }
  }
  return files;
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
  const missing = REQUIRED_PACK_FILES.filter((relative) => !lstatSync(join(PACK_DIR, relative), { throwIfNoEntry: false })?.isFile());
  if (missing.length) {
    throw new Error(`RealBud's property safety pack is incomplete (${missing.join(", ")}). Reinstall RealBud.`);
  }
  const home = hermesHome(root);
  const dest = propertyProfileDir(root);
  mkdirSync(dest, { recursive: true });
  const wrote: string[] = [];
  const destConfig = join(dest, "config.yaml");
  const existingModel = yamlBlock(readIf(destConfig), "model") ?? yamlBlock(readIf(join(home, "config.yaml")), "model");

  for (const name of ["SOUL.md", "config.yaml", "distribution.yaml", "profile.yaml"]) {
    const from = join(PACK_DIR, name);
    let body = readFileSync(from, "utf8");
    if (name === "config.yaml") body = withYamlBlock(body, "model", existingModel);
    writeFileSync(join(dest, name), body);
    wrote.push(name);
  }
  const skillsFrom = join(PACK_DIR, "skills");
  if (existsSync(skillsFrom)) {
    const skillsTo = join(dest, "skills");
    // The pack owns this exact directory. Removing it before the copy ensures
    // an old or injected skill cannot survive a safe re-apply.
    rmSync(skillsTo, { recursive: true, force: true });
    cpSync(skillsFrom, skillsTo, { recursive: true });
    wrote.push("skills/");
  }
  // Credentials stay inside RealBud's dedicated worker home. Copy once from
  // that home's root for compatibility with worker-managed auth; never read
  // or migrate the user's personal ~/.hermes credentials.
  for (const name of [".env", "auth.json"]) {
    const from = join(home, name);
    const to = join(dest, name);
    if (existsSync(from) && !existsSync(to)) {
      copyFileSync(from, to);
      wrote.push(name);
    }
  }
  if (!packInstalled(root) || !approvalsAreManual(root)) {
    throw new Error("RealBud could not verify the installed property safety pack. Try Repair safety setup again.");
  }
  return { dir: dest, wrote };
}

export function approvalsAreManual(root?: string): boolean {
  try {
    const raw = readFileSync(join(propertyProfileDir(root), "config.yaml"), "utf8");
    const approvals = raw.split("approvals:")[1] ?? "";
    return /(?:^|\n)\s*mode:\s*manual\s*(?:\n|$)/.test(approvals) &&
      /(?:^|\n)\s*cron_mode:\s*deny\s*(?:\n|$)/.test(approvals) &&
      !/(?:^|\n)\s*(?:mode|cron_mode):\s*(?:off|smart|yolo|on|allow)\s*(?:\n|$)/.test(approvals) &&
      /(?:^|\n)toolsets:\s*\[\]\s*(?:\n|$)/.test(raw) &&
      /(?:^|\n)terminal:\s*\n\s*backend:\s*none\s*(?:\n|$)/.test(raw);
  } catch {
    return false;
  }
}
