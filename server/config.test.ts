import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyWorkerRuntimeEnv,
  assertSourceDataDirKeyBoundary,
  DATA_DIR,
  instanceConfigs,
  loadConfig,
  saveConfig,
  workerCli,
  workerRuntimeDir,
  WORKER_CLI,
  WORKER_HOME,
  WORKER_RUNTIME_DIR,
} from "./config.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "realbud-config-"));
  dirs.push(dir);
  return dir;
}

describe("instanceConfigs", () => {
  it("refuses a direct source server before it can replace OS-protected desktop keys", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "secure-keys.json"), JSON.stringify({ version: 1, keys: { desk: "protected" } }));

    expect(() => assertSourceDataDirKeyBoundary(dir, {})).toThrow(/OS-protected keys/i);
    expect(existsSync(join(dir, "desk.key"))).toBe(false);
    expect(existsSync(join(dir, ".secrets.key"))).toBe(false);
  });

  it("keeps isolated source runs and packaged key injection available", () => {
    const isolated = tempDir();
    expect(() => assertSourceDataDirKeyBoundary(isolated, {})).not.toThrow();

    const packaged = tempDir();
    writeFileSync(join(packaged, "secure-keys.json"), JSON.stringify({ version: 1, keys: {} }));
    expect(() => assertSourceDataDirKeyBoundary(packaged, { REALBUD_PRODUCTION: "1" })).not.toThrow();
  });

  it("defaults the fleet to the pinned Hermes worker only", () => {
    const map = instanceConfigs({});
    expect(Object.keys(map)).toEqual(["hermes"]);
    expect(map.hermes?.driver).toBe("hermesAgent");
    expect(WORKER_HOME).toBe(process.env.REALBUD_WORKER_HOME ?? join(DATA_DIR, "worker"));
    expect(map.hermes?.environment?.HERMES_HOME).toBe(WORKER_HOME);
    expect(map.hermes?.environment?.HOME).toBe(WORKER_RUNTIME_DIR);
    expect(map.hermes?.config).toMatchObject({ cli: WORKER_CLI, fullAuto: false });
  });

  it("ignores persisted attempts to reuse PATH Hermes or bypass manual approvals", () => {
    const map = instanceConfigs({
      instances: {
        hermes: {
          driver: "hermesAgent",
          environment: { HOME: "/personal/home", HERMES_HOME: "/personal/home/.hermes" },
          config: { cli: "hermes", fullAuto: true },
        },
      },
    });
    expect(map.hermes?.environment).toMatchObject({ HOME: WORKER_RUNTIME_DIR, HERMES_HOME: WORKER_HOME });
    expect(map.hermes?.config).toMatchObject({ cli: WORKER_CLI, fullAuto: false });
  });

  it("canonicalises a persisted legacy fleet to the one private Bud worker", () => {
    const map = instanceConfigs({
      instances: { ghost: { driver: "not-a-real-driver", environment: { HERMES_HOME: "/personal/home" } } },
    });
    expect(Object.keys(map)).toEqual(["hermes"]);
    expect(map.hermes).toMatchObject({
      driver: "hermesAgent",
      environment: { HOME: WORKER_RUNTIME_DIR, HERMES_HOME: WORKER_HOME },
      config: { cli: WORKER_CLI, fullAuto: false },
    });
  });

  it("does not inject legacy generic-provider credentials into Bud", () => {
    const map = instanceConfigs({
      xai: { key: "legacy-xai" },
      box: { token: "legacy-box" },
    });
    expect(map.hermes?.environment?.XAI_API_KEY).toBeUndefined();
    expect(map.hermes?.environment?.BOX_TOKEN).toBeUndefined();
  });

  it("isolates every worker process from personal paths and ambient model keys", () => {
    const root = "/private/realbud-worker";
    const env = applyWorkerRuntimeEnv({
      PATH: "/personal/bin:/usr/bin",
      HOME: "/personal/home",
      HERMES_HOME: "/personal/home/.hermes",
      XDG_CONFIG_HOME: "/personal/config",
      DEEPSEEK_API_KEY: "personal-shell-key",
      COMPOSIO_KEY: "personal-integration-key",
      GITHUB_TOKEN: "personal-github-token",
      CSC_KEY_PASSWORD: "release-certificate-password",
      SESSION_COOKIE: "personal-browser-cookie",
      REALBUD_DESK_KEY: "desk-wrapping-key",
      REALBUD_SECRET_KEY: "secret-wrapping-key",
    }, root);
    expect(env).toMatchObject({
      HOME: workerRuntimeDir(root),
      HERMES_HOME: root,
      XDG_CONFIG_HOME: join(workerRuntimeDir(root), ".config"),
      UV_PYTHON_INSTALL_DIR: join(workerRuntimeDir(root), "python"),
      UV_PYTHON_PREFERENCE: "only-managed",
    });
    expect(env.PATH?.startsWith(join(workerRuntimeDir(root), ".local", "bin"))).toBe(true);
    expect(env.PATH).toContain("/personal/bin:/usr/bin");
    expect(env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(env.COMPOSIO_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.CSC_KEY_PASSWORD).toBeUndefined();
    expect(env.SESSION_COOKIE).toBeUndefined();
    expect(env.REALBUD_DESK_KEY).toBeUndefined();
    expect(env.REALBUD_SECRET_KEY).toBeUndefined();
    expect(workerCli(root).startsWith(workerRuntimeDir(root))).toBe(true);
  });

  it("migrates plaintext config credentials into encrypted storage", () => {
    const dir = tempDir();
    const key = Buffer.alloc(32, 12);
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ composio: { key: "legacy-composio", url: "https://example.test" }, profile: { name: "PM" } }),
    );
    const cfg = loadConfig({ dir, secretKey: key, production: true });
    expect(cfg.composio).toMatchObject({ key: "legacy-composio", url: "https://example.test" });
    expect(readFileSync(join(dir, "config.json"), "utf8")).not.toContain("legacy-composio");
    expect(readFileSync(join(dir, "secrets.json"), "utf8")).not.toContain("legacy-composio");
    expect(existsSync(join(dir, "config-transaction.json"))).toBe(false);
    for (const entry of readdirSync(dir)) {
      expect(readFileSync(join(dir, entry), "utf8"), entry).not.toContain("legacy-composio");
    }
  });

  it("repeats a plaintext migration safely after credentials landed before the public config was scrubbed", () => {
    const dir = tempDir();
    const key = Buffer.alloc(32, 25);
    const config = JSON.stringify({ composio: { key: "legacy-retry", url: "https://example.test" } });
    writeFileSync(join(dir, "config.json"), config);
    expect(() => loadConfig({
      dir,
      secretKey: key,
      production: true,
      fault: (point) => { if (point === "after-secrets") throw new Error("simulated migration crash"); },
    })).toThrow(/simulated migration crash/);
    expect(readFileSync(join(dir, "config.json"), "utf8")).toContain("legacy-retry");
    expect(existsSync(join(dir, "config-transaction.json"))).toBe(false);

    expect(loadConfig({ dir, secretKey: key, production: true }).composio).toMatchObject({
      key: "legacy-retry",
      url: "https://example.test",
    });
    for (const entry of readdirSync(dir)) {
      expect(readFileSync(join(dir, entry), "utf8"), entry).not.toContain("legacy-retry");
    }
  });

  it("migrates legacy plaintext before a direct settings transaction can journal it", () => {
    const dir = tempDir();
    const base = { dir, secretKey: Buffer.alloc(32, 26), production: true };
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ composio: { key: "legacy-direct-save", url: "https://example.test" }, profile: { name: "Before" } }),
    );

    expect(() => saveConfig(
      { profile: { name: "After" } },
      { ...base, fault: (point) => { if (point === "after-journal") throw new Error("simulated settings crash"); } },
    )).toThrow(/simulated settings crash/);
    expect(readFileSync(join(dir, "config-transaction.json"), "utf8")).not.toContain("legacy-direct-save");

    expect(loadConfig(base)).toMatchObject({
      composio: { key: "legacy-direct-save", url: "https://example.test" },
      profile: { name: "Before" },
    });
    for (const entry of readdirSync(dir)) {
      expect(readFileSync(join(dir, entry), "utf8"), entry).not.toContain("legacy-direct-save");
    }
  });

  it("keeps config credentials write-only and supports replacement", () => {
    const dir = tempDir();
    const opts = { dir, secretKey: Buffer.alloc(32, 13), production: true };
    saveConfig({ composio: { key: "first", url: "https://one.test" } }, opts);
    saveConfig({ composio: { key: "second" } }, opts);
    expect(loadConfig(opts).composio).toMatchObject({ key: "second", url: "https://one.test" });
    const config = readFileSync(join(dir, "config.json"), "utf8");
    expect(config).not.toContain("first");
    expect(config).not.toContain("second");
  });

  it("persists only the closed work-routing hint and keeps it across reload", () => {
    const dir = tempDir();
    const opts = { dir, secretKey: Buffer.alloc(32, 28), production: true };
    saveConfig({ workRouting: { preference: "local-accelerated", revision: 7 } }, opts);
    expect(loadConfig(opts).workRouting).toEqual({ preference: "local-accelerated", revision: 7 });
    expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8"))).toMatchObject({
      workRouting: { preference: "local-accelerated", revision: 7 },
    });
  });

  it("keeps the Pocket bot token encrypted while preserving its PM-only allowlist", () => {
    const dir = tempDir();
    const opts = { dir, secretKey: Buffer.alloc(32, 19), production: true };
    saveConfig({
      pocket: {
        provider: "telegram",
        key: "123456:abcdefghijklmnopqrstuvwxyz_ABCDEFG",
        enabled: true,
        allowedUserId: "12345",
      },
    }, opts);
    expect(loadConfig(opts).pocket).toEqual({
      provider: "telegram",
      key: "123456:abcdefghijklmnopqrstuvwxyz_ABCDEFG",
      enabled: true,
      allowedUserId: "12345",
    });
    expect(readFileSync(join(dir, "config.json"), "utf8")).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(readFileSync(join(dir, "secrets.json"), "utf8")).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  it("keeps every WhatsApp Business credential encrypted while preserving channel routing settings", () => {
    const dir = tempDir();
    const opts = { dir, secretKey: Buffer.alloc(32, 20), production: true };
    saveConfig({
      pocket: {
        provider: "whatsapp-cloud",
        whatsappCloudAccessToken: `EAA${"x".repeat(80)}`,
        whatsappCloudAppSecret: "a".repeat(32),
        whatsappCloudVerifyToken: "realbud_verify_token_123456",
        whatsappCloudEnabled: true,
        whatsappCloudPhoneNumberId: "123456789012345",
        whatsappCloudAllowedUserId: "61412345678",
        whatsappCloudWebhookPort: 8090,
        whatsappCloudGraphVersion: "v26.0",
      },
    }, opts);
    expect(loadConfig(opts).pocket).toMatchObject({
      provider: "whatsapp-cloud",
      whatsappCloudAccessToken: `EAA${"x".repeat(80)}`,
      whatsappCloudAppSecret: "a".repeat(32),
      whatsappCloudVerifyToken: "realbud_verify_token_123456",
      whatsappCloudEnabled: true,
      whatsappCloudPhoneNumberId: "123456789012345",
      whatsappCloudAllowedUserId: "61412345678",
      whatsappCloudWebhookPort: 8090,
      whatsappCloudGraphVersion: "v26.0",
    });
    const config = readFileSync(join(dir, "config.json"), "utf8");
    const secrets = readFileSync(join(dir, "secrets.json"), "utf8");
    for (const secret of [`EAA${"x".repeat(80)}`, "a".repeat(32), "realbud_verify_token_123456"]) {
      expect(config).not.toContain(secret);
      expect(secrets).not.toContain(secret);
    }
  });

  it("holds an unrecoverable config instead of treating it as first run", () => {
    const dir = tempDir();
    const key = Buffer.alloc(32, 21);
    writeFileSync(join(dir, "config.json"), "truncated");
    expect(loadConfig({ dir, secretKey: key, production: true })).toEqual({});
    expect(() => saveConfig({ profile: { name: "Do not overwrite" } }, { dir, secretKey: key, production: true })).toThrow(/needs recovery/i);
    expect(readFileSync(join(dir, "config.json"), "utf8")).toBe("truncated");
  });

  it("restores the last verified config generation", () => {
    const dir = tempDir();
    const opts = { dir, secretKey: Buffer.alloc(32, 22), production: true };
    saveConfig({ profile: { name: "Verified" } }, opts);
    saveConfig({ profile: { name: "Newest" } }, opts);
    writeFileSync(join(dir, "config.json"), "truncated");
    expect(loadConfig(opts).profile?.name).toBe("Verified");
    expect(readFileSync(join(dir, "config.json"), "utf8")).toContain("Verified");
  });

  it("rolls back both config and ciphertext after a crash between their writes", () => {
    const dir = tempDir();
    const base = { dir, secretKey: Buffer.alloc(32, 23), production: true };
    saveConfig({ composio: { key: "old-private", url: "https://old.test" } }, base);
    expect(() => saveConfig(
      { composio: { key: "new-private", url: "https://new.test" } },
      { ...base, fault: (point) => { if (point === "after-secrets") throw new Error("simulated crash"); } },
    )).toThrow(/simulated crash/);
    const journal = readFileSync(join(dir, "config-transaction.json"), "utf8");
    expect(journal).not.toContain("old-private");
    expect(journal).not.toContain("new-private");

    expect(loadConfig(base).composio).toMatchObject({ key: "old-private", url: "https://old.test" });
    expect(existsSync(join(dir, "config-transaction.json"))).toBe(false);
  });

  it("finishes an already-landed pair after a crash before journal cleanup", () => {
    const dir = tempDir();
    const base = { dir, secretKey: Buffer.alloc(32, 24), production: true };
    saveConfig({ composio: { key: "old-private", url: "https://old.test" } }, base);
    expect(() => saveConfig(
      { composio: { key: "new-private", url: "https://new.test" } },
      { ...base, fault: (point) => { if (point === "after-config") throw new Error("simulated crash"); } },
    )).toThrow(/simulated crash/);

    expect(loadConfig(base).composio).toMatchObject({ key: "new-private", url: "https://new.test" });
    expect(existsSync(join(dir, "config-transaction.json"))).toBe(false);
  });
});
