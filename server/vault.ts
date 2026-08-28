// The PM's book: markdown files Hermes may read. Not a second brain UI.
// Worker SOUL stays in the Hermes pack. Evaluate never reads these files.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { DATA_DIR } from "./config.ts";

const SAFE_ID = /^[\w-]+$/;

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

export function seedVault(book?: string): string {
  const dir = bookDir(book);
  mkdirSync(join(dir, "properties"), { recursive: true });
  mkdirSync(join(dir, "owners"), { recursive: true });
  mkdirSync(join(dir, "decisions"), { recursive: true });
  const user = join(dir, "USER.md");
  if (!existsSync(user)) {
    writeFileSync(user, "# You\n\nThis is the property manager RealBud works for.\n");
  }
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
    );
  }
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
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, file);
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
  writeFileSync(path, `---\n${nextMatter.trim()}\n---\n\n${body.replace(/^\n+/, "")}`);
}

export function appendAllowedLines(
  entries: Array<{ id: string; line: string; address?: string }>,
  book?: string,
  at = Date.now(),
): void {
  if (entries.length === 0) return;
  seedVault(book);
  const bullets: string[] = [];
  for (const entry of entries) {
    const existing = readPropertyNote(entry.id, book);
    const bullet = `- ${entry.line}`;
    const next = /^## Last allowed/m.test(existing)
      ? existing.replace(/^(## Last allowed\n)/m, `$1\n${bullet}\n`)
      : `${existing.trimEnd()}\n\n## Last allowed\n\n${bullet}\n`;
    writePropertyNote(entry.id, next.trim(), { address: entry.address }, book);
    bullets.push(bullet);
  }
  const day = new Date(at).toISOString().slice(0, 10);
  const log = join(bookDir(book), "decisions", `${day}.md`);
  mkdirSync(dirname(log), { recursive: true });
  const prev = existsSync(log) ? readFileSync(log, "utf8") : `# ${day}\n\n`;
  writeFileSync(log, `${prev.trimEnd()}\n${bullets.join("\n")}\n`);
}

export function appendAllowedLine(id: string, line: string, book?: string, address?: string, at = Date.now()): void {
  appendAllowedLines([{ id, line, address }], book, at);
}
