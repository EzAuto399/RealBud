import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { HERMES_PIN } from "./hermes-pin.ts";
import {
  attachModel,
  beginModelAttachment,
  commitModelAttachment,
  installStatus,
  listModels,
  MIN_WORKER_INSTALL_FREE_BYTES,
  modelCredentialEnvironment,
  modelStatus,
  preflight,
  PROVIDER_OPTIONS,
  recoverPendingModelAttachment,
  rollbackModelAttachment,
  startInstall,
  workerStoragePreflight,
  workerInstallInProgress,
} from "./hermes-bridge.ts";
import { workerCli, workerInstallDirForRuntime, workerRuntimeDir } from "./config.ts";
import { workerRuntimePaths } from "./worker-runtime.ts";

const dirs: string[] = [];
const enoughStorage = () => ({
  availableBlocks: MIN_WORKER_INSTALL_FREE_BYTES,
  blockSize: 1n,
});
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

async function waitForInstall(timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = installStatus();
    if (["done", "failed"].includes(status.state)) return status;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`install did not settle: ${installStatus().state}`);
}

async function waitForProcessExit(pid: number, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

describe("attachModel", () => {
  it("encrypts the key, preserves unrelated env lines, and writes the model block", () => {
    const { dir, profile } = tempHome();
    writeFileSync(join(profile, "SOUL.md"), "# RealBud\n");
    writeFileSync(join(profile, ".env"), "OTHER_SETTING=keep-me\n");
    const status = attachModel({ providerId: "xai", apiKey: "sk-test-123", model: "grok-4" }, { root: dir });
    expect(status).toMatchObject({ provider: "xai", model: "grok-4", keyPresent: true });
    const env = readFileSync(join(profile, ".env"), "utf8");
    expect(env).toContain("OTHER_SETTING=keep-me");
    expect(env).not.toContain("sk-test-123");
    expect(readFileSync(join(dir, "secrets.json"), "utf8")).not.toContain("sk-test-123");
    expect(modelCredentialEnvironment(dir)).toEqual({ XAI_API_KEY: "sk-test-123" });
    const config = readFileSync(join(profile, "config.yaml"), "utf8");
    expect(config).toMatch(/model:\n  default: grok-4\n  provider: xai/);
  });

  it("replaces the encrypted credential instead of stacking values", () => {
    const { dir, profile } = tempHome();
    writeFileSync(join(profile, "SOUL.md"), "# RealBud\n");
    attachModel({ providerId: "xai", apiKey: "old-key", model: "grok-4" }, { root: dir });
    attachModel({ providerId: "xai", apiKey: "new-key", model: "grok-4" }, { root: dir });
    expect(modelCredentialEnvironment(dir)).toEqual({ XAI_API_KEY: "new-key" });
    expect(readFileSync(join(dir, "secrets.json"), "utf8")).not.toContain("old-key");
    expect(readFileSync(join(dir, "secrets.json"), "utf8")).not.toContain("new-key");
  });

  it("refuses unknown providers, missing model, and missing pack", () => {
    const { dir, profile } = tempHome();
    writeFileSync(join(profile, "SOUL.md"), "# RealBud\n");
    expect(() => attachModel({ providerId: "nope", apiKey: "k", model: "m" }, { root: dir })).toThrow(/unknown provider/);
    expect(() => attachModel({ providerId: "xai", apiKey: "k", model: "" }, { root: dir })).toThrow(/model id/);
    expect(() => attachModel({ providerId: "xai", apiKey: "k", model: "grok-4\nprovider: nope" }, { root: dir })).toThrow(/unsupported characters/);
    expect(() => attachModel({ providerId: "xai", apiKey: "bad\nINJECTED=value", model: "grok-4" }, { root: dir })).toThrow(/api key is not valid/);
    expect(() => attachModel({ providerId: "xai", apiKey: "k", model: "grok-4", baseUrl: "file:///tmp/model" }, { root: dir })).toThrow(/http\(s\)/);
    expect(() => attachModel({ providerId: "xai", apiKey: "k", model: "grok-4", baseUrl: "https://key@example.com/v1" }, { root: dir })).toThrow(/embedded credentials/);
    // empty key with no existing credential for the provider -> refused
    expect(() => attachModel({ providerId: "anthropic", apiKey: "", model: "m" }, { root: dir })).toThrow(/api key is required for Anthropic/);
    // empty key on a provider that already has a credential -> keeps it
    attachModel({ providerId: "xai", apiKey: "first-key", model: "grok-4" }, { root: dir });
    const kept = attachModel({ providerId: "xai", apiKey: "", model: "grok-4.6" }, { root: dir });
    expect(kept.keyPresent).toBe(true);
    expect(modelCredentialEnvironment(dir)).toEqual({ XAI_API_KEY: "first-key" });
    expect(readFileSync(join(profile, "config.yaml"), "utf8")).toMatch(/default: grok-4\.6/);
    const empty = mkdtempSync(join(tmpdir(), "realbud-bridge-empty-"));
    dirs.push(empty);
    expect(() => attachModel({ providerId: "xai", apiKey: "k", model: "m" }, { root: empty })).toThrow(/pack/);
    expect(existsSync(join(empty, "profiles", HERMES_PIN.profile, "config.yaml"))).toBe(false);
  });

  it("modelStatus reads back the block and masks absence", () => {
    const { dir, profile } = tempHome();
    expect(modelStatus(dir)).toMatchObject({ provider: null, model: null, keyPresent: false });
    writeFileSync(join(profile, "SOUL.md"), "# RealBud\n");
    attachModel({ providerId: "anthropic", apiKey: "sk-ant", model: "claude-sonnet-4-5" }, { root: dir });
    expect(modelStatus(dir)).toMatchObject({ provider: "anthropic", model: "claude-sonnet-4-5", keyPresent: true });
  });

  it("offers the pinned worker's curated BYOK adapters and uses canonical env vars", () => {
    expect(PROVIDER_OPTIONS.map((provider) => provider.id)).toEqual(expect.arrayContaining([
      "anthropic",
      "openai-api",
      "gemini",
      "xai",
      "openrouter",
      "deepseek",
      "kimi-coding",
      "zai",
      "minimax",
      "ollama-cloud",
    ]));
    expect(PROVIDER_OPTIONS.find((provider) => provider.id === "ollama-cloud")?.envVar).toBe("OLLAMA_API_KEY");
    for (const provider of PROVIDER_OPTIONS) {
      expect(provider.recommendedModels.length, `${provider.id} recommendations`).toBeGreaterThan(0);
      expect(provider.recommendedModels[0].id).toBe(provider.exampleModel);
      expect(new Set(provider.recommendedModels.map((model) => model.id)).size).toBe(provider.recommendedModels.length);
      expect(provider.recommendedModels.every((model) => model.id.trim() && model.label.trim() && model.note.trim())).toBe(true);
    }
  });

  it("recognises and encrypts a legacy Ollama Cloud key", () => {
    const { dir, profile } = tempHome();
    writeFileSync(join(profile, "SOUL.md"), "# RealBud\n");
    writeFileSync(join(profile, ".env"), "OLLAMA_CLOUD_API_KEY=legacy-private-key\n");
    writeFileSync(join(profile, "config.yaml"), "model:\n  default: qwen3.5:397b\n  provider: ollama-cloud\n  base_url: ''\n");

    expect(modelStatus(dir)).toMatchObject({ provider: "ollama-cloud", keyPresent: true });
    attachModel({ providerId: "ollama-cloud", apiKey: "", model: "qwen3.5:397b" }, { root: dir });

    const env = readFileSync(join(profile, ".env"), "utf8");
    expect(env).not.toContain("legacy-private-key");
    expect(modelCredentialEnvironment(dir)).toEqual({ OLLAMA_API_KEY: "legacy-private-key" });
    expect(readFileSync(join(dir, "secrets.json"), "utf8")).not.toContain("legacy-private-key");
  });

  it("rolls a failed staged candidate back to the exact prior model and credential", () => {
    const { dir, profile } = tempHome();
    writeFileSync(join(profile, "SOUL.md"), "# RealBud\n");
    attachModel({ providerId: "xai", apiKey: "old-private", model: "grok-4" }, { root: dir });

    const staged = beginModelAttachment(
      { providerId: "anthropic", apiKey: "candidate-private", model: "claude-sonnet-4-5" },
      { root: dir },
    );
    expect(modelStatus(dir)).toMatchObject({ provider: "anthropic", model: "claude-sonnet-4-5" });
    expect(readFileSync(join(dir, "model-transaction.json"), "utf8")).not.toContain("candidate-private");
    rollbackModelAttachment(staged.transactionId, { root: dir });

    expect(modelStatus(dir)).toMatchObject({ provider: "xai", model: "grok-4", keyPresent: true });
    expect(modelCredentialEnvironment(dir)).toEqual({ XAI_API_KEY: "old-private" });
    expect(existsSync(join(dir, "model-transaction.json"))).toBe(false);
  });

  it("recovers an interrupted unverified candidate on the next startup", () => {
    const { dir, profile } = tempHome();
    writeFileSync(join(profile, "SOUL.md"), "# RealBud\n");
    attachModel({ providerId: "xai", apiKey: "old-private", model: "grok-4" }, { root: dir });
    beginModelAttachment({ providerId: "xai", apiKey: "candidate-private", model: "grok-4.6" }, { root: dir });

    expect(recoverPendingModelAttachment(dir)).toMatchObject({ action: "restored-previous" });
    expect(modelStatus(dir)).toMatchObject({ provider: "xai", model: "grok-4", keyPresent: true });
    expect(modelCredentialEnvironment(dir)).toEqual({ XAI_API_KEY: "old-private" });
  });

  it("keeps a staged candidate only after an explicit successful commit", () => {
    const { dir, profile } = tempHome();
    writeFileSync(join(profile, "SOUL.md"), "# RealBud\n");
    const staged = beginModelAttachment(
      { providerId: "xai", apiKey: "verified-private", model: "grok-4.6" },
      { root: dir },
    );
    commitModelAttachment(staged.transactionId, { root: dir });

    expect(recoverPendingModelAttachment(dir)).toMatchObject({ action: "none" });
    expect(modelStatus(dir)).toMatchObject({ provider: "xai", model: "grok-4.6", keyPresent: true });
    expect(modelCredentialEnvironment(dir)).toEqual({ XAI_API_KEY: "verified-private" });
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
});

describe("install job", () => {
  it("runs a fake installer, verifies the version, and lands done", async () => {
    const root = mkdtempSync(join(tmpdir(), "realbud-bridge-install-"));
    dirs.push(root);
    const installer = join(root, "fake-installer.sh");
    writeFileSync(
      installer,
      `#!/bin/sh\nset -eu\n` +
        `printf 'downloading…\\nextracting…\\n'\n` +
        `mkdir -p "$HOME/.local/bin" "$HERMES_INSTALL_DIR/.git"\n` +
        `printf '%s\\n' ${JSON.stringify(HERMES_PIN.commit)} > "$HERMES_INSTALL_DIR/.git/HEAD"\n` +
        `printf '#!/bin/sh\\necho "Hermes Agent v0.20.3 (2026.8.16.2)"\\n' > "$HOME/version-bin"\n` +
        `printf '#!/bin/sh\\nexec "%s/version-bin" "$@"\\n' "$HOME" > "$HOME/.local/bin/hermes"\n` +
        `chmod 700 "$HOME/version-bin" "$HOME/.local/bin/hermes"\n`,
    );
    chmodSync(installer, 0o700);
    const job = startInstall(JSON.stringify(installer), { root, timeoutMs: 15_000, storageProbe: enoughStorage });
    expect(["running", "verifying"]).toContain(job.state);
    expect(workerInstallInProgress()).toBe(true);
    const status = await waitForInstall();
    expect(status.state).toBe("done");
    expect(workerInstallInProgress()).toBe(false);
    expect(status.lines.join("\n")).toContain("downloading");
    expect(existsSync(workerCli(root))).toBe(true);
    expect(existsSync(join(workerRuntimeDir(root), ".realbud-install-id"))).toBe(true);
  }, 20_000);

  it("installs and verifies only inside RealBud's private runtime", async () => {
    const root = mkdtempSync(join(tmpdir(), "realbud-private-worker-"));
    const personal = mkdtempSync(join(tmpdir(), "personal-hermes-sentinel-"));
    dirs.push(root, personal);

    const personalLauncher = join(personal, ".local", "bin", "hermes");
    const personalCredential = join(personal, ".hermes", "credentials.txt");
    const personalPackageManager = join(personal, "bin", "brew");
    const personalSsh = join(personal, "bin", "ssh");
    const packageManagerTouched = join(personal, "package-manager-was-used");
    mkdirSync(join(personal, ".local", "bin"), { recursive: true });
    mkdirSync(join(personal, ".hermes"), { recursive: true });
    mkdirSync(join(personal, "bin"), { recursive: true });
    writeFileSync(personalLauncher, "personal-launcher-sentinel\n");
    writeFileSync(personalCredential, "personal-credential-sentinel\n");
    writeFileSync(personalPackageManager, `#!/bin/sh\nprintf touched > ${JSON.stringify(packageManagerTouched)}\n`);
    chmodSync(personalPackageManager, 0o700);
    writeFileSync(personalSsh, `#!/bin/sh\nprintf touched > ${JSON.stringify(packageManagerTouched)}\n`);
    chmodSync(personalSsh, 0o700);

    const observed = join(root, "installer-env.txt");
    const installer = join(root, "fake-installer.sh");
    writeFileSync(
      installer,
        `#!/bin/sh\nset -eu\n` +
        `brew install ripgrep >/dev/null 2>&1 || true\n` +
        `ssh example.invalid >/dev/null 2>&1 || true\n` +
        `if curl -fsSL https://nodejs.org/dist/latest-v26.x/ >/dev/null 2>&1; then exit 91; fi\n` +
        `mkdir -p "$HOME/.local/bin" "$HERMES_INSTALL_DIR/.git"\n` +
        `printf '%s\n' ${JSON.stringify(HERMES_PIN.commit)} > "$HERMES_INSTALL_DIR/.git/HEAD"\n` +
        `printf '#!/bin/sh\\necho "Hermes Agent v0.20.3 (2026.8.16.2)"\\n' > "$HOME/.local/bin/hermes"\n` +
        `chmod 700 "$HOME/.local/bin/hermes"\n` +
        `printf '%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n' "$HOME" "$HERMES_HOME" "$HERMES_INSTALL_DIR" "\${SSH_AUTH_SOCK-unset}" "$GIT_CONFIG_GLOBAL" "$GIT_SSH_COMMAND" "$(node --version)" "$UV_PYTHON_INSTALL_DIR" > ${JSON.stringify(observed)}\n`,
    );
    chmodSync(installer, 0o700);

    const previous = {
      HOME: process.env.HOME,
      HERMES_HOME: process.env.HERMES_HOME,
      HERMES_INSTALL_DIR: process.env.HERMES_INSTALL_DIR,
      PATH: process.env.PATH,
      SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    };
    process.env.HOME = personal;
    process.env.HERMES_HOME = join(personal, ".hermes");
    process.env.HERMES_INSTALL_DIR = join(personal, "shared-install");
    process.env.PATH = `${join(personal, "bin")}:/usr/bin:/bin`;
    process.env.SSH_AUTH_SOCK = join(personal, "personal-ssh-agent.sock");
    process.env.GITHUB_TOKEN = "personal-github-token";
    let status: Awaited<ReturnType<typeof waitForInstall>>;
    try {
      startInstall(JSON.stringify(installer), { root, timeoutMs: 5_000, storageProbe: enoughStorage });
      status = await waitForInstall();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    expect(status.state).toBe("done");
    expect(existsSync(workerCli(root))).toBe(true);
    const stagedRuntime = workerRuntimePaths(root).slotA;
    expect(readFileSync(observed, "utf8").trim().split("\n")).toEqual([
      stagedRuntime,
      stagedRuntime,
      workerInstallDirForRuntime(stagedRuntime),
      "unset",
      "/dev/null",
      "/usr/bin/false",
      "v0.0.0",
      join(stagedRuntime, "python"),
    ]);
    expect(existsSync(packageManagerTouched)).toBe(false);
    expect(readFileSync(personalLauncher, "utf8")).toBe("personal-launcher-sentinel\n");
    expect(readFileSync(personalCredential, "utf8")).toBe("personal-credential-sentinel\n");
  });

  it("leaves the active runtime byte-for-byte in place when a staged install fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "realbud-failed-worker-"));
    dirs.push(root);
    const activeMarker = join(workerRuntimeDir(root), "active-marker");
    mkdirSync(workerRuntimeDir(root), { recursive: true });
    writeFileSync(activeMarker, "known-active-worker\n");
    const installer = join(root, "failing-installer.sh");
    writeFileSync(
      installer,
      `#!/bin/sh\nset -eu\nmkdir -p "$HOME"\nprintf partial > "$HOME/partial"\nexit 9\n`,
    );
    chmodSync(installer, 0o700);

    startInstall(JSON.stringify(installer), { root, timeoutMs: 5_000, storageProbe: enoughStorage });
    const status = await waitForInstall();

    expect(status.state).toBe("failed");
    expect(status.error).toMatch(/active worker was unchanged/i);
    expect(readFileSync(activeMarker, "utf8")).toBe("known-active-worker\n");
    expect(existsSync(workerRuntimePaths(root).slotA)).toBe(false);
  });

  it("settles and discards staging when process creation throws synchronously", () => {
    const root = mkdtempSync(join(tmpdir(), "realbud-sync-worker-failure-"));
    dirs.push(root);

    const status = startInstall("bad\0command", { root, timeoutMs: 5_000, storageProbe: enoughStorage });

    expect(status).toMatchObject({
      state: "failed",
      error: "The private worker installer could not start. The active worker was unchanged.",
    });
    expect(workerInstallInProgress()).toBe(false);
    expect(existsSync(workerRuntimePaths(root).slotA)).toBe(false);
  });

  it("reaps the installer process tree when the bounded install times out", async () => {
    const root = mkdtempSync(join(tmpdir(), "realbud-timeout-worker-"));
    dirs.push(root);
    const grandchildPid = join(root, "grandchild.pid");
    const grandchild = join(root, "grandchild.sh");
    const installer = join(root, "slow-installer.sh");
    writeFileSync(grandchild, "#!/bin/sh\nsleep 30\n");
    chmodSync(grandchild, 0o700);
    writeFileSync(
      installer,
      `#!/bin/sh\nset -eu\n` +
        `${JSON.stringify(grandchild)} &\n` +
        `grandchild_pid=$!\n` +
        `printf "%s" "$grandchild_pid" > ${JSON.stringify(grandchildPid)}\n` +
        `wait "$grandchild_pid"\n`,
    );
    chmodSync(installer, 0o700);

    startInstall(JSON.stringify(installer), { root, timeoutMs: 2_000, storageProbe: enoughStorage });
    const status = await waitForInstall();
    expect(status).toMatchObject({
      state: "failed",
      error: "The private worker install timed out. The active worker was unchanged.",
    });

    expect(existsSync(grandchildPid), JSON.stringify(status)).toBe(true);
    const pid = Number(readFileSync(grandchildPid, "utf8"));
    expect(await waitForProcessExit(pid)).toBe(true);
  });

  it("preflight reports the dependency list", async () => {
    const result = await preflight(undefined, () => ({
      availableBlocks: MIN_WORKER_INSTALL_FREE_BYTES,
      blockSize: 1n,
    }));
    expect(result.deps.map((d) => d.name)).toEqual(["curl", "git", "python3", "storage"]);
    expect(result.deps.every((d) => typeof d.ok === "boolean")).toBe(true);
    expect(result.deps.find((d) => d.name === "storage")).toMatchObject({ ok: true, detail: "3.0 GB free" });
  });

  it("reports low or unverifiable worker-install storage", () => {
    const belowMinimum = workerStoragePreflight("/unused", () => ({
      availableBlocks: MIN_WORKER_INSTALL_FREE_BYTES - 1n,
      blockSize: 1n,
    }));
    expect(belowMinimum).toMatchObject({ name: "storage", ok: false });
    expect(belowMinimum.detail).toMatch(/Bud needs 3\.0 GB to prepare safely/);

    const unknown = workerStoragePreflight("/unused", () => {
      throw new Error("probe unavailable");
    });
    expect(unknown).toEqual({ name: "storage", ok: false, detail: "free space could not be verified" });
  });

  it("holds a worker install before creating a staging runtime when storage is low", () => {
    const root = mkdtempSync(join(tmpdir(), "realbud-low-storage-worker-"));
    dirs.push(root);

    const status = startInstall("exit 0", {
      root,
      storageProbe: () => ({
        availableBlocks: MIN_WORKER_INSTALL_FREE_BYTES - 1n,
        blockSize: 1n,
      }),
    });

    expect(status).toMatchObject({ state: "failed" });
    expect(status.error).toMatch(/nothing was changed/i);
    expect(workerInstallInProgress()).toBe(false);
    expect(existsSync(workerRuntimePaths(root).slotsDir)).toBe(false);
  });
});
