import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { HERMES_PIN } from "./hermes-pin.ts";
import { installInFlight, startInstall } from "./hermes-bridge.ts";
import { repairExistingProfile, startRepair, uninstallWorker } from "./hermes-lifecycle.ts";
import { fakeHermesVersion } from "./testing/fake-hermes.ts";

import { privateFixtureDirectory, privateFixtureRoot, writePrivateFixtureFile, WINDOWS_PROFILE_TEST_OPTIONS } from "./testing/private-profile-fixture.ts";

const dirs: string[] = [];
const tempDir = (prefix: string) => {
  const dir = privateFixtureRoot(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

afterEach(async () => {
  const deadline = Date.now() + 12_000;
  while (installInFlight() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("uninstallWorker", () => {
  it("removes RealBud's profile and stamps while preserving the shared runtime", async () => {
    const home = tempDir("realbud-life-home-");
    const data = tempDir("realbud-life-data-");
    const agent = join(home, "hermes-agent");
    const profile = join(home, "profiles", HERMES_PIN.profile);
    mkdirSync(join(agent, "bin"), { recursive: true });
    privateFixtureDirectory(profile);
    mkdirSync(join(home, "profiles", "personal"), { recursive: true });
    mkdirSync(join(data, "vault", "properties"), { recursive: true });
    writeFileSync(join(agent, "bin", "hermes"), "#!/bin/sh\n");
    writeFileSync(join(profile, "SOUL.md"), "# RealBud\n");
    writeFileSync(join(home, "profiles", "personal", "SOUL.md"), "keep-me");
    writeFileSync(join(home, ".env"), "PERSONAL=1\n");
    writeFileSync(join(home, "auth.json"), '{"token":"personal"}');
    writeFileSync(join(data, "config.json"), '{"ok":true}');
    writeFileSync(join(data, "channel.json"), '{"telegram":true}');
    writeFileSync(join(data, "desk.json"), '{"book":true}');
    writeFileSync(join(data, "vault", "properties", "12-river.md"), "# 12 River\n");
    writeFileSync(join(data, "hands-ping.json"), '{"at":1,"ok":true,"detail":"ok","kind":"ping"}');
    writeFileSync(join(data, "hands-last.json"), '{"at":1,"ok":true,"detail":"ok","kind":"ping"}');

    const status = await uninstallWorker({ root: home, dataDir: data });
    expect(status.pack.installed).toBe(false);
    expect(status.ready).toBe(false);
    expect(existsSync(agent)).toBe(true);
    expect(readFileSync(join(agent, "bin", "hermes"), "utf8")).toBe("#!/bin/sh\n");
    expect(existsSync(profile)).toBe(false);
    expect(existsSync(join(data, "hands-ping.json"))).toBe(false);
    expect(existsSync(join(data, "hands-last.json"))).toBe(false);
    expect(readFileSync(join(home, ".env"), "utf8")).toContain("PERSONAL=1");
    expect(readFileSync(join(home, "auth.json"), "utf8")).toContain("personal");
    expect(readFileSync(join(home, "profiles", "personal", "SOUL.md"), "utf8")).toBe("keep-me");
    expect(readFileSync(join(data, "config.json"), "utf8")).toContain("ok");
    expect(readFileSync(join(data, "channel.json"), "utf8")).toContain("telegram");
    expect(readFileSync(join(data, "desk.json"), "utf8")).toContain("book");
    expect(readFileSync(join(data, "vault", "properties", "12-river.md"), "utf8")).toContain("12 River");
  });

  it("refuses a path that resolves outside the worker home", async () => {
    const home = tempDir("realbud-life-guard-");
    const data = tempDir("realbud-life-guard-data-");
    const outside = tempDir("realbud-life-outside-");
    const profile = join(home, "profiles", HERMES_PIN.profile);
    privateFixtureDirectory(profile);
    writeFileSync(join(profile, "SOUL.md"), "# keep\n");
    writeFileSync(join(outside, "precious.txt"), "do-not-delete");
    writeFileSync(join(data, "config.json"), '{"ok":true}');

    await expect(uninstallWorker({ root: home, dataDir: data, agentDir: outside })).rejects.toMatchObject({
      message: expect.stringMatching(/outside the worker home/),
      status: 400,
    });
    expect(existsSync(join(outside, "precious.txt"))).toBe(true);
    expect(existsSync(join(profile, "SOUL.md"))).toBe(true);
    expect(readFileSync(join(data, "config.json"), "utf8")).toContain("ok");
  });
});

describe("startRepair", WINDOWS_PROFILE_TEST_OPTIONS, () => {
  it("repairs the property pack without replacing an independent 0.21 runtime or model", async () => {
    const home = tempDir("realbud-repair-profile-");
    const profile = join(home, "profiles", HERMES_PIN.profile);
    const agent = join(home, "hermes-agent");
    privateFixtureDirectory(profile);
    mkdirSync(agent, { recursive: true });
    writeFileSync(join(agent, "keep.txt"), "independent runtime");
    writePrivateFixtureFile(join(profile, "config.yaml"), "model:\n  default: fixture-model\n");
    writePrivateFixtureFile(join(profile, ".env"), "FIXTURE_KEY=keep-this-fixture\n");
    const cli = fakeHermesVersion("Hermes Agent v0.21.0 (2026.8.31)");
    dirs.push(dirname(cli));
    const status = await repairExistingProfile({ root: home, cli });
    expect(status?.cli).toMatchObject({ compatible: true, matchesPin: false });
    expect(status?.pack.workroomReady).toBe(true);
    expect(readFileSync(join(agent, "keep.txt"), "utf8")).toBe("independent runtime");
    expect(readFileSync(join(profile, "config.yaml"), "utf8")).toContain("fixture-model");
    expect(readFileSync(join(profile, ".env"), "utf8")).toContain("keep-this-fixture");
  });

  it("holds an unknown release without altering its profile", async () => {
    const home = tempDir("realbud-repair-unsupported-");
    const profile = join(home, "profiles", HERMES_PIN.profile);
    privateFixtureDirectory(profile);
    writePrivateFixtureFile(join(profile, "config.yaml"), "keep this unchanged");
    const cli = fakeHermesVersion("Hermes Agent v0.22.0 (2026.9.9)");
    dirs.push(dirname(cli));
    await expect(repairExistingProfile({ root: home, cli })).rejects.toMatchObject({ status: 409 });
    expect(readFileSync(join(profile, "config.yaml"), "utf8")).toBe("keep this unchanged");
  });

  it("returns 409 while an install job is running", async () => {
    const job = startInstall("sleep 3", { timeoutMs: 8_000 });
    expect(["running", "verifying", "preflight"]).toContain(job.state);
    expect(installInFlight()).toBe(true);
    expect(() => startRepair("true")).toThrow(/already running/);
    try {
      startRepair("true");
    } catch (err) {
      expect((err as { status?: number }).status).toBe(409);
    }
  });
});
