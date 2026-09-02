// The PM's book: markdown files Hermes may read. Not a second brain UI.
// Worker SOUL stays in the Hermes pack. Evaluate never reads these files.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { LAW_REFERENCE_FILE, LAW_REFERENCE_MARKDOWN } from "./law-reference.ts";

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

function ensurePrivateDir(path: string): void {
  if (hardenedDirs.has(path)) return;
  mkdirSync(path, { recursive: true, mode: 0o700 });
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

export function seedVault(book?: string): string {
  const dir = bookDir(book);
  ensurePrivateDir(dir);
  ensurePrivateDir(join(dir, "properties"));
  ensurePrivateDir(join(dir, "owners"));
  ensurePrivateDir(join(dir, "decisions"));
  const user = join(dir, "USER.md");
  if (!existsSync(user)) {
    writeFileSync(user, "# You\n\nThis is the property manager RealBud works for.\n", { mode: 0o600 });
  }
  keepPrivateFile(user);
  const readme = join(dir, "README.md");
  if (!existsSync(readme)) {
    writeFileSync(
      readme,
      [
        "# Book",
        "",
        "Notes on each property live in properties/. They are preferences, not law.",
        "Desk shop rules and the ledger win. Do not invent a legal clock.",
        "Process for notices and trust sits with the licensee.",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
  }
  keepPrivateFile(readme);
  // The tenancy reference seeds once; the app's release train owns updates.
  const law = join(dir, LAW_REFERENCE_FILE);
  if (!existsSync(law)) {
    writeFileSync(law, LAW_REFERENCE_MARKDOWN, { mode: 0o600 });
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
  writeFileSync(log, `${prev.trimEnd()}\n${bullet}\n`, { mode: 0o600 });
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
  writeFileSync(log, `${prev.trimEnd()}\n${bullets.join("\n")}\n`, { mode: 0o600 });
  keepPrivateFile(log);
}
