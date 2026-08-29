import { createReadStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { composerInboxRoot, stageComposerInboxFile } from "./composer-inbox.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "realbud-inbox-"));
  dirs.push(dir);
  return dir;
}

describe("composer inbox", () => {
  it("stages a selected PDF under the private inbox and rejects social dumps", async () => {
    const root = scratch();
    const staged = await stageComposerInboxFile({
      filename: "arrears export.pdf",
      body: Readable.from([Buffer.from("%PDF-1.4 test")]),
      root,
    });
    expect(staged.name).toBe("arrears export.pdf");
    expect(staged.mimeType).toBe("application/pdf");
    expect(staged.size).toBeGreaterThan(0);
    expect(staged.path.startsWith(composerInboxRoot(root))).toBe(true);
    expect(existsSync(staged.path)).toBe(true);

    await expect(stageComposerInboxFile({
      filename: "story.mp4",
      body: Readable.from([Buffer.from("nope")]),
      root,
    })).rejects.toThrow(/PDF, image, spreadsheet or text export/i);

    await expect(stageComposerInboxFile({
      filename: "../secret.pdf",
      body: Readable.from([Buffer.from("%PDF")]),
      root,
    })).rejects.toThrow(/not usable/);
  });

  it("sweeps stale inbox files and enforces the size cap", async () => {
    const root = scratch();
    const inbox = composerInboxRoot(root);
    mkdirSync(inbox, { recursive: true });
    const stale = join(inbox, `${Date.now() - 25 * 60 * 60 * 1000}-dead.pdf`);
    writeFileSync(stale, "old");

    await expect(stageComposerInboxFile({
      filename: "shot.png",
      body: Readable.from([Buffer.alloc(32)]),
      root,
      maxBytes: 16,
    })).rejects.toThrow(/MB or smaller/);
    expect(existsSync(stale)).toBe(false);

    const keep = join(inbox, `${Date.now()}-keep.txt`);
    writeFileSync(keep, "new");
    await stageComposerInboxFile({
      filename: "note.txt",
      body: createReadStream(keep),
      root,
    });
    expect(existsSync(keep)).toBe(true);
  });
});
