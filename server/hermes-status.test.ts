import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hermesStatus } from "./hermes-status.ts";
import { HERMES_PIN } from "./hermes-pin.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const OLD_HERMES = join(SERVER_DIR, "testing", "fake-hermes-old.sh");
const PINNED_HERMES = join(SERVER_DIR, "testing", "fake-hermes-pinned.sh");

let home: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "omb-hermes-status-"));
  // `root` is the Hermes home itself (same convention as hermes-pack tests).
  // Pack marker: SOUL.md presence; approvals come from config.yaml.
  const profile = join(home, "profiles", HERMES_PIN.profile);
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, "SOUL.md"), "# RealBud\n");
  writeFileSync(
    join(profile, "config.yaml"),
    `approvals:\n  mode: manual\n  timeout: 300\nmodel:\n  default: test\n`,
  );
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
    expect(status.detail).toMatch(/Worker 0.20.3 answering\. Desk Recheck will ask it for the morning ledger\./i);
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
