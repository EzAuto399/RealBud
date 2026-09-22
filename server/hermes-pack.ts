import { currentWorkerProfile } from "./hermes-profile.ts";
// Install the locked `property` profile into a Hermes home. File copy only —
// we never edit Hermes source or launch Hermes.app.
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { isMap, parseDocument, YAMLMap } from "yaml";

import { ensureProfileDirectories, ensureProfileDirectory, readProfileFile, readProfileFiles, writeProfileFile } from "./hermes-profile-storage.ts";
import { HERMES_PIN } from "./hermes-pin.ts";
import { hermesHome, runtimeCli } from "./hermes-paths.ts";
import { readRuntimeSelection, releaseHome, runtimeCommit, selectedHermesCli } from "./hermes-runtime-selection.ts";
export { hermesHome } from "./hermes-paths.ts";

export const PACK_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "pack", "property");

export function propertyProfileDir(root?: string): string {
  return join(hermesHome(root), "profiles", currentWorkerProfile().profile);
}

/** One-shot: if Bud's hands are missing in the RealBud-owned home but still
 * live under the personal Hermes Desktop home, copy that profile only (never
 * personal / property-manager / other sibling profiles). */
export function migratePropertyProfileFromLegacyHermes(root?: string): { migrated: boolean; from?: string; to?: string } {
  const dest = propertyProfileDir(root);
  if (currentWorkerProfile().memberKey) return { migrated: false };
  if (packInstalled(root)) return { migrated: false };
  // The legacy recursive copy includes credentials and native databases. It
  // has no admitted Windows ACL/identity-preserving migration protocol yet.
  if (process.platform === "win32") throw new Error("Legacy Bud profile migration on Windows needs administrator recovery. The source and destination have been kept.");
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
  if (readProfileFile(path) === null) writeProfileFile(path, `${JSON.stringify({ version: 1, providers: {}, credential_pool: {} }, null, 2)}\n`, false);
}

const PROFILE_FILES = ["SOUL.md", "config.yaml", "distribution.yaml", "profile.yaml", ".env"];

/** The whole profile chain and its existing policy/credential files are
 * admitted in two PowerShell processes rather than eight: the directories do
 * not gate each other once their root is admitted, and no read gates another. */
function prepareProfile(root?: string): { dir: string; config: Buffer | null } {
  const home = hermesHome(root), dest = propertyProfileDir(root);
  ensureProfileDirectories([home, join(home, "profiles"), dest]);
  // Existing RealBud-owned policy/credential files are admission-only here.
  // Upstream-managed auth/memory files retain their native ownership contract.
  const existing = readProfileFiles(PROFILE_FILES.map(name => join(dest, name)));
  return { dir: dest, config: existing[PROFILE_FILES.indexOf("config.yaml")] ?? null };
}

function skillPlan(source: string, destination: string, plan: { dirs: string[]; files: Array<{ from: string; to: string }> }, depth = 0): void {
  if (depth > 12 || plan.files.length > 1000) throw new Error("Bud’s skill pack needs recovery before it can be installed.");
  const stat = lstatSync(source);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Bud’s skill pack needs recovery before it can be installed.");
  plan.dirs.push(destination);
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name), to = join(destination, entry.name);
    if (entry.isDirectory()) skillPlan(from, to, plan, depth + 1);
    else if (entry.isFile()) plan.files.push({ from, to });
    else throw new Error("Bud’s skill pack needs recovery before it can be installed.");
  }
}

function prepareSkillCopies(source: string, destination: string): Array<{ path: string; body: Buffer }> {
  const plan: { dirs: string[]; files: Array<{ from: string; to: string }> } = { dirs: [], files: [] };
  skillPlan(source, destination, plan);
  // Every destination directory is still admitted before any file in it is
  // read, and a linked or foreign one refuses before anything is created.
  ensureProfileDirectories(plan.dirs);
  const existing = readProfileFiles(plan.files.map(file => file.to));
  const files: Array<{ path: string; body: Buffer }> = [];
  plan.files.forEach((file, index) => {
    // Keep locally maintained skills; never replace them as profile repair.
    if (existing[index] !== null) return;
    if (lstatSync(file.from).size > 2 * 1024 * 1024 || files.length >= 1000) throw new Error("Bud’s skill pack needs recovery before it can be installed.");
    files.push({ path: file.to, body: readFileSync(file.from) });
  });
  return files;
}

