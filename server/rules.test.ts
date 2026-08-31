// Standing-rule decisions. Guards stay in front of any saved allow, and a
// junk file on disk must never take the desk down.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const dataDir = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMPDIR || process.cwd();
  const dir = `${base}/realbud-rules-${process.pid}-${Date.now().toString(36)}`;
  process.env.REALBUD_DATA_DIR = dir;
  return dir;
});

const { addRule, evaluateRules, loadRules, removeRule, ruleLabel } = await import("./rules.ts");
const { join } = await import("node:path");

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  mkdirSync(dataDir, { recursive: true });
  rmSync(join(dataDir, "rules.json"), { force: true });
});

describe("ruleLabel", () => {
  it("derives a PM-facing label from the approval key", () => {
    expect(ruleLabel("Bash:git")).toBe("Run git commands");
    expect(ruleLabel("Read")).toBe("Read workroom files");
    expect(ruleLabel("Write")).toBe("Change workroom files");
    expect(ruleLabel("Edit")).toBe("Change workroom files");
    expect(ruleLabel("WebSearch")).toBe("Allow WebSearch");
  });
});

describe("evaluateRules", () => {
  it("lets guards beat a matching allow rule", () => {
    const allowRm = [{ id: "1", key: "Bash:rm", decision: "allow" as const, label: "Run rm commands", createdAt: 1 }];
    expect(evaluateRules(allowRm, "Bash", "rm -rf /tmp/work")).toBeNull();

    const allowRead = [{ id: "2", key: "Read", decision: "allow" as const, label: "Read workroom files", createdAt: 1 }];
    expect(evaluateRules(allowRead, "Read", "cat .env")).toBeNull();
  });

  it("allows an exact key match", () => {
    const rules = [{ id: "1", key: "Bash:git", decision: "allow" as const, label: "Run git commands", createdAt: 1 }];
    expect(evaluateRules(rules, "Bash", "git status --short")).toBe("allow");
    expect(evaluateRules(rules, "Bash", "npm test")).toBeNull();
  });

  it("denies an exact key match", () => {
    const rules = [{ id: "1", key: "Read", decision: "deny" as const, label: "Read workroom files", createdAt: 1 }];
    expect(evaluateRules(rules, "Read", "src/index.ts")).toBe("deny");
  });
});

describe("addRule / loadRules", () => {
  it("replaces a rule for the same key", () => {
    const first = addRule("Read", "allow");
    expect(first).toHaveLength(1);
    expect(first[0].label).toBe("Read workroom files");

    const second = addRule("Read", "deny", "Hold file reads");
    expect(second).toHaveLength(1);
    expect(second[0].decision).toBe("deny");
    expect(second[0].label).toBe("Hold file reads");
    expect(second[0].id).not.toBe(first[0].id);
    expect(loadRules()).toEqual(second);
  });

  it("skips junk on disk and never throws", () => {
    writeFileSync(join(dataDir, "rules.json"), "{not json");
    expect(loadRules()).toEqual([]);

    writeFileSync(
      join(dataDir, "rules.json"),
      JSON.stringify([
        { id: 1, key: "Read" },
        null,
        "x",
        { id: "ok", key: "Bash:git", decision: "allow", label: "Run git commands", createdAt: 12 },
        { id: "", key: "Write", decision: "allow", label: "Change workroom files", createdAt: 1 },
      ]),
    );
    expect(loadRules()).toEqual([
      { id: "ok", key: "Bash:git", decision: "allow", label: "Run git commands", createdAt: 12 },
    ]);
  });

  it("removes by id", () => {
    const [rule] = addRule("Edit", "allow");
    expect(removeRule(rule.id)).toEqual([]);
    expect(() => removeRule(rule.id)).toThrow(/no such rule/);
  });
});
