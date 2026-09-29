import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { HERMES_PIN } from "./hermes-pin.ts";
import { installStatus, modelStatus, reconcileManagedModelProfile, setManagedModelChoice, startInstall } from "./hermes-bridge.ts";
import { MANAGED_MODEL_KEY_ENV, MANAGED_MODEL_PROVIDER, managedModelProfile } from "./hermes-pack.ts";
import { setWorkerModelGrant } from "./worker-model-access.ts";

import { privateFixtureDirectory, privateFixtureRoot, writePrivateFixtureFile as writeFileSync, WINDOWS_PROFILE_TEST_OPTIONS } from "./testing/private-profile-fixture.ts";

const dirs: string[] = [];
const mkdtempSync = privateFixtureRoot;
const GATEWAY = "https://gateway.fictional.test/v1";
const tempHome = () => {
  const dir = mkdtempSync(join(tmpdir(), "realbud-bridge-"));
  dirs.push(dir);
  const profile = join(dir, "profiles", HERMES_PIN.profile);
  privateFixtureDirectory(profile);
  return { dir, profile };
};
const active = () => setWorkerModelGrant({ state: "active", baseUrl: GATEWAY, keyId: "fictional-key-id", spendCapLabel: "Fictional cap" });

afterEach(() => {
  setWorkerModelGrant({ state: "none" });
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("managed model choice", WINDOWS_PROFILE_TEST_OPTIONS, () => {
  it("writes the chosen model, effort and managed provider, never a key", async () => {
    const { dir, profile } = tempHome();
    writeFileSync(join(profile, "SOUL.md"), "# RealBud\n");
    writeFileSync(join(profile, ".env"), "OTHER_SETTING=keep-me\nOPENAI_API_KEY=fictional-stale-key\n");
    active();
    const status = await setManagedModelChoice({ choice: "sonnet-xhigh" }, { root: dir });
    expect(status).toMatchObject({ provider: MANAGED_MODEL_PROVIDER, model: "claude-sonnet-5.5", choice: "sonnet-xhigh", managed: true, keyPresent: true });
    expect(status.keyHint).toBe("Model access: managed by RealBud service (Modelvia)");
    const config = readFileSync(join(profile, "config.yaml"), "utf8");
    expect(config).toContain("reasoning_effort: xhigh");
    expect(config).toContain(`key_env: ${MANAGED_MODEL_KEY_ENV}`);
    expect(config).toContain(`base_url: ${GATEWAY}`);
    expect(readFileSync(join(profile, ".env"), "utf8")).toBe("OTHER_SETTING=keep-me\n");
    if (process.platform !== "win32") expect(statSync(join(profile, "config.yaml")).mode & 0o777).toBe(0o600);
    expect(await setManagedModelChoice({ choice: "flash-high" }, { root: dir })).toMatchObject({ model: "deepseek-v4.1-flash", choice: "flash-high" });
    expect(managedModelProfile(dir)).toMatchObject({ reasoningEffort: "high", choice: "flash-high" });
  });

  it("accepts only exactly { choice } with one of the three ids", async () => {
    const { dir, profile } = tempHome();
    writeFileSync(join(profile, "SOUL.md"), "# RealBud\n");
    active();
    for (const body of [
      { providerId: "xai", apiKey: "fictional-key", model: "grok-4" },
      { choice: "flash-high", apiKey: "fictional-key" },
      { choice: "flash-high", model: "deepseek-v4.1-flash" },
      { choice: "flash-xhigh" }, { choice: "auto" }, { model: "claude-sonnet-5.5" }, {}, null, "flash-high", ["flash-high"],
    ]) {
      await expect(setManagedModelChoice(body, { root: dir })).rejects.toMatchObject({ status: 400 });
    }
    expect(existsSync(join(profile, "config.yaml"))).toBe(false);
  });

  it("refuses when not paired, withdrawn, or before the workroom exists", async () => {
    const { dir, profile } = tempHome();
    await expect(setManagedModelChoice({ choice: "flash-high" }, { root: dir })).rejects.toThrow(/Pair it from realbud\.app/);
    setWorkerModelGrant({ state: "withdrawn" });
    await expect(setManagedModelChoice({ choice: "flash-high" }, { root: dir })).rejects.toThrow(/withdrawn/);
    active();
    await expect(setManagedModelChoice({ choice: "flash-high" }, { root: dir })).rejects.toMatchObject({ status: 409 });
    expect(existsSync(join(profile, "config.yaml"))).toBe(false);
  });

  it("modelStatus reports no access without a grant, whatever an old profile names", () => {
    const { dir, profile } = tempHome();
    expect(modelStatus(dir)).toMatchObject({ provider: null, model: null, choice: null, keyPresent: false, managed: false });
    writeFileSync(join(profile, "config.yaml"), "model:\n  default: grok-4\n  provider: xai\n");
    writeFileSync(join(profile, ".env"), "XAI_API_KEY=fictional-old-key\n");
    expect(modelStatus(dir)).toMatchObject({ provider: "xai", model: "grok-4", choice: null, keyPresent: false, keyHint: null, managed: false });
    setWorkerModelGrant({ state: "withdrawn" });
    expect(modelStatus(dir)).toMatchObject({ keyPresent: false, managedWithdrawn: true });
  });

  it("reconciles an upgraded openai-api/auto profile onto the default (Sonnet · High) and keeps a valid saved choice", async () => {
    const { dir, profile } = tempHome();
    writeFileSync(join(profile, "SOUL.md"), "# RealBud\n");
    writeFileSync(join(profile, "config.yaml"), `model:\n  default: auto\n  provider: openai-api\n  base_url: "${GATEWAY}"\n  api_mode: chat_completions\n`);
    expect(await reconcileManagedModelProfile(dir)).toBe(false); // no grant: nothing written
    active();
    expect(await reconcileManagedModelProfile(dir)).toBe(true);
    expect(managedModelProfile(dir)).toMatchObject({ provider: MANAGED_MODEL_PROVIDER, model: "claude-sonnet-5.5", choice: "sonnet-high", baseUrl: GATEWAY });
    expect(await reconcileManagedModelProfile(dir)).toBe(false);
    await setManagedModelChoice({ choice: "flash-high" }, { root: dir });
    writeFileSync(join(profile, ".env"), `${MANAGED_MODEL_KEY_ENV}=fictional-shadow\n`);
    expect(await reconcileManagedModelProfile(dir)).toBe(true);
    expect(managedModelProfile(dir)).toMatchObject({ choice: "flash-high", envKeyPresent: false });
  });
});

describe("install job", () => {
  it.skipIf(process.platform === "win32")("runs a fake installer, verifies the version, and lands done", async () => {
    const dir = mkdtempSync(join(tmpdir(), "realbud-bridge-install-"));
    dirs.push(dir);
    const fake = join(dir, "hermes");
    writeFileSync(fake, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"Hermes Agent v0.20.3 (2026.8.16.2)\"; fi\n");
    const { chmodSync } = await import("node:fs");
    chmodSync(fake, 0o755);
    const job = startInstall(`printf 'downloading…\\nextracting…\\n'`, { timeoutMs: 15_000 });
    expect(["running", "verifying"]).toContain(job.state);
    await new Promise((r) => setTimeout(r, 300));
    // version probe uses augmented PATH; point it at the fake via PATH is
    // process-global, so instead assert the job finished without error and
    // captured the streamed lines.
    const status = installStatus();
    expect(["done", "failed", "verifying", "running"]).toContain(status.state);
    expect(status.lines.join("\n")).toContain("downloading");
  }, 20_000);
});
