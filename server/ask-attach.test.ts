import { readFileSync, rmSync, lstatSync, mkdirSync, readdirSync, symlinkSync, realpathSync, chmodSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ASK_ATTACH_MAX_BYTES, saveAskAttachment } from "./ask-attach.ts";
import { privateDir, privateTempRoot, windowsAdmissionTimeout } from "./testing/private-fixture.ts";
import { windowsFilePrivacySync } from "./windows-file-privacy.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("ask attachments", () => {
  it("writes a PDF under the data dir and rejects a disallowed type", () => {
    const dir = realpathSync(privateTempRoot(join(tmpdir(), "realbud-ask-")));
    dirs.push(dir);
    const saved = saveAskAttachment(dir, {
      name: "lease.pdf",
      contentBase64: Buffer.from("%PDF-1.4 test").toString("base64"),
      size: 13,
    });
    expect(saved.name).toBe("lease.pdf");
    expect(saved.path).toContain("ask-uploads");
    expect(readFileSync(saved.path, "utf8")).toContain("%PDF-1.4");
    expect(() =>
      saveAskAttachment(dir, { name: "payload.exe", contentBase64: Buffer.from("x").toString("base64") }),
    ).toThrow(/cannot be attached/);
  });
});


describe("selected document copies", () => {
  const fresh = () => { const dir = realpathSync(privateTempRoot(join(tmpdir(), "realbud-selected-"))); dirs.push(dir); return dir; };
  const input = (name = "report.xlsx", content = "synthetic file bytes") => ({ name, contentBase64: Buffer.from(content).toString("base64"), size: Buffer.byteLength(content) });

  it("keeps the same selected file private and byte-identical on separate desktops", () => {
    const a = fresh(), b = fresh();
    const source = input("C:\\Accounts\\owner report.xlsx");
    const first = saveAskAttachment(a, source), second = saveAskAttachment(b, source);
    expect(first.path).toContain(join("vault", "ask-uploads"));
    expect(first.path).not.toBe(second.path);
    expect(readFileSync(first.path)).toEqual(readFileSync(second.path));
    expect(readFileSync(first.path).toString("base64")).toBe(source.contentBase64);
    if (process.platform !== "win32") {
      expect(lstatSync(first.path).mode & 0o777).toBe(0o600);
      expect(lstatSync(join(a, "vault", "ask-uploads")).mode & 0o777).toBe(0o700);
    }
  });

  it("retains Office extensions for long Unicode and Windows reserved names", () => {
    const dir = fresh();
    for (const name of ["業".repeat(200) + ".docx", "CON.xlsx", "../../a.docx"]) {
      const saved = saveAskAttachment(dir, input(name));
      expect(saved.path.startsWith(join(realpathSync(dir), "vault", "ask-uploads"))).toBe(true);
      expect(saved.name).toMatch(/\.(docx|xlsx)$/);
      expect(Buffer.byteLength(saved.name)).toBeLessThan(180);
    }
  });

  it("rejects malformed payloads and exact size mismatches before creating copies", () => {
    const dir = fresh();
    for (const value of [null, [], {}, { ...input(), contentBase64: "aGVsbG8=!!!" }, { ...input(), size: 0 }, { ...input(), size: NaN }, { ...input(), path: "/private/secret" }]) {
      expect(() => saveAskAttachment(dir, value)).toThrow();
    }
    expect(readdirSync(dir)).toEqual([]);
    expect(() => saveAskAttachment(dir, { ...input(), contentBase64: "A".repeat(Math.ceil(ASK_ATTACH_MAX_BYTES / 3) * 4 + 4) })).toThrow(/too large/);
  });

  it("accepts an explicitly selected empty text file", () => {
    const saved = saveAskAttachment(fresh(), input("empty.txt", ""));
    expect(saved.size).toBe(0); expect(readFileSync(saved.path).length).toBe(0);
  });

  it("copies only selected bytes without changing or following the source file", () => {
    const dir = fresh(), sourceDir = fresh(), sourcePath = join(sourceDir, "statement.csv");
    writeFileSync(sourcePath, "date,amount\n2026-09-23,25.00\n");
    const selected = readFileSync(sourcePath);
    // The source can change after selection; the desktop receives bytes, not
    // authority to reopen this path or anything else in its parent directory.
    writeFileSync(sourcePath, "source changed after selection");
    const saved = saveAskAttachment(dir, {
      name: sourcePath, contentBase64: selected.toString("base64"), size: selected.length,
    });
    expect(readFileSync(saved.path)).toEqual(selected);
    expect(readFileSync(sourcePath, "utf8")).toBe("source changed after selection");
    expect(readdirSync(sourceDir)).toEqual(["statement.csv"]);
  });

  it.skipIf(process.platform === "win32")("supports older application roots while keeping the copied bytes private", () => {
    const dir = fresh(); chmodSync(dir, 0o755);
    const saved = saveAskAttachment(dir, input());
    expect(lstatSync(join(dir, "vault")).mode & 0o777).toBe(0o700);
    expect(lstatSync(saved.path).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === "win32")("refuses symlinked workrooms and upload folders without touching their targets", () => {
    for (const segment of ["vault", "ask-uploads"]) {
      const dir = fresh(), outside = fresh();
      if (segment === "ask-uploads") mkdirSync(join(dir, "vault"), { mode: 0o700 });
      symlinkSync(outside, segment === "vault" ? join(dir, "vault") : join(dir, "vault", "ask-uploads"));
      expect(() => saveAskAttachment(dir, input())).toThrow(/private attachment folder/);
      expect(readdirSync(outside)).toEqual([]);
    }
  });
});

describe.skipIf(process.platform !== "win32")("native Windows attachment privacy", () => {
  const fresh = () => { const dir = realpathSync(privateTempRoot(join(tmpdir(), "realbud-native-attach-"))); dirs.push(dir); return dir; };
  const input = { name: "statement.csv", contentBase64: Buffer.from("fictional selected bytes").toString("base64") };

  it("creates protected directories and files and verifies them on reuse", windowsAdmissionTimeout(20), () => {
    const dir = join(fresh(), "new-desktop");
    const first = saveAskAttachment(dir, input), second = saveAskAttachment(dir, input);
    for (const folder of [dir, join(dir, "vault"), join(dir, "vault", "ask-uploads")]) {
      expect(() => windowsFilePrivacySync(folder, "directory")).not.toThrow();
    }
    for (const saved of [first, second]) {
      expect(() => windowsFilePrivacySync(saved.path, "file")).not.toThrow();
      expect(readFileSync(saved.path).toString("base64")).toBe(input.contentBase64);
    }
  });

  it.each(["root", "vault", "ask-uploads"])("refuses an inherited %s descriptor without repairing it", windowsAdmissionTimeout(12), segment => {
    const outer = fresh(), dir = segment === "root" ? join(outer, "legacy") : outer;
    const rejected = segment === "root" ? dir : segment === "vault" ? join(dir, "vault") : join(dir, "vault", "ask-uploads");
    if (segment === "ask-uploads") privateDir(join(dir, "vault"));
    mkdirSync(rejected);
    expect(() => saveAskAttachment(dir, input)).toThrow(/private attachment folder/);
    expect(readdirSync(rejected)).toEqual([]);
    expect(() => windowsFilePrivacySync(rejected, "directory")).toThrow(/inheritance-not-protected/);
  });

  it("refuses a junction without creating a copy in its target", windowsAdmissionTimeout(5), () => {
    const dir = fresh(), outside = fresh();
    symlinkSync(outside, join(dir, "vault"), "junction");
    expect(() => saveAskAttachment(dir, input)).toThrow(/private attachment folder/);
    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(join(outside, "ask-uploads"))).toBe(false);
  });
});
