import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hermesStatus } from "./hermes-status.ts";
import { HERMES_PIN } from "./hermes-pin.ts";
import { applyPropertyPack, withYamlBlock } from "./hermes-pack.ts";
import { workerCli, workerInstallDir } from "./config.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const OLD_HERMES = join(SERVER_DIR, "testing", "fake-hermes-old.sh");
const PINNED_HERMES = join(SERVER_DIR, "testing", "fake-hermes-pinned.sh");

let home: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "omb-hermes-status-"));
  // `root` is the worker home itself. Readiness now requires the exact
  // checked-in safety pack, with only its dynamic model block excluded from
  // byte attestation.
  const profile = applyPropertyPack(home).dir;
  const config = join(profile, "config.yaml");
  writeFileSync(config, withYamlBlock(readFileSync(config, "utf8"), "model", "model:\n  default: test\n"));
  writeFileSync(OLD_HERMES, "#!/bin/sh\necho 'Hermes Agent v0.20.0 (2026.8.3)'\n");
  writeFileSync(PINNED_HERMES, "#!/bin/sh\necho 'Hermes Agent v0.20.3 (2026.8.16.2)'\n");
  chmodSync(OLD_HERMES, 0o755);
  chmodSync(PINNED_HERMES, 0o755);
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("hermesStatus", () => {
  it("reports a missing CLI before anything else", async () => {
    const status = await hermesStatus({ root: home, cli: "definitely-not-a-real-cli", platform: "darwin" });
    expect(status.cli.installed).toBe(false);
    expect(status.cli.matchesPin).toBe(false);
    expect(status.ready).toBe(false);
    expect(status.detail).toMatch(/not installed/i);
    expect(status.installCommand).toContain(`--commit ${HERMES_PIN.commit}`);
  });

  it("flags a version mismatch against the pin", async () => {
    const status = await hermesStatus({ root: home, cli: OLD_HERMES, platform: "darwin" });
    expect(status.cli.installed).toBe(true);
    expect(status.cli.matchesPin).toBe(false);
    expect(status.ready).toBe(false);
    expect(status.detail).toMatch(/pin is v0\.20\.3/i);
  });

  it("is ready when version, pack and manual approvals all line up", async () => {
    const status = await hermesStatus({ root: home, cli: PINNED_HERMES, platform: "linux" });
    expect(status.cli.installed).toBe(true);
    expect(status.cli.matchesPin).toBe(true);
    expect(status.pack.installed).toBe(true);
    expect(status.pack.approvalsManual).toBe(true);
    expect(status.ready).toBe(true);
    expect(status.cli.installId).toMatch(/^[0-9a-f]{20}$/);
    expect(status.detail).toMatch(/Worker 0.20.3 and the property pack are installed\. Run the hands test before Ask\./i);
  });

  it("requires the exact checkout commit for the RealBud-owned launcher", async () => {
    const isolated = mkdtempSync(join(tmpdir(), "realbud-exact-pin-"));
    try {
      const profile = join(isolated, "profiles", HERMES_PIN.profile);
      const cli = workerCli(isolated);
      mkdirSync(profile, { recursive: true });
      mkdirSync(dirname(cli), { recursive: true });
      mkdirSync(join(workerInstallDir(isolated), ".git"), { recursive: true });
      writeFileSync(join(profile, "SOUL.md"), "# RealBud\n");
      writeFileSync(join(profile, "config.yaml"), "approvals:\n  mode: manual\n");
      writeFileSync(cli, "#!/bin/sh\necho 'Hermes Agent v0.20.3 (2026.8.16.2)'\n");
      chmodSync(cli, 0o755);

      writeFileSync(join(workerInstallDir(isolated), ".git", "HEAD"), `${"0".repeat(40)}\n`);
      const wrong = await hermesStatus({ root: isolated, platform: "darwin" });
      expect(wrong.cli.matchesPin).toBe(false);
      expect(wrong.detail).toMatch(/checkout is not RealBud's pinned build/i);

      writeFileSync(join(workerInstallDir(isolated), ".git", "HEAD"), `${HERMES_PIN.commit}\n`);
      const exact = await hermesStatus({ root: isolated, platform: "darwin" });
      expect(exact.cli.matchesPin).toBe(true);
      expect(exact.cli.checkoutCommit).toBe(HERMES_PIN.commit);
    } finally {
      rmSync(isolated, { recursive: true, force: true });
    }
  });

  it("flags the pack as missing when SOUL.md is absent", async () => {
    const bare = mkdtempSync(join(tmpdir(), "omb-hermes-bare-"));
    try {
      const status = await hermesStatus({ root: bare, cli: PINNED_HERMES, platform: "linux" });
      expect(status.cli.matchesPin).toBe(true);
      expect(status.pack.installed).toBe(false);
      expect(status.ready).toBe(false);
      expect(status.detail).toMatch(/pack is not installed/i);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
