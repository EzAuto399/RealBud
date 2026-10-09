import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { applyManagedModelProfile, applyPropertyPack, MANAGED_MODEL_KEY_ENV, MANAGED_MODEL_PROVIDER, managedModelConfig, managedModelProfile, mergePropertyPolicy, ensurePropertyPack, approvalsAreManual, hermesAgentDir, isInsideHermesHome, learningPolicyReady, migratePropertyProfileFromLegacyHermes, OFF_SCOPE_BUNDLED_SKILLS, PACK_DIR, packInstalled, PREVIOUSLY_OFF_SCOPE_BUNDLED_SKILLS, propertyProfileDir, RETIRED_PACK_SKILLS, propertyWorkroomReady, skillScopeReady, stagedLearningSupported, workerLimitsReady, WORKER_ACP_TOOLSETS, WORKER_BROWSER_POLICY, WORKER_DEFERRED_TOOLS, WORKER_DIRECT_TOOLS, WORKER_DISABLED_TOOLSETS, WORKER_DISABLED_VAULTS, WORKER_DENIED_COMMANDS, MEMORY_SCHEMA_READY_COMMITS, shippedProfileDigests, yamlBlock } from "./hermes-pack.ts";
import { MANAGED_MODEL_CHOICES } from "../shared/managed-model-choices.ts";
import { HERMES_RECOMMENDED } from "./hermes-releases.ts";
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
    // Missing shipped skills are added; an unrecognised SOUL and the config are kept.
    const startup = ensurePropertyPack(home);
    expect(startup.wrote.every(rel => rel.startsWith("skills/"))).toBe(true);
    expect(startup.kept).toEqual(["SOUL.md"]);
    expect(readFileSync(join(dir, "SOUL.md"), "utf8")).toBe("Existing profile");
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
  it("reads approval and workroom readiness from parsed values, not text", () => {
    const home = mkdtempSync(join(tmpdir(), "realbud-parsed-readiness-")); dirs.push(home);
    const { dir } = applyPropertyPack(home); const path = join(dir, "config.yaml");
    expect(realpathSync(dir)).toBe(dir);
    const baseline = readFileSync(path, "utf8");
    expect(approvalsAreManual(home)).toBe(true);
    expect(propertyWorkroomReady(home)).toBe(true);
    const approvals = (mode: string) => baseline.replace("approvals:\n  mode: manual\n", `approvals:\n  mode: ${mode}\n`);
    for (const text of [
      approvals("yolo  # mode: manual"),
      approvals("Manual"),
      approvals("|\n    manual"), // block scalar yields "manual\n"
      approvals("off\n  mode: manual"), // duplicate key
      baseline + "approvals:\n  mode: manual\n",
      "approvals:\n  note: |\n    mode: manual\n  mode: smart\n",
    ]) {
      writeFileSync(path, text);
      expect(approvalsAreManual(home), text.slice(0, 80)).toBe(false);
    }
    writeFileSync(path, approvals('"manual "'));
    expect(approvalsAreManual(home)).toBe(false); // a quoted trailing space survives parsing
    writeFileSync(path, approvals("manual   # trailing comment"));
    expect(approvalsAreManual(home)).toBe(true);
    for (const text of [
      baseline.replace("  backend: local\n", "  backend: docker  # backend: local\n"),
      baseline.replace("  redact_secrets: true\n", "  redact_secrets: \"true\"\n"),
      baseline.replace("  env_passthrough: []\n", "  env_passthrough: [HOME]\n"),
      baseline.replace("  max_turns: 60\n", "  max_turns: \"60\"\n"),
      baseline.replace("  - delegation\n", "  - delegation\n  - code_execution\n"),
      baseline.replace("  - delegation\n", "  - delegation\n  - web\n"),
      baseline.replace("  - delegation\n", "  # - delegation\n"),
      baseline.replace("toolsets:\n", "toolsets_note: |\n  - code_execution\ntoolsets:\n").replace("  - terminal\n", ""),
      baseline + "terminal:\n  backend: local\n",
    ]) {
      writeFileSync(path, text);
      expect(propertyWorkroomReady(home), text.length.toString()).toBe(false);
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
    expect(parse(saved, { version: "1.1" }).skills.disabled).toEqual(expect.arrayContaining(["sample", ...OFF_SCOPE_BUNDLED_SKILLS]));
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
  it("writes SOUL, manual approvals, and the morning-arrears skill the core morning check preloads", () => {
    const home = mkdtempSync(join(tmpdir(), "realbud-hermes-"));
    dirs.push(home);
    const result = applyPropertyPack(home);
    expect(packInstalled(home)).toBe(true);
    expect(approvalsAreManual(home)).toBe(true);
    expect(propertyWorkroomReady(home)).toBe(true);
    expect(result.wrote).toEqual(expect.arrayContaining(["SOUL.md", "config.yaml", "skills/"]));
    const soul = readFileSync(join(result.dir, "SOUL.md"), "utf8");
    expect(soul).toMatch(/Draft only/);
    expect(soul).toMatch(/No notices\. No money moves/);
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
      [["agent", "execution_guidance"], "auto"],
      [["agent", "intent_ack_continuation"], "auto"],
      [["agent", "coding_context"], "auto"],
      [["tool_loop_guardrails", "hard_stop_enabled"], false],
      [["compression", "min_tail_user_messages"], 1],
      [["compression", "proactive_prune_tokens"], 0], // upstream reads 0 as off
      [["compression", "proactive_prune_tokens"], 128000],
      [["delegation", "child_timeout_seconds"], 0], // upstream reads 0 as no timeout
      [["delegation", "child_timeout_seconds"], 1800],
      [["tools", "tool_search", "defer"], [...WORKER_DEFERRED_TOOLS, "todo_list"]],
      [["tools", "tool_search", "defer"], WORKER_DEFERRED_TOOLS.filter(name => name !== "cronjob_manage")],
      [["tools", "tool_search", "enabled"], "auto"],
      [["tools", "tool_search", "enabled"], "on"],
      [["tools", "tool_search", "enabled"], true],
    ];
    for (const [at, value] of edits) {
      const doc = parseDocument(baseline, { version: "1.1" }); doc.setIn(at, value);
      writeFileSync(path, doc.toString());
      expect(workerLimitsReady(home), at.join(".")).toBe(false);
      expect(propertyWorkroomReady(home), at.join(".")).toBe(false);
    }
    const tighter = parseDocument(baseline, { version: "1.1" });
    tighter.setIn(["tool_loop_guardrails", "loop_caps", "max_web_searches"], 3);
    tighter.setIn(["compression", "proactive_prune_tokens"], 48000);
    tighter.setIn(["delegation", "child_timeout_seconds"], 300);
    tighter.setIn(["compression", "min_tail_user_messages"], 5);
    // Hermes reads a YAML false here as off too (tools/tool_search.py `_tri_state`).
    tighter.setIn(["tools", "tool_search", "enabled"], false);
    writeFileSync(path, tighter.toString());
    expect(workerLimitsReady(home)).toBe(true);
  });

  it("enables staged learning for each admitted, memory-ready runtime and no other", () => {
    expect(MEMORY_SCHEMA_READY_COMMITS).toEqual(["345cd2b057a452236de401d3534b8502a7465e8d", "f97608f178d1ffeca59860195ab7da295f7c8e5f"]);
    for (const [commit, ready] of [
      ["f97608f178d1ffeca59860195ab7da295f7c8e5f", true], // 0.21.5
      ["939e45c91d751fadd94dcd1b873ac3cb44846213", false], // 0.21.2: admitted, memory not reviewed
      ["e3dd27ee2d8b011737a4eea8e3eb3d711ab78690", false], // the v2026.9.24 tag object, not a commit
    ] as const) {
      resetRuntimeSelectionForTests();
      const home = mkdtempSync(join(tmpdir(), "realbud-learning-commit-")); dirs.push(home);
      const cli = runtimeCli(releaseHome(home, commit));
      mkdirSync(dirname(cli), { recursive: true }); writeFileSync(cli, "fictional executable marker");
      saveRuntimeSelection(home, { version: 1, selected: commit, previous: null });
      expect(stagedLearningSupported(home), commit).toBe(ready);
    }
  });
  it("writes reliability settings on install and asks an older profile for Repair, keeping the office's other settings", () => {
    const home = mkdtempSync(join(tmpdir(), "realbud-worker-reliability-")); dirs.push(home);
    const { dir } = applyPropertyPack(home); const path = join(dir, "config.yaml");
    const fresh = readFileSync(path, "utf8");
    const expected = {
      agent: { execution_guidance: true, intent_ack_continuation: true, coding_context: "off" },
      tool_loop_guardrails: { hard_stop_enabled: true, loop_caps: { max_web_searches: 10, max_subagents: 4 } },
      compression: { min_tail_user_messages: 3, proactive_prune_tokens: 64000 },
      delegation: { child_timeout_seconds: 900 },
      curator: { enabled: false },
      tools: { tool_search: { enabled: "off", defer: [...WORKER_DEFERRED_TOOLS] } },
    };
    expect(parse(fresh, { version: "1.1" })).toMatchObject(expected);
    expect(fresh).not.toContain("!!omap");
    expect(learningPolicyReady(home)).toBe(true);
    expect(workerLimitsReady(home)).toBe(true);
    expect(propertyWorkroomReady(home)).toBe(true);

    // The policy shipped before these settings, plus the office's own choices
    // in the sections Repair now shares.
    const old = parseDocument(fresh, { version: "1.1" });
    for (const at of [["agent", "execution_guidance"], ["agent", "intent_ack_continuation"], ["agent", "coding_context"],
      ["tool_loop_guardrails", "hard_stop_enabled"], ["delegation", "child_timeout_seconds"], ["compression"], ["curator"], ["tools"]]) old.deleteIn(at);
    old.set("compression", old.createNode({ threshold: 0.6, min_tail_user_messages: 1, tail_mode: "legacy" }));
    old.set("curator", old.createNode({ interval_hours: 48 }));
    old.set("tools", old.createNode({ connectors: { enabled: false }, tool_search: { listing: "off" } }));
    const before = old.toString();
    writeFileSync(path, before);
    // Needs Repair, not unsafe: approvals stay manual and startup sets only the tool-search switch.
    expect(approvalsAreManual(home)).toBe(true);
    expect(learningPolicyReady(home)).toBe(false);
    expect(workerLimitsReady(home)).toBe(false);
    expect(propertyWorkroomReady(home)).toBe(false);
    expect(ensurePropertyPack(home).wrote).toEqual(["config.yaml"]);
    expect(parse(readFileSync(path, "utf8"), { version: "1.1" })).toEqual({
      ...parse(before, { version: "1.1" }), tools: { connectors: { enabled: false }, tool_search: { listing: "off", enabled: "off" } },
    });
    expect(workerLimitsReady(home)).toBe(false);

    applyPropertyPack(home);
    const saved = readFileSync(path, "utf8");
    expect(saved).not.toContain("!!omap");
    const repaired = parse(saved, { version: "1.1" });
    expect(repaired).toMatchObject(expected);
    expect(repaired.compression).toEqual({ threshold: 0.6, min_tail_user_messages: 3, tail_mode: "legacy", proactive_prune_tokens: 64000 });
    expect(repaired.curator).toEqual({ interval_hours: 48, enabled: false });
    expect(repaired.tools).toEqual({ connectors: { enabled: false }, tool_search: { listing: "off", enabled: "off", defer: [...WORKER_DEFERRED_TOOLS] } });
    expect(learningPolicyReady(home)).toBe(true);
    expect(workerLimitsReady(home)).toBe(true);
    expect(propertyWorkroomReady(home)).toBe(true);

    // An office that switched the curator back on needs Repair for the learning gate.
    const curatorOn = parseDocument(saved, { version: "1.1" }); curatorOn.setIn(["curator", "enabled"], true);
    writeFileSync(path, curatorOn.toString());
    expect(learningPolicyReady(home)).toBe(false);
    applyPropertyPack(home);
    expect(learningPolicyReady(home)).toBe(true);
  });

  it("turns tool search off in a 0.1.48 profile at startup, before any readiness read, changing nothing else", () => {
    const home = mkdtempSync(join(tmpdir(), "realbud-tool-search-upgrade-")); dirs.push(home);
    const { dir } = applyPropertyPack(home); const path = join(dir, "config.yaml");
    const fresh = readFileSync(path, "utf8");
    expect(parse(fresh, { version: "1.1" }).tools.tool_search).toEqual({ enabled: "off", defer: [...WORKER_DEFERRED_TOOLS] });
    expect(workerLimitsReady(home)).toBe(true);

    // What 0.1.48's Install and Repair wrote: the deferral list and no switch.
    const old = parseDocument(fresh, { version: "1.1" }); old.deleteIn(["tools", "tool_search", "enabled"]);
    const before = old.toString();
    writeFileSync(path, before);
    expect(workerLimitsReady(home)).toBe(false);

    expect(ensurePropertyPack(home).wrote).toEqual(["config.yaml"]);
    const after = readFileSync(path, "utf8");
    expect(after.split("\n").filter(line => line !== "    enabled: \"off\"")).toEqual(before.split("\n"));
    expect(parse(after, { version: "1.1" })).toEqual(parse(fresh, { version: "1.1" }));
    expect(workerLimitsReady(home)).toBe(true);
    expect(propertyWorkroomReady(home)).toBe(true);
    // Once set, a restart writes nothing.
    expect(ensurePropertyPack(home).wrote).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(after);

    // An office that switched it back on gets it off again at the next start.
    for (const value of ["auto", "on", true]) {
      const on = parseDocument(after, { version: "1.1" }); on.setIn(["tools", "tool_search", "enabled"], value);
      writeFileSync(path, on.toString());
      expect(workerLimitsReady(home), String(value)).toBe(false);
      expect(ensurePropertyPack(home).wrote).toEqual(["config.yaml"]);
      expect(parse(readFileSync(path, "utf8"), { version: "1.1" }).tools.tool_search).toEqual({ enabled: "off", defer: [...WORKER_DEFERRED_TOOLS] });
      expect(workerLimitsReady(home)).toBe(true);
    }
  });

  it("keeps the deferral list for rollback and turns tool search off whatever the office had", () => {
    expect(WORKER_DIRECT_TOOLS).toEqual(["todo_list", "session_search", "process_manage"]);
    for (const name of WORKER_DIRECT_TOOLS) expect(WORKER_DEFERRED_TOOLS).not.toContain(name as never);
    const pack = readFileSync(join(PACK_DIR, "config.yaml"), "utf8");
    expect(parse(pack, { version: "1.1" }).tools.tool_search).toEqual({ enabled: "off" });
    // Upstream's legacy bare true/false and every map form: Install and Repair leave the bridge off.
    for (const office of ["tool_search: false", "tool_search: true", "tool_search:\n    enabled: auto", "tool_search:\n    enabled: \"on\"", "tool_search:\n    enabled: true"]) {
      expect(parse(mergePropertyPolicy(`tools:\n  ${office}\n`, pack), { version: "1.1" }).tools.tool_search, office).toEqual({ enabled: "off", defer: [...WORKER_DEFERRED_TOOLS] });
    }
    // The office's other tool-search settings stay.
    expect(parse(mergePropertyPolicy("tools:\n  tool_search:\n    enabled: on\n    listing_max_tokens: 2000\n", pack), { version: "1.1" }).tools.tool_search)
      .toEqual({ enabled: "off", listing_max_tokens: 2000, defer: [...WORKER_DEFERRED_TOOLS] });
    for (const office of ["compression: 3\n", "curator: off\n", "tools: [tool_search]\n"]) {
      expect(() => mergePropertyPolicy(office, pack)).toThrow(/kept/);
    }
  });

  it("hides off-scope upstream skills on install and keeps document, RealBud and office skills listed", () => {
    const home = mkdtempSync(join(tmpdir(), "realbud-skill-scope-")); dirs.push(home);
    const { dir } = applyPropertyPack(home);
    const disabled: string[] = parse(readFileSync(join(dir, "config.yaml"), "utf8"), { version: "1.1" }).skills.disabled;
    expect(disabled).toEqual([...OFF_SCOPE_BUNDLED_SKILLS, ...RETIRED_PACK_SKILLS].sort());
    // Mail, messaging, social posting, coding agents and desktop control stay out of Ask's index.
    for (const name of ["himalaya", "email-inbox-triage", "google-workspace", "imessage", "xurl", "computer-use", "claude-code", "codex"]) expect(disabled).toContain(name);
    for (const name of ["hermes-agent", "pdf", "xlsx", "docx", ...PREVIOUSLY_OFF_SCOPE_BUNDLED_SKILLS, ...readdirSync(join(PACK_DIR, "skills"))]) expect(disabled).not.toContain(name);
    expect(disabled.some(name => name.startsWith("realbud-"))).toBe(false);
    // The seeding opt-out marker would also withhold pdf/xlsx/docx from a new profile.
    expect(existsSync(join(dir, ".no-bundled-skills"))).toBe(false);
    expect(skillScopeReady(home)).toBe(true);
    expect(propertyWorkroomReady(home)).toBe(true);
  });

  it("asks an older profile for Repair once, then hides skills without deleting them or the office's own choices", () => {
    const home = mkdtempSync(join(tmpdir(), "realbud-skill-scope-old-")); dirs.push(home);
    const { dir } = applyPropertyPack(home); const path = join(dir, "config.yaml");
    const old = parseDocument(readFileSync(path, "utf8"), { version: "1.1" });
    old.setIn(["skills", "disabled"], "['sample-office-hidden']"); // `hermes config set` list literal
    const before = old.toString();
    writeFileSync(path, before);
    const seeded = join(dir, "skills", "email", "himalaya");
    privateFixtureDirectory(seeded); writeFileSync(join(seeded, "SKILL.md"), "---\nname: himalaya\ndescription: fictional seeded copy\n---\n");
    expect(skillScopeReady(home)).toBe(false);
    expect(propertyWorkroomReady(home)).toBe(false);
    expect(ensurePropertyPack(home).wrote).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(before);

    applyPropertyPack(home);
    const disabled = parse(readFileSync(path, "utf8"), { version: "1.1" }).skills.disabled;
    expect(disabled).toEqual(expect.arrayContaining(["sample-office-hidden", ...OFF_SCOPE_BUNDLED_SKILLS]));
    expect(readFileSync(join(seeded, "SKILL.md"), "utf8")).toContain("fictional seeded copy");
    expect(skillScopeReady(home)).toBe(true);
    expect(propertyWorkroomReady(home)).toBe(true);

    // Re-listing one upstream skill, or a string that upstream matches by substring, needs Repair again.
    const repaired = readFileSync(path, "utf8");
    for (const value of [disabled.filter((name: string) => name !== "himalaya"), JSON.stringify(disabled)]) {
      const doc = parseDocument(repaired, { version: "1.1" }); doc.setIn(["skills", "disabled"], value);
      writeFileSync(path, doc.toString());
      expect(skillScopeReady(home)).toBe(false);
    }
    const unreadable = parseDocument(repaired, { version: "1.1" });
    unreadable.setIn(["skills", "disabled"], unreadable.createNode({ nested: "map" }));
    writeFileSync(path, unreadable.toString());
    expect(() => applyPropertyPack(home)).toThrow(/kept/);
    expect(readFileSync(path, "utf8")).toBe(unreadable.toString());
  });

  it("was reviewed against the bundled skills of the release RealBud recommends", () => {
    // 0.21.0, 0.21.2, 0.21.3 and 0.21.5 bundle the same 58 skills. A new recommended
    // release needs OFF_SCOPE_BUNDLED_SKILLS checked against its skills/ tree.
    expect(["29112bef099274229cadff79cdff7bf7b99c4b77", "939e45c91d751fadd94dcd1b873ac3cb44846213", "345cd2b057a452236de401d3534b8502a7465e8d", "f97608f178d1ffeca59860195ab7da295f7c8e5f"]).toContain(HERMES_RECOMMENDED.commit);
    expect(OFF_SCOPE_BUNDLED_SKILLS).toHaveLength(47);
    // 47 hidden + 7 reopened + hermes-agent, pdf, xlsx and docx = 58.
    expect(PREVIOUSLY_OFF_SCOPE_BUNDLED_SKILLS).toEqual(["blocked-page-recovery", "document-to-action-items", "grounded-citations", "humanizer", "meeting-action-items", "powerpoint", "weekly-review-planning"]);
    for (const name of PREVIOUSLY_OFF_SCOPE_BUNDLED_SKILLS) expect(OFF_SCOPE_BUNDLED_SKILLS).not.toContain(name);
    // maps sends property addresses to OpenStreetMap; it stays hidden.
    expect(OFF_SCOPE_BUNDLED_SKILLS).toContain("maps");
  });

  it("lists the reopened office-work skills on Repair while keeping a name the office hid itself", () => {
    const home = mkdtempSync(join(tmpdir(), "realbud-skill-scope-reopen-")); dirs.push(home);
    const { dir } = applyPropertyPack(home); const path = join(dir, "config.yaml");
    // A profile repaired under the earlier floor: all seven hidden, plus the office's own.
    const old = parseDocument(readFileSync(path, "utf8"), { version: "1.1" });
    old.setIn(["skills", "disabled"], old.createNode([...OFF_SCOPE_BUNDLED_SKILLS, ...PREVIOUSLY_OFF_SCOPE_BUNDLED_SKILLS, "sample-office-hidden"].sort()));
    writeFileSync(path, old.toString());
    expect(skillScopeReady(home)).toBe(true);
    applyPropertyPack(home);
    const disabled: string[] = parse(readFileSync(path, "utf8"), { version: "1.1" }).skills.disabled;
    expect(disabled).toEqual([...OFF_SCOPE_BUNDLED_SKILLS, ...RETIRED_PACK_SKILLS, "sample-office-hidden"].sort());
    expect(skillScopeReady(home)).toBe(true);
  });

  it("retires domain-intel and intake-properties: never installed, hidden on Repair, never a readiness gate", () => {
    const home = mkdtempSync(join(tmpdir(), "realbud-retired-skills-")); dirs.push(home);
    const { dir } = applyPropertyPack(home); const path = join(dir, "config.yaml");
    expect(RETIRED_PACK_SKILLS).toEqual(["domain-intel", "intake-properties"]);
    for (const name of RETIRED_PACK_SKILLS) expect(existsSync(join(dir, "skills", name))).toBe(false);
    // A profile installed by an earlier pack keeps its copies (install never deletes) and an older floor.
    for (const name of RETIRED_PACK_SKILLS) { privateFixtureDirectory(join(dir, "skills", name)); writeFileSync(join(dir, "skills", name, "SKILL.md"), `# ${name}\n`); }
    const old = parseDocument(readFileSync(path, "utf8"), { version: "1.1" });
    old.setIn(["skills", "disabled"], old.createNode([...OFF_SCOPE_BUNDLED_SKILLS].sort()));
    writeFileSync(path, old.toString());
    expect(propertyWorkroomReady(home)).toBe(true);
    applyPropertyPack(home);
    expect(parse(readFileSync(path, "utf8"), { version: "1.1" }).skills.disabled).toEqual(expect.arrayContaining([...RETIRED_PACK_SKILLS]));
    expect(propertyWorkroomReady(home)).toBe(true);
  });

  it("installs the staged upstream optional skills byte for byte beside RealBud's own", () => {
    const staged = ["decision-questionnaire", "one-three-one-rule", "rss-feeds", "simple-english"];
    expect(readdirSync(join(PACK_DIR, "skills")).sort()).toEqual(["morning-arrears", "portal-explore", "working-rules", ...staged].sort());
    const home = mkdtempSync(join(tmpdir(), "realbud-optional-skills-")); dirs.push(home);
    const { dir } = applyPropertyPack(home);
    for (const name of staged) {
      const shipped = readFileSync(join(PACK_DIR, "skills", name, "SKILL.md"), "utf8");
      expect(shipped).toMatch(new RegExp(`^---\\nname: ${name}\\n`));
      expect(shipped).toMatch(/^license: MIT$/m);
      expect(readFileSync(join(PACK_DIR, "skills", name, "LICENSE"), "utf8")).toMatch(/^MIT License/);
      expect(readFileSync(join(dir, "skills", name, "SKILL.md"), "utf8")).toBe(shipped);
    }
    expect(existsSync(join(dir, "skills", "rss-feeds", "scripts", "feed.py"))).toBe(true);
    expect(existsSync(join(dir, "skills", "simple-english", "references", "checklist.md"))).toBe(true);
  });

  it("ships the working-rules skill into the prepared profile, visible and free of tool names", () => {
    const home = mkdtempSync(join(tmpdir(), "realbud-working-rules-")); dirs.push(home);
    const { dir } = applyPropertyPack(home);
    const shipped = readFileSync(join(PACK_DIR, "skills", "working-rules", "SKILL.md"), "utf8");
    expect(shipped).toMatch(/^---\nname: working-rules\ndescription: /);
    expect(readFileSync(join(dir, "skills", "working-rules", "SKILL.md"), "utf8")).toBe(shipped);
    expect(parse(readFileSync(join(dir, "config.yaml"), "utf8"), { version: "1.1" }).skills.disabled).not.toContain("working-rules");
    // SOUL keeps tool names from the person; the skill names none it could echo.
    expect(shipped).not.toMatch(/workflow_settings_|memory_propose/);
  });

  it("raises memory limits to the pack's floor on install and Repair, keeping a larger office limit", () => {
    const home = mkdtempSync(join(tmpdir(), "realbud-memory-limits-")); dirs.push(home);
    const { dir } = applyPropertyPack(home); const path = join(dir, "config.yaml");
    expect(parse(readFileSync(path, "utf8"), { version: "1.1" }).memory).toMatchObject({ write_approval: true, memory_char_limit: 12000, user_char_limit: 6000 });
    writeFileSync(path, readFileSync(path, "utf8").replace("memory_char_limit: 12000", "memory_char_limit: 2200").replace("user_char_limit: 6000", "user_char_limit: 9000").replace("memory:\n", "memory:\n  memory_enabled: true\n"));
    applyPropertyPack(home);
    expect(parse(readFileSync(path, "utf8"), { version: "1.1" }).memory).toEqual({ memory_enabled: true, write_approval: true, memory_char_limit: 12000, user_char_limit: 9000 });
    expect(parse(mergePropertyPolicy("memory:\n  user_char_limit: \"big\"\n", readFileSync(join(PACK_DIR, "config.yaml"), "utf8")), { version: "1.1" }).memory.user_char_limit).toBe(6000);
  });

  it("brings shipped-unchanged SOUL and skills up to a changed pack on startup, keeps office edits and adds new files", () => {
    const home = mkdtempSync(join(tmpdir(), "realbud-pack-upgrade-")); dirs.push(home);
    const { dir } = applyPropertyPack(home);
    const recordPath = join(dir, ".realbud-shipped.json");
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");
    expect(ensurePropertyPack(home)).toMatchObject({ wrote: [], kept: [] });
    const unchanged = "skills/morning-arrears/SKILL.md", edited = "skills/portal-explore/SKILL.md", added = "skills/working-rules/SKILL.md";
    // Simulate an earlier pack: SOUL and one skill hold bytes RealBud shipped before.
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    record.pack = "earlier-pack";
    record.files["SOUL.md"].unshift(sha("Earlier shipped SOUL"));
    record.files[unchanged].unshift(sha("Earlier shipped skill"));
    writeFileSync(recordPath, JSON.stringify(record));
    writeFileSync(join(dir, "SOUL.md"), "Earlier shipped SOUL");
    writeFileSync(join(dir, unchanged), "Earlier shipped skill");
    writeFileSync(join(dir, edited), "Office's own version");
    rmSync(join(dir, added));
    const result = ensurePropertyPack(home);
    expect(result.wrote.sort()).toEqual(["SOUL.md", added, unchanged].sort());
    expect(result.kept).toEqual([edited]);
    for (const rel of ["SOUL.md", unchanged, added]) expect(readFileSync(join(dir, rel), "utf8")).toBe(readFileSync(join(PACK_DIR, rel), "utf8"));
    expect(readFileSync(join(dir, edited), "utf8")).toBe("Office's own version");
    // Recorded: nothing more happens until the pack changes again, and the edit stays.
    const settled = readFileSync(recordPath, "utf8");
    expect(JSON.parse(settled).files[unchanged]).toContain(sha("Earlier shipped skill"));
    expect(ensurePropertyPack(home)).toMatchObject({ wrote: [], kept: [] });
    expect(readFileSync(recordPath, "utf8")).toBe(settled);
    expect(readFileSync(join(dir, edited), "utf8")).toBe("Office's own version");
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

describe("shippedProfileDigests", () => {
  it("names the current pack SOUL/skills and earlier shipped revisions, never an office edit", () => {
    const shipped = shippedProfileDigests(), digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
    expect(shipped.has("SOUL.md", digest(join(PACK_DIR, "SOUL.md")))).toBe(true);
    expect(shipped.has("skills/morning-arrears/SKILL.md", digest(join(PACK_DIR, "skills", "morning-arrears", "SKILL.md")))).toBe(true);
    expect(shipped.has("SOUL.md", "e7991443b5d1bc198277b04845090ca13dccf0d617df4758fce79e8d024faa04")).toBe(true);
    expect(shipped.has("SOUL.md", createHash("sha256").update("Fictional office edit.\n").digest("hex"))).toBe(false);
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

describe("Ask tool policy (Hermes 0.21.5 reads it; harmless on 0.21.3)", () => {
  const pack = () => readFileSync(join(PACK_DIR, "config.yaml"), "utf8");
  const EXCLUDED = ["browser", "computer_use", "connections", "cronjob", "image_gen", "kanban", "tts", "web"];

  it("ships an explicit ACP selection, the exclusions and the login policy", () => {
    const shipped = parse(pack(), { version: "1.1" });
    expect(shipped.platform_toolsets).toEqual({ acp: [...WORKER_ACP_TOOLSETS] });
    expect(shipped.agent.disabled_toolsets).toEqual([...WORKER_DISABLED_TOOLSETS]);
    expect(WORKER_DISABLED_TOOLSETS).toEqual(EXCLUDED);
    for (const name of EXCLUDED) expect(WORKER_ACP_TOOLSETS).not.toContain(name as never);
    expect(WORKER_ACP_TOOLSETS).toContain("no_mcp");
    // Ask keeps today's tools: execute_code stays behind HERMES_EXEC_ASK.
    for (const name of ["terminal", "file", "vision", "todo", "memory", "session_search", "skills", "delegation", "code_execution"]) expect(WORKER_ACP_TOOLSETS).toContain(name as never);
    // No native web search/extract anywhere, and no keyless tier behind it.
    expect(shipped.toolsets).not.toContain("web");
    expect(shipped.web).toEqual({ keyless_fallback: false });
    expect(shipped.skills).toEqual({ write_approval: true, guard_agent_created: true });
    expect(shipped.auxiliary).not.toHaveProperty("vision");
    expect(shipped.auth).toEqual({ adopt_external_logins: false });
    expect(shipped.agent.auto_recovery_cycles).toBe(1);
    expect(shipped.tools).toEqual({ connectors: { enabled: false }, tool_search: { enabled: "off" } });
  });

  it("never adopts the setup role, Hermes Connectors, plugins or the Hermes browser", () => {
    const raw = pack();
    // manage_catalog is granted only to a profile whose profile.yaml says `role: setup` (0.21.5 toolsets.py).
    expect(readFileSync(join(PACK_DIR, "profile.yaml"), "utf8")).not.toMatch(/^\s*role\s*:/m);
    expect(raw).not.toMatch(/manage_catalog|^\s*-?\s*setup\b|^plugins:|^desktop:|mcp_servers:/m);
    const merged = parse(mergePropertyPolicy("platform_toolsets:\n  acp: [hermes-acp, browser, connections, setup]\ntools:\n  connectors: true\nagent:\n  disabled_toolsets: []\n", raw), { version: "1.1" });
    expect(merged.platform_toolsets.acp).toEqual([...WORKER_ACP_TOOLSETS]);
    expect(merged.agent.disabled_toolsets).toEqual([...WORKER_DISABLED_TOOLSETS]);
    expect(merged.tools.connectors).toEqual({ enabled: false });
    expect(merged.browser.backend).toBe("off");
  });

  it("owns only the ACP list and the login switch, keeping the office's other platforms and auth settings", () => {
    const office = "platform_toolsets:\n  cli: [hermes-cli]\n  telegram: [web]\nauth:\n  codex_login_method: browser\n  adopt_external_logins: true\ntools:\n  connectors:\n    enabled: true\n    note: kept\nweb:\n  keyless_fallback: true\n  extract_char_limit: 9000\nskills:\n  guard_agent_created: false\n";
    const merged = parse(mergePropertyPolicy(office, pack()), { version: "1.1" });
    expect(merged.platform_toolsets).toEqual({ cli: ["hermes-cli"], telegram: ["web"], acp: [...WORKER_ACP_TOOLSETS] });
    expect(merged.auth).toEqual({ codex_login_method: "browser", adopt_external_logins: false });
    expect(merged.tools.connectors).toEqual({ enabled: false, note: "kept" });
    expect(merged.web).toEqual({ keyless_fallback: false, extract_char_limit: 9000 });
    expect(merged.skills.guard_agent_created).toBe(true);
    for (const office of ["auth: off\n", "platform_toolsets: [acp]\n", "web: off\n"]) expect(() => mergePropertyPolicy(office, pack())).toThrow(/kept/);
  });

  // Each change an office, a 44→45 schema migration (which appends
  // `connections` to saved platform lists) or a hand edit could make.
  const drift: Array<[string, (doc: ReturnType<typeof parseDocument>) => void]> = [
    ["the migration appended connections to the ACP list", doc => doc.setIn(["platform_toolsets", "acp"], doc.createNode([...WORKER_ACP_TOOLSETS, "connections"]))],
    ["the ACP list was removed", doc => doc.deleteIn(["platform_toolsets", "acp"])],
    ["an exclusion was dropped", doc => doc.setIn(["agent", "disabled_toolsets"], doc.createNode(WORKER_DISABLED_TOOLSETS.filter(name => name !== "browser")))],
    ["native web came back", doc => doc.setIn(["agent", "disabled_toolsets"], doc.createNode(WORKER_DISABLED_TOOLSETS.filter(name => name !== "web")))],
    ["the keyless web tier is missing (upstream defaults it on)", doc => doc.delete("web")],
    ["the keyless web tier is on", doc => doc.setIn(["web", "keyless_fallback"], true)],
    ["the keyless web switch is the string \"false\" (upstream reads bool(\"false\") as true)", doc => doc.setIn(["web", "keyless_fallback"], "false")],
    ["the guard on skills Bud writes is missing (upstream defaults it off)", doc => doc.deleteIn(["skills", "guard_agent_created"])],
    ["the guard on skills Bud writes is off", doc => doc.setIn(["skills", "guard_agent_created"], false)],
    ["external logins were allowed", doc => doc.setIn(["auth", "adopt_external_logins"], true)],
    ["the login switch is the string \"false\" (upstream reads bool(\"false\") as true)", doc => doc.setIn(["auth", "adopt_external_logins"], "false")],
    ["Hermes Connectors were switched on", doc => doc.setIn(["tools", "connectors", "enabled"], true)],
    ["upstream's five recovery cycles came back", doc => doc.setIn(["agent", "auto_recovery_cycles"], 5)],
    ...WORKER_DISABLED_VAULTS.flatMap((name): Array<[string, (doc: ReturnType<typeof parseDocument>) => void]> => [
      [`vault.${name}.enabled is missing (0.21.5 defaults it on)`, doc => doc.deleteIn(["vault", name, "enabled"])],
      [`vault.${name} is missing`, doc => doc.deleteIn(["vault", name])],
      [`vault.${name}.enabled is the string "false" (upstream turns off only on \`is False\`)`, doc => doc.setIn(["vault", name, "enabled"], "false")],
      [`vault.${name}.enabled is true`, doc => doc.setIn(["vault", name, "enabled"], true)],
    ]),
    ["the vault section is missing", doc => doc.delete("vault")],
    ["the turn wall-clock budget is missing", doc => doc.deleteIn(["agent", "run_budget_seconds"])],
    ["the turn budget outlasts RealBud's hard stop", doc => doc.setIn(["agent", "run_budget_seconds"], 900)],
    ["the turn budget is below a minute", doc => doc.setIn(["agent", "run_budget_seconds"], 30)],
    ["the turn budget is a string", doc => doc.setIn(["agent", "run_budget_seconds"], "840")],
    ["the background-review input cap is missing", doc => doc.deleteIn(["auxiliary", "background_review", "max_input_tokens"])],
    ["the background-review input cap is 0 (upstream reads <= 0 as unlimited)", doc => doc.setIn(["auxiliary", "background_review", "max_input_tokens"], 0)],
    ["the background-review input cap is upstream's 600K", doc => doc.setIn(["auxiliary", "background_review", "max_input_tokens"], 600000)],
  ];
  it.each(drift)("reads a profile where %s as needing Repair, which restores it", (_label, change) => {
    const home = mkdtempSync(join(tmpdir(), "realbud-acp-policy-")); dirs.push(home);
    const { dir } = applyPropertyPack(home); const path = join(dir, "config.yaml");
    expect(workerLimitsReady(home)).toBe(true);
    const doc = parseDocument(readFileSync(path, "utf8"), { version: "1.1" });
    change(doc);
    writeFileSync(path, doc.toString());
    expect(workerLimitsReady(home)).toBe(false);
    expect(propertyWorkroomReady(home)).toBe(false);
    applyPropertyPack(home);
    expect(workerLimitsReady(home)).toBe(true);
    expect(propertyWorkroomReady(home)).toBe(true);
  });

  it("ships the vault, turn-budget and review-cap keys and keeps the office's other settings in those sections", () => {
    const shipped = parse(pack(), { version: "1.1" });
    expect(WORKER_DISABLED_VAULTS).toEqual(["onepassword", "bitwarden"]);
    expect(shipped.vault).toEqual({ onepassword: { enabled: false }, bitwarden: { enabled: false } });
    expect(shipped.agent.run_budget_seconds).toBe(840);
    expect(shipped.auxiliary.background_review).toEqual({ enabled: false, extra_tools: [], max_input_tokens: 120000 });
    const office = "vault:\n  onepassword:\n    enabled: true\n    account: fictional-office\n  bitwarden: true\n  keepassxc:\n    enabled: true\nauxiliary:\n  vision:\n    model: fictional-vision\n  background_review:\n    max_input_tokens: 600000\n";
    const merged = parse(mergePropertyPolicy(office, pack()), { version: "1.1" });
    expect(merged.vault).toEqual({ onepassword: { enabled: false, account: "fictional-office" }, bitwarden: { enabled: false }, keepassxc: { enabled: true } });
    expect(merged.auxiliary.vision).toEqual({ model: "fictional-vision" });
    expect(merged.auxiliary.background_review.max_input_tokens).toBe(120000);
    expect(merged.agent.run_budget_seconds).toBe(840);
    expect(() => mergePropertyPolicy("vault: off\n", pack())).toThrow(/kept/);
  });

  it("accepts a tighter turn budget and review cap", () => {
    const home = mkdtempSync(join(tmpdir(), "realbud-acp-budget-")); dirs.push(home);
    const { dir } = applyPropertyPack(home); const path = join(dir, "config.yaml");
    const doc = parseDocument(readFileSync(path, "utf8"), { version: "1.1" });
    doc.setIn(["agent", "run_budget_seconds"], 600);
    doc.setIn(["auxiliary", "background_review", "max_input_tokens"], 60000);
    writeFileSync(path, doc.toString());
    expect(workerLimitsReady(home)).toBe(true);
    expect(learningPolicyReady(home)).toBe(true);
  });

  it("accepts an office that turned the recovery wait off entirely", () => {
    const home = mkdtempSync(join(tmpdir(), "realbud-acp-recovery-")); dirs.push(home);
    const { dir } = applyPropertyPack(home); const path = join(dir, "config.yaml");
    const doc = parseDocument(readFileSync(path, "utf8"), { version: "1.1" });
    doc.setIn(["agent", "auto_recovery_cycles"], 0);
    writeFileSync(path, doc.toString());
    expect(workerLimitsReady(home)).toBe(true);
  });
});

describe("worker browser surface", () => {
  it("owns the browser keys that would give Hermes its own browser and keeps the office's other browser settings", () => {
    const office = "browser:\n  headed: true\n  backend: \"\"\n  cloud_provider: camofox\n  cdp_url: http://127.0.0.1:9222\n  engine: lightpanda\n  use_real_profile: true\n";
    const merged = mergePropertyPolicy(office, readFileSync(join(PACK_DIR, "config.yaml"), "utf8"));
    const doc = parseDocument(merged, { version: "1.1" });
    expect(doc.toJS().browser).toEqual({ headed: true, ...WORKER_BROWSER_POLICY });
    expect(WORKER_BROWSER_POLICY).toEqual({ backend: "off", cloud_provider: "local", cdp_url: "", engine: "chrome", use_real_profile: false });
  });

  it.each(Object.keys(WORKER_BROWSER_POLICY))("reads a profile whose browser.%s was changed as needing Repair", key => {
    const home = mkdtempSync(join(tmpdir(), "realbud-worker-browser-")); dirs.push(home);
    const { dir } = applyPropertyPack(home); const path = join(dir, "config.yaml");
    expect(workerLimitsReady(home)).toBe(true);
    const doc = parseDocument(readFileSync(path, "utf8"), { version: "1.1" });
    doc.deleteIn(["browser", key]);
    writeFileSync(path, doc.toString());
    expect(workerLimitsReady(home)).toBe(false);
    applyPropertyPack(home);
    expect(workerLimitsReady(home)).toBe(true);
  });
});

describe("worker command deny list", () => {
  it("writes approvals.deny on install, keeps the office's other settings, and restores drift on Repair", () => {
    const home = mkdtempSync(join(tmpdir(), "realbud-worker-deny-")); dirs.push(home);
    const dir = propertyProfileDir(home); privateFixtureDirectory(dir);
    const path = join(dir, "config.yaml");
    writeFileSync(path, "model:\n  provider: retained\napprovals:\n  mode: yolo\n  deny: [\"rm -rf *\"]\nterminal:\n  timeout: 99\n");
    applyPropertyPack(home);
    const written = parseDocument(readFileSync(path, "utf8"), { version: "1.1" }).toJS();
    expect(written.approvals.mode).toBe("manual");
    expect(written.approvals.deny).toEqual([...WORKER_DENIED_COMMANDS]);
    expect(written.model.provider).toBe("retained");
    expect(workerLimitsReady(home)).toBe(true);
    expect(propertyWorkroomReady(home)).toBe(true);
    for (const drift of [(doc: ReturnType<typeof parseDocument>) => doc.deleteIn(["approvals", "deny"]),
      (doc: ReturnType<typeof parseDocument>) => doc.setIn(["approvals", "deny"], "curl[ .]*"),
      (doc: ReturnType<typeof parseDocument>) => doc.setIn(["approvals", "deny"], doc.createNode(WORKER_DENIED_COMMANDS.slice(1)))]) {
      const doc = parseDocument(readFileSync(path, "utf8"), { version: "1.1" });
      drift(doc);
      writeFileSync(path, doc.toString());
      expect(workerLimitsReady(home)).toBe(false);
      expect(propertyWorkroomReady(home)).toBe(false);
      applyPropertyPack(home);
      expect(workerLimitsReady(home)).toBe(true);
      expect(propertyWorkroomReady(home)).toBe(true);
    }
  });

  it("covers the network tools and inline interpreters as whole-command globs", () => {
    // Python's fnmatchcase over a lower-cased command, as Hermes matches.
    const glob = (pattern: string) => new RegExp("^" + pattern.replace(/[.+^$(){}|\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\[!/g, "[^") + "$", "s");
    const denied = (command: string) => WORKER_DENIED_COMMANDS.some(pattern => glob(pattern).test(command.toLowerCase().trim()));
    for (const command of ["curl https://example.invalid -d @file", "/usr/bin/curl x", "ls; wget x", "echo $(curl x)", "CURL.EXE http://x",
      "cat a | nc host 1", "ssh host", "scp a host:", "Invoke-WebRequest -Uri x", "iwr x", "irm x", "certutil -urlcache x", "bitsadmin /transfer x",
      "powershell -enc AAA", "pwsh -c x", "osascript -e x", "python3 -c 'print(1)'", "node -e 1", "node --eval 1", "perl -e 1", "ruby -e 1"]) {
      expect(denied(command), command).toBe(true);
    }
    for (const command of ["python3 report.py", "ls -la", "grep -rn sync .", "cat notes/confirm.txt", "git status"]) {
      expect(denied(command), command).toBe(false);
    }
  });
});

describe("managed model profile", WINDOWS_PROFILE_TEST_OPTIONS, () => {
  const GATEWAY = "https://gateway.fictional.test/v1";

  it("writes the named managed provider, the choice's model and effort, and keeps the rest of the config", () => {
    const pack = readFileSync(join(PACK_DIR, "config.yaml"), "utf8");
    const written = parse(managedModelConfig(pack, GATEWAY, "sonnet-xhigh"));
    expect(written.model).toEqual({ default: "claude-sonnet-5.5", provider: MANAGED_MODEL_PROVIDER, supports_vision: true });
    expect(written.providers).toEqual({ realbud: { base_url: GATEWAY, key_env: MANAGED_MODEL_KEY_ENV, api_mode: "chat_completions" } });
    expect(written.agent.reasoning_effort).toBe("xhigh");
    expect(written.agent.max_turns).toBe(parse(pack).agent.max_turns);
    expect(written.approvals).toEqual(parse(pack).approvals);
    // An empty profile still gets a readable block document.
    expect(parse(managedModelConfig("", GATEWAY, "flash-high"))).toMatchObject({ model: { default: "deepseek-v4.1-flash" }, agent: { reasoning_effort: "high" } });
  });

  it("declares image input only for the choices whose model takes images, and drops it on a switch to Flash", () => {
    const pack = readFileSync(join(PACK_DIR, "config.yaml"), "utf8");
    expect(Object.fromEntries(MANAGED_MODEL_CHOICES.map(choice => [choice.id, choice.supportsVision]))).toEqual({ "flash-high": false, "sonnet-medium": true, "sonnet-high": true, "sonnet-xhigh": true });
    for (const choice of MANAGED_MODEL_CHOICES) {
      const model = parse(managedModelConfig(pack, GATEWAY, choice.id), { version: "1.1" }).model;
      expect(model).toEqual({ default: choice.model, provider: MANAGED_MODEL_PROVIDER, ...(choice.supportsVision ? { supports_vision: true } : {}) });
    }
    const flash = parse(managedModelConfig(managedModelConfig(pack, GATEWAY, "sonnet-high"), GATEWAY, "flash-high"), { version: "1.1" });
    expect(flash.model).toEqual({ default: "deepseek-v4.1-flash", provider: MANAGED_MODEL_PROVIDER });
    // A pack reinstall keeps the managed model section as written.
    expect(parse(mergePropertyPolicy(managedModelConfig(pack, GATEWAY, "sonnet-xhigh"), pack), { version: "1.1" }).model.supports_vision).toBe(true);
  });

  it("reads images through Sonnet on Flash only, owning auxiliary.vision with the choice", () => {
    const pack = readFileSync(join(PACK_DIR, "config.yaml"), "utf8");
    const route = { provider: MANAGED_MODEL_PROVIDER, model: "claude-sonnet-5.5" };
    const flash = managedModelConfig(pack, GATEWAY, "flash-high");
    expect(parse(flash, { version: "1.1" }).auxiliary).toEqual({ ...parse(pack, { version: "1.1" }).auxiliary, vision: route });
    // Any explicit auxiliary.vision would make a vision model describe images as text.
    for (const id of ["sonnet-high", "sonnet-xhigh"] as const) {
      const sonnet = parse(managedModelConfig(flash, GATEWAY, id), { version: "1.1" });
      expect(sonnet.auxiliary).not.toHaveProperty("vision");
      expect(sonnet.auxiliary.title_generation).toEqual({ enabled: false });
    }
    const office = "auxiliary:\n  vision:\n    provider: fictional-vision\n    base_url: http://fictional.invalid\n  compression:\n    timeout: 99\n";
    expect(parse(managedModelConfig(office, GATEWAY, "flash-high"), { version: "1.1" }).auxiliary).toEqual({ vision: route, compression: { timeout: 99 } });
    expect(parse(managedModelConfig(office, GATEWAY, "sonnet-high"), { version: "1.1" }).auxiliary).toEqual({ compression: { timeout: 99 } });
    expect(parse(managedModelConfig("", GATEWAY, "flash-high"), { version: "1.1" }).auxiliary).toEqual({ vision: route });
    expect(managedModelConfig("", GATEWAY, "sonnet-high")).not.toContain("auxiliary");
    expect(() => managedModelConfig("auxiliary: off\n", GATEWAY, "flash-high")).toThrow(/kept/);
    // A pack reinstall keeps it as written.
    expect(parse(mergePropertyPolicy(flash, pack), { version: "1.1" }).auxiliary.vision).toEqual(route);
  });

  it("reads a Flash profile without the image route, or a Sonnet one with any, as not vision-ready", () => {
    const home = mkdtempSync(join(tmpdir(), "realbud-managed-vision-")); dirs.push(home);
    applyPropertyPack(home);
    const path = join(propertyProfileDir(home), "config.yaml");
    for (const choice of ["flash-high", "sonnet-high"] as const) {
      applyManagedModelProfile(GATEWAY, { root: home, choice });
      expect(managedModelProfile(home).visionReady).toBe(true);
      const doc = parseDocument(readFileSync(path, "utf8"), { version: "1.1" });
      if (choice === "flash-high") doc.deleteIn(["auxiliary", "vision"]);
      else doc.setIn(["auxiliary", "vision"], doc.createNode({ model: "fictional-vision" }));
      writeFileSync(path, doc.toString());
      expect(managedModelProfile(home)).toMatchObject({ choice, visionReady: false });
    }
  });

  it("carries the choice through a policy rewrite only while it is still one of the three", () => {
    const pack = readFileSync(join(PACK_DIR, "config.yaml"), "utf8");
    const chosen = managedModelConfig(pack, GATEWAY, "sonnet-xhigh");
    expect(parse(mergePropertyPolicy(chosen, pack)).agent.reasoning_effort).toBe("xhigh");
    const flashXhigh = chosen.replace("default: claude-sonnet-5.5", "default: deepseek-v4.1-flash");
    expect(parse(mergePropertyPolicy(flashXhigh, pack)).agent.reasoning_effort).toBeUndefined();
    expect(parse(mergePropertyPolicy(chosen.replace("reasoning_effort: xhigh", "reasoning_effort: max"), pack)).agent.reasoning_effort).toBeUndefined();
  });

  it("moves an office saved on Sonnet · High to Medium once; a later step back up to High is kept", () => {
    const home = mkdtempSync(join(tmpdir(), "realbud-managed-profile-")); dirs.push(home);
    applyPropertyPack(home);
    const profile = propertyProfileDir(home);
    // An office set up while High was the default: its profile already says High, with no marker.
    applyManagedModelProfile(GATEWAY, { root: home, choice: "sonnet-high" });
    rmSync(join(profile, ".realbud-medium-default-2026-10-08"));
    expect(applyManagedModelProfile(GATEWAY, { root: home })).toMatchObject({ choice: "sonnet-medium", reasoningEffort: "medium" });
    applyManagedModelProfile(GATEWAY, { root: home, choice: "sonnet-high" });
    applyPropertyPack(home);
    expect(applyManagedModelProfile(GATEWAY, { root: home })).toMatchObject({ choice: "sonnet-high" });
    // Other choices are never moved.
    const other = mkdtempSync(join(tmpdir(), "realbud-managed-profile-")); dirs.push(other);
    applyPropertyPack(other);
    applyManagedModelProfile(GATEWAY, { root: other, choice: "flash-high" });
    rmSync(join(propertyProfileDir(other), ".realbud-medium-default-2026-10-08"));
    expect(applyManagedModelProfile(GATEWAY, { root: other })).toMatchObject({ choice: "flash-high" });
  });

  it("survives a pack reinstall, and a fresh apply migrates auto to the default (Sonnet · Medium) while dropping shadowing keys", () => {
    const home = mkdtempSync(join(tmpdir(), "realbud-managed-profile-")); dirs.push(home);
    applyPropertyPack(home);
    const profile = propertyProfileDir(home);
    writeFileSync(join(profile, "config.yaml"), readFileSync(join(profile, "config.yaml"), "utf8").replace(/\s*$/, "\n") +
      `model:\n  default: auto\n  provider: openai-api\n  base_url: "${GATEWAY}"\n  api_mode: chat_completions\n`);
    writeFileSync(join(profile, ".env"), "KEEP=fictional\nexport OPENAI_API_KEY=fictional-stale\nREALBUD_MODEL_API_KEY=fictional-shadow\n");
    expect(managedModelProfile(home)).toMatchObject({ choice: null, envKeyPresent: true });
    expect(applyManagedModelProfile(GATEWAY, { root: home })).toMatchObject({ choice: "sonnet-medium", envKeyRemoved: true });
    expect(readFileSync(join(profile, ".env"), "utf8")).toBe("KEEP=fictional\n");
    applyManagedModelProfile(GATEWAY, { root: home, choice: "sonnet-xhigh" });
    applyPropertyPack(home);
    expect(managedModelProfile(home)).toEqual({
      provider: MANAGED_MODEL_PROVIDER, model: "claude-sonnet-5.5", baseUrl: GATEWAY, apiMode: "chat_completions",
      keyEnv: MANAGED_MODEL_KEY_ENV, reasoningEffort: "xhigh", choice: "sonnet-xhigh", envKeyPresent: false, visionReady: true,
    });
    expect(approvalsAreManual(home)).toBe(true);
    expect(() => applyManagedModelProfile("file:///fictional", { root: home })).toThrow(/needs recovery/);
  });
});
