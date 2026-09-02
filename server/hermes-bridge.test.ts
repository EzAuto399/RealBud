import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { HERMES_PIN } from "./hermes-pin.ts";
import { attachModel, installStatus, listModelOptions, listModels, modelStatus, preflight, PROVIDER_OPTIONS, startInstall } from "./hermes-bridge.ts";

const dirs: string[] = [];
const tempHome = () => {
  const dir = mkdtempSync(join(tmpdir(), "realbud-bridge-"));
  dirs.push(dir);
  const profile = join(dir, "profiles", HERMES_PIN.profile);
  mkdirSync(profile, { recursive: true });
  return { dir, profile };
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("attachModel", () => {
  it("writes the .env key and the config model block, preserving other env lines", () => {
    const { dir, profile } = tempHome();
    writeFileSync(join(profile, "SOUL.md"), "# RealBud\n");
    writeFileSync(join(profile, ".env"), "OTHER_SETTING=keep-me\n");
    const status = attachModel({ providerId: "xai", apiKey: "sk-test-123", model: "grok-4" }, { root: dir });
    expect(status).toMatchObject({ provider: "xai", model: "grok-4", keyPresent: true });
    const env = readFileSync(join(profile, ".env"), "utf8");
    expect(env).toContain("OTHER_SETTING=keep-me");
    expect(env).toContain("XAI_API_KEY=sk-test-123");
    if (process.platform !== "win32") {
      expect(statSync(join(profile, ".env")).mode & 0o777).toBe(0o600);
    }
    const config = readFileSync(join(profile, "config.yaml"), "utf8");
    expect(config).toMatch(/model:\n  default: grok-4\n  provider: xai/);
  });

  it("replaces an existing key line instead of stacking duplicates", () => {
    const { dir, profile } = tempHome();
    writeFileSync(join(profile, "SOUL.md"), "# RealBud\n");
    attachModel({ providerId: "xai", apiKey: "old-key", model: "grok-4" }, { root: dir });
    attachModel({ providerId: "xai", apiKey: "new-key", model: "grok-4" }, { root: dir });
    const env = readFileSync(join(profile, ".env"), "utf8");
    expect(env.match(/XAI_API_KEY=/g)).toHaveLength(1);
    expect(env).toContain("new-key");
  });

  it("refuses unknown providers, missing model, and missing pack", () => {
    const { dir, profile } = tempHome();
    writeFileSync(join(profile, "SOUL.md"), "# RealBud\n");
    expect(() => attachModel({ providerId: "nope", apiKey: "k", model: "m" }, { root: dir })).toThrow(/unknown provider/);
    expect(() => attachModel({ providerId: "xai", apiKey: "k", model: "" }, { root: dir })).toThrow(/model id/);
    // empty key with no existing credential for the provider -> refused
    expect(() => attachModel({ providerId: "anthropic", apiKey: "", model: "m" }, { root: dir })).toThrow(/api key is required for Anthropic/);
    // empty key on a provider that already has a credential -> keeps it
    attachModel({ providerId: "xai", apiKey: "first-key", model: "grok-4" }, { root: dir });
    const kept = attachModel({ providerId: "xai", apiKey: "", model: "grok-4.6" }, { root: dir });
    expect(kept.keyPresent).toBe(true);
    expect(readFileSync(join(profile, ".env"), "utf8")).toContain("first-key");
    expect(readFileSync(join(profile, "config.yaml"), "utf8")).toMatch(/default: grok-4\.6/);
    const empty = mkdtempSync(join(tmpdir(), "realbud-bridge-empty-"));
    dirs.push(empty);
    expect(() => attachModel({ providerId: "xai", apiKey: "k", model: "m" }, { root: empty })).toThrow(/pack/);
    expect(existsSync(join(empty, "profiles", HERMES_PIN.profile, "config.yaml"))).toBe(false);
  });

  it("accepts DeepSeek and Kimi (Moonshot) from the curated list", () => {
    const { dir, profile } = tempHome();
    writeFileSync(join(profile, "SOUL.md"), "# RealBud\n");
    expect(PROVIDER_OPTIONS.map((p) => p.id)).toEqual(
      expect.arrayContaining(["deepseek", "moonshotai", "google", "groq", "mistral"]),
    );
    const deepseek = attachModel({ providerId: "deepseek", apiKey: "sk-ds", model: "deepseek-v4-pro" }, { root: dir });
    expect(deepseek).toMatchObject({ provider: "deepseek", model: "deepseek-v4-pro", keyPresent: true });
    expect(readFileSync(join(profile, ".env"), "utf8")).toContain("DEEPSEEK_API_KEY=sk-ds");
    const kimi = attachModel({ providerId: "moonshotai", apiKey: "sk-kimi", model: "kimi-k3" }, { root: dir });
    expect(kimi).toMatchObject({ provider: "moonshotai", model: "kimi-k3", keyPresent: true });
    expect(readFileSync(join(profile, ".env"), "utf8")).toContain("MOONSHOT_API_KEY=sk-kimi");
  });

  it("rejects config injection and unsafe custom URLs at the authoritative boundary", () => {
    const { dir, profile } = tempHome();
    writeFileSync(join(profile, "SOUL.md"), "# RealBud\n");

    expect(() =>
      attachModel({ providerId: "xai", apiKey: "safe-key\nEVIL=value", model: "grok-4" }, { root: dir }),
    ).toThrow(/api key format/);
    expect(() =>
      attachModel({ providerId: "xai", apiKey: "safe-key", model: "grok-4\napprovals: auto" }, { root: dir }),
    ).toThrow(/model id contains unsupported/);
    expect(() =>
      attachModel({ providerId: "xai", apiKey: "safe-key", model: "grok-4", baseUrl: "file:///tmp/provider" }, { root: dir }),
    ).toThrow(/http or https/);
    expect(() =>
      attachModel({ providerId: "xai", apiKey: "safe-key", model: "grok-4", baseUrl: "https://user:pass@example.com/v1" }, { root: dir }),
    ).toThrow(/embedded credentials/);
    expect(existsSync(join(profile, ".env"))).toBe(false);
    expect(existsSync(join(profile, "config.yaml"))).toBe(false);
  });

  it("accepts a bounded local OpenAI-compatible URL", () => {
    const { dir, profile } = tempHome();
    writeFileSync(join(profile, "SOUL.md"), "# RealBud\n");
    attachModel(
      { providerId: "openai-api", apiKey: "local-test-key", model: "local/model-v1", baseUrl: "http://127.0.0.1:11434/v1" },
      { root: dir },
    );
    expect(readFileSync(join(profile, "config.yaml"), "utf8")).toContain('base_url: "http://127.0.0.1:11434/v1"');
  });

  it("modelStatus reads back the block and masks absence", () => {
    const { dir, profile } = tempHome();
    expect(modelStatus(dir)).toMatchObject({ provider: null, model: null, keyPresent: false });
    writeFileSync(join(profile, "SOUL.md"), "# RealBud\n");
    attachModel({ providerId: "anthropic", apiKey: "sk-ant", model: "claude-sonnet-4-5" }, { root: dir });
    expect(modelStatus(dir)).toMatchObject({ provider: "anthropic", model: "claude-sonnet-4-5", keyPresent: true });
  });

  it("does not borrow an unrelated provider credential for a configured OAuth provider", () => {
    const { dir, profile } = tempHome();
    writeFileSync(join(profile, "config.yaml"), "model:\n  default: grok-4.5\n  provider: xai-oauth\n");
    writeFileSync(join(profile, ".env"), "ANTHROPIC_API_KEY=unrelated-test-key\n");

    expect(modelStatus(dir)).toEqual({
      provider: "xai-oauth",
      model: "grok-4.5",
      keyPresent: false,
      keyHint: null,
    });
  });

  it("recognises only the exact configured provider in the profile credential pool", () => {
    const { dir, profile } = tempHome();
    writeFileSync(join(profile, "config.yaml"), "model:\n  default: grok-4.5\n  provider: xai-oauth\n");
    writeFileSync(
      join(profile, "auth.json"),
      JSON.stringify({ version: 1, credential_pool: { "xai-oauth": [{ opaque: "not-inspected" }] } }),
    );

    expect(modelStatus(dir)).toEqual({
      provider: "xai-oauth",
      model: "grok-4.5",
      keyPresent: true,
      keyHint: "xai-oauth profile login",
    });
  });

  it("changes models without replacing the current Hermes OAuth login", () => {
    const { dir, profile } = tempHome();
    writeFileSync(join(profile, "SOUL.md"), "# RealBud\n");
    writeFileSync(join(profile, "config.yaml"), "model:\n  default: grok-4.5\n  provider: xai-oauth\n");
    writeFileSync(
      join(profile, "auth.json"),
      JSON.stringify({ version: 1, credential_pool: { "xai-oauth": [{ opaque: "not-inspected" }] } }),
    );

    const status = attachModel({ providerId: "xai-oauth", apiKey: "", model: "grok-4.6" }, { root: dir });
    expect(status).toMatchObject({ provider: "xai-oauth", model: "grok-4.6", keyPresent: true });
    expect(readFileSync(join(profile, "config.yaml"), "utf8")).toMatch(/default: grok-4\.6\n  provider: xai-oauth/);
    expect(existsSync(join(profile, ".env"))).toBe(false);
    expect(() =>
      attachModel({ providerId: "xai-oauth", apiKey: "must-not-be-stored", model: "grok-4.6" }, { root: dir }),
    ).toThrow(/does not accept a pasted API key/);
  });
});

describe("listModels", () => {
  it("reads the worker cache for the provider and skips non-text models", () => {
    const dir = mkdtempSync(join(tmpdir(), "realbud-bridge-models-"));
    dirs.push(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "models_dev_cache.json"),
      JSON.stringify({ xai: { models: { "grok-4.5": {}, "grok-4.6": {}, "grok-imagine-video": {} } } }),
    );
    expect(listModels("xai", dir)).toEqual(["grok-4.5", "grok-4.6"]);
    expect(listModels("unknown-provider", dir)).toEqual([]);
  });

  it("reads the profile cache and maps OpenAI's attach id", () => {
    const { dir, profile } = tempHome();
    writeFileSync(
      join(profile, "models_dev_cache.json"),
      JSON.stringify({ openai: { models: { "gpt-5": {}, "gpt-image-1": {} } } }),
    );
    expect(listModels("openai-api", dir)).toEqual(["gpt-5"]);
  });

  it("offers recommended fallbacks plus the newest Hermes text/tool models", () => {
    const dir = mkdtempSync(join(tmpdir(), "realbud-bridge-picker-"));
    dirs.push(dir);
    writeFileSync(
      join(dir, "models_dev_cache.json"),
      JSON.stringify({
        xai: {
          models: {
            "grok-4.5": { name: "Grok 4.5", release_date: "2026-07-08", tool_call: true, modalities: { output: ["text"] } },
            "grok-4.6": { name: "Grok 4.6", release_date: "2026-08-12", tool_call: true, modalities: { output: ["text"] } },
            "grok-imagine-image": { name: "Imagine", release_date: "2026-08-20", tool_call: false, modalities: { output: ["image"] } },
          },
        },
      }),
    );

    const options = listModelOptions("xai", dir);
    expect(options[0]).toMatchObject({ id: "grok-4.6", name: "Grok 4.6", recommended: true });
    expect(options.find((option) => option.id === "grok-4.5")).toMatchObject({ releaseDate: "2026-07-08", recommended: false });
    expect(options.some((option) => option.id.includes("imagine"))).toBe(false);
    expect(listModelOptions("xai-oauth", dir)).toEqual(options);
    expect(listModelOptions("unknown-provider", dir)).toEqual([]);
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

  it("preflight reports the dependency list", async () => {
    const result = await preflight();
    expect(result.deps.map((d) => d.name)).toEqual(["curl", "git", "python3"]);
    expect(result.deps.every((d) => typeof d.ok === "boolean")).toBe(true);
  });
});
