import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { applyPropertyPack, approvalsAreManual, packInstalled } from "./hermes-pack.ts";
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
    expect(result.wrote).toEqual(expect.arrayContaining(["SOUL.md", "config.yaml", "skills/"]));
    const soul = readFileSync(join(result.dir, "SOUL.md"), "utf8");
    expect(soul).toMatch(/Draft only/);
    expect(soul).toMatch(/No notices\. No trust/);
    expect(soul).not.toMatch(/send the SMS/i);
    expect(readFileSync(join(result.dir, "config.yaml"), "utf8")).toMatch(/mode:\s*manual/);
  });

  it("attaches the machine Hermes model and copies .env once", () => {
    const home = mkdtempSync(join(tmpdir(), "realbud-hermes-"));
    dirs.push(home);
    writeFileSync(
      join(home, "config.yaml"),
      "model:\n  default: grok-4.5\n  provider: xai-oauth\n",
    );
    writeFileSync(join(home, ".env"), "XAI_API_KEY=test-key\n");
    const first = applyPropertyPack(home);
    const cfg = readFileSync(join(first.dir, "config.yaml"), "utf8");
    expect(cfg).toMatch(/mode:\s*manual/);
    expect(cfg).toMatch(/default:\s*grok-4\.5/);
    expect(cfg).toMatch(/provider:\s*xai-oauth/);
    expect(readFileSync(join(first.dir, ".env"), "utf8")).toContain("XAI_API_KEY=test-key");

    writeFileSync(join(first.dir, ".env"), "XAI_API_KEY=keep-me\n");
    writeFileSync(join(home, "config.yaml"), "model:\n  default: other\n  provider: openai\n");
    applyPropertyPack(home);
    const again = readFileSync(join(first.dir, "config.yaml"), "utf8");
    expect(again).toMatch(/default:\s*grok-4\.5/);
    expect(readFileSync(join(first.dir, ".env"), "utf8")).toContain("keep-me");
    expect(packInstalled(home)).toBe(true);
  });

  it("fails closed on a modified pack or stale skill and repairs both on re-apply", () => {
    const home = mkdtempSync(join(tmpdir(), "realbud-hermes-"));
    dirs.push(home);
    const installed = applyPropertyPack(home);
    writeFileSync(join(installed.dir, "SOUL.md"), "modified\n");
    expect(packInstalled(home)).toBe(false);
    applyPropertyPack(home);
    expect(packInstalled(home)).toBe(true);

    writeFileSync(join(installed.dir, "skills", "morning-arrears", "SKILL.md"), "stale skill\n");
    expect(packInstalled(home)).toBe(false);
    applyPropertyPack(home);
    expect(packInstalled(home)).toBe(true);
  });

  it("stays installed when the worker adds bundled skills beside the pack", () => {
    const home = mkdtempSync(join(tmpdir(), "realbud-hermes-"));
    dirs.push(home);
    const installed = applyPropertyPack(home);
    writeFileSync(join(installed.dir, "skills", ".bundled_manifest"), "hermes-owned\n");
    writeFileSync(join(installed.dir, "skills", "unowned.md"), "extra capability\n");
    expect(packInstalled(home)).toBe(true);
  });

  it("requires manual approvals, cron deny, no toolsets and no terminal", () => {
    const home = mkdtempSync(join(tmpdir(), "realbud-hermes-"));
    dirs.push(home);
    const installed = applyPropertyPack(home);
    const config = join(installed.dir, "config.yaml");
    writeFileSync(config, readFileSync(config, "utf8").replace("cron_mode: deny", "cron_mode: allow"));
    expect(approvalsAreManual(home)).toBe(false);
  });
});

describe("product fleet", () => {
  it("registers Hermes as the only built-in driver", () => {
    expect(BUILT_IN_DRIVERS.map((d) => d.driverKind)).toEqual(["hermesAgent"]);
  });
});
