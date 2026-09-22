// The PM's book: markdown files Hermes may read. Not a second brain UI.
// Worker SOUL stays in the Hermes pack. Evaluate never reads these files.
import { chmodSync, existsSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { createEmptyFileSync, mkdirNewSync, restrictNewSync, writeFileAtomic, writeFilePrivateSync, type NewPrivateObject } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { LAW_REFERENCE_FILE, LAW_REFERENCE_MARKDOWN, refreshBundledLawReference } from "./law-reference.ts";

const SAFE_ID = /^[\w-]+$/;
const hardenedDirs = new Set<string>();
const hardenedFiles = new Set<string>();

/** `dataDir` is `~/.realbud` (or the test data dir). The book is `<dataDir>/vault`. */
export function vaultDir(dataDir?: string): string {
  return join(dataDir ?? DATA_DIR, "vault");
}

function bookDir(book?: string): string {
  return book ?? vaultDir();
}

function safeId(id: string): string {
  const trimmed = String(id ?? "").trim();
  if (!SAFE_ID.test(trimmed)) throw Object.assign(new Error("no such property"), { status: 400 });
  return trimmed;
}

function propertyPath(id: string, book?: string): string {
  return join(bookDir(book), "properties", `${safeId(id)}.md`);
}

/** Folders this call creates get their own protected Windows descriptor: at
 * once, or in the caller's single batch when it passes `created`. */
function ensurePrivateDir(path: string, created?: NewPrivateObject[]): void {
  if (hardenedDirs.has(path)) return;
  const made = mkdirNewSync(path, 0o700).map((folder) => ({ path: folder, kind: "directory" as const }));
  if (created) created.push(...made);
  else restrictNewSync(made);
  try {
    chmodSync(path, 0o700);
  } catch {
    // Windows does not expose POSIX directory modes. The user-scoped app data
    // ACL remains authoritative there.
  }
  hardenedDirs.add(path);
}

function keepPrivateFile(path: string): void {
  if (hardenedFiles.has(path)) return;
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort on platforms without POSIX modes.
  }
  hardenedFiles.add(path);
}

/** Exact bundled defaults distinguish a fresh restore target from edited notes. */
export const DEFAULT_VAULT_DOCUMENTS: Readonly<Record<string,string>> = {
  'USER.md': '# You\n\nThis is the property manager RealBud works for.\n',
  'README.md': ['# Book','','Notes on each property live in properties/. They are preferences, not law.',
    'Desk shop rules and the ledger win. Do not invent a legal clock.','Process for notices and trust sits with the licensee.',''].join('\n'),
  [LAW_REFERENCE_FILE]: LAW_REFERENCE_MARKDOWN,
};

export function seedVault(book?: string): string {
  const dir = bookDir(book);
  const folders = [dir, join(dir, "properties"), join(dir, "owners"), join(dir, "decisions")];
  // Everything a first run creates here is restricted in one PowerShell
  // process on Windows, while the new documents are still empty.
  const created: NewPrivateObject[] = [];
  const fresh: Array<[string, string]> = [];
  try {
    for (const folder of folders) ensurePrivateDir(folder, created);
    for (const name of ["USER.md", "README.md", LAW_REFERENCE_FILE]) {
      const path = join(dir, name);
      if (!existsSync(path) && createEmptyFileSync(path, 0o600)) {
        created.push({ path, kind: "file" });
        fresh.push([path, DEFAULT_VAULT_DOCUMENTS[name]]);
      }
    }
    restrictNewSync(created);
  } catch (error) {
    // Nothing new stays behind unprotected: a retry creates it again.
    for (const { path, kind } of created.reverse()) {
      try {
        if (kind === "file") unlinkSync(path);
        else rmdirSync(path);
      } catch {
        /* already removed, or no longer empty */
      }
    }
    for (const folder of folders) hardenedDirs.delete(folder);
    throw error;
  }
  for (const [path, content] of fresh) writeFileSync(path, content, { mode: 0o600 });
  const user = join(dir, "USER.md");
  keepPrivateFile(user);
  const readme = join(dir, "README.md");
  keepPrivateFile(readme);
  // Upgrade the known bundled reference atomically; office additions survive.
  const law = join(dir, LAW_REFERENCE_FILE);
  if (!fresh.some(([path]) => path === law)) {
    const existing = readFileSync(law, "utf8");
    const refreshed = refreshBundledLawReference(existing);
    if (refreshed !== existing) writeFileAtomic(law, refreshed, 0o600);
  }
  keepPrivateFile(law);
  return dir;
}

