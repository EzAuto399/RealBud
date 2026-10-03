/** Hermes 0.21.5's own config migrations (hermes_cli/config.py `migrate_config`,
 * hermes_cli/config_migrations.py steps 45 and 46) run on property profiles that
 * RealBud's `applyPropertyPack` wrote, then RealBud's Repair, then a rollback
 * read by 0.21.3. Only fictional profiles in private temp dirs.
 *
 *   REALBUD_TEST_HERMES_0215_TREE  hermes-agent at v2026.9.24 (f97608f1)
 *   REALBUD_TEST_HERMES_PYTHON     python that imports it (pyyaml and Hermes' deps)
 *   REALBUD_TEST_HERMES_0213_TREE  optional: hermes-agent at v2026.9.14 (345cd2b0), for rollback
 * A skipped run is not evidence. */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

import { applyPropertyPack, approvalsAreManual, propertyProfileDir, propertyWorkroomReady } from "./hermes-pack.ts";

const python = process.env.REALBUD_TEST_HERMES_PYTHON;
const candidate = process.env.REALBUD_TEST_HERMES_0215_TREE;
const current = process.env.REALBUD_TEST_HERMES_0213_TREE;

const SCRIPT = String.raw`
import json, logging, os, sys
mode, tree = sys.argv[1], sys.argv[2]
sys.path.insert(0, tree); os.chdir(tree)
logging.disable(logging.CRITICAL)
from hermes_cli.config import check_config_version, load_config, migrate_config
out = {"before": list(check_config_version())}
if mode == "migrate":
    results = migrate_config(interactive=False, quiet=True)
    out["added"] = results["config_added"]; out["warnings"] = results["warnings"]
    out["after"] = list(check_config_version())
config = load_config()
out["effective"] = {
    "model": (config.get("model") or {}).get("default"),
    "effort": (config.get("agent") or {}).get("reasoning_effort"),
    "memory_char_limit": (config.get("memory") or {}).get("memory_char_limit"),
    "skills_disabled": (config.get("skills") or {}).get("disabled"),
    "mcp": (config.get("mcp_servers") or {}).get("fictional-office"),
    "platform_toolsets": config.get("platform_toolsets"),
    "disabled_toolsets": (config.get("agent") or {}).get("disabled_toolsets"),
    "approvals": (config.get("approvals") or {}).get("mode"),
}
if mode == "probe":
    from model_tools import get_tool_definitions
    from acp_adapter import session as acp_session
    from agent.skill_utils import parse_config_string_list
    from hermes_cli.tools_config import _get_platform_tools, enabled_mcp_server_names
    resolved = _get_platform_tools(config, "acp")
    mcp = resolved & enabled_mcp_server_names(config)
    enabled = acp_session._expand_acp_enabled_toolsets(sorted(resolved - mcp), sorted(mcp))
    disabled = parse_config_string_list((config.get("agent") or {}).get("disabled_toolsets")) or None
    out["enabled"] = enabled
    out["parent"] = sorted(t["function"]["name"] for t in get_tool_definitions(
        enabled_toolsets=enabled, disabled_toolsets=disabled, quiet_mode=True, skip_tool_search_assembly=True))
print("RESULT " + json.dumps(out))
`;

