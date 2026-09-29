import { currentWorkerProfile } from "./hermes-profile.ts";
// Install the locked `property` profile into a Hermes home. File copy only —
// we never edit Hermes source or launch Hermes.app.
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { Document, isMap, isSeq, parseDocument, YAMLMap } from "yaml";

import { ensureProfileDirectories, ensureProfileDirectory, readProfileFile, readProfileFiles, writeProfileFile, writeProfileFiles, type ProfileFileWrite } from "./hermes-profile-storage.ts";
import { HERMES_PIN } from "./hermes-pin.ts";
import { hermesHome, runtimeCli } from "./hermes-paths.ts";
import { readRuntimeSelection, releaseHome, runtimeCommit, selectedHermesCli } from "./hermes-runtime-selection.ts";
import { DEFAULT_MANAGED_MODEL_CHOICE, managedModelChoice, managedModelChoiceFor, managedModelChoiceKeepingModel, type ManagedModelChoiceId, type ManagedReasoningEffort } from "../shared/managed-model-choices.ts";
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

/** An empty owned-home root prevents fallback to personal Hermes auth. Returned
 * rather than written so an apply can publish it in the same batch as the pack. */
function pendingRootAuth(root?: string): ProfileFileWrite | null {
  const path = join(hermesHome(root), "auth.json");
  if (readProfileFile(path) !== null) return null;
  return { path, bytes: `${JSON.stringify({ version: 1, providers: {}, credential_pool: {} }, null, 2)}\n`, overwrite: false };
}

function ensurePrivateRootAuth(root?: string): void {
  const pending = pendingRootAuth(root);
  if (pending) writeProfileFiles([pending]);
}

const PROFILE_FILES = ["SOUL.md", "config.yaml", "distribution.yaml", "profile.yaml", ".env"];

type SkillPlan = { dirs: string[]; files: Array<{ from: string; to: string }> };

/** The whole profile chain and its existing policy/credential files are
 * admitted in two PowerShell processes rather than eight: the directories do
 * not gate each other once their root is admitted, and no read gates another.
 *
 * A caller that already knows the skill tree it is about to install passes it
 * here, so the skill directories join the same two processes and the skill
 * files join the same read, instead of paying for two more cold PowerShell
 * launches of their own. The plan is computed from the read-only shipped pack
 * and names nothing in the destination that is not created under an admitted
 * root, so the protect-the-root-before-creating-descendants rule is unchanged. */
function prepareProfile(root?: string, skills?: SkillPlan): { dir: string; config: Buffer | null; skills: Array<Buffer | null> } {
  const home = hermesHome(root), dest = propertyProfileDir(root);
  ensureProfileDirectories([home, join(home, "profiles"), dest, ...(skills?.dirs ?? [])]);
  // Existing RealBud-owned policy/credential files are admission-only here.
  // Upstream-managed auth/memory files retain their native ownership contract.
  const existing = readProfileFiles([
    ...PROFILE_FILES.map(name => join(dest, name)),
    ...(skills?.files ?? []).map(file => file.to),
  ]);
  return {
    dir: dest,
    config: existing[PROFILE_FILES.indexOf("config.yaml")] ?? null,
    skills: existing.slice(PROFILE_FILES.length),
  };
}

