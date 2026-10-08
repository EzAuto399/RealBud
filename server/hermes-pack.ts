import { currentWorkerProfile } from "./hermes-profile.ts";
// Install the locked `property` profile into a Hermes home. File copy only —
// we never edit Hermes source or launch Hermes.app.
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { Document, isMap, isScalar, isSeq, parseDocument, visit, YAMLMap } from "yaml";

import { ensureProfileDirectories, ensureProfileDirectory, readProfileFile, readProfileFiles, writeProfileFile, writeProfileFiles, type ProfileFileWrite } from "./hermes-profile-storage.ts";
import { HERMES_PIN } from "./hermes-pin.ts";
import { HERMES_RELEASES } from "./hermes-releases.ts";
import { hermesHome, runtimeCli } from "./hermes-paths.ts";
import { readRuntimeSelection, releaseHome, runtimeCommit, selectedHermesCli } from "./hermes-runtime-selection.ts";
import { DEFAULT_MANAGED_MODEL_CHOICE, MANAGED_VISION_CHOICE, managedModelChoice, managedModelChoiceFor, managedModelChoiceKeepingModel, type ManagedModelChoice, type ManagedModelChoiceId, type ManagedReasoningEffort } from "../shared/managed-model-choices.ts";
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

/** Private record of the SOUL/skill digests RealBud shipped into this profile,
 * so a later pack replaces only files the office never changed. */
const SHIPPED_RECORD = ".realbud-shipped.json";
const PROFILE_FILES = ["SOUL.md", "config.yaml", "distribution.yaml", "profile.yaml", ".env", SHIPPED_RECORD];

/** Bytes shipped before the record existed (every git revision of these files),
 * so offices installed earlier still upgrade. Files with one revision need none. */
const LEGACY_SHIPPED: Readonly<Record<string, readonly string[]>> = {
  "SOUL.md": [
    "480d8565062a9cd91f90a8069787fbd65d75b63707192f5757ebf03035896ff7", "79fa105a2e33d234cee0fe9ec69a3889874218f100ff3aae961001646eed4025",
    "87e7cf2b510adff407e3f4ce092bc1f551ae8cc98e891f318abfce1707b0754c", "a66ff693e675383f53103c5233b34a745509968ef4dacc9fde8d39576e4109d6",
    "ab939a24fd3d4f71d5d68c390b3191950b090acd8610a7b72c19f89eb335e46d", "b0edfaea1858037f65cf2e80b21562d6a505d8a4777a91ea01c3767ad82f890c",
    "c7dcdea8b878e366db9b82c8663a7db90c7bdc9de1491a0bd41735cea59b1d54", "d98188e07093c803576c1690985573336a5bfbd54edc91d94a960f6638603a9f",
    // Last property-management SOUL (2026-10-07), so a profile with a damaged record still takes the neutral one.
    "1aee1058db6dec321da6791c5575f86799f58748321b2fad80f17c4e5a7b7c44",
    // Neutral SOUL before Bud could propose a workflow's new time (2026-10-08).
    "e7991443b5d1bc198277b04845090ca13dccf0d617df4758fce79e8d024faa04",
  ],
  "skills/morning-arrears/SKILL.md": ["f52e1dc7954e750eada6b35d97e367c3c9a2bb5488947694968c53447e8ba1df"],
};

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
type ShippedRecord = { pack: string; files: Record<string, string[]> };

/** A missing or damaged record only means fewer files count as unchanged. */
function readShippedRecord(bytes: Buffer | null): ShippedRecord {
  try {
    const parsed: unknown = JSON.parse(bytes?.toString("utf8") ?? "");
    if (parsed && typeof parsed === "object" && typeof (parsed as ShippedRecord).pack === "string") {
      const files: Record<string, string[]> = {};
      for (const [rel, list] of Object.entries((parsed as ShippedRecord).files ?? {})) {
        if (Array.isArray(list)) files[rel] = list.filter((d): d is string => typeof d === "string" && /^[0-9a-f]{64}$/.test(d));
      }
      return { pack: (parsed as ShippedRecord).pack, files };
    }
  } catch { /* fall through */ }
  return { pack: "", files: {} };
}

type ShippedFile = { rel: string; from: string; to: string; body: Buffer; digest: string };

/** SOUL.md plus the skill tree, read from the read-only shipped pack. */
function shippedPack(root?: string): { plan?: SkillPlan; files: ShippedFile[]; digest: string } {
  const dest = propertyProfileDir(root), skillsFrom = join(PACK_DIR, "skills");
  const plan: SkillPlan | undefined = existsSync(skillsFrom)
    ? (() => { const built: SkillPlan = { dirs: [], files: [] }; skillPlan(skillsFrom, join(dest, "skills"), built); return built; })()
    : undefined;
  const files = [{ from: join(PACK_DIR, "SOUL.md"), to: join(dest, "SOUL.md") }, ...(plan?.files ?? [])].map(({ from, to }) => {
    if (lstatSync(from).size > 2 * 1024 * 1024) throw new Error("Bud’s skill pack needs recovery before it can be installed.");
    const body = readFileSync(from);
    return { rel: relative(PACK_DIR, from).split(sep).join("/"), from, to, body, digest: sha256(body) };
  });
  return { plan, files, digest: sha256(Buffer.from(files.map(f => `${f.rel} ${f.digest}`).join("\n"))) };
}

