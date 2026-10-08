import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runWorkroomRead, WorkroomReadError, WORKROOM_READ_TOOL } from "./workroom-read.ts";

const hooks = vi.hoisted(() => ({ beforeOpen: undefined as (() => void) | undefined, duringRead: undefined as (() => void) | undefined }));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: (path: string, flags: number, mode?: number) => { hooks.beforeOpen?.(); return actual.openSync(path, flags, mode); },
    readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
      hooks.duringRead?.(); return actual.readSync(fd, buffer, offset, length, position);
    },
  };
});

const roots: string[] = [];
function fixture(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "realbud-workroom-read-")));
  roots.push(root); return root;
}
function file(root: string, name: string, text: string | Buffer): string {
  const path = join(root, name); writeFileSync(path, text); return path;
}
afterEach(() => {
  hooks.beforeOpen = undefined; hooks.duringRead = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("fixed workroom reads", () => {
  it("advertises a closed read-only tool, and metadata explains source-date limits", () => {
    const root = fixture(), path = file(root, "Property.csv", "reference\n001\n");
    const before = readFileSync(path);
    const result = runWorkroomRead(root, { operation: "stat", path });
    expect(WORKROOM_READ_TOOL).toMatchObject({ name: "workroom_read", annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, inputSchema: { additionalProperties: false } });
    expect(result).toMatchObject({ operation: "stat", path: "Property.csv", type: "file", size: before.length });
    expect(result.modifiedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(result.modifiedAtMeaning).toMatch(/workroom copy.*upload time.*not the original document date/i);
    expect(readFileSync(path)).toEqual(before);
  });

  it("lists safe workroom entries with explicit paging and excludes private files", () => {
    const root = fixture();
    file(root, "b.txt", "b"); file(root, "a.txt", "a"); file(root, ".env", "fixture-private"); file(root, "desk.json", "fixture-private"); mkdirSync(join(root, "folder"));
    const result = runWorkroomRead(root, { operation: "list", offset: 1, limit: 1 });
    expect(result).toMatchObject({ path: ".", totalEntries: 3, excludedEntries: 2, returnedEntries: 1, hasMore: true });
    expect(result.entries).toMatchObject([{ name: "b.txt", path: "b.txt", type: "file" }]);
    expect(runWorkroomRead(root, { operation: "list", offset: 30 })).toMatchObject({ entries: [], hasMore: false });
  });

  it("reads UTF-8 lines with explicit total coverage, empty files, and offsets", () => {
    const root = fixture();
    file(root, "notes.md", "first\r\nsecond\nthird\r\n"); file(root, "empty.txt", "");
    expect(runWorkroomRead(root, { operation: "text", path: "notes.md", offset: 1, limit: 1 })).toMatchObject({ text: "second", lineCount: 3, returnedLines: 1, hasMore: true });
    expect(runWorkroomRead(root, { operation: "text", path: "notes.md", offset: 3 })).toMatchObject({ text: "", lineCount: 3, returnedLines: 0, hasMore: false });
    expect(runWorkroomRead(root, { operation: "text", path: "empty.txt" })).toMatchObject({ text: "", lineCount: 0, hasMore: false });
  });

  it.each([
    null, [], {}, { operation: ["csv"] }, { operation: "execute", path: "a.txt" }, { operation: "text" },
    { operation: "stat", path: "a.txt", code: "print(1)" }, { operation: "text", path: "a.txt", offset: null },
    { operation: "text", path: "a.txt", limit: null }, { operation: "text", path: "a.txt", offset: -1 },
    { operation: "text", path: "a.txt", offset: 0.5 }, { operation: "text", path: "a.txt", limit: 101 },
    { operation: "stat", path: "a.txt", limit: 1 }, { operation: "text", path: "a.txt", columns: ["ref"] },
    { operation: "csv", path: "a.csv", columns: [] }, { operation: "csv", path: "a.csv", columns: ["ref", "ref"] },
  ])("rejects unsupported argument combinations: %j", input => {
    expect(() => runWorkroomRead(fixture(), input)).toThrow(WorkroomReadError);
  });

  it("returns safe errors without host paths for missing files", () => {
    const root = fixture();
    expect(() => runWorkroomRead(root, { operation: "stat", path: "missing.txt" })).toThrow("The workroom path is unavailable or cannot be read safely.");
  });

  it("rejects unsupported formats, invalid UTF-8, binary bytes, oversized files and oversized output", () => {
    const root = fixture();
    file(root, "code.py", "print(1)"); file(root, "bytes.txt", Buffer.from([0xc3, 0x28])); file(root, "binary.txt", "a\0b");
    file(root, "large.txt", Buffer.alloc(8 * 1024 * 1024 + 1, 65)); file(root, "long.txt", "a".repeat(50_000));
    for (const name of ["code.py", "bytes.txt", "binary.txt", "large.txt", "long.txt"]) expect(() => runWorkroomRead(root, { operation: "text", path: name })).toThrow(WorkroomReadError);
    expect(() => runWorkroomRead(root, { operation: "text", path: "long.txt" })).toThrow(/no truncated result/);
    expect(runWorkroomRead(root, { operation: "stat", path: "code.py" })).toMatchObject({ type: "file" });
  });
});

describe("workroom path authority", () => {
  it.each(["../secret.txt", "folder/../a.txt", "/outside/secret.txt", "C:\\outside\\secret.txt", "a.txt:stream", "folder\\a.txt", ".env", ".ssh/key", "a.txt/child", "a.txt\0", "a.txt.", "a.txt ", "NUL.txt", "desk.json", "desk.key", "desk-backups/a.json", "credentials.json"])('rejects unsafe path "%s"', path => {
    const root = fixture(); file(root, "a.txt", "fixture");
    expect(() => runWorkroomRead(root, { operation: "text", path })).toThrow(WorkroomReadError);
  });

  it("rejects symlink files, symlink parents, hardlinks and linked workroom roots", () => {
    const root = fixture(), outside = fixture(); file(outside, "secret.txt", "fictional private data");
    symlinkSync(join(outside, "secret.txt"), join(root, "link.txt")); symlinkSync(outside, join(root, "linked-folder"), "dir");
    linkSync(join(outside, "secret.txt"), join(root, "hard.txt")); symlinkSync(root, join(outside, "linked-root"), "dir");
    for (const path of ["link.txt", "linked-folder/secret.txt", "hard.txt"]) expect(() => runWorkroomRead(root, { operation: "text", path })).toThrow(/Linked|special/);
    expect(() => runWorkroomRead(join(outside, "linked-root"), { operation: "list" })).toThrow(/folder cannot be read safely/);
    expect(runWorkroomRead(root, { operation: "list" })).toMatchObject({ entries: [], excludedEntries: 3 });
  });

  it("resolves a host link above the workroom, accepting relative and either absolute spelling", () => {
    const base = fixture(), real = join(base, "real"), alias = join(base, "alias");
    mkdirSync(join(real, "workroom"), { recursive: true }); file(join(real, "workroom"), "a.txt", "fixture");
    symlinkSync(real, alias, "dir");
    const root = join(alias, "workroom");
    for (const path of ["a.txt", join(root, "a.txt"), join(real, "workroom", "a.txt")]) expect(runWorkroomRead(root, { operation: "text", path })).toMatchObject({ path: "a.txt", text: "fixture" });
    expect(() => runWorkroomRead(root, { operation: "text", path: join(alias, "a.txt") })).toThrow(/inside the current workroom/);
  });

  it("allows the published Desk projection but rejects prefix lookalikes outside the root", () => {
    const root = fixture(); file(root, "DESK-CONTEXT.md", "fictional visible desk facts");
    expect(runWorkroomRead(root, { operation: "text", path: "DESK-CONTEXT.md" })).toMatchObject({ text: "fictional visible desk facts" });
    expect(() => runWorkroomRead(root, { operation: "stat", path: `${root}-outside/file.txt` })).toThrow(/inside the current workroom/);
  });

  it("rejects a substituted file inode between path validation and opening", () => {
    const root = fixture(); file(root, "a.txt", "first"); file(root, "replacement.txt", "other");
    hooks.beforeOpen = () => { hooks.beforeOpen = undefined; renameSync(join(root, "replacement.txt"), join(root, "a.txt")); };
    expect(() => runWorkroomRead(root, { operation: "text", path: "a.txt" })).toThrow(/changed before/);
  });

  it("rejects root replacement while a descriptor is being read", () => {
    const base = fixture(), root = join(base, "workroom"); mkdirSync(root); file(root, "a.txt", "first");
    hooks.duringRead = () => {
      hooks.duringRead = undefined; renameSync(root, join(base, "old-workroom")); mkdirSync(root); file(root, "a.txt", "other");
    };
    expect(() => runWorkroomRead(root, { operation: "text", path: "a.txt" })).toThrow(/path changed/);
  });

  it("rejects file growth during a descriptor read", () => {
    const root = fixture(); file(root, "a.txt", "first");
    hooks.duringRead = () => { hooks.duringRead = undefined; file(root, "a.txt", "first plus growth"); };
    expect(() => runWorkroomRead(root, { operation: "text", path: "a.txt" })).toThrow(/changed during/);
  });
});

describe("complete CSV inspection", () => {
  it("counts every data row independently of the page, with multiline quoting and leading zeros", () => {
    const root = fixture();
    file(root, "Property.csv", '\ufeffreference,address,levy\r\n001,"12 Fiction St, Example",050\r\n002,"Line one\nLine two",\r\n001,"A ""quoted"" place",050\r\n003,Elsewhere, \r\n');
    const result = runWorkroomRead(root, { operation: "csv", path: "Property.csv", offset: 1, limit: 1 });
    expect(result).toMatchObject({ rowCount: 4, columnCount: 3, offset: 1, returnedRows: 1, hasMore: true, rows: [{ reference: "002", address: "Line one\nLine two", levy: "" }], statistics: [
      { column: "reference", present: 4, blank: 0, distinct: 3 }, { column: "address", present: 4, blank: 0, distinct: 4 }, { column: "levy", present: 2, blank: 2, distinct: 1 },
    ] });
    expect(result.summaryCoverage).toMatch(/All data rows/);
    expect(result.sampleCoverage).toMatch(/page only/);
    expect(runWorkroomRead(root, { operation: "csv", path: "Property.csv", columns: ["levy", "reference"], offset: 2, limit: 1 })).toMatchObject({ rows: [{ levy: "050", reference: "001" }], statistics: [{ column: "levy" }, { column: "reference" }] });
  });

  it("counts intentionally blank data rows and supports header-only and past-end pages", () => {
    const root = fixture(); file(root, "blank.csv", 'ref,value\n,\n"",""\n'); file(root, "header.csv", "ref,value\n");
    expect(runWorkroomRead(root, { operation: "csv", path: "blank.csv", offset: 10 })).toMatchObject({ rowCount: 2, rows: [], returnedRows: 0, hasMore: false, statistics: [{ blank: 2 }, { blank: 2 }] });
    expect(runWorkroomRead(root, { operation: "csv", path: "header.csv" })).toMatchObject({ rowCount: 0, rows: [], statistics: [{ present: 0, blank: 0, distinct: 0 }, { present: 0, blank: 0, distinct: 0 }] });
  });

  it.each(["", "ref,ref\n1,2", "ref,\n1,2", "ref,value\n1", "ref,value\n1,2,3", 'ref\n"unclosed', 'ref\nun"quoted', 'ref\n"closed"tail'])("rejects malformed CSV without publishing partial counts: %j", text => {
    const root = fixture(); file(root, "bad.csv", text);
    expect(() => runWorkroomRead(root, { operation: "csv", path: "bad.csv" })).toThrow(WorkroomReadError);
  });

  it("rejects unknown columns, excessive columns, rows and cells instead of silently truncating", () => {
    const root = fixture();
    file(root, "small.csv", "ref\n001\n");
    expect(() => runWorkroomRead(root, { operation: "csv", path: "small.csv", columns: ["missing"] })).toThrow(/exact CSV header/);
    file(root, "wide.csv", Array.from({ length: 129 }, (_, index) => `c${index}`).join(","));
    file(root, "rows.csv", "ref\n" + "1\n".repeat(100_001));
    file(root, "cells.csv", "a,b,c,d,e,f\n" + "1,2,3,4,5,6\n".repeat(84_000));
    file(root, "cell.csv", "ref\n" + "a".repeat(32_769));
    for (const path of ["wide.csv", "rows.csv", "cells.csv", "cell.csv"]) expect(() => runWorkroomRead(root, { operation: "csv", path })).toThrow(/No partial statistics/);
  });

  it("rejects overlarge samples, then returns all-row statistics with a smaller page", () => {
    const root = fixture(); file(root, "sample.csv", "ref\n" + ("a".repeat(25_000) + "\n").repeat(3));
    expect(() => runWorkroomRead(root, { operation: "csv", path: "sample.csv" })).toThrow(/Reduce the page limit/);
    expect(runWorkroomRead(root, { operation: "csv", path: "sample.csv", limit: 1 })).toMatchObject({ rowCount: 3, returnedRows: 1, hasMore: true, statistics: [{ present: 3, distinct: 1 }] });
  });
});
