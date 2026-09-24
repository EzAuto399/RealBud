import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { execFileCli } from "./procs.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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