/** Add missing shipped files; replace one only when its bytes are something
 * RealBud shipped before (or `forced`, e.g. SOUL on Repair). Office edits are
 * kept and named. `existing` is in `files` order, already read under admission. */
function shippedWrites(dest: string, files: ShippedFile[], existing: Array<Buffer | null>, recordBytes: Buffer | null, pack: string, forced: ReadonlySet<string>) {
  const record = readShippedRecord(recordBytes);
  const writes: ProfileFileWrite[] = [], wrote: string[] = [], kept: string[] = [];
  const next: Record<string, string[]> = { ...record.files };
  files.forEach((file, index) => {
    const known = record.files[file.rel] ?? [];
    next[file.rel] = [...new Set([...known, file.digest])];
    const current = existing[index] ?? null;
    if (current === null) writes.push({ path: file.to, bytes: file.body, overwrite: false });
    else if (sha256(current) === file.digest) return;
    else if (forced.has(file.rel)) writes.push({ path: file.to, bytes: file.body });
    else if ([...known, ...(LEGACY_SHIPPED[file.rel] ?? [])].includes(sha256(current))) writes.push({ path: file.to, bytes: file.body, expected: current });
    else { kept.push(file.rel); return; }
    wrote.push(file.rel);
  });
  const recordWrite: ProfileFileWrite = { path: join(dest, SHIPPED_RECORD), bytes: `${JSON.stringify({ pack, files: next }, null, 2)}\n`, expected: recordBytes };
  return { writes, wrote, kept, record: recordWrite };
}

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
function prepareProfile(root?: string, skills?: SkillPlan): { dir: string; soul: Buffer | null; config: Buffer | null; record: Buffer | null; skills: Array<Buffer | null> } {
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
    soul: existing[PROFILE_FILES.indexOf("SOUL.md")] ?? null,
    config: existing[PROFILE_FILES.indexOf("config.yaml")] ?? null,
    record: existing[PROFILE_FILES.indexOf(SHIPPED_RECORD)] ?? null,
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

/** Startup initializes a new profile. For an existing one it only brings
 * SOUL/skills up to a changed pack where the office left them as shipped;
 * config and everything else change through Repair. */
export function ensurePropertyPack(root?: string): { dir: string; wrote: string[]; kept: string[] } {
  if (!packInstalled(root)) return { ...applyPropertyPack(root), kept: [] };
  const { dir, record } = prepareProfile(root);
  ensurePrivateRootAuth(root);
  const shipped = shippedPack(root);
  if (readShippedRecord(record).pack === shipped.digest) return { dir, wrote: [], kept: [] };
  const { soul, record: recordBytes, skills } = prepareProfile(root, shipped.plan);
  const sync = shippedWrites(dir, shipped.files, [soul, ...skills], recordBytes, shipped.digest, new Set());
  writeProfileFiles([...sync.writes, sync.record]);
  if (sync.kept.length) console.info(`[pack] kept ${sync.kept.length} office-edited Bud file(s): ${sync.kept.join(", ")}`);
  return { dir, wrote: sync.wrote, kept: sync.kept };
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
 * 0.21.2 939e45c9, 0.21.3 345cd2b0 and 0.21.5 f97608f1 ship the same 58) except `hermes-agent`
 * (upstream ESSENTIAL_SKILLS, never disableable), `pdf`, `xlsx`, `docx` and the
 * office-work skills in `PREVIOUSLY_OFF_SCOPE_BUNDLED_SKILLS`.
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
  "box", "claude-code", "claude-design", "codebase-inspection", "codex", "competitor-news-monitor",
  "computer-use", "design-md", "dogfood", "email-inbox-triage", "findmy", "gif-search", "github",
  "google-workspace", "hermes-agent-skill-authoring", "himalaya", "imessage",
  "inspecting-hermes-desktop-dom", "llm-wiki", "manim-video", "maps", "node-inspect-debugger",
  "notion", "obsidian", "opencode", "p5js", "popular-web-designs", "product-price-monitor", "python-debugpy",
  "requesting-code-review", "sdlc-review", "simplify-code", "songsee", "songwriting-and-ai-music", "spike",
  "systematic-debugging", "teams-meeting-pipeline", "test-driven-development", "xurl",
  "youtube-content",
];

