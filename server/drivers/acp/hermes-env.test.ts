import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
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
      HERMES_CODEX_EVENT_STALE_TIMEOUT_SECONDS: "60",
    });
  });
});
