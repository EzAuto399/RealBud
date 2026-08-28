import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { TurnAttachment } from "./contracts.ts";
import {
  recoverSelectedFileWorkspaces,
  stageSelectedFileWorkspace,
} from "./selected-file-workspace.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "realbud-selected-file-"));
  roots.push(root);
  return root;
}

function attachment(path: string, name = "inspection.txt"): TurnAttachment {
  const bytes = readFileSync(path).byteLength;
  return { path, name, size: bytes, mimeType: "text/plain" };
}

describe("selected-file workspace", () => {
  it("copies only selected bytes into a private workspace and cleans idempotently", async () => {
    const root = scratch();
    const source = join(root, "source.txt");
    writeFileSync(source, "verified evidence");
    const staged = await stageSelectedFileWorkspace([attachment(source, "inspection: notes.txt")], {
      root: join(root, "work"),
      idFactory: () => "fixed-id",
    });

    expect(staged.directory).toBe(join(root, "work", "turn-fixed-id"));
    expect(statSync(staged.directory).mode & 0o777).toBe(0o700);
    expect(staged.attachments).toHaveLength(1);
    expect(staged.attachments[0]?.path).not.toBe(source);
    expect(staged.attachments[0]?.path).toMatch(/001-inspection_ notes\.txt$/);
    expect(readFileSync(staged.attachments[0]!.path, "utf8")).toBe("verified evidence");
    expect(staged.inputDigests[0]).toMatch(/^[a-f0-9]{64}$/);

    await staged.cleanup();
    await staged.cleanup();
    expect(existsSync(staged.directory)).toBe(false);
    expect(readFileSync(source, "utf8")).toBe("verified evidence");
  });

  it("rejects changed metadata, aggregate overflow and a newly introduced symlink", async () => {
    const root = scratch();
    const first = join(root, "first.txt");
    const second = join(root, "second.txt");
    writeFileSync(first, "12345");
    writeFileSync(second, "67890");

    await expect(stageSelectedFileWorkspace([
      { ...attachment(first), size: 4 },
    ], { root: join(root, "changed") })).rejects.toThrow(/changed/);
    await expect(stageSelectedFileWorkspace([
      attachment(first),
      attachment(second),
    ], { root: join(root, "large"), maxBytes: 9 })).rejects.toThrow(/total/);

    const link = join(root, "late-link.txt");
    symlinkSync(first, link);
    await expect(stageSelectedFileWorkspace([
      { ...attachment(first), path: link },
    ], { root: join(root, "link") })).rejects.toThrow(/changed/);
  });

  it("startup recovery removes only exact private turn directories", () => {
    const root = scratch();
    const parent = join(root, "work");
    mkdirSync(join(parent, "turn-one"), { recursive: true });
    mkdirSync(join(parent, "turn-two"));
    mkdirSync(join(parent, "keep-me"));
    writeFileSync(join(parent, "turn-file"), "not a directory");
    chmodSync(parent, 0o700);

    expect(recoverSelectedFileWorkspaces(parent)).toBe(2);
    expect(existsSync(join(parent, "turn-one"))).toBe(false);
    expect(existsSync(join(parent, "turn-two"))).toBe(false);
    expect(existsSync(join(parent, "keep-me"))).toBe(true);
    expect(existsSync(join(parent, "turn-file"))).toBe(true);
  });
});
