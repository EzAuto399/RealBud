import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { seedVault, writePropertyNote } from "./vault.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

describe("private workroom", () => {
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