/** Bundled skills an earlier floor hid and Bud now lists. Each is instruction
 * text plus at most stdlib scripts: no credential, install, cron, browser or
 * outbound message is required (an optional key or browser step is skipped
 * when absent, and every external write stays behind the person's approval).
 * `powerpoint` (reopened 2026-10-02) creates, reads and edits local .pptx files
 * with python-pptx, which Repair installs from the reviewed lock
 * (server/hermes-document-deps.lock.json), never lazily; its optional render
 * step runs a local LibreOffice only when one is already installed.
 * Repair removes exactly these from an existing `skills.disabled` before
 * adding the floor, so any other name an office hid stays hidden. */
export const PREVIOUSLY_OFF_SCOPE_BUNDLED_SKILLS: readonly string[] = [
  "blocked-page-recovery", "document-to-action-items", "grounded-citations", "humanizer", "meeting-action-items",
  "powerpoint", "weekly-review-planning",
];

/** Skills earlier packs shipped in `skills/` and no longer do: `domain-intel`
 * (unused domain recon) and `intake-properties` (now the Auston pack's
 * `property-management` skill). Install never deletes profile files, so Repair
 * hides any copy left in an existing profile through `skills.disabled`. Not a
 * readiness requirement: a profile not yet repaired keeps working. */
export const RETIRED_PACK_SKILLS: readonly string[] = ["domain-intel", "intake-properties"];

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
  // the saved model as one of the four choices (never Flash with `xhigh`).
  const savedEffort = result.getIn(["agent", "reasoning_effort"]);
  const keepEffort = managedModelChoiceFor(result.getIn(["model", "default"]), savedEffort) ? savedEffort : null;
  for (const key of keys) {
    if (policy.has(key)) result.set(key, policy.get(key));
  }
  if (!isMap(result.get("approvals"))) throw new Error(UNREADABLE_PROFILE);
  result.setIn(["approvals", "deny"], result.createNode([...WORKER_DENIED_COMMANDS]));
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
  result.setIn(["skills", "guard_agent_created"], true);
  // Memory size floor: an office's larger limit stays, a smaller or unreadable one rises to the pack's.
  for (const key of ["memory_char_limit", "user_char_limit"]) {
    const floor = policy.getIn(["memory", key]), saved = result.getIn(["memory", key]);
    if (typeof floor === "number" && !(Number.isInteger(saved) && (saved as number) >= floor)) result.setIn(["memory", key], floor);
  }
  const reopened = new Set(PREVIOUSLY_OFF_SCOPE_BUNDLED_SKILLS);
  const officeHidden = disabledSkillNames(result.getIn(["skills", "disabled"])).filter(name => !reopened.has(name));
  const disabled = new Set([...officeHidden, ...OFF_SCOPE_BUNDLED_SKILLS, ...RETIRED_PACK_SKILLS]);
  result.setIn(["skills", "disabled"], result.createNode([...disabled].sort()));
  result.setIn(["auxiliary", "background_review"], policy.getIn(["auxiliary", "background_review"]));
  // Owned whole: with titles off, the rest of the block (provider, model) is unused.
  if (policy.hasIn(["auxiliary", "title_generation"])) result.setIn(["auxiliary", "title_generation"], policy.getIn(["auxiliary", "title_generation"]));
  // Portal work goes through RealBud's own fenced browser, and the person signs
  // in themselves; Ask and its subagents get no Hermes browser or credential
  // vault. 0.21.5 also drops the `browser` toolset (`WORKER_DISABLED_TOOLSETS`);
  // 0.21.3 ACP ignores that list, so these keys keep its availability check
  // (tools/browser_tool_install.py `check_browser_requirements`, which also
  // gates browser_vault_*) from being satisfied by settings. An `agent-browser`
  // CLI plus Chromium on PATH still satisfies it there, which the host's
  // native-browser refusal covers. Other browser settings stay the office's.
  for (const [key, value] of Object.entries(WORKER_BROWSER_POLICY)) result.setIn(["browser", key], value);
  // Own only the listed compression, curator, login-policy, ACP-selection and
  // keyless-web keys and the tool-search deferral list; every other setting in
  // those sections (other platforms' toolsets included) stays the office's.
  for (const key of ["compression", "curator", "tools", "auth", "platform_toolsets", "vault", "web"]) {
    if (result.has(key) && !isMap(result.get(key))) throw new Error(UNREADABLE_PROFILE);
    if (!result.has(key)) result.set(key, new YAMLMap(result.schema));
  }
  for (const [key, subkeys] of Object.entries(OWNED_SUBKEYS)) {
    for (const subkey of subkeys) if (policy.hasIn([key, subkey])) result.setIn([key, subkey], policy.getIn([key, subkey]));
  }
  const search = result.getIn(["tools", "tool_search"]);
  if (!isMap(search)) {
    // Upstream reads a bare `false` here as `enabled: off` and anything else as
    // auto (tools/tool_search.py `ToolSearchConfig.from_raw`); keep that meaning.
    const map = new YAMLMap(result.schema);
    if (search === false) map.set("enabled", "off");
    result.setIn(["tools", "tool_search"], map);
  }
  // Hermes Connectors stay off; the rest of `tools.connectors` stays the office's.
  if (!isMap(result.getIn(["tools", "connectors"]))) result.setIn(["tools", "connectors"], new YAMLMap(result.schema));
  result.setIn(["tools", "connectors", "enabled"], false);
  // No password-manager login source; the rest of each vault entry stays the office's.
  for (const name of WORKER_DISABLED_VAULTS) {
    if (!isMap(result.getIn(["vault", name]))) result.setIn(["vault", name], new YAMLMap(result.schema));
    result.setIn(["vault", name, "enabled"], false);
  }
  // Flow style: no block line in the profile reads like an enabled `- computer_use` toolset.
  result.setIn(["tools", "tool_search", "defer"], result.createNode([...WORKER_DEFERRED_TOOLS], { flow: true }));
  return result.toString();
}

