import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeFileAtomic, writeFileFsynced } from "./atomic.ts";

describe("writeFileAtomic", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omb-atomic-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the file", () => {
    const p = join(dir, "x.json");
    writeFileAtomic(p, '{"a":1}');
    expect(readFileSync(p, "utf8")).toBe('{"a":1}');
  });

  it("replaces existing contents in full", () => {
    const p = join(dir, "x.json");
    writeFileAtomic(p, "old-and-longer");
    writeFileAtomic(p, "new");
    expect(readFileSync(p, "utf8")).toBe("new");
  });

  it("leaves no temp files behind", () => {
    const p = join(dir, "x.json");
    writeFileAtomic(p, "a");
    writeFileAtomic(p, "b");
    expect(readdirSync(dir)).toEqual(["x.json"]);
  });

  it("preserves unicode across the write", () => {
    const p = join(dir, "u.json");
    const s = JSON.stringify({ msg: "café — 日本語 — 🚀" });
    writeFileAtomic(p, s);
    expect(readFileSync(p, "utf8")).toBe(s);
    expect(existsSync(p)).toBe(true);
  });

  it("fsyncs an exact backup without renaming away the original", () => {
    const p = join(dir, "backup.json");
    writeFileFsynced(p, Buffer.from("exact-bytes"));
    expect(readFileSync(p)).toEqual(Buffer.from("exact-bytes"));
  });

  it("cleans up the temporary file when replacement fails", () => {
    const p = join(dir, "target");
    mkdirSync(p);
    expect(() => writeFileAtomic(p, "cannot replace a directory")).toThrow();
    expect(readdirSync(dir)).toEqual(["target"]);
  });
});

describe("private file helpers", () => {
  it("reads only a plain single-link file of ours, never through a link or an alias", async () => {
    const { openPrivateFileSync, readPrivateFileSync, writeFileAtomic, UNSAFE_PRIVATE_FILE } = await import("./atomic.ts");
    const { linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "rb-private-"));
    try {
      const secret = join(dir, "protected.txt"); writeFileSync(secret, "fictional protected text");
      const note = join(dir, "note.md"); writeFileSync(note, "note");
      expect(readPrivateFileSync(note)).toBe("note");
      expect(readPrivateFileSync(join(dir, "absent.md"))).toBeNull();
      symlinkSync(secret, join(dir, "link.md"));
      expect(() => readPrivateFileSync(join(dir, "link.md"))).toThrow();
      linkSync(secret, join(dir, "alias.md"));
      expect(() => readPrivateFileSync(join(dir, "alias.md"))).toThrow(UNSAFE_PRIVATE_FILE);
      expect(() => openPrivateFileSync(dir)).toThrow(UNSAFE_PRIVATE_FILE);
      // A write never replaces a link or an alias, and the protected file keeps its text.
      expect(() => writeFileAtomic(join(dir, "link.md"), "planted", 0o600)).toThrow(UNSAFE_PRIVATE_FILE);
      expect(() => writeFileAtomic(join(dir, "alias.md"), "planted", 0o600)).toThrow(UNSAFE_PRIVATE_FILE);
      expect(readFileSync(secret, "utf8")).toBe("fictional protected text");
      expect(readFileSync(join(dir, "link.md"), "utf8")).toBe("fictional protected text");
      writeFileAtomic(note, "replaced", 0o600);
      expect(readPrivateFileSync(note)).toBe("replaced");
      // A FIFO under the name never holds the host: the open is non-blocking and the type is refused at once.
      const { execFileSync } = await import("node:child_process");
      execFileSync("mkfifo", [join(dir, "pipe.md")]);
      const started = Date.now();
      expect(() => readPrivateFileSync(join(dir, "pipe.md"))).toThrow(UNSAFE_PRIVATE_FILE);
      expect(Date.now() - started).toBeLessThan(2_000);
      // Reads are bounded.
      writeFileSync(join(dir, "big.md"), "x".repeat(2_048));
      expect(() => readPrivateFileSync(join(dir, "big.md"), 1_024)).toThrow(UNSAFE_PRIVATE_FILE);
      expect(readPrivateFileSync(join(dir, "big.md"), 4_096)).toHaveLength(2_048);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
