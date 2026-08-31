// Cross-platform Hermes CLI stub for tests. POSIX keeps the shell script;
// Windows gets a .cmd wrapper around a tiny node runner (CreateProcess cannot
// exec bare #! scripts the way POSIX does).
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HERMES_PIN } from "../hermes-pin.ts";

export type FakeHermes = { dir: string; script: string; root: string };

function writeRunner(path: string, answer: string, exitCode: number, stderr: string): void {
  writeFileSync(
    path,
    [
      "#!/usr/bin/env node",
      'if (process.argv.includes("--version")) {',
      '  process.stdout.write("Hermes Agent v0.20.3 (2026.8.16.2)\\n");',
      "  process.exit(0);",
      "}",
      stderr ? `process.stderr.write(${JSON.stringify(stderr)});` : "",
      `process.stdout.write(${JSON.stringify(answer)});`,
      `process.exit(${exitCode});`,
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

/** A fake `hermes`: --version prints the pin; chat prints `answer`. */
export function fakeHermes(answer: string, exitCode = 0, stderr = ""): FakeHermes {
  const dir = mkdtempSync(join(tmpdir(), "omb-fake-hermes-"));
  const profile = join(dir, "profiles", HERMES_PIN.profile);
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, "SOUL.md"), "# RealBud\n");
  writeFileSync(join(profile, "config.yaml"), "approvals:\n  mode: manual\ncron_mode: deny\n");

  if (process.platform === "win32") {
    const runner = join(dir, "fake-hermes-runner.mjs");
    writeRunner(runner, answer, exitCode, stderr);
    const script = join(dir, "hermes.cmd");
    writeFileSync(script, `@ECHO OFF\r\n"${process.execPath}" "${runner}" %*\r\n`);
    return { dir, script, root: dir };
  }

  const script = join(dir, "hermes");
  writeFileSync(
    script,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Hermes Agent v0.20.3 (2026.8.16.2)"; exit 0; fi\n` +
      `printf '%s' '${answer.replace(/'/g, "'\\''")}'\n${stderr ? `echo '${stderr.replace(/'/g, "'\\''")}' >&2` : ""}\nexit ${exitCode}\n`,
  );
  chmodSync(script, 0o755);
  return { dir, script, root: dir };
}

/** Version-only stub for hermes-status tests. */
export function fakeHermesVersion(versionLine: string, basename = "hermes"): string {
  const dir = mkdtempSync(join(tmpdir(), "omb-fake-hermes-ver-"));
  if (process.platform === "win32") {
    const runner = join(dir, "fake-hermes-version.mjs");
    writeFileSync(
      runner,
      [
        "#!/usr/bin/env node",
        'if (process.argv.includes("--version")) {',
        `  process.stdout.write(${JSON.stringify(`${versionLine}\n`)});`,
        "  process.exit(0);",
        "}",
        "process.exit(1);",
      ].join("\n"),
    );
    const script = join(dir, `${basename}.cmd`);
    writeFileSync(script, `@ECHO OFF\r\n"${process.execPath}" "${runner}" %*\r\n`);
    return script;
  }
  const script = join(dir, basename);
  writeFileSync(script, `#!/bin/sh\necho '${versionLine.replace(/'/g, "'\\''")}'\n`);
  chmodSync(script, 0o755);
  return script;
}
