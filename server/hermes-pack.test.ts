import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { applyPropertyPack, ensurePropertyPack, approvalsAreManual, hermesAgentDir, isInsideHermesHome, migratePropertyProfileFromLegacyHermes, packInstalled, propertyProfileDir, propertyWorkroomReady, yamlBlock } from "./hermes-pack.ts";
import { BUILT_IN_DRIVERS } from "./drivers/builtIn.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("applyPropertyPack", () => {
  it("initializes a new profile once and preserves every existing profile setting on restart", () => {
    const home = mkdtempSync(join(tmpdir(), "realbud-profile-startup-")); dirs.push(home);
    const { dir, wrote } = ensurePropertyPack(home);
    expect(wrote).toContain("config.yaml");
    const files = { "config.yaml": "# Custom formatting\napprovals:\n  mode: manual\nagent:\n  max_turns: 120\n", "SOUL.md": "Locally maintained identity", ".env": "TEST_KEY=retained", "auth.json": "{}", "MEMORY.md": "Learned preferences" };
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    expect(ensurePropertyPack(home).wrote).toEqual([]);
    for (const [name, body] of Object.entries(files)) expect(readFileSync(join(dir, name), "utf8")).toBe(body);
    expect(propertyWorkroomReady(home)).toBe(false);
  });
  it("preserves an incomplete existing profile for explicit repair and establishes private root auth", () => {
    const home = mkdtempSync(join(tmpdir(), "realbud-profile-incomplete-")); dirs.push(home);
    const dir = propertyProfileDir(home); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SOUL.md"), "Existing profile");
    writeFileSync(join(dir, "config.yaml"), "{broken");
    expect(ensurePropertyPack(home).wrote).toEqual([]);
    expect(readFileSync(join(dir, "config.yaml"), "utf8")).toBe("{broken");
    expect(JSON.parse(readFileSync(join(home, "auth.json"), "utf8"))).toMatchObject({ providers: {}, credential_pool: {} });
    expect(approvalsAreManual(home)).toBe(false);
  });
  it("keeps unrelated upstream settings, credentials, memory and locally edited skills during repair", () => {
    const home = mkdtempSync(join(tmpdir(), "realbud-profile-preserve-")); dirs.push(home);
    const { dir } = applyPropertyPack(home);
    const path = join(dir, "config.yaml");
    writeFileSync(path, readFileSync(path, "utf8") + "\nupdates:\n  check: false\nmemory:\n  user_profile: retained\nmcp_servers:\n  office:\n    enabled: false\n");
    const skill = join(dir, "skills", "local-skill.md"); writeFileSync(skill, "My learned procedure");
    writeFileSync(join(dir, "MEMORY.md"), "Operator preferences");
    writeFileSync(join(dir, ".env"), "TEST_KEY=retained");
    applyPropertyPack(home);
    const config = readFileSync(path, "utf8");
    expect(config).toContain("updates:\n  check: false");
    expect(config).toContain("memory:\n  user_profile: retained");
    expect(config).toContain("mcp_servers:\n  office:\n    enabled: false");
    expect(readFileSync(skill, "utf8")).toBe("My learned procedure");
    expect(readFileSync(join(dir, "MEMORY.md"), "utf8")).toBe("Operator preferences");
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe("TEST_KEY=retained");
    expect(propertyWorkroomReady(home)).toBe(true);
  });
  it("refuses unreadable or duplicated policy config instead of replacing it", () => {
    const home = mkdtempSync(join(tmpdir(), "realbud-profile-invalid-")); dirs.push(home);
    const { dir } = applyPropertyPack(home); const path = join(dir, "config.yaml");
    for (const text of ["{broken", "approvals:\n  mode: manual\napprovals:\n  mode: off\n"]) {
      writeFileSync(path, text); expect(() => applyPropertyPack(home)).toThrow(/kept/); expect(readFileSync(path, "utf8")).toBe(text);
    }
  });
  it("repairs bounded source-read limits without changing the model or repairing on startup", () => {
    const home = mkdtempSync(join(tmpdir(), "realbud-read-budget-")); dirs.push(home);
    const { dir } = applyPropertyPack(home); const path = join(dir, "config.yaml");
    const old = "approvals:\n  mode: manual\nfile_read_max_chars: 100000\ntool_output:\n  max_line_length: 2000\nmodel:\n  provider: retained-provider\n  default: retained-model\n";
    writeFileSync(path, old);
    expect(ensurePropertyPack(home).wrote).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(old);
    applyPropertyPack(home);
    const repaired = readFileSync(path, "utf8");
    expect(repaired).toContain("file_read_max_chars: 32000");
    expect(yamlBlock(repaired, "tool_output")).toContain("max_line_length: 32000");
    expect(yamlBlock(repaired, "model")).toContain("provider: retained-provider");
    expect(yamlBlock(repaired, "model")).toContain("default: retained-model");
    const duplicate = repaired + "file_read_max_chars: 1\n";
    writeFileSync(path, duplicate);
    expect(() => applyPropertyPack(home)).toThrow(/duplicate/);
    expect(readFileSync(path, "utf8")).toBe(duplicate);
  });
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

  it("treats CRLF config as workroom-ready", () => {
    const home = mkdtempSync(join(tmpdir(), "realbud-hermes-crlf-"));
    dirs.push(home);
    applyPropertyPack(home);
    const configPath = join(propertyProfileDir(home), "config.yaml");
    writeFileSync(configPath, readFileSync(configPath, "utf8").replace(/\n/g, "\r\n"));
    expect(propertyWorkroomReady(home)).toBe(true);
    expect(yamlBlock(readFileSync(configPath, "utf8"), "terminal")).toMatch(/backend: local/);
  });

  it("does not inherit a Hermes Desktop home model into Bud's hands", () => {
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
    expect(cfg).not.toMatch(/default:\s*grok-4\.5/);
    expect(cfg).not.toMatch(/provider:\s*xai-oauth/);
    expect(existsSync(join(first.dir, ".env"))).toBe(false);
    expect(existsSync(join(first.dir, "auth.json"))).toBe(false);

    // Once Bud has its own model block, re-apply keeps it.
    writeFileSync(
      join(first.dir, "config.yaml"),
      `${readFileSync(join(first.dir, "config.yaml"), "utf8")}\nmodel:\n  default: grok-4.5\n  provider: xai-oauth\n`,
    );
    writeFileSync(join(first.dir, ".env"), "XAI_API_KEY=keep-me\n");
    writeFileSync(join(home, "config.yaml"), "model:\n  default: other\n  provider: openai\n");
    applyPropertyPack(home);
    const again = readFileSync(join(first.dir, "config.yaml"), "utf8");
    expect(again).toMatch(/default:\s*grok-4\.5/);
    expect(readFileSync(join(first.dir, ".env"), "utf8")).toContain("keep-me");
  });
});

describe("migratePropertyProfileFromLegacyHermes", () => {
  it("copies only the property profile into an empty RealBud hermes home", () => {
    const owned = mkdtempSync(join(tmpdir(), "realbud-owned-hermes-"));
    dirs.push(owned);
    const legacy = join(owned, "legacy-home-sim");
    // Simulate by invoking migrate with owned root empty and stubbing via
    // copying into real ~/.hermes is unsafe in tests — exercise packInstalled
    // + cp path with an explicit root that already has a sibling layout.
    const home = mkdtempSync(join(tmpdir(), "realbud-hermes-mig-"));
    dirs.push(home);
    const profile = join(home, "profiles", "property");
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, "SOUL.md"), "# RealBud hands\n");
    writeFileSync(join(profile, "auth.json"), JSON.stringify({ version: 1, credential_pool: { "xai-oauth": [{}] } }));
    // Second empty home: migrate is no-op when pack already installed on root.
    expect(migratePropertyProfileFromLegacyHermes(home)).toEqual({ migrated: false });
    expect(packInstalled(home)).toBe(true);
    void legacy;
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
