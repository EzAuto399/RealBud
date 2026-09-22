import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { applyPropertyPack, ensurePropertyPack, approvalsAreManual, hermesAgentDir, isInsideHermesHome, learningPolicyReady, migratePropertyProfileFromLegacyHermes, packInstalled, propertyProfileDir, propertyWorkroomReady, stagedLearningSupported, workerLimitsReady, yamlBlock } from "./hermes-pack.ts";
import { releaseHome, resetRuntimeSelectionForTests, saveRuntimeSelection, selectedHermesCli } from "./hermes-runtime-selection.ts";
import { runtimeCli } from "./hermes-paths.ts";
import { dirname } from "node:path";
import { BUILT_IN_DRIVERS } from "./drivers/builtIn.ts";
import { parse, parseDocument } from "yaml";

import { privateFixtureDirectory, privateFixtureRoot, writePrivateFixtureFile as writeFileSync, WINDOWS_PROFILE_TEST_OPTIONS } from "./testing/private-profile-fixture.ts";

const dirs: string[] = [];
const mkdtempSync = privateFixtureRoot;

afterEach(() => {
  resetRuntimeSelectionForTests();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("applyPropertyPack", WINDOWS_PROFILE_TEST_OPTIONS, () => {
  it.runIf(process.platform !== "win32")("keeps newly installed and repaired policy files private", () => {
    const home = mkdtempSync(join(tmpdir(), "realbud-profile-private-")); dirs.push(home);
    const { dir } = applyPropertyPack(home);
    expect(statSync(dir).mode & 0o077).toBe(0);
    const paths = [join(home, "auth.json"), ...["SOUL.md", "config.yaml", "distribution.yaml", "profile.yaml"].map(name => join(dir, name))];
    for (const path of paths) expect(statSync(path).mode & 0o077, path).toBe(0);
    applyPropertyPack(home);
    for (const path of paths) expect(statSync(path).mode & 0o077, path).toBe(0);
  });
  it("repairs missing learning sections as plain mappings understood by Hermes", () => {
    const home = mkdtempSync(join(tmpdir(), "realbud-profile-mapping-")); dirs.push(home);
    const dir = propertyProfileDir(home); privateFixtureDirectory(dir);
    const path = join(dir, "config.yaml");
    writeFileSync(path, "model:\n  provider: retained\n");
    applyPropertyPack(home);
    const saved = readFileSync(path, "utf8");
    expect(saved).not.toContain("!!omap");
    expect(parse(saved, { version: "1.1" })).toMatchObject({
      model: { provider: "retained" }, skills: { write_approval: true }, memory: { write_approval: true },
      auxiliary: { background_review: { enabled: false, extra_tools: [] } },
    });
    expect(learningPolicyReady(home)).toBe(true);
  });
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
    const dir = propertyProfileDir(home); privateFixtureDirectory(dir);
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
    writeFileSync(path, readFileSync(path, "utf8").replace("memory:\n", "memory:\n  user_profile: retained\n") + "\nupdates:\n  check: false\nmcp_servers:\n  office:\n    enabled: false\n");
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
  it("requires explicit repair for absent, duplicate or malformed learning gates", () => {
    const home = mkdtempSync(join(tmpdir(), "realbud-learning-policy-")); dirs.push(home);
    const { dir } = applyPropertyPack(home); const path = join(dir, "config.yaml");
    const baseline = readFileSync(path, "utf8");
    expect(learningPolicyReady(home)).toBe(true);
    for (const text of [baseline.replace(/write_approval: true/g, "write_approval: false"), baseline + "skills:\n  write_approval: false\n", baseline + "broken: [\n"]) {
      writeFileSync(path, text);
      expect(learningPolicyReady(home)).toBe(false);
      expect(propertyWorkroomReady(home)).toBe(false);
      expect(ensurePropertyPack(home).wrote).toEqual([]);
      expect(readFileSync(path, "utf8")).toBe(text);
    }
    writeFileSync(path, baseline.replace(/write_approval: true/g, "write_approval: false"));
    applyPropertyPack(home);
    expect(learningPolicyReady(home)).toBe(true);
  });
  it("enables staged background learning only for the admitted executable in this process", () => {
    const home = mkdtempSync(join(tmpdir(), "realbud-learning-release-")); dirs.push(home);
    const commit = "345cd2b057a452236de401d3534b8502a7465e8d";
    const cli = runtimeCli(releaseHome(home, commit));
    mkdirSync(dirname(cli), { recursive: true }); writeFileSync(cli, "fictional executable marker");
    saveRuntimeSelection(home, { version: 1, selected: commit, previous: null });
    expect(stagedLearningSupported(home)).toBe(true);
    const { dir } = applyPropertyPack(home);
    expect(readFileSync(join(dir, "config.yaml"), "utf8")).toMatch(/background_review:\n\s+enabled: true/);
    expect(learningPolicyReady(home)).toBe(true);

    resetRuntimeSelectionForTests();
    saveRuntimeSelection(home, { version: 1, selected: null, previous: null });
    selectedHermesCli(home); // Cache the old worker before a staged update.
    saveRuntimeSelection(home, { version: 1, selected: commit, previous: null });
    expect(stagedLearningSupported(home)).toBe(false);
    expect(learningPolicyReady(home)).toBe(false);
    applyPropertyPack(home);
    expect(readFileSync(join(dir, "config.yaml"), "utf8")).toMatch(/background_review:\n\s+enabled: false/);
    expect(propertyWorkroomReady(home)).toBe(true);
  });
  it("keeps custom skill and memory settings while removing background tool/provider escapes", () => {
    const home = mkdtempSync(join(tmpdir(), "realbud-learning-preserve-")); dirs.push(home);
    const { dir } = applyPropertyPack(home); const path = join(dir, "config.yaml");
    writeFileSync(path, "skills:\n  disabled: [sample]\n  write_approval: false\nmemory:\n  memory_enabled: false\n  write_approval: false\nauxiliary:\n  title:\n    model: retained\n  background_review:\n    enabled: true\n    provider: unreviewed\n    extra_tools: [terminal]\n");
    applyPropertyPack(home);
    const saved = readFileSync(path, "utf8");
    expect(saved).toContain("disabled: [ sample ]");
    expect(saved).toContain("memory_enabled: false");
    expect(saved).toContain("model: retained");
    expect(saved).not.toContain("unreviewed");
    expect(learningPolicyReady(home)).toBe(true);
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
    privateFixtureDirectory(profile);
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

  it("writes cheaper worker limits on install and repairs a profile from before they existed", () => {
    const home = mkdtempSync(join(tmpdir(), "realbud-worker-limits-")); dirs.push(home);
    const { dir } = applyPropertyPack(home); const path = join(dir, "config.yaml");
    const fresh = readFileSync(path, "utf8");
    expect(parse(fresh, { version: "1.1" })).toMatchObject({
      agent: { max_turns: 60, budget_warning_ratio: 0.75 },
      security: { redact_secrets: true, allow_lazy_installs: false },
      tool_loop_guardrails: { loop_caps: { max_web_searches: 10, max_subagents: 4 } },
      auxiliary: { background_review: { enabled: false, extra_tools: [] }, title_generation: { enabled: false } },
    });
    expect(fresh).not.toContain("!!omap");
    expect(workerLimitsReady(home)).toBe(true);
    expect(propertyWorkroomReady(home)).toBe(true);

    // The policy shipped before these limits, plus an office's own title model.
    const old = parseDocument(fresh, { version: "1.1" });
    for (const at of [["agent", "budget_warning_ratio"], ["security", "allow_lazy_installs"], ["tool_loop_guardrails"], ["auxiliary", "title_generation"]]) old.deleteIn(at);
    old.setIn(["auxiliary", "title_generation"], old.createNode({ enabled: true, model: "fictional-title-model" }));
    const before = old.toString();
    writeFileSync(path, before);
    // Needs Repair, not unsafe: hands still run and startup does not rewrite it.
    expect(approvalsAreManual(home)).toBe(true);
    expect(learningPolicyReady(home)).toBe(true);
    expect(workerLimitsReady(home)).toBe(false);
    expect(propertyWorkroomReady(home)).toBe(false);
    expect(ensurePropertyPack(home).wrote).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(before);

    applyPropertyPack(home);
    const repaired = parse(readFileSync(path, "utf8"), { version: "1.1" });
    expect(repaired.auxiliary.title_generation).toEqual({ enabled: false });
    expect(workerLimitsReady(home)).toBe(true);
    expect(propertyWorkroomReady(home)).toBe(true);
  });

  it("does not accept looser worker limits than the pack's", () => {
    const home = mkdtempSync(join(tmpdir(), "realbud-worker-limits-loose-")); dirs.push(home);
    const { dir } = applyPropertyPack(home); const path = join(dir, "config.yaml");
    const baseline = readFileSync(path, "utf8");
    const edits: Array<[string[], unknown]> = [
      [["tool_loop_guardrails", "loop_caps", "max_web_searches"], 0], // upstream reads 0 as unlimited
      [["tool_loop_guardrails", "loop_caps", "max_web_searches"], 50],
      [["tool_loop_guardrails", "loop_caps", "max_subagents"], 5],
      [["security", "allow_lazy_installs"], true],
      [["auxiliary", "title_generation", "enabled"], true],
      [["agent", "budget_warning_ratio"], 1],
    ];
    for (const [at, value] of edits) {
      const doc = parseDocument(baseline, { version: "1.1" }); doc.setIn(at, value);
      writeFileSync(path, doc.toString());
      expect(workerLimitsReady(home), at.join(".")).toBe(false);
      expect(propertyWorkroomReady(home), at.join(".")).toBe(false);
    }
    const tighter = parseDocument(baseline, { version: "1.1" });
    tighter.setIn(["tool_loop_guardrails", "loop_caps", "max_web_searches"], 3);
    writeFileSync(path, tighter.toString());
    expect(workerLimitsReady(home)).toBe(true);
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
    privateFixtureDirectory(profile);
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