const UNREADABLE_PROFILE = "Bud’s profile has unreadable or duplicate settings. The existing file has been kept.";

/** Sections where Install and Repair own only these keys, taken from the pack. */
const OWNED_SUBKEYS = {
  compression: ["min_tail_user_messages", "proactive_prune_tokens"],
  curator: ["enabled"],
  auth: ["adopt_external_logins"],
  platform_toolsets: ["acp"],
  web: ["keyless_fallback"],
} as const;

/** Owned `platform_toolsets.acp`: Ask's explicit selection, which Hermes 0.21.5
 * resolves per platform (acp_adapter/session.py `_make_agent` →
 * hermes_cli/tools_config.py `_get_platform_tools`) instead of 0.21.3's fixed
 * `hermes-acp`. hermes-acp's tools minus `WORKER_DISABLED_TOOLSETS`; `no_mcp`
 * keeps configured MCP servers out, while RealBud's per-turn ACP mounts still
 * join (acp_adapter/server.py `_register_session_mcp_servers`). */
export const WORKER_ACP_TOOLSETS = [
  "terminal", "file", "vision", "todo", "memory", "session_search", "skills", "delegation", "code_execution", "no_mcp",
] as const;

/** Owned `agent.disabled_toolsets` (inside the owned `agent` block): removed at
 * tool granularity from Ask, CLI jobs and every subagent, which inherits them
 * (tools/delegate_tool_toolsets.py `_resolve_child_toolsets`). Every name is a
 * toolset in both 0.21.3 and 0.21.5, so neither warns about an unknown name.
 * `setup` (`manage_catalog`) is not listed: 0.21.3 has no such toolset, and
 * 0.21.5 strips it from every profile without `role: setup`, which the pack's
 * profile.yaml never declares. 0.21.3 ACP ignores this list; there the host
 * refuses a native browser call (drivers/acp/core.ts `hermesNativeBrowserTool`).
 * `web` (web_search, web_extract, and web_search in `search`): on macOS the
 * worker sandbox allows no outbound connection, so both always failed; where
 * there is no sandbox, Hermes' keyless tier would send office queries to free
 * third-party services (`web.keyless_fallback`, also owned off). Bud reads
 * public pages through RealBud's `read_page` (server/web-research-broker.ts).
 * A search provider needs a billed account and is a separate decision. */
export const WORKER_DISABLED_TOOLSETS = ["browser", "computer_use", "connections", "cronjob", "image_gen", "kanban", "tts", "web"] as const;

/** Tools Bud uses on most jobs that upstream defers behind `tool_search` by
 * default (tools/tool_search.py `_DEFAULT_DEFERRED_TOOLS`, 0.21.3 and 0.21.5). */
export const WORKER_DIRECT_TOOLS = ["todo_list", "session_search", "process_manage"] as const;

/** Owned `tools.tool_search.defer`. An explicit list replaces upstream's
 * curated default wholesale, so this is that default (0.21.3) minus
 * `WORKER_DIRECT_TOOLS`: core tools defer only when named, so those three
 * become directly visible, and MCP and plugin tools still defer as before.
 * 0.21.5's default is the same set without `setup_mcp`, a tool it no longer
 * has; naming it there defers nothing. Promoting a release whose default
 * differs needs this list reviewed again. */
export const WORKER_DEFERRED_TOOLS = [
  "computer_use", "image_generate", "cronjob_manage",
  "drive_preview", "gui_tour", "desktop_preview", "annotate_preview", "show_tip", "setup_mcp", "desktop_project",
  "close_terminal", "apply_layout", "read_terminal", "read_window_below", "focus_pane",
] as const;

/** Owned `vault.<name>.enabled: false`. Hermes 0.21.5 defaults both to true
 * and, in 0.21.3 and 0.21.5 alike, treats an installed `op`/`bw` CLI as a login
 * source unless the value is exactly `False` (agent/vault_backends/base.py
 * `is_enabled`). Credentials never pass through Bud. */
export const WORKER_DISABLED_VAULTS = ["onepassword", "bitwarden"] as const;

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

