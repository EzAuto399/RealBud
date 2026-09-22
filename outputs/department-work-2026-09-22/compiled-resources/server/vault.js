// The PM's book: markdown files Hermes may read. Not a second brain UI.
// Worker SOUL stays in the Hermes pack. Evaluate never reads these files.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "./atomic.js";
import { DATA_DIR } from "./config.js";
import { LAW_REFERENCE_FILE, LAW_REFERENCE_MARKDOWN, refreshBundledLawReference } from "./law-reference.js";
const SAFE_ID = /^[\w-]+$/;
const hardenedDirs = new Set();
const hardenedFiles = new Set();
/** `dataDir` is `~/.realbud` (or the test data dir). The book is `<dataDir>/vault`. */
export function vaultDir(dataDir) {
    return join(dataDir ?? DATA_DIR, "vault");
}
function bookDir(book) {
    return book ?? vaultDir();
}
function safeId(id) {
    const trimmed = String(id ?? "").trim();
    if (!SAFE_ID.test(trimmed))
        throw Object.assign(new Error("no such property"), { status: 400 });
    return trimmed;
}
function propertyPath(id, book) {
    return join(bookDir(book), "properties", `${safeId(id)}.md`);
}
function ensurePrivateDir(path) {
    if (hardenedDirs.has(path))
        return;
    mkdirSync(path, { recursive: true, mode: 0o700 });
    try {
        chmodSync(path, 0o700);
    }
    catch {
        // Windows does not expose POSIX directory modes. The user-scoped app data
        // ACL remains authoritative there.
    }
    hardenedDirs.add(path);
}
function keepPrivateFile(path) {
    if (hardenedFiles.has(path))
        return;
    try {
        chmodSync(path, 0o600);
    }
    catch {
        // Best effort on platforms without POSIX modes.
    }
    hardenedFiles.add(path);
}
/** Exact bundled defaults distinguish a fresh restore target from edited notes. */
export const DEFAULT_VAULT_DOCUMENTS = {
    'USER.md': '# You\n\nThis is the property manager RealBud works for.\n',
    'README.md': ['# Book', '', 'Notes on each property live in properties/. They are preferences, not law.',
        'Desk shop rules and the ledger win. Do not invent a legal clock.', 'Process for notices and trust sits with the licensee.', ''].join('\n'),
    [LAW_REFERENCE_FILE]: LAW_REFERENCE_MARKDOWN,
};
export function seedVault(book) {
    const dir = bookDir(book);
    ensurePrivateDir(dir);
    ensurePrivateDir(join(dir, "properties"));
    ensurePrivateDir(join(dir, "owners"));
    ensurePrivateDir(join(dir, "decisions"));
    const user = join(dir, "USER.md");
    if (!existsSync(user)) {
        writeFileSync(user, DEFAULT_VAULT_DOCUMENTS['USER.md'], { mode: 0o600 });
    }
    keepPrivateFile(user);
    const readme = join(dir, "README.md");
    if (!existsSync(readme)) {
        writeFileSync(readme, DEFAULT_VAULT_DOCUMENTS['README.md'], { mode: 0o600 });
    }
    keepPrivateFile(readme);
    // Upgrade the known bundled reference atomically; office additions survive.
    const law = join(dir, LAW_REFERENCE_FILE);
    if (!existsSync(law)) {
        writeFileSync(law, LAW_REFERENCE_MARKDOWN, { mode: 0o600 });
    }
    else {
        const existing = readFileSync(law, "utf8");
        const refreshed = refreshBundledLawReference(existing);
        if (refreshed !== existing)
            writeFileAtomic(law, refreshed, 0o600);
    }
    keepPrivateFile(law);
    return dir;
}
export function vaultDirFromDeskFile(file) {
    return join(dirname(file), "vault");
}
function splitFrontmatter(raw) {
    if (!raw.startsWith("---\n"))
        return { matter: "", body: raw };
    const end = raw.indexOf("\n---\n", 4);
    if (end < 0)
        return { matter: "", body: raw };
    return { matter: raw.slice(4, end), body: raw.slice(end + 5) };
}
export function readPropertyNote(id, book) {
    seedVault(book);
    const path = propertyPath(id, book);
    if (!existsSync(path))
        return "";
    const { body } = splitFrontmatter(readFileSync(path, "utf8"));
    return body.replace(/^\n+/, "").trimEnd();
}
export function writePropertyNote(id, body, meta, book) {
    seedVault(book);
    const path = propertyPath(id, book);
    const text = String(body ?? "");
    if (text.length > 20_000)
        throw Object.assign(new Error("note is too long"), { status: 400 });
    const address = meta.address ? `\naddress: ${meta.address.replace(/\n/g, " ")}` : "";
    const file = `---\nid: ${safeId(id)}${address}\n---\n\n${text.trimEnd()}\n`;
    ensurePrivateDir(dirname(path));
    writeFileAtomic(path, file, 0o600);
    keepPrivateFile(path);
    return text.trimEnd();
}
export function archivePropertyNote(id, book) {
    seedVault(book);
    const path = propertyPath(id, book);
    if (!existsSync(path))
        return;
    const raw = readFileSync(path, "utf8");
    if (/^archived:\s*true/m.test(raw))
        return;
    const { matter, body } = splitFrontmatter(raw);
    const nextMatter = matter.includes("archived:")
        ? matter.replace(/archived:\s*\w+/g, "archived: true")
        : `${matter.trim()}\narchived: true`;
    writeFileSync(path, `---\n${nextMatter.trim()}\n---\n\n${body.replace(/^\n+/, "")}`, { mode: 0o600 });
    keepPrivateFile(path);
}
export function appendAllowedLine(id, line, book, address) {
    seedVault(book);
    const existing = readPropertyNote(id, book);
    const bullet = `- ${line}`;
    let next;
    if (/^## Last allowed/m.test(existing)) {
        next = existing.replace(/^(## Last allowed\n)/m, `$1\n${bullet}\n`);
    }
    else {
        next = `${existing.trimEnd()}\n\n## Last allowed\n\n${bullet}\n`;
    }
    writePropertyNote(id, next.trim(), { address }, book);
    const day = new Date().toISOString().slice(0, 10);
    const log = join(bookDir(book), "decisions", `${day}.md`);
    ensurePrivateDir(dirname(log));
    const prev = existsSync(log) ? readFileSync(log, "utf8") : `# ${day}\n\n`;
    writeFileSync(log, `${prev.trimEnd()}\n${bullet}\n`, { mode: 0o600 });
    keepPrivateFile(log);
}
/** Bulk intake writes one decisions log append instead of repeatedly reading
 * and rewriting the growing day file. Property notes remain independently
 * addressable and private. */
export function appendAllowedLines(entries, book) {
    if (!entries.length)
        return;
    seedVault(book);
    const bullets = [];
    for (const entry of entries) {
        const bullet = `- ${entry.line}`;
        writePropertyNote(entry.id, `## Last allowed\n\n${bullet}`, { address: entry.address }, book);
        bullets.push(bullet);
    }
    const day = new Date().toISOString().slice(0, 10);
    const log = join(bookDir(book), "decisions", `${day}.md`);
    ensurePrivateDir(dirname(log));
    const prev = existsSync(log) ? readFileSync(log, "utf8") : `# ${day}\n\n`;
    writeFileSync(log, `${prev.trimEnd()}\n${bullets.join("\n")}\n`, { mode: 0o600 });
    keepPrivateFile(log);
}
