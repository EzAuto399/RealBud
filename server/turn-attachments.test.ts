import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  decodeTurnAttachments,
  MAX_TURN_ATTACHMENT_BYTES,
  MAX_TURN_ATTACHMENTS,
} from "./turn-attachments.ts";

describe("turn attachment boundary", () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "realbud-attachments-"));
  });
  afterEach(() => rmSync(scratch, { recursive: true, force: true }));

  it("derives canonical metadata and deduplicates the same selected file", () => {
    const file = join(scratch, "inspection photo.JPG");
    const alias = join(scratch, "alias.jpg");
    writeFileSync(file, "image bytes");
    symlinkSync(file, alias);

    expect(decodeTurnAttachments([
      { path: file, name: "forged.exe", size: 1 },
      { path: alias },
    ])).toEqual([
      { path: realpathSync(file), name: "inspection photo.JPG", size: 11, mimeType: "image/jpeg" },
    ]);
  });

  it("rejects missing, non-file, oversized, and unbounded selections", () => {
    expect(() => decodeTurnAttachments([{ path: "relative.csv" }])).toThrow(/absolute/);
    expect(() => decodeTurnAttachments([{ path: join(scratch, "missing.csv") }])).toThrow(/no longer available/);
    const directory = join(scratch, "folder");
    mkdirSync(directory);
    expect(() => decodeTurnAttachments([{ path: directory }])).toThrow(/regular files/);

    const huge = join(scratch, "huge.pdf");
    writeFileSync(huge, "");
    truncateSync(huge, MAX_TURN_ATTACHMENT_BYTES + 1);
    expect(() => decodeTurnAttachments([{ path: huge }])).toThrow(/50 MB/);
    expect(() => decodeTurnAttachments(Array.from({ length: MAX_TURN_ATTACHMENTS + 1 }, () => ({ path: huge })))).toThrow(/no more than/);
  });
});
