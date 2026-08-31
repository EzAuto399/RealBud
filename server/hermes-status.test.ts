import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyHandsReadiness, hermesStatus } from "./hermes-status.ts";
import { HERMES_PIN } from "./hermes-pin.ts";
import { fakeHermesVersion } from "./testing/fake-hermes.ts";

let home: string;
let OLD_HERMES: string;
let PINNED_HERMES: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "omb-hermes-status-"));
  const profile = join(home, "profiles", HERMES_PIN.profile);
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, "SOUL.md"), "# RealBud\n");
  writeFileSync(
    join(profile, "config.yaml"),
    `approvals:\n  mode: manual\n  timeout: 300\nagent:\n  max_turns: 60\ntoolsets:\n  - web\n  - terminal\n  - file\n  - vision\n  - todo\n  - session_search\n  - delegation\nsecurity:\n  redact_secrets: true\nterminal:\n  backend: local\n  home_mode: profile\n  env_passthrough: []\nmodel:\n  default: test\n`,
  );
  OLD_HERMES = fakeHermesVersion("Hermes Agent v0.20.0 (2026.8.3)", "fake-hermes-old");
  PINNED_HERMES = fakeHermesVersion("Hermes Agent v0.20.3 (2026.8.16.2)", "fake-hermes-pinned");
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

  it("is not ready until the hands test passes", async () => {
    const status = await hermesStatus({ root: home, cli: PINNED_HERMES, platform: "linux" });
    expect(status.cli.installed).toBe(true);
    expect(status.cli.matchesPin).toBe(true);
    expect(status.pack.installed).toBe(true);
    expect(status.pack.approvalsManual).toBe(true);
    expect(status.pack.workroomReady).toBe(true);
    expect(status.ready).toBe(false);
    expect(status.detail).toMatch(/Run the hands test before Recheck or Ask/i);
    expect(status.detail).not.toMatch(/answering/i);

    const afterPing = applyHandsReadiness(status, {
      at: 1,
      ok: true,
      detail: "Worker answered OK.",
      kind: "ping",
    });
    expect(afterPing.ready).toBe(true);
    expect(afterPing.detail).toMatch(/passed the hands test/i);

    const afterFail = applyHandsReadiness(status, {
      at: 1,
      ok: false,
      detail: "ping failed",
      kind: "ping",
    });
    expect(afterFail.ready).toBe(false);
    expect(afterFail.detail).toMatch(/Run the hands test/i);
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
