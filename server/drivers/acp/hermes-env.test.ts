import { describe, expect, it } from "vitest";
import { homedir, tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { hardenHermesChildEnv } from "./hermes.ts";

describe("Hermes child stream watchdog", () => {
  it("binds separate desktop workers to their own data roots", () => {
    for (const data of ["desktop-a", "desktop-b"]) {
      const env: Record<string, string | undefined> = { REALBUD_DATA_DIR: data, HERMES_HOME: "/unrelated/personal" };
      hardenHermesChildEnv(env);
      expect(env.HERMES_HOME).toBe(join(data, "hermes"));
    }
  });

  it.skipIf(process.platform === "win32")("puts the owned runtime's venv first so `python3` is Bud's own Python", () => {
    const home = mkdtempSync(join(tmpdir(), "rb-venv-path-"));
    try {
      const bin = join(home, "hermes-agent", "venv", "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "hermes"), "");
      const env: Record<string, string | undefined> = { REALBUD_HERMES_HOME: home, PATH: "/usr/bin:/bin" };
      hardenHermesChildEnv(env);
      expect(env.PATH?.split(":")[0]).toBe(bin);
      expect(env.PATH).toContain("/usr/bin");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("honors the explicit owned worker home and retains safe mode", () => {
    const env: Record<string, string | undefined> = { REALBUD_HERMES_HOME: "/owned/member", REALBUD_DATA_DIR: "/desktop", HERMES_HOME: "/unrelated/personal" };
    hardenHermesChildEnv(env);
    expect(env.HERMES_HOME).toBe("/owned/member");
    expect(env.HERMES_SAFE_MODE).toBe("1");
  });
  it.each([undefined, "", "   "])("defaults an unset or empty watchdog (%s) to 60 seconds", (value) => {
    const env: Record<string, string | undefined> = {
      HERMES_CODEX_EVENT_STALE_TIMEOUT_SECONDS: value,
      HERMES_API_TIMEOUT: "120",
    };
    hardenHermesChildEnv(env);
    expect(env.HERMES_CODEX_EVENT_STALE_TIMEOUT_SECONDS).toBe("60");
    expect(env.HERMES_API_TIMEOUT).toBe("120");
  });

  it.each(["0", "25", "180", " 45 "])("preserves an explicit watchdog setting (%s)", (value) => {
    const env = { HERMES_CODEX_EVENT_STALE_TIMEOUT_SECONDS: value };
    hardenHermesChildEnv(env);
    expect(env.HERMES_CODEX_EVENT_STALE_TIMEOUT_SECONDS).toBe(value);
  });

  it("drops the settings that would give Hermes its own browser", () => {
    const env: Record<string, string | undefined> = {
      AGENT_BROWSER_EXECUTABLE_PATH: "/synthetic/chromium",
      AGENT_BROWSER_ENGINE: "lightpanda",
      agent_browser_session: "fictional",
      BROWSER_CDP_URL: "http://127.0.0.1:9222",
      CAMOFOX_URL: "http://127.0.0.1:9377",
      PLAYWRIGHT_BROWSERS_PATH: "/synthetic/ms-playwright",
      BROWSER_TIMEOUT: "kept",
    };
    hardenHermesChildEnv(env);
    for (const key of ["AGENT_BROWSER_EXECUTABLE_PATH", "AGENT_BROWSER_ENGINE", "agent_browser_session", "BROWSER_CDP_URL", "CAMOFOX_URL", "PLAYWRIGHT_BROWSERS_PATH"]) {
      expect(env, key).not.toHaveProperty(key);
    }
    expect(env.BROWSER_TIMEOUT).toBe("kept");
  });

  it("keeps provider and capability hardening in place", () => {
    const env: Record<string, string | undefined> = {
      OPENAI_API_KEY: "fictional-key",
      OPENROUTER_API_KEY: "fictional-key",
      KIMI_API_KEY: "fictional-key",
      MOONSHOT_API_KEY: "fictional-key",
      // The managed grant's own name, the endpoint override, and keys upstream's
      // host-derived fallback would read, are all ambient here.
      REALBUD_MODEL_API_KEY: "fictional-ambient-grant",
      OPENAI_BASE_URL: "https://ambient.invalid/v1",
      MODELVIA_API_KEY: "fictional-key",
      DEEPSEEK_API_KEY: "fictional-key",
      ANTHROPIC_API_KEY: "fictional-key",
      XAI_API_KEY: "fictional-key",
      COMPOSIO_KEY: "fictional-key",
      REALBUD_CUA_CONTROL_TOKEN: "fictional-private-host-token",
      REALBUD_CUA_CONTROL_URL: "http://127.0.0.1:1234",
      REALBUD_DESK_KEY: "fictional-desk-key",
      HERMES_ACP_SKIP_CONFIGURED_MCP: "0",
      HERMES_SAFE_MODE: "0",
      HERMES_EXEC_ASK: "0",
    };
    hardenHermesChildEnv(env);
    expect(env).toEqual({
      HERMES_HOME: join(homedir(), ".realbud", "hermes"),
      HERMES_ACP_SKIP_CONFIGURED_MCP: "1",
      HERMES_SAFE_MODE: "1",
      HERMES_EXEC_ASK: "1",
      COPILOT_GH_HOST: "realbud.invalid",
      HERMES_CODEX_EVENT_STALE_TIMEOUT_SECONDS: "60",
    });
  });
});

describe("Hermes child GitHub isolation", () => {
  it("drops GitHub/Copilot logins and points upstream's gh lookup at a host with no login", () => {
    const env: Record<string, string | undefined> = {
      GH_TOKEN: "fictional-gh", GITHUB_TOKEN: "fictional-github", COPILOT_GITHUB_TOKEN: "fictional-copilot",
      GH_ENTERPRISE_TOKEN: "fictional-enterprise", GH_HOST: "github.example.invalid", COPILOT_GH_HOST: "github.com", PATH: "/usr/bin",
    };
    hardenHermesChildEnv(env);
    for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GH_HOST"]) expect(env[key]).toBeUndefined();
    expect(env.COPILOT_GH_HOST).toBe("realbud.invalid");
    expect(env.PATH).toBe("/usr/bin");
  });
});
