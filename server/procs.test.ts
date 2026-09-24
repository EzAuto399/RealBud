import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { spawnCli, cliEnvironment, execFileCli } from "./procs.ts";

const dirs: string[] = [];
it("does not give a CLI the workflow encryption key or private desktop authority", () => {
  const source = { PATH: "/fictional/bin", PROVIDER_SETTING: "keep", REALBUD_DESK_KEY: "secret", REALBUD_CUA_CONTROL_TOKEN: "secret", REALBUD_CUA_CONTROL_URL: "http://127.0.0.1:1234" };
  expect(cliEnvironment(source)).toEqual({ PATH: "/fictional/bin", PROVIDER_SETTING: "keep" });
  expect(source.REALBUD_DESK_KEY).toBe("secret");
});
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("execFileCli one-shot integration", () => {
  it("preserves argv and removes service authority before the contained spawn", async () => {
    const source = "console.log(JSON.stringify({args:process.argv.slice(1),safe:process.env.FICTIONAL_SETTING,desk:Boolean(process.env.REALBUD_DESK_KEY),cua:Boolean(process.env.REALBUD_CUA_CONTROL_TOKEN)}))";
    const args = ["", "space inside", 'quoted"argument', "backslash\\", "文字😀"];
    const output = await new Promise<string>((resolve, reject) => execFileCli(process.execPath, ["-e", source, "--", ...args], {
      timeout: 4_000, encoding: "utf8", env: { ...process.env, FICTIONAL_SETTING: "keep", REALBUD_DESK_KEY: "fictional-private-authority", REALBUD_CUA_CONTROL_TOKEN: "fictional-control-authority" },
    }, (error, stdout) => error ? reject(error) : resolve(stdout)));
    expect(JSON.parse(output)).toEqual({ args, safe: "keep", desk: false, cua: false });
  });

  it.skipIf(process.platform !== "win32")("runs a resolved npm node shim through the supervisor without a shell", async () => {
    const directory = mkdtempSync(join(tmpdir(), "realbud-worker-shim-")); dirs.push(directory);
    const script = join(directory, "fictional-worker.js"), shim = join(directory, "fictional-worker.cmd");
    writeFileSync(script, "console.log(JSON.stringify(process.argv.slice(2)));\n");
    writeFileSync(shim, '@ECHO off\r\n"%~dp0\\node.exe" "%~dp0\\fictional-worker.js" %*\r\n');
    const args = ['quote"inside', "tail\\", "space inside", ""];
    const output = await new Promise<string>((resolve, reject) => execFileCli(shim, args, { timeout: 4_000, encoding: "utf8" },
      (error, stdout) => error ? reject(error) : resolve(stdout)));
    expect(JSON.parse(output)).toEqual(args);
  });
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
