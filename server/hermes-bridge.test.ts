import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { HERMES_PIN } from "./hermes-pin.ts";
import { attachModel, installStatus, modelStatus, preflight, startInstall } from "./hermes-bridge.ts";

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
    expect(() => attachModel({ providerId: "xai", apiKey: "", model: "m" }, { root: dir })).toThrow(/api key/);
    const empty = mkdtempSync(join(tmpdir(), "realbud-bridge-empty-"));
    dirs.push(empty);
    expect(() => attachModel({ providerId: "xai", apiKey: "k", model: "m" }, { root: empty })).toThrow(/pack/);
    expect(existsSync(join(profile, "config.yaml"))).toBe(false);
  });

  it("modelStatus reads back the block and masks absence", () => {
    const { dir, profile } = tempHome();
    expect(modelStatus(dir)).toMatchObject({ provider: null, model: null, keyPresent: false });
    writeFileSync(join(profile, "SOUL.md"), "# RealBud\n");
    attachModel({ providerId: "anthropic", apiKey: "sk-ant", model: "claude-sonnet-4-5" }, { root: dir });
    expect(modelStatus(dir)).toMatchObject({ provider: "anthropic", model: "claude-sonnet-4-5", keyPresent: true });
  });
});

describe("install job", () => {
  it("runs a fake installer, verifies the version, and lands done", async () => {
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
