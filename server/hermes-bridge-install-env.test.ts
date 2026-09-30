import { afterEach, describe, expect, it, vi } from "vitest";
import { installStatus, startInstall } from "./hermes-bridge.ts";

const saved = { GH_TOKEN: process.env.GH_TOKEN, COPILOT_GH_HOST: process.env.COPILOT_GH_HOST };
afterEach(() => { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });

describe("worker installer environment", () => {
  it.skipIf(process.platform === "win32")("gives the installer no GitHub login to adopt", async () => {
    process.env.GH_TOKEN = "fictional-gh-token"; process.env.COPILOT_GH_HOST = "github.com";
    startInstall(`printf 'gh=%s host=%s\\n' "\${GH_TOKEN:-none}" "$COPILOT_GH_HOST"`, { timeoutMs: 15_000 });
    await vi.waitFor(() => expect(installStatus().lines.join("\n")).toContain("gh=none host=realbud.invalid"), { timeout: 5_000 });
  }, 20_000);
});
