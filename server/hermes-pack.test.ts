import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { applyPropertyPack, approvalsAreManual, hermesAgentDir, isInsideHermesHome, packInstalled, propertyWorkroomReady } from "./hermes-pack.ts";
import { BUILT_IN_DRIVERS } from "./drivers/builtIn.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("applyPropertyPack", () => {
  it("writes SOUL, manual approvals, and the morning-arrears skill", () => {
    const home = mkdtempSync(join(tmpdir(), "realbud-hermes-"));
    dirs.push(home);
    const result = applyPropertyPack(home);
    expect(packInstalled(home)).toBe(true);
    expect(approvalsAreManual(home)).toBe(true);
    expect(propertyWorkroomReady(home)).toBe(true);
    expect(result.wrote).toEqual(expect.arrayContaining(["SOUL.md", "config.yaml", "skills/"]));
    const soul = readFileSync(join(result.dir, "SOUL.md"), "utf8");
    expect(soul).toMatch(/Draft only/);
    expect(soul).toMatch(/No notices\. No trust/);
    expect(soul).not.toMatch(/send the SMS/i);
    const config = readFileSync(join(result.dir, "config.yaml"), "utf8");
    expect(config).toMatch(/mode:\s*manual/);
    expect(config).toMatch(/backend:\s*local/);
    expect(config).toMatch(/home_mode:\s*profile/);
    expect(config).toMatch(/max_turns:\s*60/);
    expect(config).toMatch(/toolsets:[\s\S]*- terminal[\s\S]*- delegation/);
    expect(config).not.toMatch(/^\s+-\s*(code_execution|computer_use|cronjob|skills)\s*$/m);
    expect(config).not.toMatch(/backend:\s*none|toolsets:\s*\[\]/);
  });

  it("does not call a legacy disabled-terminal profile workroom-ready", () => {
    const home = mkdtempSync(join(tmpdir(), "realbud-hermes-legacy-"));
    dirs.push(home);
    const profile = join(home, "profiles", "property");
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, "config.yaml"), "approvals:\n  mode: manual\nterminal:\n  backend: none\n");
    expect(approvalsAreManual(home)).toBe(true);
    expect(propertyWorkroomReady(home)).toBe(false);
  });

  it("attaches the machine Hermes model without copying home credentials", () => {
    const home = mkdtempSync(join(tmpdir(), "realbud-hermes-"));
    dirs.push(home);
    writeFileSync(
      join(home, "config.yaml"),
      "model:\n  default: grok-4.5\n  provider: xai-oauth\n",
    );
    writeFileSync(join(home, ".env"), "XAI_API_KEY=test-key\n");
    writeFileSync(join(home, "auth.json"), '{"token":"personal"}');
    const first = applyPropertyPack(home);
    const cfg = readFileSync(join(first.dir, "config.yaml"), "utf8");
    expect(cfg).toMatch(/mode:\s*manual/);
    expect(cfg).toMatch(/default:\s*grok-4\.5/);
    expect(cfg).toMatch(/provider:\s*xai-oauth/);
    expect(existsSync(join(first.dir, ".env"))).toBe(false);
    expect(existsSync(join(first.dir, "auth.json"))).toBe(false);

    writeFileSync(join(first.dir, ".env"), "XAI_API_KEY=keep-me\n");
    writeFileSync(join(home, "config.yaml"), "model:\n  default: other\n  provider: openai\n");
    applyPropertyPack(home);
    const again = readFileSync(join(first.dir, "config.yaml"), "utf8");
    expect(again).toMatch(/default:\s*grok-4\.5/);
    expect(readFileSync(join(first.dir, ".env"), "utf8")).toContain("keep-me");
  });
});

describe("hermesAgentDir", () => {
  it("is the official checkout inside the worker home and never the home itself", () => {
    const home = mkdtempSync(join(tmpdir(), "realbud-hermes-agent-"));
    dirs.push(home);
    expect(hermesAgentDir(home)).toBe(join(home, "hermes-agent"));
    expect(isInsideHermesHome(hermesAgentDir(home), home)).toBe(true);
    expect(isInsideHermesHome(home, home)).toBe(false);
    expect(isInsideHermesHome(join(home, "..", "outside"), home)).toBe(false);
  });
});

describe("product fleet", () => {
  it("registers Hermes as the only built-in driver", () => {
    expect(BUILT_IN_DRIVERS.map((d) => d.driverKind)).toEqual(["hermesAgent"]);
  });
});
