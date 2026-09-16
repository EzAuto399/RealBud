import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { seedVault, writePropertyNote } from "./vault.ts";
import { LAW_REFERENCE_FILE, LAW_REFERENCE_MARKDOWN } from "./law-reference.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

describe("private workroom", () => {
  it("refreshes the legacy legal shortcuts while preserving appended office notes", () => {
    const root = mkdtempSync(join(tmpdir(), "realbud-law-refresh-"));
    dirs.push(root);
    const book = seedVault(join(root, "vault"));
    const path = join(book, LAW_REFERENCE_FILE);
    const legacy = readFileSync(new URL("./testing/legacy-law-reference.md", import.meta.url), "utf8");
    const note = "\n## Office note\nAsk the licensee before proceeding.\n";
    writeFileSync(path, legacy + note);
    seedVault(book);
    expect(readFileSync(path, "utf8")).toBe(LAW_REFERENCE_MARKDOWN + note);
    seedVault(book);
    expect(readFileSync(path, "utf8")).toBe(LAW_REFERENCE_MARKDOWN + note);
    writeFileSync(path, "Office-authored reference");
    seedVault(book);
    expect(readFileSync(path, "utf8")).toBe("Office-authored reference");
  });
  it.skipIf(process.platform === "win32")("keeps directories private and authored notes owner-only", () => {
    const root = mkdtempSync(join(tmpdir(), "realbud-vault-mode-"));
    dirs.push(root);
    const book = join(root, "vault");

    seedVault(book);
    writePropertyNote("prop-oak", "Private note", { address: "12 Oak St" }, book);

    expect(mode(book)).toBe(0o700);
    expect(mode(join(book, "properties"))).toBe(0o700);
    expect(mode(join(book, "README.md"))).toBe(0o600);
    expect(mode(join(book, "USER.md"))).toBe(0o600);
    expect(mode(join(book, "properties", "prop-oak.md"))).toBe(0o600);
  });
});
