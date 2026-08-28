import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  RecoveryRequiredError,
  deleteRecoverableFile,
  previousFile,
  quarantineFile,
  readRecoverableFile,
  writeRecoverableFile,
} from "./recoverable-file.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "realbud-recoverable-"));
  dirs.push(dir);
  return join(dir, "state.json");
}

const decode = (raw: string): { value: number } => {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
  const value = (parsed as { value?: unknown }).value;
  if (!Number.isInteger(value)) throw new Error("invalid");
  return { value: value as number };
};

describe("recoverable local files", () => {
  it("distinguishes a true first run from invalid durable state", () => {
    const file = tempFile();
    expect(readRecoverableFile(file, decode)).toMatchObject({ state: "missing", value: null });
    writeFileSync(file, "not-json");
    expect(readRecoverableFile(file, decode)).toMatchObject({ state: "blocked", reason: "current-invalid" });
    expect(readFileSync(file, "utf8")).toBe("not-json");
  });

  it("keeps one verified generation and restores it without losing corrupt evidence", () => {
    const file = tempFile();
    writeRecoverableFile(file, JSON.stringify({ value: 1 }), decode);
    writeRecoverableFile(file, JSON.stringify({ value: 2 }), decode);
    expect(decode(readFileSync(previousFile(file), "utf8"))).toEqual({ value: 1 });

    writeFileSync(file, "truncated");
    expect(readRecoverableFile(file, decode)).toMatchObject({ state: "restored", value: { value: 1 } });
    expect(decode(readFileSync(file, "utf8"))).toEqual({ value: 1 });
    expect(readFileSync(quarantineFile(file), "utf8")).toBe("truncated");
  });

  it("refuses to overwrite an unrecoverable generation", () => {
    const file = tempFile();
    writeFileSync(file, "corrupt");
    expect(() => writeRecoverableFile(file, JSON.stringify({ value: 3 }), decode)).toThrow(RecoveryRequiredError);
    expect(readFileSync(file, "utf8")).toBe("corrupt");
  });

  it("restores a missing current file when a verified previous generation exists", () => {
    const file = tempFile();
    writeFileSync(previousFile(file), JSON.stringify({ value: 4 }));
    expect(readRecoverableFile(file, decode)).toMatchObject({ state: "restored", reason: "current-missing" });
    expect(decode(readFileSync(file, "utf8"))).toEqual({ value: 4 });
  });

  it("deletes only the exact file and its recovery generations", () => {
    const file = tempFile();
    writeRecoverableFile(file, JSON.stringify({ value: 1 }), decode);
    writeRecoverableFile(file, JSON.stringify({ value: 2 }), decode);
    writeFileSync(quarantineFile(file), "evidence");
    deleteRecoverableFile(file);
    expect(readRecoverableFile(file, decode).state).toBe("missing");
  });
});
