import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyPropertyPack, packInstalled, propertyProfileDir, withYamlBlock } from "./hermes-pack.ts";
import { stageSelectedFileWorkerHome } from "./selected-file-profile.ts";

describe("selected-file isolated worker profile", () => {
  let root: string;
  let workerHome: string;
  let workspace: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "realbud-selected-profile-"));
    workerHome = join(root, "worker");
    workspace = join(root, "workspace");
    mkdirSync(workspace);
    applyPropertyPack(workerHome);
    const configPath = join(propertyProfileDir(workerHome), "config.yaml");
    writeFileSync(configPath, withYamlBlock(
      readFileSync(configPath, "utf8"),
      "model",
      "model:\n  default: test-model\n  provider: deepseek\n  base_url: ''\n",
    ));
    mkdirSync(join(workerHome, "sessions"), { recursive: true });
    writeFileSync(join(workerHome, "sessions", "private.json"), "private session");
    writeFileSync(join(workerHome, "memory.md"), "private memory");
    writeFileSync(join(workerHome, ".env"), "DEEPSEEK_API_KEY=do-not-copy");
    writeFileSync(join(workerHome, "auth.json"), "do-not-copy");
    writeFileSync(join(workerHome, "worker-secrets.enc"), "do-not-copy");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("copies only the code-owned pack and non-secret model selection", () => {
    const isolated = stageSelectedFileWorkerHome(workspace, { workerHome });
    expect(isolated.startsWith(workspace)).toBe(true);
    expect(packInstalled(isolated)).toBe(true);
    const config = readFileSync(join(propertyProfileDir(isolated), "config.yaml"), "utf8");
    expect(config).toContain("default: test-model");
    expect(config).toContain("provider: deepseek");
    expect(config).toContain("cron_mode: deny");
    expect(config).toContain("toolsets: []");
    expect(existsSync(join(isolated, "sessions"))).toBe(false);
    expect(existsSync(join(isolated, "memory.md"))).toBe(false);
    expect(existsSync(join(isolated, ".env"))).toBe(false);
    expect(existsSync(join(isolated, "auth.json"))).toBe(false);
    expect(existsSync(join(isolated, "worker-secrets.enc"))).toBe(false);
  });

  it("reconstructs the model block without copying unknown or secret-like fields", () => {
    const configPath = join(propertyProfileDir(workerHome), "config.yaml");
    writeFileSync(configPath, withYamlBlock(
      readFileSync(configPath, "utf8"),
      "model",
      "model:\n  default: test-model\n  provider: deepseek\n  base_url: ''\n  api_key: must-not-cross\n",
    ));

    const isolated = stageSelectedFileWorkerHome(workspace, { workerHome });
    const copied = readFileSync(join(propertyProfileDir(isolated), "config.yaml"), "utf8");
    expect(copied).toContain("default: test-model");
    expect(copied).not.toContain("api_key");
    expect(copied).not.toContain("must-not-cross");
  });

  it("requires a configured model and never reuses an existing task profile", () => {
    const noModel = join(root, "no-model");
    applyPropertyPack(noModel);
    expect(() => stageSelectedFileWorkerHome(workspace, { workerHome: noModel })).toThrow(/model profile is invalid/i);

    const otherWorkspace = join(root, "other-workspace");
    mkdirSync(otherWorkspace);
    stageSelectedFileWorkerHome(otherWorkspace, { workerHome });
    expect(() => stageSelectedFileWorkerHome(otherWorkspace, { workerHome })).toThrow(/already exists/i);
  });
});
