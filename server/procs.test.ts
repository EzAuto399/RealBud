import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { spawnCli } from "./procs.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("spawnCli private workroom mode", () => {
  it.skipIf(process.platform === "win32")("gives child-created files an owner-only default", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "realbud-child-mode-"));
    dirs.push(cwd);
    const child = spawnCli("/bin/sh", ["-c", "printf private > proof.txt"], {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      privateFiles: true,
    });

    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`child exited ${String(code)}`)));
    });

    expect(readFileSync(join(cwd, "proof.txt"), "utf8")).toBe("private");
    expect(statSync(join(cwd, "proof.txt")).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === "win32")("preserves ENOENT when the private CLI is missing", async () => {
    const child = spawnCli("realbud-definitely-missing-cli", [], {
      env: { PATH: "/usr/bin:/bin" },
      stdio: ["pipe", "pipe", "pipe"],
      privateFiles: true,
    });

    const error = await new Promise<NodeJS.ErrnoException>((resolve) => child.once("error", resolve));
    expect(error.code).toBe("ENOENT");
  });
});
