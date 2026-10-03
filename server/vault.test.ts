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
    // An older build wrote this text from a string with LF endings; a Windows
    // checkout may give the fixture file CRLF, which no installed vault ever had.
    const legacy = readFileSync(new URL("./testing/legacy-law-reference.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
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

describe("seeded book folders", () => {
  it("makes bud-work and uploads owner-only with the book", async () => {
    const { BUD_WORK_FOLDER, seedVault } = await import("./vault.ts");
    const { lstatSync, mkdtempSync, realpathSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = realpathSync(mkdtempSync(join(tmpdir(), "rb-vault-seed-")));
    try {
      const book = seedVault(join(root, "vault"));
      for (const name of [BUD_WORK_FOLDER, "uploads", "properties", "decisions"]) expect(lstatSync(join(book, name)).mode & 0o777).toBe(0o700);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("planted links in the workroom", () => {
  it("never reads through or replaces a link or alias a worker left in the book", async () => {
    const { appendAllowedLine, archivePropertyNote, readPropertyNote, seedVault, writePropertyNote } = await import("./vault.ts");
    const { UNSAFE_PRIVATE_FILE } = await import("./atomic.ts");
    const { existsSync, linkSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = realpathSync(mkdtempSync(join(tmpdir(), "rb-vault-links-")));
    try {
      const protectedFile = join(root, "protected.yaml"); writeFileSync(protectedFile, "secret: fictional\n");
      const book = seedVault(join(root, "vault"));
      writePropertyNote("prop-oak", "Fine as is.", {}, book);
      // A note replaced by a link to a protected file: nothing is read through it, nothing replaces it.
      rmSync(join(book, "properties", "prop-oak.md")); symlinkSync(protectedFile, join(book, "properties", "prop-oak.md"));
      expect(() => readPropertyNote("prop-oak", book)).toThrow();
      expect(() => appendAllowedLine("prop-oak", "approved fictional", book)).toThrow();
      expect(() => archivePropertyNote("prop-oak", book)).toThrow();
      expect(readFileSync(protectedFile, "utf8")).toBe("secret: fictional\n");
      expect(readFileSync(join(book, "properties", "prop-oak.md"), "utf8")).toBe("secret: fictional\n");
      // A hard-linked alias of a protected file is refused too.
      linkSync(protectedFile, join(book, "properties", "prop-elm.md"));
      expect(() => readPropertyNote("prop-elm", book)).toThrow(UNSAFE_PRIVATE_FILE);
      expect(() => writePropertyNote("prop-elm", "planted", {}, book)).toThrow(UNSAFE_PRIVATE_FILE);
      expect(readFileSync(protectedFile, "utf8")).toBe("secret: fictional\n");
      // A decisions log turned into a link is left alone.
      const day = new Date().toISOString().slice(0, 10);
      symlinkSync(protectedFile, join(book, "decisions", `${day}.md`));
      writePropertyNote("prop-ash", "Note.", {}, book);
      expect(() => appendAllowedLine("prop-ash", "approved fictional", book)).toThrow();
      expect(readFileSync(protectedFile, "utf8")).toBe("secret: fictional\n");
      // A folder of the book replaced by a link is never crossed.
      const elsewhere = join(root, "elsewhere"); mkdirSync(elsewhere);
      rmSync(join(book, "properties"), { recursive: true, force: true }); symlinkSync(elsewhere, join(book, "properties"));
      expect(() => writePropertyNote("prop-fir", "Note.", {}, book)).toThrow(UNSAFE_PRIVATE_FILE);
      expect(() => readPropertyNote("prop-fir", book)).toThrow(UNSAFE_PRIVATE_FILE);
      expect(existsSync(join(elsewhere, "prop-fir.md"))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