/** Startup is initialization only. Existing profiles change through Repair. */
export function ensurePropertyPack(root?: string): { dir: string; wrote: string[] } {
  if (!packInstalled(root)) return applyPropertyPack(root);
  prepareProfile(root);
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
  const result = policyDocument(existing.trim() ? existing : defaults);
  const policy = policyDocument(defaults);
  const keys = ["approvals", "agent", "toolsets", "security", "delegation", "terminal", "file_read_max_chars", "tool_output"];
  for (const key of keys) {
    if (policy.has(key)) result.set(key, policy.get(key));
  }
  // Own only the write gate; retain memory preferences and skill visibility.
  for (const key of ["skills", "memory", "auxiliary"]) {
    if (result.has(key) && !isMap(result.get(key))) throw new Error("Bud’s learning settings could not be read. The existing file has been kept.");
    // YAML 1.1 setIn creates !!omap for missing parents; PyYAML reads that as
    // a sequence, so Hermes would lose these policy gates. Create plain maps.
    if (!result.has(key)) result.set(key, new YAMLMap(result.schema));
  }
  for (const key of ["skills", "memory"]) result.setIn([key, "write_approval"], true);
  result.setIn(["auxiliary", "background_review"], policy.getIn(["auxiliary", "background_review"]));
  return result.toString();
}

function policyDocument(raw: string) {
  // Match upstream's YAML 1.1 booleans, and reject malformed/duplicate mappings
  // before its write gate can fail open on a config-loading exception.
  const doc = parseDocument(raw, { uniqueKeys: true, version: "1.1" });
  if (doc.errors.length || doc.warnings.length || !isMap(doc.contents)) throw new Error("Bud’s profile has unreadable or duplicate settings. The existing file has been kept.");
  doc.toJS({ maxAliasCount: 50 });
  return doc;
}

/** Native staged writes are reviewed only at this exact upstream source pin.
 * A pending update must not enable them on an older process-cached executable. */
export function stagedLearningSupported(root?: string): boolean {
  try {
    const home = hermesHome(root);
    const selected = readRuntimeSelection(home).selected;
    if (!selected || runtimeCommit(selected) !== "345cd2b057a452236de401d3534b8502a7465e8d") return false;
    const cli = runtimeCli(releaseHome(home, selected));
    return existsSync(cli) && selectedHermesCli(home) === cli;
  } catch { return false; }
}

export function learningPolicyReady(root?: string): boolean {
  try {
    const doc = policyDocument(readFileSync(join(propertyProfileDir(root), "config.yaml"), "utf8"));
    const background = doc.getIn(["auxiliary", "background_review"]);
    if (!isMap(background)) return false;
    const settings = background.toJSON() as { enabled?: unknown; extra_tools?: unknown };
    return doc.getIn(["skills", "write_approval"]) === true && doc.getIn(["memory", "write_approval"]) === true &&
      (settings.enabled === false || (settings.enabled === true && stagedLearningSupported(root))) &&
      JSON.stringify(settings.extra_tools) === "[]" &&
      background.items.every(item => ["enabled", "extra_tools"].includes(String(item.key)));
  } catch { return false; }
}

export function stagedLearningEnabled(root?: string): boolean {
  try {
    if (!learningPolicyReady(root) || !stagedLearningSupported(root)) return false;
    return policyDocument(readFileSync(join(propertyProfileDir(root), "config.yaml"), "utf8"))
      .getIn(["auxiliary", "background_review", "enabled"]) === true;
  } catch { return false; }
}