type Result = { before: [number, number]; after?: [number, number]; added?: string[]; warnings?: string[]; enabled?: string[]; parent?: string[];
  effective: { model: unknown; effort: unknown; memory_char_limit: unknown; skills_disabled: unknown; mcp: Record<string, unknown> | null;
    platform_toolsets: Record<string, string[]> | null; disabled_toolsets: unknown; approvals: unknown } };

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "realbud-hermes-migration-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function hermes(mode: "migrate" | "read" | "probe", tree: string, root: string): Result {
  const env = { PATH: "/usr/bin:/bin", HOME: join(root, "user"), HERMES_HOME: propertyProfileDir(root), PYTHONDONTWRITEBYTECODE: "1" };
  const stdout = execFileSync(python!, ["-c", SCRIPT, mode, tree], { env, encoding: "utf8", timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
  const line = stdout.split("\n").find(text => text.startsWith("RESULT "));
  if (!line) throw new Error("hermes printed no result");
  return JSON.parse(line.slice(7)) as Result;
}

/** An office's own settings, then Install. `legacy` strips what only the
 * 0.21.5-era pack owns (agent.disabled_toolsets, platform_toolsets.acp) and
 * leaves an ACP list an office saved through `hermes tools` in the 0.21.3 era. */
let seq = 0;
function profile(stamp: number | null, legacy: boolean): { root: string; config: string } {
  const root = join(scratch, `p${seq++}`); mkdirSync(join(root, "user"), { recursive: true });
  const config = join(propertyProfileDir(root), "config.yaml");
  mkdirSync(propertyProfileDir(root), { recursive: true });
  writeFileSync(config, [
    "model:", "  default: claude-sonnet-5.5", "agent:", "  reasoning_effort: xhigh",
    "memory:", "  memory_char_limit: 3100", "skills:", "  disabled: [fictional-office-skill]",
    "mcp_servers:", "  fictional-office:", "    command: /synthetic/bin/false", "    disabled: true",
    "platform_toolsets:", "  cli: [web, terminal, file]", "",
  ].join("\n"));
  applyPropertyPack(root);
  const doc = parseDocument(readFileSync(config, "utf8"), { version: "1.1" });
  if (legacy) {
    doc.deleteIn(["agent", "disabled_toolsets"]);
    doc.setIn(["platform_toolsets", "acp"], doc.createNode(["web", "terminal", "file", "browser"]));
  }
  if (stamp !== null) doc.set("_config_version", stamp);
  writeFileSync(config, doc.toString());
  return { root, config };
}

const today = ["delegate_task", "execute_code", "memory", "patch", "process_manage", "read_file", "search_files", "session_search",
  "skill_manage", "skill_view", "skills_list", "terminal", "todo_list", "web_extract", "web_search", "write_file"];

function officeKept(result: Result) {
  expect(result.effective.model).toBe("claude-sonnet-5.5");
  expect(result.effective.effort).toBe("xhigh");
  expect(result.effective.memory_char_limit).toBe(3100);
  expect(result.effective.skills_disabled).toContain("fictional-office-skill");
  expect(result.effective.mcp).toMatchObject({ command: "/synthetic/bin/false", enabled: false });
  expect(result.effective.mcp).not.toHaveProperty("disabled");
  expect(result.effective.platform_toolsets?.cli).toEqual(expect.arrayContaining(["web", "terminal", "file"]));
  expect(result.effective.approvals).toBe("manual");
}

function askTools(root: string) {
  const probed = hermes("probe", candidate!, root);
  expect(probed.enabled).not.toContain("connections");
  expect(probed.enabled).not.toContain("browser");
  expect(probed.enabled!.some(name => name.startsWith("mcp-"))).toBe(false);
  expect(probed.parent).toEqual(today);
}

describe.runIf(Boolean(python && candidate) && process.platform !== "win32")("Hermes 0.21.5 config migrations on RealBud profiles", () => {
  describe.each([
    { label: "unstamped", stamp: null, from: 0, unversioned: true },
    { label: "stamped at 44", stamp: 44, from: 44, unversioned: false },
  ])("today's pack, $label", ({ stamp, from }) => {
    let p: ReturnType<typeof profile>, migrated: Result;
    beforeAll(() => { p = profile(stamp, false); });
    it("migrates to 46 without adding connections; 46 turns the office's disabled MCP server off", () => {
      expect(propertyWorkroomReady(p.root)).toBe(true);
      migrated = hermes("migrate", candidate!, p.root);
      expect(migrated.before).toEqual([from, 46]);
      expect(migrated.after).toEqual([46, 46]);
      // Advisory only: the resolver honours `no_mcp` (hermes_cli/tools_config.py
      // `_get_platform_tools`), but `validate_platform_toolsets` does not know it.
      expect(migrated.warnings).toEqual(["platform 'acp' references unknown toolset 'no_mcp' — did you mean 'hermes-acp'?"]);
      expect(migrated.added!.filter(line => /connections/.test(line))).toEqual([]);
      expect(migrated.effective.platform_toolsets).toEqual({ cli: ["web", "terminal", "file"],
        acp: ["web", "terminal", "file", "vision", "todo", "memory", "session_search", "skills", "delegation", "code_execution", "no_mcp"] });
      officeKept(migrated);
    }, 240_000);
    it("stays workroom-ready with no Repair, and Ask's tools are unchanged", () => {
      expect(propertyWorkroomReady(p.root)).toBe(true);
      expect(approvalsAreManual(p.root)).toBe(true);
      askTools(p.root);
    }, 240_000);
    it("Repair keeps the stamp, the migrated MCP choice and the office's settings", () => {
      const before = readFileSync(p.config, "utf8");
      applyPropertyPack(p.root);
      expect(propertyWorkroomReady(p.root)).toBe(true);
      expect(parseDocument(readFileSync(p.config, "utf8")).get("_config_version")).toBe(46);
      const read = hermes("read", candidate!, p.root);
      expect(read.before).toEqual([46, 46]);
      officeKept(read);
      expect(readFileSync(p.config, "utf8").length).toBeGreaterThan(before.length / 2);
    }, 240_000);
    it.runIf(Boolean(current))("0.21.3 reads the migrated profile and does not rewrite or refuse version 46", () => {
      const bytes = readFileSync(p.config);
      const older = hermes("migrate", current!, p.root);
      expect(older.before).toEqual([46, 44]);
      expect(older.after).toEqual([46, 44]);
      expect(readFileSync(p.config)).toEqual(bytes);
      officeKept(older);
      expect(propertyWorkroomReady(p.root)).toBe(true);
    }, 240_000);
  });

  describe.each([
    { label: "unstamped", stamp: null, from: 0, appended: false },
    { label: "stamped at 44", stamp: 44, from: 44, appended: true },
  ])("0.21.3-era pack (no disabled_toolsets, office-saved ACP list), $label", ({ stamp, from, appended }) => {
    let p: ReturnType<typeof profile>;
    beforeAll(() => { p = profile(stamp, true); });
    it("45 appends connections only to a stamped profile; Repair takes ACP back and Ask gets no connector", () => {
      expect(propertyWorkroomReady(p.root)).toBe(false);
      const migrated = hermes("migrate", candidate!, p.root);
      expect(migrated.before).toEqual([from, 46]);
      expect(migrated.after).toEqual([46, 46]);
      const lists = migrated.effective.platform_toolsets!;
      expect(lists.acp.includes("connections")).toBe(appended);
      expect(lists.cli.includes("connections")).toBe(appended);
      officeKept(migrated);
      expect(propertyWorkroomReady(p.root)).toBe(false);
      applyPropertyPack(p.root);
      expect(propertyWorkroomReady(p.root)).toBe(true);
      const repaired = hermes("read", candidate!, p.root);
      expect(repaired.effective.disabled_toolsets).toContain("connections");
      expect(repaired.effective.platform_toolsets!.acp).not.toContain("connections");
      officeKept(repaired);
      askTools(p.root);
    }, 240_000);
  });
});
