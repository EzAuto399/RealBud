import { currentWorkerProfile } from "./hermes-profile.js";
// Install the locked `property` profile into a Hermes home. File copy only —
// we never edit Hermes source or launch Hermes.app.
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { isMap, parseDocument, YAMLMap } from "./vendor/yaml.mjs";
import { ensureProfileDirectory, readProfileFile, writeProfileFile } from "./hermes-profile-storage.js";
import { HERMES_PIN } from "./hermes-pin.js";
import { hermesHome, runtimeCli } from "./hermes-paths.js";
import { readRuntimeSelection, releaseHome, runtimeCommit, selectedHermesCli } from "./hermes-runtime-selection.js";
export { hermesHome } from "./hermes-paths.js";
export const PACK_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "pack", "property");
export function propertyProfileDir(root) {
    return join(hermesHome(root), "profiles", currentWorkerProfile().profile);
}
/** One-shot: if Bud's hands are missing in the RealBud-owned home but still
 * live under the personal Hermes Desktop home, copy that profile only (never
 * personal / property-manager / other sibling profiles). */
export function migratePropertyProfileFromLegacyHermes(root) {
    const dest = propertyProfileDir(root);
    if (currentWorkerProfile().memberKey)
        return { migrated: false };
    if (packInstalled(root))
        return { migrated: false };
    // The legacy recursive copy includes credentials and native databases. It
    // has no admitted Windows ACL/identity-preserving migration protocol yet.
    if (process.platform === "win32")
        throw new Error("Legacy Bud profile migration on Windows needs administrator recovery. The source and destination have been kept.");
    const legacyHome = join(homedir(), ".hermes");
    const owned = hermesHome(root);
    if (resolvedPath(owned) === resolvedPath(legacyHome))
        return { migrated: false };
    const from = join(legacyHome, "profiles", HERMES_PIN.profile);
    if (!existsSync(join(from, "SOUL.md")))
        return { migrated: false };
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(from, dest, { recursive: true });
    // Stamp so Advanced can show the split happened once.
    try {
        writeFileSync(join(dest, ".realbud-migrated-from-legacy-hermes"), `${new Date().toISOString()}\nfrom=${from}\n`, { flag: "wx" });
    }
    catch {
        /* already stamped or unwritable */
    }
    return { migrated: true, from, to: dest };
}
/** Official installer checkout — Hermes status calls this "Install directory". */
export function hermesAgentDir(root) {
    return join(hermesHome(root), "hermes-agent");
}
function resolvedPath(path) {
    const absolute = resolve(path);
    try {
        return realpathSync(absolute);
    }
    catch {
        try {
            return join(realpathSync(dirname(absolute)), basename(absolute));
        }
        catch {
            return absolute;
        }
    }
}
/** True when `target` resolves strictly inside the Hermes home (never the home itself). */
export function isInsideHermesHome(target, root) {
    const home = resolvedPath(hermesHome(root));
    const resolved = resolvedPath(target);
    const rel = relative(home, resolved);
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
export function packInstalled(root) {
    return existsSync(join(propertyProfileDir(root), "SOUL.md"));
}
function ensurePrivateRootAuth(root) {
    // An empty owned-home root prevents fallback to personal Hermes auth.
    const path = join(hermesHome(root), "auth.json");
    if (readProfileFile(path) === null)
        writeProfileFile(path, `${JSON.stringify({ version: 1, providers: {}, credential_pool: {} }, null, 2)}\n`, false);
}
function prepareProfile(root) {
    const home = hermesHome(root), dest = propertyProfileDir(root);
    ensureProfileDirectory(home);
    ensureProfileDirectory(join(home, "profiles"));
    ensureProfileDirectory(dest);
    // Existing RealBud-owned policy/credential files are admission-only here.
    // Upstream-managed auth/memory files retain their native ownership contract.
    for (const name of ["SOUL.md", "config.yaml", "distribution.yaml", "profile.yaml", ".env"])
        readProfileFile(join(dest, name));
    return dest;
}
function prepareSkillCopies(source, destination, files = [], depth = 0) {
    if (depth > 12 || files.length > 1000)
        throw new Error("Bud’s skill pack needs recovery before it can be installed.");
    const stat = lstatSync(source);
    if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error("Bud’s skill pack needs recovery before it can be installed.");
    ensureProfileDirectory(destination);
    for (const entry of readdirSync(source, { withFileTypes: true })) {
        const from = join(source, entry.name), to = join(destination, entry.name);
        if (entry.isDirectory())
            prepareSkillCopies(from, to, files, depth + 1);
        else if (entry.isFile()) {
            // Keep locally maintained skills; never replace them as profile repair.
            if (readProfileFile(to) === null) {
                if (lstatSync(from).size > 2 * 1024 * 1024 || files.length >= 1000)
                    throw new Error("Bud’s skill pack needs recovery before it can be installed.");
                files.push({ path: to, body: readFileSync(from) });
            }
        }
        else
            throw new Error("Bud’s skill pack needs recovery before it can be installed.");
    }
    return files;
}
/** Startup is initialization only. Existing profiles change through Repair. */
export function ensurePropertyPack(root) {
    if (!packInstalled(root))
        return applyPropertyPack(root);
    prepareProfile(root);
    ensurePrivateRootAuth(root);
    return { dir: propertyProfileDir(root), wrote: [] };
}
/** Indented YAML map under `key:` (Hermes config style). */
export function yamlBlock(raw, key) {
    const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = normalized.split("\n");
    const start = lines.findIndex((line) => line === `${key}:` || line.startsWith(`${key}:`));
    if (start < 0)
        return null;
    const block = [lines[start]];
    for (let i = start + 1; i < lines.length; i++) {
        const line = lines[i];
        if (line.length > 0 && !/^[ \t]/.test(line))
            break;
        block.push(line);
    }
    return block.join("\n");
}
export function withYamlBlock(raw, key, block) {
    const cleaned = raw.replace(/\s+$/, "\n");
    const existing = new RegExp(`^${key}:\\n(?:[ \\t].*\\n)*`, "m");
    if (!block)
        return cleaned.replace(existing, "");
    const next = block.endsWith("\n") ? block : `${block}\n`;
    return existing.test(cleaned) ? cleaned.replace(existing, next) : cleaned + next;
}
function readIf(path) {
    try {
        return readFileSync(path, "utf8");
    }
    catch {
        return "";
    }
}
/** Replace only RealBud-owned policy blocks; keep all other upstream settings. */
export function mergePropertyPolicy(existing, defaults) {
    const result = policyDocument(existing.trim() ? existing : defaults);
    const policy = policyDocument(defaults);
    const keys = ["approvals", "agent", "toolsets", "security", "delegation", "terminal", "file_read_max_chars", "tool_output"];
    for (const key of keys) {
        if (policy.has(key))
            result.set(key, policy.get(key));
    }
    // Own only the write gate; retain memory preferences and skill visibility.
    for (const key of ["skills", "memory", "auxiliary"]) {
        if (result.has(key) && !isMap(result.get(key)))
            throw new Error("Bud’s learning settings could not be read. The existing file has been kept.");
        // YAML 1.1 setIn creates !!omap for missing parents; PyYAML reads that as
        // a sequence, so Hermes would lose these policy gates. Create plain maps.
        if (!result.has(key))
            result.set(key, new YAMLMap(result.schema));
    }
    for (const key of ["skills", "memory"])
        result.setIn([key, "write_approval"], true);
    result.setIn(["auxiliary", "background_review"], policy.getIn(["auxiliary", "background_review"]));
    return result.toString();
}
function policyDocument(raw) {
    // Match upstream's YAML 1.1 booleans, and reject malformed/duplicate mappings
    // before its write gate can fail open on a config-loading exception.
    const doc = parseDocument(raw, { uniqueKeys: true, version: "1.1" });
    if (doc.errors.length || doc.warnings.length || !isMap(doc.contents))
        throw new Error("Bud’s profile has unreadable or duplicate settings. The existing file has been kept.");
    doc.toJS({ maxAliasCount: 50 });
    return doc;
}
/** Native staged writes are reviewed only at this exact upstream source pin.
 * A pending update must not enable them on an older process-cached executable. */
export function stagedLearningSupported(root) {
    try {
        const home = hermesHome(root);
        const selected = readRuntimeSelection(home).selected;
        if (!selected || runtimeCommit(selected) !== "345cd2b057a452236de401d3534b8502a7465e8d")
            return false;
        const cli = runtimeCli(releaseHome(home, selected));
        return existsSync(cli) && selectedHermesCli(home) === cli;
    }
    catch {
        return false;
    }
}
export function learningPolicyReady(root) {
    try {
        const doc = policyDocument(readFileSync(join(propertyProfileDir(root), "config.yaml"), "utf8"));
        const background = doc.getIn(["auxiliary", "background_review"]);
        if (!isMap(background))
            return false;
        const settings = background.toJSON();
        return doc.getIn(["skills", "write_approval"]) === true && doc.getIn(["memory", "write_approval"]) === true &&
            (settings.enabled === false || (settings.enabled === true && stagedLearningSupported(root))) &&
            JSON.stringify(settings.extra_tools) === "[]" &&
            background.items.every(item => ["enabled", "extra_tools"].includes(String(item.key)));
    }
    catch {
        return false;
    }
}
export function stagedLearningEnabled(root) {
    try {
        if (!learningPolicyReady(root) || !stagedLearningSupported(root))
            return false;
        return policyDocument(readFileSync(join(propertyProfileDir(root), "config.yaml"), "utf8"))
            .getIn(["auxiliary", "background_review", "enabled"]) === true;
    }
    catch {
        return false;
    }
}
export function applyPropertyPack(root) {
    const dest = prepareProfile(root);
    const destConfig = join(dest, "config.yaml");
    let existingBytes = null;
    try {
        existingBytes = readProfileFile(destConfig);
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw new Error("Bud’s existing profile could not be read. Its files have been kept.");
    }
    const defaults = policyDocument(readFileSync(join(PACK_DIR, "config.yaml"), "utf8"));
    defaults.setIn(["auxiliary", "background_review", "enabled"], stagedLearningSupported(root));
    const config = mergePropertyPolicy(existingBytes?.toString("utf8") ?? "", defaults.toString());
    const skillsFrom = join(PACK_DIR, "skills");
    const skillCopies = existsSync(skillsFrom) ? prepareSkillCopies(skillsFrom, join(dest, "skills")) : [];
    ensurePrivateRootAuth(root);
    const wrote = [];
    for (const name of ["SOUL.md", "config.yaml", "distribution.yaml", "profile.yaml"]) {
        const from = join(PACK_DIR, name);
        if (!existsSync(from))
            continue;
        let body = readFileSync(from, "utf8");
        if (name === "config.yaml")
            body = config;
        writeProfileFile(join(dest, name), body, true, name === "config.yaml" ? existingBytes : undefined);
        wrote.push(name);
    }
    if (existsSync(skillsFrom)) {
        for (const file of skillCopies)
            writeProfileFile(file.path, file.body, false);
        wrote.push("skills/");
    }
    return { dir: dest, wrote };
}
export function approvalsAreManual(root) {
    try {
        const raw = readFileSync(join(propertyProfileDir(root), "config.yaml"), "utf8");
        return /approvals:[\s\S]*?mode:\s*manual/.test(raw) && !/mode:\s*(off|smart|yolo)/.test(raw.split("approvals:")[1] ?? "");
    }
    catch {
        return false;
    }
}
/** The supported property profile must provide a usable local workroom while
 * keeping subprocess credentials isolated from the user's normal HOME. */
export function propertyWorkroomReady(root) {
    try {
        const raw = readIf(join(propertyProfileDir(root), "config.yaml")).replace(/\r\n/g, "\n");
        const terminal = yamlBlock(raw, "terminal") ?? "";
        const agent = yamlBlock(raw, "agent") ?? "";
        const security = yamlBlock(raw, "security") ?? "";
        const toolsets = yamlBlock(raw, "toolsets") ?? "";
        const maxTurns = Number(agent.match(/^\s+max_turns:\s*(\d+)\s*$/m)?.[1] ?? 0);
        const requiredToolsets = ["web", "terminal", "file", "vision", "todo", "session_search", "delegation"];
        return (/^\s+backend:\s*local\s*$/m.test(terminal) &&
            /^\s+home_mode:\s*profile\s*$/m.test(terminal) &&
            /^\s+env_passthrough:\s*\[\]\s*$/m.test(terminal) &&
            /^\s+redact_secrets:\s*true\s*$/m.test(security) &&
            requiredToolsets.every((name) => new RegExp(`^\\s+-\\s*${name}\\s*$`, "m").test(toolsets)) &&
            !/^\s+-\s*(code_execution|computer_use|cronjob|skills)\s*$/m.test(toolsets) &&
            maxTurns >= 60 && learningPolicyReady(root));
    }
    catch {
        return false;
    }
}