export function applyPropertyPack(root?: string): { dir: string; wrote: string[] } {
  // `prepareProfile` has already admitted and read `config.yaml`; re-reading it
  // here would only cost another cold PowerShell process on Windows.
  const { dir: dest, config: existingBytes } = prepareProfile(root);
  const defaults = policyDocument(readFileSync(join(PACK_DIR, "config.yaml"), "utf8"));
  defaults.setIn(["auxiliary", "background_review", "enabled"], stagedLearningSupported(root));
  const config = mergePropertyPolicy(existingBytes?.toString("utf8") ?? "", defaults.toString());
  const skillsFrom = join(PACK_DIR, "skills");
  const skillCopies = existsSync(skillsFrom) ? prepareSkillCopies(skillsFrom, join(dest, "skills")) : [];
  ensurePrivateRootAuth(root);
  const wrote: string[] = [];

  for (const name of ["SOUL.md", "config.yaml", "distribution.yaml", "profile.yaml"]) {
    const from = join(PACK_DIR, name);
    if (!existsSync(from)) continue;
    let body = readFileSync(from, "utf8");
    if (name === "config.yaml") body = config;
    writeProfileFile(join(dest, name), body, true, name === "config.yaml" ? existingBytes : undefined);
    wrote.push(name);
  }
  if (existsSync(skillsFrom)) {
    for (const file of skillCopies) writeProfileFile(file.path, file.body, false);
    wrote.push("skills/");
  }
  return { dir: dest, wrote };
}

// ── managed model attach (provisioned installations) ─────────────────────────
//
// An installation provisioned by the RealBud service gets its model access from
// the vendor: a revocable, spend-capped gateway key that reaches the worker only
// through the launch environment. The profile still has to SELECT that gateway,
// and the keys below are the ones the pinned runtime actually reads. They were
// taken from the installed release (`HERMES_RECOMMENDED`, hermes-agent 0.21.3,
// commit 345cd2b0), not from assumption:
//
//   model.provider  hermes_cli/auth.py `_config_model_provider()` — rung 2 of
//                   `resolve_provider("auto")`, above every env-key and OAuth
//                   rung. `openai-api` is the registry's OpenAI-compatible
//                   api-key row: ("openai-api", "OpenAI API",
//                   "https://api.openai.com/v1", ("OPENAI_API_KEY",),
//                   "OPENAI_BASE_URL").
//   model.default   hermes_cli/auth_model_picker.py `_save_model_choice()`;
//                   every runtime reader spells it `model_cfg.get("default")`
//                   (hermes_cli/runtime_provider.py `_effective_model`).
//   model.base_url  hermes_cli/auth.py `_config_model_provider()`. The launch
//                   env `OPENAI_BASE_URL` also overrides the provider default
//                   (agent/client_lifecycle.py `_resolve_env_credentials`:
//                   `base_url = env_url or default_base`); writing it here too
//                   means a CLI path that never sees the launch env still
//                   resolves the gateway rather than api.openai.com.
//   model.api_mode  hermes_cli/runtime_provider.py `_configured_api_mode()`.
//                   Pinned deliberately: the `openai-api` overlay declares
//                   transport `codex_responses` (hermes_cli/providers.py
//                   HERMES_OVERLAYS), and `_detect_api_mode_for_url` only
//                   mandates Responses for official OpenAI hosts — so without
//                   this key the worker would POST /responses to a gateway that
//                   publishes an OpenAI-compatible /chat/completions surface.
//
// Nothing here edits Hermes source: this is the same profile-file write the
// bridge's manual attach already performs, through the same admitted helpers.
export const MANAGED_MODEL_PROVIDER = "openai-api";
export const MANAGED_MODEL_API_MODE = "chat_completions";
/** The gateway's own router entry: it picks an eligible model per turn. Proven
 * by live-usage QA settling a receipt against `/v1/chat/completions`. Written
 * only when the profile names no model, so an office choice is never replaced. */
export const MANAGED_MODEL_DEFAULT = "auto";
/** The one profile `.env` name that can shadow the launch-env grant: upstream
 * `agent/credential_pool.get_env_prefer_dotenv()` prefers the profile dotenv
 * over `os.environ`, so a stale line there would win over the granted key. */
export const MANAGED_MODEL_ENV_KEY = "OPENAI_API_KEY";

export interface ManagedModelProfile {
  provider: string | null;
  model: string | null;
  baseUrl: string | null;
  apiMode: string | null;
  /** True while a `.env` line could still shadow the granted key. */
  envKeyPresent: boolean;
}