/** Programs Bud's terminal may never start, at the start of a command or after
 * any separator (`;`, `|`, `&&`, `$(`, a path `/`), with or without `.exe`. */
const DENIED_PROGRAMS = [
  "curl", "wget", "nc", "ncat", "netcat", "ssh", "scp", "sftp", "rsync", "ftp", "telnet", "socat",
  "invoke-webrequest", "iwr", "invoke-restmethod", "irm", "certutil", "bitsadmin", "osascript", "pwsh", "powershell",
] as const;
/** Inline code an interpreter would run without a reviewable file. */
const DENIED_INLINE_CODE = ["python* -c *", "node -e *", "node --eval *", "perl -e *", "ruby -e *"] as const;

/** Owned `approvals.deny`: fnmatch globs Hermes checks before any approval
 * mode, yolo included, lower-cased and over its de-obfuscated variants, against
 * the WHOLE command (tools/approval_floors.py `_match_user_deny_rule`). This
 * is a blocklist, not a guarantee: a renamed binary, a script file or a tab
 * separator gets past it. The boundary on macOS is the Ask worker's network
 * sandbox (server/worker-network-sandbox.ts); Windows still needs a
 * per-program firewall rule, and Linux an equivalent. */
export const WORKER_DENIED_COMMANDS: readonly string[] = [
  ...DENIED_PROGRAMS.flatMap(name => [`${name}[ .]*`, `*[!a-z0-9_-]${name}[ .]*`]),
  ...DENIED_INLINE_CODE.flatMap(glob => [glob, `*[!a-z0-9_-]${glob}`]),
];

/** The profile as Hermes' own parser (PyYAML, YAML 1.1) reads it: duplicate
 * or malformed mappings are unreadable, so are collection keys (PyYAML refuses
 * them), and a bare `y`/`n`, a boolean to this library but a string to
 * PyYAML, stays a string. Exported for the readiness tests only. */
export function policyDocument(raw: string): Document {
  const doc = parseDocument(raw, { uniqueKeys: true, version: "1.1" });
  if (doc.errors.length || doc.warnings.length || !isMap(doc.contents)) throw new Error(UNREADABLE_PROFILE);
  visit(doc, {
    Pair(_, pair) { if (!isScalar(pair.key)) throw new Error(UNREADABLE_PROFILE); },
    // `!!pairs`, `!!omap`, `!!set`, ... : PyYAML's SafeLoader refuses them.
    Map(_, node) { if (node.tag) throw new Error(UNREADABLE_PROFILE); },
    Seq(_, node) { if (node.tag) throw new Error(UNREADABLE_PROFILE); },
    // An explicit tag (`!!bool n`, `!!str`, ...) is nothing the pack writes, and
    // PyYAML raises on `!!bool y/n`: the whole file reads as unreadable.
    Scalar(_, node) {
      if (node.tag) throw new Error(UNREADABLE_PROFILE);
      if (typeof node.value === "boolean" && /^[yn]$/i.test(node.source ?? "")) node.value = node.source;
    },
  });
  doc.toJS({ maxAliasCount: 50 });
  return doc;
}

/** A security switch counts only as the canonical `true`/`false` token: a
 * real boolean here, spelled the one way every parser agrees on. */
export function strictBool(doc: Document, path: readonly string[], expected: boolean): boolean {
  const node = doc.getIn([...path], true);
  return isScalar(node) && node.value === expected && node.source === String(expected);
}

/** Admitted runtimes whose native memory/skill proposal schema RealBud's
 * review helpers match (server/hermes-memory-review.ts): 0.21.3 and 0.21.5
 * (v2026.9.24 peeled; its `matched_entry` proposal schema is migrated). A
 * further release stays out until its memory side is reviewed. */
export const MEMORY_SCHEMA_READY_COMMITS: readonly string[] = [
  "345cd2b057a452236de401d3534b8502a7465e8d",
  "f97608f178d1ffeca59860195ab7da295f7c8e5f",
];

/** Native staged writes are reviewed only at an admitted upstream commit whose
 * memory schema is ready. A pending update must not enable them on an older
 * process-cached executable. */
