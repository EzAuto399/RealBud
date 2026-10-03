// The PM's book: markdown files Hermes may read. Not a second brain UI.
// Worker SOUL stays in the Hermes pack. Evaluate never reads these files.
import { existsSync, lstatSync, rmdirSync, unlinkSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import { assertOwnPrivate, createEmptyFileSync, keepPrivateDirSync, keepPrivateFileSync, mkdirNewSync, readPrivateFileSync, restrictNewSync, writeFileAtomic, type NewPrivateObject } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { LAW_REFERENCE_FILE, LAW_REFERENCE_MARKDOWN, refreshBundledLawReference } from "./law-reference.ts";

const SAFE_ID = /^[\w-]+$/;
const hardenedDirs = new Set<string>();
const hardenedFiles = new Set<string>();

/** The one folder of the book a worker may write: Bud's own working files.
 * Everything else in the book (notes, decisions, uploads, inputs, reference
 * sheets) is read-only to the worker and maintained by RealBud. */
export const BUD_WORK_FOLDER = "bud-work";

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

/**
 * The worker writes the whole workroom, so a folder or file inside it may
 * be a link the worker planted. Before the host touches `path`, every
 * component below the book folder must be a real folder (or absent): a
 * planted link refuses the operation instead of carrying it elsewhere. The
 * final file itself is opened without following links (server/atomic.ts).
 */
function assertInsideBook(path: string, book?: string): string {
  const root = bookDir(book);
  const inside = relative(root, path);
  if (!inside || inside.startsWith("..") || inside.includes(`..${sep}`)) throw Object.assign(new Error("no such property"), { status: 400 });
  let current = root;
  for (const part of inside.split(sep).slice(0, -1)) {
    current = join(current, part);
    let stat;
    try { stat = lstatSync(current); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return path; throw error; }
    assertOwnPrivate(stat, "directory");
  }
  return path;
}

/** The text of a book file through a checked descriptor, or "" when absent. */
function readBookFile(path: string, book?: string): string {
  return readPrivateFileSync(assertInsideBook(path, book)) ?? "";
}

/** Replace a book file atomically; every folder below the book must be a real
 * folder of ours, and the target a plain file of ours or absent. */
export function writeBookFile(path: string, text: string, book?: string): void {
  assertInsideBook(path, book);
  ensurePrivateDir(dirname(path));
  writeFileAtomic(path, text, 0o600);
  keepPrivateFile(path);
}

/** Folders this call creates get their own protected Windows descriptor: at
 * once, or in the caller's single batch when it passes `created`. */
function ensurePrivateDir(path: string, created?: NewPrivateObject[]): void {
  if (hardenedDirs.has(path)) return;
  const made = mkdirNewSync(path, 0o700).map((folder) => ({ path: folder, kind: "directory" as const }));
  if (created) created.push(...made);
  else restrictNewSync(made);
  // The folder itself, never a link's target (a worker could plant one).
  keepPrivateDirSync(path);
  hardenedDirs.add(path);
}

function keepPrivateFile(path: string): void {
  if (hardenedFiles.has(path)) return;
  keepPrivateFileSync(path);
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
  const folders = [dir, join(dir, "properties"), join(dir, "owners"), join(dir, "decisions"), join(dir, "uploads"), join(dir, BUD_WORK_FOLDER)];
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
  for (const [path, content] of fresh) writeFileAtomic(path, content, 0o600);
  const user = join(dir, "USER.md");
  keepPrivateFile(user);
  const readme = join(dir, "README.md");
  keepPrivateFile(readme);
  // Upgrade the known bundled reference atomically; office additions survive.
  const law = join(dir, LAW_REFERENCE_FILE);
  if (!fresh.some(([path]) => path === law)) {
    const existing = readBookFile(law, book);
    const refreshed = refreshBundledLawReference(existing);
    if (refreshed !== existing) writeBookFile(law, refreshed, book);
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
  const { body } = splitFrontmatter(readBookFile(propertyPath(id, book), book));
  return body.replace(/^\n+/, "").trimEnd();
}

export function writePropertyNote(id: string, body: string, meta: { address?: string }, book?: string): string {
  seedVault(book);
  const path = propertyPath(id, book);
  const text = String(body ?? "");
  if (text.length > 20_000) throw Object.assign(new Error("note is too long"), { status: 400 });
  const address = meta.address ? `\naddress: ${meta.address.replace(/\n/g, " ")}` : "";
  const file = `---\nid: ${safeId(id)}${address}\n---\n\n${text.trimEnd()}\n`;
  writeBookFile(path, file, book);
  return text.trimEnd();
}

export function archivePropertyNote(id: string, book?: string): void {
  seedVault(book);
  const path = propertyPath(id, book);
  const raw = readPrivateFileSync(assertInsideBook(path, book));
  if (raw === null || /^archived:\s*true/m.test(raw)) return;
  const { matter, body } = splitFrontmatter(raw);
  const nextMatter = matter.includes("archived:")
    ? matter.replace(/archived:\s*\w+/g, "archived: true")
    : `${matter.trim()}\narchived: true`;
  writeBookFile(path, `---\n${nextMatter.trim()}\n---\n\n${body.replace(/^\n+/, "")}`, book);
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
  const prev = readPrivateFileSync(assertInsideBook(log, book)) ?? `# ${day}\n\n`;
  writeBookFile(log, `${prev.trimEnd()}\n${bullet}\n`, book);
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
  const prev = readPrivateFileSync(assertInsideBook(log, book)) ?? `# ${day}\n\n`;
  writeBookFile(log, `${prev.trimEnd()}\n${bullets.join("\n")}\n`, book);
}
