// Install the locked `property` profile into a Hermes home. File copy only —
// we never edit Hermes source or launch Hermes.app.
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

import { HERMES_PIN } from "./hermes-pin.ts";

export const PACK_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "pack", "property");

export function hermesHome(root?: string): string {
  return root ?? process.env.HERMES_HOME ?? join(homedir(), ".hermes");
}

export function propertyProfileDir(root?: string): string {
  return join(hermesHome(root), "profiles", HERMES_PIN.profile);
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
    writeFileSync(join(dest, name), body);
    wrote.push(name);
  }
  const skillsFrom = join(PACK_DIR, "skills");
  if (existsSync(skillsFrom)) {
    cpSync(skillsFrom, join(dest, "skills"), { recursive: true });
    wrote.push("skills/");
  }
  // Credentials stay on the machine. Copy once so the isolated profile can
  // use the same Hermes providers — we do not put keys in the git pack.
  for (const name of [".env", "auth.json"]) {
    const from = join(home, name);
    const to = join(dest, name);
    if (existsSync(from) && !existsSync(to)) {
      copyFileSync(from, to);
      wrote.push(name);
    }
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