export function stagedLearningSupported(root?: string): boolean {
  try {
    const home = hermesHome(root);
    const selected = readRuntimeSelection(home).selected;
    const commit = runtimeCommit(selected);
    if (!selected || !commit || !HERMES_RELEASES.some(release => release.commit === commit) || !MEMORY_SCHEMA_READY_COMMITS.includes(commit)) return false;
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
    // The curator archives agent-created skills outside the write gate.
    return strictBool(doc, ["skills", "write_approval"], true) && strictBool(doc, ["memory", "write_approval"], true) &&
      strictBool(doc, ["curator", "enabled"], false) &&
      (strictBool(doc, ["auxiliary", "background_review", "enabled"], false) || (strictBool(doc, ["auxiliary", "background_review", "enabled"], true) && stagedLearningSupported(root))) &&
      JSON.stringify(settings.extra_tools) === "[]" &&
      background.items.every(item => ["enabled", "extra_tools", "max_input_tokens"].includes(String(item.key)));
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
    const integer = (path: string[], min: number, max: number) => {
      const value = doc.getIn(path);
      return Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
    };
    const ratio = doc.getIn(["agent", "budget_warning_ratio"]);
    const defer = doc.getIn(["tools", "tool_search", "defer"]);
    const deferred = isSeq(defer) ? new Set((defer.toJSON() as unknown[]).map(String)) : null;
    return doc.getIn(["auxiliary", "title_generation", "enabled"]) === false &&
      doc.getIn(["security", "allow_lazy_installs"]) === false &&
      Object.entries(WORKER_BROWSER_POLICY).every(([key, value]) => doc.getIn(["browser", key]) === value) &&
      cap("max_web_searches", 10) && cap("max_subagents", 4) &&
      typeof ratio === "number" && ratio > 0 && ratio < 1 &&
      doc.getIn(["agent", "execution_guidance"]) === true && doc.getIn(["agent", "intent_ack_continuation"]) === true &&
      doc.getIn(["agent", "coding_context"]) === "off" &&
      doc.getIn(["tool_loop_guardrails", "hard_stop_enabled"]) === true &&
      // At least three requests kept; pruning on, no later than 64K (0 is off).
      integer(["compression", "min_tail_user_messages"], 3, 1_000) &&
      integer(["compression", "proactive_prune_tokens"], 1, 64_000) &&
      // Upstream reads 0 as no timeout and floors a positive value at 30 s.
      integer(["delegation", "child_timeout_seconds"], 1, 900) &&
      deferred !== null && WORKER_DEFERRED_TOOLS.every(name => deferred.has(name)) &&
      WORKER_DIRECT_TOOLS.every(name => !deferred.has(name)) &&
      // Upstream reads `bool(value)`, so only a real YAML false refuses borrowing.
      strictBool(doc, ["auth", "adopt_external_logins"], false) &&
      strictBool(doc, ["tools", "connectors", "enabled"], false) &&
      // Upstream reads `bool(value)`, so only a real YAML false turns the keyless tier off.
      strictBool(doc, ["web", "keyless_fallback"], false) &&
      strictBool(doc, ["skills", "guard_agent_created"], true) &&
      includesAll(doc.getIn(["approvals", "deny"]), WORKER_DENIED_COMMANDS) &&
      sameList(doc.getIn(["platform_toolsets", "acp"]), WORKER_ACP_TOOLSETS) &&
      includesAll(doc.getIn(["agent", "disabled_toolsets"]), WORKER_DISABLED_TOOLSETS) &&
      // 0 disables the extra recovery wait; anything above one cycle is looser.
      integer(["agent", "auto_recovery_cycles"], 0, 1) &&
      // Upstream reads only `is False` as off, so the string "false" leaves it on.
      WORKER_DISABLED_VAULTS.every(name => strictBool(doc, ["vault", name, "enabled"], false)) &&
      // Wrap-up notice at 80%, before RealBud's 900 s hard stop.
      integer(["agent", "run_budget_seconds"], 60, 870) &&
      // Upstream reads <= 0 as unlimited.
      integer(["auxiliary", "background_review", "max_input_tokens"], 1, 120_000);
  } catch { return false; }
}

/** A YAML sequence holding exactly these names in this order. */
function sameList(value: unknown, names: readonly string[]): boolean {
  return isSeq(value) && JSON.stringify((value.toJSON() as unknown[]).map(String)) === JSON.stringify(names);
}

/** A YAML sequence holding at least these names. */
function includesAll(value: unknown, names: readonly string[]): boolean {
  if (!isSeq(value)) return false;
  const held = new Set((value.toJSON() as unknown[]).map(String));
  return names.every(name => held.has(name));
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
  // Plan the skill tree from the read-only shipped pack before anything in the
  // destination is admitted: the plan touches only `PACK_DIR`, so its
  // destination directories and files can share the profile's own admission
  // processes instead of paying for two more cold PowerShell launches.
  const shipped = shippedPack(root), plan = shipped.plan;
  // `prepareProfile` has already admitted and read `config.yaml`; re-reading it
  // here would only cost another cold PowerShell process on Windows.
  const { dir: dest, soul, config: existingBytes, record, skills: existingSkills } = prepareProfile(root, plan);
  const defaults = policyDocument(readFileSync(join(PACK_DIR, "config.yaml"), "utf8"));
  defaults.setIn(["auxiliary", "background_review", "enabled"], stagedLearningSupported(root));
  const config = mergePropertyPolicy(existingBytes?.toString("utf8") ?? "", defaults.toString());
  // Repair rewrites SOUL as before; skills follow the shipped-unchanged rule.
  const sync = shippedWrites(dest, shipped.files, [soul, ...existingSkills], record, shipped.digest, new Set(["SOUL.md"]));
  const wrote: string[] = [];
  // Every destination directory here is already admitted and every existing
  // destination file already read, so the whole pack publishes in one batch:
  // three PowerShell processes for the set rather than three per file. The
  // order is the order these were written one at a time.
  const entries: ProfileFileWrite[] = [];
  const auth = pendingRootAuth(root);
  if (auth) entries.push(auth);

  entries.push(...sync.writes);
  wrote.push("SOUL.md");
  for (const name of ["config.yaml", "distribution.yaml", "profile.yaml"]) {
    const from = join(PACK_DIR, name);
    if (!existsSync(from)) continue;
    const body = name === "config.yaml" ? config : readFileSync(from, "utf8");
    entries.push({ path: join(dest, name), bytes: body, expected: name === "config.yaml" ? existingBytes : undefined });
    wrote.push(name);
  }
  if (plan) wrote.push("skills/");
  entries.push(sync.record);
  writeProfileFiles(entries);
  return { dir: dest, wrote };
}

