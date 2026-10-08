import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

import { HERMES_PIN } from "./hermes-pin.ts";
import { modelStatus, reconcileManagedModelProfile, setManagedModelChoice } from "./hermes-bridge.ts";
import { MANAGED_MODEL_KEY_ENV, MANAGED_MODEL_PROVIDER, managedModelProfile } from "./hermes-pack.ts";
import { canonicalModelChoice, setWorkerModelGrant } from "./worker-model-access.ts";
import { storedModelChoice, workerControlDir } from "./worker-control.ts";
import { writePrivateJson } from "./private-json.ts";

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
  for (const dir of dirs.splice(0)) { rmSync(dir, { recursive: true, force: true }); rmSync(workerControlDir(dir), { recursive: true, force: true }); }
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

  it("reconciles an upgraded openai-api/auto profile onto the default (Sonnet · Medium) and keeps a valid saved choice", async () => {
    const { dir, profile } = tempHome();
    writeFileSync(join(profile, "SOUL.md"), "# RealBud\n");
    writeFileSync(join(profile, "config.yaml"), `model:\n  default: auto\n  provider: openai-api\n  base_url: "${GATEWAY}"\n  api_mode: chat_completions\n`);
    expect(await reconcileManagedModelProfile(dir)).toBe(false); // no grant: nothing written
    active();
    expect(await reconcileManagedModelProfile(dir)).toBe(true);
    expect(managedModelProfile(dir)).toMatchObject({ provider: MANAGED_MODEL_PROVIDER, model: "claude-sonnet-5.5", choice: "sonnet-medium", baseUrl: GATEWAY });
    expect(await reconcileManagedModelProfile(dir)).toBe(false);
    await setManagedModelChoice({ choice: "flash-high" }, { root: dir });
    writeFileSync(join(profile, ".env"), `${MANAGED_MODEL_KEY_ENV}=fictional-shadow\n`);
    expect(await reconcileManagedModelProfile(dir)).toBe(true);
    expect(managedModelProfile(dir)).toMatchObject({ choice: "flash-high", envKeyPresent: false, visionReady: true });
    // A Flash profile from before it read images through Sonnet gets the route.
    const doc = parseDocument(readFileSync(join(profile, "config.yaml"), "utf8"), { version: "1.1" });
    doc.deleteIn(["auxiliary", "vision"]);
    writeFileSync(join(profile, "config.yaml"), doc.toString());
    expect(managedModelProfile(dir)).toMatchObject({ choice: "flash-high", visionReady: false });
    expect(await reconcileManagedModelProfile(dir)).toBe(true);
    expect(managedModelProfile(dir)).toMatchObject({ choice: "flash-high", visionReady: true });
    expect(await reconcileManagedModelProfile(dir)).toBe(false);
  });

  it("keeps the office's choice when the worker is deleted and restores it into a recreated profile", async () => {
    const { dir, profile } = tempHome();
    writeFileSync(join(profile, "SOUL.md"), "# RealBud\n");
    active();
    await setManagedModelChoice({ choice: "sonnet-xhigh" }, { root: dir });
    // Everything in the worker folder is deleted: RealBud's own record still answers.
    for (const entry of readdirSync(dir)) rmSync(join(dir, entry), { recursive: true, force: true });
    expect(readdirSync(dir)).toEqual([]);
    expect(modelStatus(dir)).toMatchObject({ provider: MANAGED_MODEL_PROVIDER, model: "claude-sonnet-5.5", choice: "sonnet-xhigh", managed: true });
    // A recreated profile (fresh pack, no model) gets the same choice back.
    privateFixtureDirectory(profile);
    writeFileSync(join(profile, "SOUL.md"), "# RealBud\n");
    expect(await reconcileManagedModelProfile(dir)).toBe(true);
    expect(managedModelProfile(dir)).toMatchObject({ choice: "sonnet-xhigh", baseUrl: GATEWAY });
  });

  it("commits a new choice before projecting it, so a failed profile write still keeps it", async () => {
    const { dir, profile } = tempHome();
    writeFileSync(join(profile, "SOUL.md"), "# RealBud\n");
    active();
    await setManagedModelChoice({ choice: "flash-high" }, { root: dir });
    writeFileSync(join(profile, "config.yaml"), "agent: not-a-map\n");
    await expect(setManagedModelChoice({ choice: "sonnet-xhigh" }, { root: dir })).rejects.toThrow();
    expect(storedModelChoice(dir, HERMES_PIN.profile)).toBe("sonnet-xhigh");
    expect(modelStatus(dir).choice).toBe("sonnet-xhigh");
  });

  it("seeds the saved choice from a valid profile, then the provisioning receipt, then the default", async () => {
    const fromProfile = tempHome();
    writeFileSync(join(fromProfile.profile, "config.yaml"), "model:\n  default: claude-sonnet-5.5\n  provider: realbud\nagent:\n  reasoning_effort: xhigh\n");
    expect(await canonicalModelChoice({ root: fromProfile.dir, dataDir: fromProfile.dir })).toBe("sonnet-xhigh");
    // Seeded once: a later profile edit does not change the office's choice.
    writeFileSync(join(fromProfile.profile, "config.yaml"), "model:\n  default: auto\n");
    expect(await canonicalModelChoice({ root: fromProfile.dir, dataDir: fromProfile.dir })).toBe("sonnet-xhigh");

    const fromReceipt = tempHome();
    await writePrivateJson(join(fromReceipt.dir, "service-provisioning.json"), {
      version: 1, state: "active", installationId: "fictional-installation", companyId: "fictional-company", hostInstallationId: "fictional-host",
      provider: "modelvia", projectId: "fictional-project", keyId: "fictional-key-id", baseUrl: GATEWAY, spendCapLabel: "Fictional cap",
      apps: ["gmail"], provisionedAt: "2026-10-08T00:00:00.000Z",
      modelProfile: { provider: MANAGED_MODEL_PROVIDER, apiMode: "chat_completions", baseUrl: GATEWAY, model: "deepseek-v4.1-flash", envKeyRemoved: false, appliedAt: "2026-10-08T00:00:00.000Z", choice: "flash-high" },
    });
    expect(await canonicalModelChoice({ root: fromReceipt.dir, dataDir: fromReceipt.dir })).toBe("flash-high");

    const fresh = tempHome();
    expect(await canonicalModelChoice({ root: fresh.dir, dataDir: fresh.dir })).toBe("sonnet-medium");
  });
});