export function vaultDirFromDeskFile(file: string): string {
  return join(dirname(file), "vault");
}

function splitFrontmatter(raw: string): { matter: string; body: string } {
  if (!raw.startsWith("---\n")) return { matter: "", body: raw };
  const end = raw.indexOf("\n---\n", 4);
  if (end < 0) return { matter: "", body: raw };
  return { matter: raw.slice(4, end), body: raw.slice(end + 5) };
}

export function readPropertyNote(id: string, book?: string): string {
  seedVault(book);
  const path = propertyPath(id, book);
  if (!existsSync(path)) return "";
  const { body } = splitFrontmatter(readFileSync(path, "utf8"));
  return body.replace(/^\n+/, "").trimEnd();
}

export function writePropertyNote(id: string, body: string, meta: { address?: string }, book?: string): string {
  seedVault(book);
  const path = propertyPath(id, book);
  const text = String(body ?? "");
  if (text.length > 20_000) throw Object.assign(new Error("note is too long"), { status: 400 });
  const address = meta.address ? `\naddress: ${meta.address.replace(/\n/g, " ")}` : "";
  const file = `---\nid: ${safeId(id)}${address}\n---\n\n${text.trimEnd()}\n`;
  ensurePrivateDir(dirname(path));
  writeFileAtomic(path, file, 0o600);
  keepPrivateFile(path);
  return text.trimEnd();
}

export function archivePropertyNote(id: string, book?: string): void {
  seedVault(book);
  const path = propertyPath(id, book);
  if (!existsSync(path)) return;
  const raw = readFileSync(path, "utf8");
  if (/^archived:\s*true/m.test(raw)) return;
  const { matter, body } = splitFrontmatter(raw);
  const nextMatter = matter.includes("archived:")
    ? matter.replace(/archived:\s*\w+/g, "archived: true")
    : `${matter.trim()}\narchived: true`;
  writeFileSync(path, `---\n${nextMatter.trim()}\n---\n\n${body.replace(/^\n+/, "")}`, { mode: 0o600 });
  keepPrivateFile(path);
}

export function appendAllowedLine(id: string, line: string, book?: string, address?: string): void {
  seedVault(book);
  const existing = readPropertyNote(id, book);
  const bullet = `- ${line}`;
  let next: string;
  if (/^## Last allowed/m.test(existing)) {
    next = existing.replace(/^(## Last allowed\n)/m, `$1\n${bullet}\n`);
  } else {
    next = `${existing.trimEnd()}\n\n## Last allowed\n\n${bullet}\n`;
  }
  writePropertyNote(id, next.trim(), { address }, book);
  const day = new Date().toISOString().slice(0, 10);
  const log = join(bookDir(book), "decisions", `${day}.md`);
  ensurePrivateDir(dirname(log));
  const prev = existsSync(log) ? readFileSync(log, "utf8") : `# ${day}\n\n`;
  writeFilePrivateSync(log, `${prev.trimEnd()}\n${bullet}\n`, 0o600);
  keepPrivateFile(log);
}

/** Bulk intake writes one decisions log append instead of repeatedly reading
 * and rewriting the growing day file. Property notes remain independently
 * addressable and private. */
export function appendAllowedLines(
  entries: ReadonlyArray<{ id: string; line: string; address?: string }>,
  book?: string,
): void {
  if (!entries.length) return;
  seedVault(book);
  const bullets: string[] = [];
  for (const entry of entries) {
    const bullet = `- ${entry.line}`;
    writePropertyNote(entry.id, `## Last allowed\n\n${bullet}`, { address: entry.address }, book);
    bullets.push(bullet);
  }
  const day = new Date().toISOString().slice(0, 10);
  const log = join(bookDir(book), "decisions", `${day}.md`);
  ensurePrivateDir(dirname(log));
  const prev = existsSync(log) ? readFileSync(log, "utf8") : `# ${day}\n\n`;
  writeFilePrivateSync(log, `${prev.trimEnd()}\n${bullets.join("\n")}\n`, 0o600);
  keepPrivateFile(log);
}