// ── managed model attach (provisioned installations) ─────────────────────────
//
// RealBud is managed-only: every office reasons through its paired Modelvia
// grant, with one of the four choices in `shared/managed-model-choices.ts`.
// The profile SELECTS the gateway and never holds the key. One-shot CLI workers
// receive the key through their launch environment; Ask (ACP) receives only a
// token for RealBud's loopback model relay, which holds the key, is pointed to
// per launch by a managed-scope overlay over these same keys, and enforces the
// choice's reasoning effort on every request (server/ask-model-relay.ts):
// 0.21.3 ACP never puts it on the wire, and 0.21.5 ACP sends this profile's
// effort, which the relay replaces with the same value. Every key below was taken from the installed release
// (hermes-agent 0.21.3, commit 345cd2b0, then `HERMES_RECOMMENDED`) and proven by
// `server/managed-model-wire.native.test.ts` against that real CLI. 0.21.5
// (f97608f1) is now recommended; that wire proof has NOT been re-run on 0.21.5
// and must be before these keys are claimed for it:
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
//   model.supports_vision
//                   agent/image_routing.py `_supports_vision_override`: true
//                   makes image input native and shows `vision_analyze`.
//   agent.reasoning_effort
//                   hermes_constants.py `resolve_reasoning_config`, clamped by
//                   the custom profile to OPENAI_COMPAT_WIRE_EFFORTS (which
//                   includes `xhigh`). `mergePropertyPolicy` carries it through
//                   a policy rewrite while it still pairs with the saved model.
//   auxiliary.vision
//                   0.21.5 (f97608f1) agent/auxiliary_client.py
//                   `_resolve_task_provider_model("vision")` reads provider and
//                   model here; `custom:realbud` resolves through the same
//                   `providers.realbud` entry (`_resolve_named_custom_branch`:
//                   its base_url, which Ask's overlay points at the relay, and
//                   its key_env), so the key custody is unchanged.
//                   `check_vision_requirements` (tools/vision_tools.py) resolves
//                   the same client, so `vision_analyze` shows for Flash.
//                   Resolution was probed in the 0.21.5 source tree; the wire
//                   proof above has not been run for it.
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
  /** The saved (model, effort) pair as one of the four choices, else null. */
  choice: ManagedModelChoiceId | null;
  /** True while a `.env` line could still shadow the granted key. */
  envKeyPresent: boolean;
  /** `auxiliary.vision` is exactly what the saved choice needs (`managedVisionRoute`). */
  visionReady: boolean;
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
  const choice = managedModelChoiceFor(modelId, effort);
  const vision = section(parsed.auxiliary).vision;
  return {
    provider: scalarText(model.provider),
    model: modelId,
    baseUrl: scalarText(entry.base_url),
    apiMode: scalarText(entry.api_mode),
    keyEnv: scalarText(entry.key_env),
    reasoningEffort: effort,
    choice,
    envKeyPresent: readIf(join(dir, ".env")).replace(/\r\n/g, "\n").split("\n").some(line => envKeyPattern().test(line.trim())),
    visionReady: choice !== null && JSON.stringify(vision ?? null) === JSON.stringify(managedVisionRoute(managedModelChoice(choice))),
  };
}

/** Owned `auxiliary.vision`: a text-only choice reads images with
 * `MANAGED_VISION_CHOICE`'s model through the same managed provider (Ask: the
 * relay, which admits that model only for an image request; CLI jobs: the
 * granted gateway). None for a choice that takes images itself: any explicit
 * `auxiliary.vision` makes 0.21.5 describe attached images as text even for a
 * vision model (agent/image_routing.py `decide_image_input_mode`). */