function modelField(block: string | null, key: string): string | null {
  if (!block) return null;
  const raw = new RegExp(`^[ \\t]+${key}:\\s*(.+?)\\s*$`, "m").exec(block)?.[1];
  if (!raw) return null;
  const unquoted = /^(['"])([\s\S]*)\1$/.exec(raw);
  const value = (unquoted ? unquoted[2] : raw).trim();
  return value ? value : null;
}

/** What the profile currently selects, for readiness. Never returns a secret. */
export function managedModelProfile(root?: string): ManagedModelProfile {
  const dir = propertyProfileDir(root);
  const block = yamlBlock(readIf(join(dir, "config.yaml")).replace(/\r\n/g, "\n"), "model");
  return {
    provider: modelField(block, "provider"),
    model: modelField(block, "default"),
    baseUrl: modelField(block, "base_url"),
    apiMode: modelField(block, "api_mode"),
    envKeyPresent: new RegExp(`^${MANAGED_MODEL_ENV_KEY}=.+`, "m").test(readIf(join(dir, ".env"))),
  };
}

export interface ManagedModelApply {
  provider: string;
  apiMode: string;
  baseUrl: string;
  model: string | null;
  /** Receipt fact: a stale `.env` key existed and was removed by this apply. */
  envKeyRemoved: boolean;
  appliedAt: string;
}

/**
 * Point the worker profile at the provisioned gateway.
 *
 * The `.env` key is dropped FIRST, so there is never a moment where the profile
 * names the gateway while a stale provider key still outranks the granted one.
 * The granted key itself is never written here — it exists only in the private
 * vault and in the environment of one worker launch.
 *
 * An existing `model.default` is preserved: it is the office's own last choice.
 * Only when the profile names none does this write `auto`, the gateway's own
 * router entry, so a fresh computer is ready without a second setup step.
 */
export function applyManagedModelProfile(baseUrl: string, opts?: { root?: string; model?: string }): ManagedModelApply {
  const url = String(baseUrl ?? "").trim();
  if (!/^https?:\/\/[^\s"']+$/.test(url) || url.length > 2_048) {
    throw new Error("The model access for this computer needs recovery. Contact service support.");
  }
  const dir = propertyProfileDir(opts?.root);
  ensureProfileDirectory(dir);
  const envKeyRemoved = removeManagedEnvKey(dir);

  const configPath = join(dir, "config.yaml");
  const existing = readProfileFile(configPath);
  const raw = existing?.toString("utf8") ?? "";
  const model = opts?.model?.trim()
    || modelField(yamlBlock(raw.replace(/\r\n/g, "\n"), "model"), "default")
    || MANAGED_MODEL_DEFAULT;
  const block =
    "model:\n" +
    `  default: ${model}\n` +
    `  provider: ${MANAGED_MODEL_PROVIDER}\n` +
    `  base_url: ${JSON.stringify(url)}\n` +
    `  api_mode: ${MANAGED_MODEL_API_MODE}\n`;
  writeProfileFile(configPath, withYamlBlock(raw, "model", block), true, existing);
  return {
    provider: MANAGED_MODEL_PROVIDER, model, baseUrl: url, apiMode: MANAGED_MODEL_API_MODE,
    envKeyRemoved, appliedAt: new Date().toISOString(),
  };
}

/** Drop any `OPENAI_API_KEY` line from the profile `.env`, keeping every other
 * line. Returns whether one was there to remove. */
export function removeManagedEnvKey(profileDir: string): boolean {
  const envPath = join(profileDir, ".env");
  const before = readProfileFile(envPath);
  if (!before) return false;
  const body = before.toString("utf8");
  const kept = body.replace(/\r\n/g, "\n").split("\n").filter(line => !new RegExp(`^${MANAGED_MODEL_ENV_KEY}=`).test(line));
  const next = kept.join("\n").replace(/\n+$/, "");
  const rewritten = next ? `${next}\n` : "";
  if (rewritten === body) return false;
  writeProfileFile(envPath, rewritten, true, before);
  return true;
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
      maxTurns >= 60 && learningPolicyReady(root)
    );
  } catch {
    return false;
  }
}
