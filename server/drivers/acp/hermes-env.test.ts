import { describe, expect, it } from "vitest";

import { hardenHermesChildEnv } from "./hermes.ts";

describe("Hermes child stream watchdog", () => {
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
    };
    hardenHermesChildEnv(env);
    expect(env).toEqual({
      HERMES_ACP_SKIP_CONFIGURED_MCP: "1",
      HERMES_CODEX_EVENT_STALE_TIMEOUT_SECONDS: "60",
    });
  });
});