function managedVisionRoute(choice: ManagedModelChoice): { provider: string; model: string } | null {
  return choice.supportsVision ? null : { provider: MANAGED_MODEL_PROVIDER, model: managedModelChoice(MANAGED_VISION_CHOICE).model };
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
 * including comments, are kept; the `model` and `providers` sections and
 * `auxiliary.vision` are owned whole, so no leftover provider can be selected
 * beside the grant. */
export function managedModelConfig(raw: string, baseUrl: string, choiceId: ManagedModelChoiceId): string {
  const choice = managedModelChoice(choiceId);
  const doc: Document = raw.trim() ? policyDocument(raw) : new Document({}, { version: "1.1" });
  if (doc.has("agent") && !isMap(doc.get("agent"))) throw new Error(UNREADABLE_PROFILE);
  // `model.supports_vision` is the first override upstream consults
  // (agent/image_routing.py `_supports_vision_override`); without it a custom
  // provider reads as text-only and `vision_analyze` stays hidden
  // (tools/vision_tools.py `check_vision_requirements`). Written only for a
  // choice whose model takes images; the section is owned whole, so a switch
  // to a text-only choice drops it.
  doc.set("model", doc.createNode({
    default: choice.model, provider: MANAGED_MODEL_PROVIDER, ...(choice.supportsVision ? { supports_vision: true } : {}),
  }));
  doc.set("providers", doc.createNode({
    [MANAGED_MODEL_PROVIDER_ENTRY]: { base_url: baseUrl, key_env: MANAGED_MODEL_KEY_ENV, api_mode: MANAGED_MODEL_API_MODE },
  }));
  if (!doc.has("agent")) doc.set("agent", new YAMLMap(doc.schema));
  doc.setIn(["agent", "reasoning_effort"], choice.effort);
  // `auxiliary.vision` is owned whole with the choice; the rest of `auxiliary` stays.
  if (doc.has("auxiliary") && !isMap(doc.get("auxiliary"))) throw new Error(UNREADABLE_PROFILE);
  const vision = managedVisionRoute(choice);
  if (vision) {
    if (!doc.has("auxiliary")) doc.set("auxiliary", new YAMLMap(doc.schema));
    doc.setIn(["auxiliary", "vision"], doc.createNode(vision));
  } else if (doc.has("auxiliary")) doc.deleteIn(["auxiliary", "vision"]);
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
/** Written once an office has had its one move to the default choice. */
const MEDIUM_FOR_ALL_MARKER = ".realbud-medium-default-2026-10-08";

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
  // Owner decision 8 Oct 2026: every office moves to the default once, including
  // one saved on Sonnet · High (the default until then). The marker makes it
  // once, so an office that steps back up to High afterwards stays there.
  const marker = join(dir, MEDIUM_FOR_ALL_MARKER), moveOnce = !opts?.choice && saved.choice === "sonnet-high" && !existsSync(marker);
  const choiceId = opts?.choice ?? (moveOnce ? DEFAULT_MANAGED_MODEL_CHOICE : saved.choice) ?? managedModelChoiceKeepingModel(saved.model) ?? DEFAULT_MANAGED_MODEL_CHOICE;
  const choice = managedModelChoice(choiceId);
  // Build and validate first: a damaged config is refused before anything,
  // including the `.env`, changes.
  const next = managedModelConfig(raw, url, choiceId);
  const envKeyRemoved = removeManagedEnvKey(dir);
  writeProfileFile(configPath, next, true, existing);
  if (!existsSync(marker)) writeFileSync(marker, `${new Date().toISOString()}\n`, { mode: 0o600 });
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
    // Parsed, not pattern-matched: a comment or block scalar must never read as manual.
    return policyDocument(readFileSync(join(propertyProfileDir(root), "config.yaml"), "utf8")).getIn(["approvals", "mode"]) === "manual";
  } catch {
    return false;
  }
}

/** The supported property profile must provide a usable local workroom while
 * keeping subprocess credentials isolated from the user's normal HOME. */
export function propertyWorkroomReady(root?: string): boolean {
  try {
    const doc = policyDocument(readFileSync(join(propertyProfileDir(root), "config.yaml"), "utf8"));
    const maxTurns = doc.getIn(["agent", "max_turns"]);
    const passthrough = doc.getIn(["terminal", "env_passthrough"]);
    const toolsetsNode = doc.get("toolsets");
    const toolsets: unknown[] = isSeq(toolsetsNode) ? toolsetsNode.toJSON() : [];
    const requiredToolsets = ["terminal", "file", "vision", "todo", "session_search", "delegation"];
    return (
      doc.getIn(["terminal", "backend"]) === "local" &&
      doc.getIn(["terminal", "home_mode"]) === "profile" &&
      isSeq(passthrough) && passthrough.items.length === 0 &&
      doc.getIn(["security", "redact_secrets"]) === true &&
      toolsets.every((name) => typeof name === "string") &&
      requiredToolsets.every((name) => toolsets.includes(name)) &&
      !["code_execution", "computer_use", "cronjob", "skills", "web"].some((name) => toolsets.includes(name)) &&
      Number.isInteger(maxTurns) && (maxTurns as number) >= 60 &&
      learningPolicyReady(root) && workerLimitsReady(root) && skillScopeReady(root)
    );
  } catch {
    return false;
  }
}