function skillPlan(source: string, destination: string, plan: SkillPlan, depth = 0): void {
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

/** `existing` is what `prepareProfile` already read for `plan.files`, in order:
 * every destination directory was admitted before any file in it was read, and
 * a linked or foreign one refused before anything was created. */
function prepareSkillCopies(plan: SkillPlan, existing: Array<Buffer | null>): Array<{ path: string; body: Buffer }> {
  if (existing.length !== plan.files.length) throw new Error("Bud’s skill pack needs recovery before it can be installed.");
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

/**
 * Hermes' bundled skills that Bud's worker must neither list nor load: every
 * name in the bundled `skills/` tree of the admitted releases (0.21.0 29112bef,
 * 0.21.2 939e45c9 and 0.21.3 345cd2b0 ship the same 58) except `hermes-agent`
 * (upstream ESSENTIAL_SKILLS, never disableable), `pdf`, `xlsx` and `docx`.
 *
 * `skills.disabled` is enforced by Hermes itself: the system-prompt skill index
 * drops these names (agent/prompt_builder.py `_build_skills_system_prompt_inner`),
 * `skills_list` omits them and `skill_view` refuses them (tools/skills_tool.py
 * `_find_all_skills`, `skill_view`). Upstream has no allowlist key. The
 * `.no-bundled-skills` marker is not used: it only limits seeding to the
 * essential set (tools/skills_sync.py `sync_skills`), so it would withhold
 * pdf/xlsx/docx from a new profile and still list what an existing one has.
 * RealBud's pack skills, `realbud-*` customer-pack skills and an office's own
 * learned skills are not upstream names and stay visible. Promoting a release
 * whose bundle differs needs this list reviewed again.
 */
export const OFF_SCOPE_BUNDLED_SKILLS: readonly string[] = [
  "airtable", "apple-notes", "apple-reminders", "architecture-diagram", "arxiv", "ascii-video", "baoyu-infographic",
  "blocked-page-recovery", "box", "claude-code", "claude-design", "codebase-inspection", "codex", "competitor-news-monitor",
  "computer-use", "design-md", "document-to-action-items", "dogfood", "email-inbox-triage", "findmy", "gif-search", "github",
  "google-workspace", "grounded-citations", "hermes-agent-skill-authoring", "himalaya", "humanizer", "imessage",
  "inspecting-hermes-desktop-dom", "llm-wiki", "manim-video", "maps", "meeting-action-items", "node-inspect-debugger",
  "notion", "obsidian", "opencode", "p5js", "popular-web-designs", "powerpoint", "product-price-monitor", "python-debugpy",
  "requesting-code-review", "sdlc-review", "simplify-code", "songsee", "songwriting-and-ai-music", "spike",
  "systematic-debugging", "teams-meeting-pipeline", "test-driven-development", "weekly-review-planning", "xurl",
  "youtube-content",
];

const UNREADABLE_LEARNING = "Bud’s learning settings could not be read. The existing file has been kept.";

/** `skills.disabled` as upstream reads it (agent/skill_utils.py
 * `parse_config_string_list`): a sequence, or a string holding one name or the
 * list literal `hermes config set` writes. Anything else is unreadable policy. */
function disabledSkillNames(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  let items: unknown[] | null = null;
  if (isSeq(value)) items = value.toJSON() as unknown[];
  else if (typeof value === "string") {
    const text = value.trim();
    for (const candidate of text.startsWith("[") ? [text, text.replace(/'/g, "\"")] : []) {
      try { const parsed: unknown = JSON.parse(candidate); if (Array.isArray(parsed)) { items = parsed; break; } } catch { /* not a list literal */ }
    }
    items ??= [text];
  }
  if (!items || !items.every(item => typeof item === "string" || typeof item === "number")) throw new Error(UNREADABLE_LEARNING);
  return items.map(item => String(item).trim()).filter(Boolean);
}

/** Replace only RealBud-owned policy blocks; keep all other upstream settings. */
export function mergePropertyPolicy(existing: string, defaults: string): string {
  const result = policyDocument(existing.trim() ? existing : defaults);
  const policy = policyDocument(defaults);
  const keys = ["approvals", "agent", "toolsets", "security", "delegation", "terminal", "file_read_max_chars", "tool_output", "tool_loop_guardrails"];
  // The office's managed model choice is the one `agent` key that is not
  // policy. Carry it through the policy rewrite only while it still pairs with
  // the saved model as one of the three choices (never Flash with `xhigh`).
  const savedEffort = result.getIn(["agent", "reasoning_effort"]);
  const keepEffort = managedModelChoiceFor(result.getIn(["model", "default"]), savedEffort) ? savedEffort : null;
  for (const key of keys) {
    if (policy.has(key)) result.set(key, policy.get(key));
  }
  if (keepEffort && isMap(result.get("agent"))) result.setIn(["agent", "reasoning_effort"], keepEffort);
  // Own the write gate and a floor of hidden upstream skills; retain memory
  // preferences and any further skills the office has hidden itself.
  for (const key of ["skills", "memory", "auxiliary", "browser"]) {
    if (result.has(key) && !isMap(result.get(key))) throw new Error(UNREADABLE_LEARNING);
    // YAML 1.1 setIn creates !!omap for missing parents; PyYAML reads that as
    // a sequence, so Hermes would lose these policy gates. Create plain maps.
    if (!result.has(key)) result.set(key, new YAMLMap(result.schema));
  }
  for (const key of ["skills", "memory"]) result.setIn([key, "write_approval"], true);
  const disabled = new Set([...disabledSkillNames(result.getIn(["skills", "disabled"])), ...OFF_SCOPE_BUNDLED_SKILLS]);
  result.setIn(["skills", "disabled"], result.createNode([...disabled].sort()));
  result.setIn(["auxiliary", "background_review"], policy.getIn(["auxiliary", "background_review"]));
  // Owned whole: with titles off, the rest of the block (provider, model) is unused.
  if (policy.hasIn(["auxiliary", "title_generation"])) result.setIn(["auxiliary", "title_generation"], policy.getIn(["auxiliary", "title_generation"]));
  // Portal work goes through RealBud's own fenced browser, and the person signs
  // in themselves; Ask and its subagents get no Hermes browser or credential
  // vault. Hermes 0.21.3 ACP ignores `agent.disabled_toolsets`, so these keys
  // keep its availability check (tools/browser_tool_install.py
  // `check_browser_requirements`, which also gates browser_vault_*) from being
  // satisfied by settings. Other browser settings stay the office's.
  for (const [key, value] of Object.entries(WORKER_BROWSER_POLICY)) result.setIn(["browser", key], value);
  return result.toString();
}

/** Owned `browser.*` keys. `backend: off` stops Browser Use mode (`browser_exec`
 * plus the vault, which Hermes enables whenever `uvx` runs). `cloud_provider:
 * local` is the definitive local selection: no cloud browser auto-detected from
 * a key and no Camofox from `CAMOFOX_URL`. An empty `cdp_url` never attaches to
 * an already-running browser. `engine: chrome` rules out Lightpanda, which is
 * advertised with no Chromium on disk. `use_real_profile: false` never copies
 * the person's own signed-in browser profile. The worker environment
 * (drivers/acp/hermes.ts) drops the matching overrides. */
export const WORKER_BROWSER_POLICY = {
  backend: "off",
  cloud_provider: "local",
  cdp_url: "",
  engine: "chrome",
  use_real_profile: false,
} as const;

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

/** The worker limits every install writes, checked against the parsed config
 * so a profile from before they existed reads as needing Repair (which writes
 * them) rather than as unsafe. Keys verified in the pinned runtime's
 * hermes_cli/config_defaults.py (0.21.3); older supported releases ignore the
 * ones they lack. Tighter values than the pack's are accepted. */
export function workerLimitsReady(root?: string): boolean {
  try {
    const doc = policyDocument(readFileSync(join(propertyProfileDir(root), "config.yaml"), "utf8"));
    const cap = (key: string, max: number) => {
      const value = doc.getIn(["tool_loop_guardrails", "loop_caps", key]);
      // Upstream reads 0 as unlimited, so a cap must be a positive integer.
      return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= max;
    };
    const ratio = doc.getIn(["agent", "budget_warning_ratio"]);
    return doc.getIn(["auxiliary", "title_generation", "enabled"]) === false &&
      doc.getIn(["security", "allow_lazy_installs"]) === false &&
      Object.entries(WORKER_BROWSER_POLICY).every(([key, value]) => doc.getIn(["browser", key]) === value) &&
      cap("max_web_searches", 10) && cap("max_subagents", 4) &&
      typeof ratio === "number" && ratio > 0 && ratio < 1;
  } catch { return false; }
}

/** Every off-scope bundled skill is hidden, as a real sequence: upstream's
 * `skill_view` gate tests `name in skills.disabled`, which on a string is a
 * substring match. A profile from before this floor reads as needing Repair;
 * further hidden skills are accepted. */
export function skillScopeReady(root?: string): boolean {
  try {
    const value = policyDocument(readFileSync(join(propertyProfileDir(root), "config.yaml"), "utf8")).getIn(["skills", "disabled"]);
    if (!isSeq(value)) return false;
    const names = new Set(disabledSkillNames(value));
    return OFF_SCOPE_BUNDLED_SKILLS.every(name => names.has(name));
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
  const skillsFrom = join(PACK_DIR, "skills");
  // Plan the skill tree from the read-only shipped pack before anything in the
  // destination is admitted: the plan touches only `PACK_DIR`, so its
  // destination directories and files can share the profile's own admission
  // processes instead of paying for two more cold PowerShell launches.
  const plan: SkillPlan | undefined = existsSync(skillsFrom)
    ? (() => { const built: SkillPlan = { dirs: [], files: [] }; skillPlan(skillsFrom, join(propertyProfileDir(root), "skills"), built); return built; })()
    : undefined;
  // `prepareProfile` has already admitted and read `config.yaml`; re-reading it
  // here would only cost another cold PowerShell process on Windows.
  const { dir: dest, config: existingBytes, skills: existingSkills } = prepareProfile(root, plan);
  const defaults = policyDocument(readFileSync(join(PACK_DIR, "config.yaml"), "utf8"));
  defaults.setIn(["auxiliary", "background_review", "enabled"], stagedLearningSupported(root));
  const config = mergePropertyPolicy(existingBytes?.toString("utf8") ?? "", defaults.toString());
  const skillCopies = plan ? prepareSkillCopies(plan, existingSkills) : [];
  const wrote: string[] = [];
  // Every destination directory here is already admitted and every existing
  // destination file already read, so the whole pack publishes in one batch:
  // three PowerShell processes for the set rather than three per file. The
  // order is the order these were written one at a time.
  const entries: ProfileFileWrite[] = [];
  const auth = pendingRootAuth(root);
  if (auth) entries.push(auth);

  for (const name of ["SOUL.md", "config.yaml", "distribution.yaml", "profile.yaml"]) {
    const from = join(PACK_DIR, name);
    if (!existsSync(from)) continue;
    let body = readFileSync(from, "utf8");
    if (name === "config.yaml") body = config;
    entries.push({ path: join(dest, name), bytes: body, expected: name === "config.yaml" ? existingBytes : undefined });
    wrote.push(name);
  }
  if (plan) {
    for (const file of skillCopies) entries.push({ path: file.path, bytes: file.body, overwrite: false });
    wrote.push("skills/");
  }
  writeProfileFiles(entries);
  return { dir: dest, wrote };
}

// ── managed model attach (provisioned installations) ─────────────────────────
//
// RealBud is managed-only: every office reasons through its paired Modelvia
// grant, with one of the three choices in `shared/managed-model-choices.ts`.
// The key reaches the worker only through the launch environment; the profile
// SELECTS the gateway. Every key below was taken from the installed release
// (`HERMES_RECOMMENDED`, hermes-agent 0.21.3, commit 345cd2b0) and proven by
// `server/managed-model-wire.native.test.ts` against the real CLI:
//
//   model.provider  `custom:realbud` names the `providers.realbud` entry
//                   (hermes_cli/runtime_provider_custom.py
//                   `_get_named_custom_provider`). It resolves to the `custom`
//                   runtime, whose provider profile
//                   (plugins/model-providers/custom) is the one that puts
//                   top-level `reasoning_effort` on the wire. The earlier
//                   `openai-api` row never sends it (agent/transports/
//                   chat_completions.py), so `sonnet-xhigh` was unreachable.
//   providers.realbud.key_env
//                   `_resolve_named_custom_runtime` reads the key from the env
//                   var this names, BEFORE the host-gated fallbacks. Without it
//                   a bare custom endpoint derives a key name from the host
//                   (`_host_derived_api_key`: nothing for localhost/IPs, and
//                   OPENAI_API_KEY only for openai.com), so one fixed name
//                   works for any granted gateway host.
//   providers.realbud.api_mode
//                   `chat_completions`: the gateway publishes an
//                   OpenAI-compatible /chat/completions surface.
//   agent.reasoning_effort
//                   hermes_constants.py `resolve_reasoning_config`, clamped by
//                   the custom profile to OPENAI_COMPAT_WIRE_EFFORTS (which
//                   includes `xhigh`). `mergePropertyPolicy` carries it through
//                   a policy rewrite while it still pairs with the saved model.
//
// Nothing here edits Hermes source: this is a profile-file write through the
// same admitted helpers the pack install uses.
export const MANAGED_MODEL_PROVIDER = "custom:realbud";
/** The `providers:` entry `MANAGED_MODEL_PROVIDER` names. */
export const MANAGED_MODEL_PROVIDER_ENTRY = "realbud";
export const MANAGED_MODEL_API_MODE = "chat_completions";
/** The one env name the worker reads the granted key from. RealBud-owned, so
 * no ambient provider variable can stand in for the grant. */
export const MANAGED_MODEL_KEY_ENV = "REALBUD_MODEL_API_KEY";
/** Profile `.env` names that could shadow or stand in for the launch-env
 * grant: upstream prefers the profile dotenv over `os.environ`, so a stale
 * line would win over the granted key. `OPENAI_API_KEY` is the pre-29-Sep
 * managed name and older manual attaches. */
export const MANAGED_MODEL_ENV_KEYS = [MANAGED_MODEL_KEY_ENV, "OPENAI_API_KEY"] as const;

export interface ManagedModelProfile {
  provider: string | null;
  model: string | null;
  baseUrl: string | null;
  apiMode: string | null;
  keyEnv: string | null;
  reasoningEffort: string | null;
  /** The saved (model, effort) pair as one of the three choices, else null. */
  choice: ManagedModelChoiceId | null;
  /** True while a `.env` line could still shadow the granted key. */
  envKeyPresent: boolean;
}

function scalarText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function envKeyPattern(): RegExp {
  return new RegExp(`^(?:export\\s+)?(?:${MANAGED_MODEL_ENV_KEYS.join("|")})\\s*=`);
}

/** What the profile currently selects, for readiness. Never returns a secret. */
export function managedModelProfile(root?: string): ManagedModelProfile {
  const dir = propertyProfileDir(root);
  let parsed: Record<string, unknown> = {};
  // The same strict reader the writer uses: a damaged or duplicate-key config
  // reads as nothing selected, never as a choice the writer would refuse.
  try {
    const raw = readIf(join(dir, "config.yaml"));
    const value = raw.trim() ? policyDocument(raw).toJS({ maxAliasCount: 50 }) : null;
    if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>;
  } catch { /* unreadable config reads as nothing selected */ }
  const section = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const model = section(parsed.model), agent = section(parsed.agent);
  const entry = section(section(parsed.providers)[MANAGED_MODEL_PROVIDER_ENTRY]);
  const modelId = scalarText(model.default), effort = scalarText(agent.reasoning_effort);
  return {
    provider: scalarText(model.provider),
    model: modelId,
    baseUrl: scalarText(entry.base_url),
    apiMode: scalarText(entry.api_mode),
    keyEnv: scalarText(entry.key_env),
    reasoningEffort: effort,
    choice: managedModelChoiceFor(modelId, effort),
    envKeyPresent: readIf(join(dir, ".env")).replace(/\r\n/g, "\n").split("\n").some(line => envKeyPattern().test(line.trim())),
  };
}

export interface ManagedModelApply {
  provider: string;
  apiMode: string;
  baseUrl: string;
  choice: ManagedModelChoiceId;
  model: string;
  reasoningEffort: ManagedReasoningEffort;
  keyEnv: string;
  /** Receipt fact: a stale `.env` key existed and was removed by this apply. */
  envKeyRemoved: boolean;
  appliedAt: string;
}

/** The profile config with the managed selection written in. Other settings,
 * including comments, are kept; the `model` and `providers` sections are
 * owned whole, so no leftover provider can be selected beside the grant. */
export function managedModelConfig(raw: string, baseUrl: string, choiceId: ManagedModelChoiceId): string {
  const choice = managedModelChoice(choiceId);
  const doc: Document = raw.trim() ? policyDocument(raw) : new Document({}, { version: "1.1" });
  if (doc.has("agent") && !isMap(doc.get("agent"))) throw new Error("Bud’s profile has unreadable or duplicate settings. The existing file has been kept.");
  doc.set("model", doc.createNode({ default: choice.model, provider: MANAGED_MODEL_PROVIDER }));
  doc.set("providers", doc.createNode({
    [MANAGED_MODEL_PROVIDER_ENTRY]: { base_url: baseUrl, key_env: MANAGED_MODEL_KEY_ENV, api_mode: MANAGED_MODEL_API_MODE },
  }));
  if (!doc.has("agent")) doc.set("agent", new YAMLMap(doc.schema));
  doc.setIn(["agent", "reasoning_effort"], choice.effort);
  return doc.toString();
}

/**
 * Point the worker profile at the provisioned gateway with one of the three
 * choices.
 *
 * The new config is built and validated first; then the `.env` keys are
 * dropped before the config is written, so there is never a moment where the
 * profile names the gateway while a stale provider key still outranks the
 * granted one. The granted key itself is never written here — it exists only
 * in the private vault and in the environment of one worker launch.
 *
 * Without an explicit choice the office's saved choice is kept. A profile that
 * holds no valid choice — including the earlier `auto` router entry or a
 * retired model id — moves to `flash-high`.
 */
export function applyManagedModelProfile(baseUrl: string, opts?: { root?: string; choice?: ManagedModelChoiceId }): ManagedModelApply {
  const url = String(baseUrl ?? "").trim();
  if (!/^https?:\/\/[^\s"']+$/.test(url) || url.length > 2_048) {
    throw new Error("The model access for this computer needs recovery. Contact service support.");
  }
  const dir = propertyProfileDir(opts?.root);
  ensureProfileDirectory(dir);
  const configPath = join(dir, "config.yaml");
  const existing = readProfileFile(configPath);
  const raw = existing?.toString("utf8") ?? "";
  const saved = managedModelProfile(opts?.root);
  const choiceId = opts?.choice ?? saved.choice ?? managedModelChoiceKeepingModel(saved.model) ?? DEFAULT_MANAGED_MODEL_CHOICE;
  const choice = managedModelChoice(choiceId);
  // Build and validate first: a damaged config is refused before anything,
  // including the `.env`, changes.
  const next = managedModelConfig(raw, url, choiceId);
  const envKeyRemoved = removeManagedEnvKey(dir);
  writeProfileFile(configPath, next, true, existing);
  return {
    provider: MANAGED_MODEL_PROVIDER, apiMode: MANAGED_MODEL_API_MODE, baseUrl: url,
    choice: choiceId, model: choice.model, reasoningEffort: choice.effort, keyEnv: MANAGED_MODEL_KEY_ENV,
    envKeyRemoved, appliedAt: new Date().toISOString(),
  };
}

/** Drop every managed-key line (`MANAGED_MODEL_ENV_KEYS`) from the profile
 * `.env`, keeping every other line. Returns whether one was there to remove. */
export function removeManagedEnvKey(profileDir: string): boolean {
  const envPath = join(profileDir, ".env");
  const before = readProfileFile(envPath);
  if (!before) return false;
  const body = before.toString("utf8");
  const kept = body.replace(/\r\n/g, "\n").split("\n").filter(line => !envKeyPattern().test(line.trim()));
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
      maxTurns >= 60 && learningPolicyReady(root) && workerLimitsReady(root) && skillScopeReady(root)
    );
  } catch {
    return false;
  }
}
