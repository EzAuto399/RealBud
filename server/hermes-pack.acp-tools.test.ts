/** Ask's effective tools under the pack policy, enumerated by Hermes' own
 * toolset resolution (0.21.5: acp_adapter/session.py `_make_agent` →
 * hermes_cli/tools_config.py `_get_platform_tools`; children:
 * tools/delegate_tool_toolsets.py `_resolve_child_toolsets`), with a browser
 * CLI and Chromium on PATH, ambient browser/connector/model credentials, a
 * configured MCP server and an office that asked for browser and connectors.
 *
 * Needs source trees and a Python that can import them, so it runs only when
 * pointed at them (never the real ~/.realbud by default):
 *   REALBUD_TEST_HERMES_PYTHON     python with Hermes' dependencies
 *   REALBUD_TEST_HERMES_0215_TREE  hermes-agent at v2026.9.24 (f97608f1)
 *   REALBUD_TEST_HERMES_0213_TREE  optional: hermes-agent at v2026.9.14 (345cd2b0)
 * A skipped run is not evidence. */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { mergePropertyPolicy, PACK_DIR, WORKER_DISABLED_TOOLSETS } from "./hermes-pack.ts";
import { BROWSER_SERVER } from "./browser-broker.ts";
import { SIGN_IN_SERVER } from "./browser-sign-in.ts";
import { WEB_RESEARCH_SERVER } from "./web-research-broker.ts";
import { REMINDERS_SERVER } from "./reminders-broker.ts";
import { BANK_SOURCE_SERVER } from "./bank-source-broker.ts";
import { WORKFLOW_SETTINGS_SERVER } from "./workflow-settings-broker.ts";
import { MCP_CONNECTORS_SERVER } from "./mcp-connector-broker.ts";
import { WORKSPACE_VIEWS_SERVER } from "./workspace-views-broker.ts";
import { HERMIOS_CRM_SERVER } from "./hermios-crm-broker.ts";

const python = process.env.REALBUD_TEST_HERMES_PYTHON;
const candidate = process.env.REALBUD_TEST_HERMES_0215_TREE;
const current = process.env.REALBUD_TEST_HERMES_0213_TREE;

const PROBE = String.raw`
import inspect, json, logging, os, sys
tree = sys.argv[1]
sys.path.insert(0, tree); os.chdir(tree)
logging.disable(logging.CRITICAL)
from hermes_cli.config import load_config
from model_tools import get_tool_definitions
from acp_adapter import session as acp_session
from agent.skill_utils import parse_config_string_list
from tools.registry import registry
from tools.delegate_tool_toolsets import _resolve_child_toolsets
config = load_config()
names = lambda enabled, disabled: sorted(t["function"]["name"] for t in get_tool_definitions(
    enabled_toolsets=enabled, disabled_toolsets=disabled, quiet_mode=True, skip_tool_search_assembly=True))
if "enabled_toolsets is None" in inspect.getsource(acp_session.SessionManager._make_agent):
    from hermes_cli.tools_config import _get_platform_tools, enabled_mcp_server_names
    resolved = _get_platform_tools(config, "acp")
    mcp = resolved & enabled_mcp_server_names(config)
    enabled = acp_session._expand_acp_enabled_toolsets(sorted(resolved - mcp), sorted(mcp))
    disabled = parse_config_string_list((config.get("agent") or {}).get("disabled_toolsets")) or None
else:
    configured = [n for n, c in (config.get("mcp_servers") or {}).items() if not isinstance(c, dict) or c.get("enabled", True) is not False]
    enabled = acp_session._expand_acp_enabled_toolsets(["hermes-acp"], mcp_server_names=configured)
    disabled = None
out = {"enabled": enabled, "parent": names(enabled, disabled)}
# RealBud's brokers join per session over ACP mcpServers (acp_adapter/server.py
# _register_session_mcp_servers); register one tool each as discovery would,
# including the bare server-name alias (tools/mcp_tool_registration.py), which a
# server named like a built-in toolset merges into that toolset's resolution.
servers = json.loads(sys.argv[2])
for server, tool in servers:
    registry.register(name=tool, toolset="mcp-" + server, handler=lambda *a, **k: "{}",
                      schema={"name": tool, "description": "fictional broker", "parameters": {"type": "object", "properties": {}}})
    registry.register_toolset_alias(server, "mcp-" + server)
mounted = acp_session._expand_acp_enabled_toolsets(enabled, mcp_server_names=[server for server, _ in servers])
out["mounted"] = names(mounted, disabled)
class Parent: pass
parent = Parent(); parent.enabled_toolsets = mounted; parent.disabled_toolsets = disabled
out["children"] = {}
for label, ask in {"inherit": None, "ask": ["browser", "connections", "kanban", "cronjob", "computer_use", "image_gen", "tts", "setup", "web", "terminal"]}.items():
    child_enabled, child_disabled = _resolve_child_toolsets(parent, ask, "leaf")
    out["children"][label] = names(child_enabled, child_disabled)
try:
    from agent.credential_sources import adopt_external_logins_enabled
    out["adopt_external_logins"] = adopt_external_logins_enabled()
except ImportError:
    out["adopt_external_logins"] = None
# A 1Password and a Bitwarden CLI are on PATH and the office switched both on.
try:
    from agent.vault_backends.base import is_enabled, is_installed
    out["vaults"] = {n: {"installed": is_installed(n), "enabled": is_enabled(n)} for n in ("onepassword", "bitwarden")}
except ImportError:
    out["vaults"] = None
from agent.agent_init import _normalize_run_budget_seconds
from agent import background_review
out["run_budget_seconds"] = _normalize_run_budget_seconds((config.get("agent") or {}).get("run_budget_seconds"))
out["review_input_budget"] = background_review._review_input_token_budget(background_review._task_block(config))
print("PROBE " + json.dumps(out))
`;

type Probe = { enabled: string[]; parent: string[]; mounted: string[]; children: { inherit: string[]; ask: string[] }; adopt_external_logins: boolean | null;
  vaults: Record<"onepassword" | "bitwarden", { installed: boolean; enabled: boolean }> | null; run_budget_seconds: number | null; review_input_budget: number | null };

const scratch = mkdtempSync(join(tmpdir(), "realbud-acp-tools-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function probe(tree: string): Probe {
  const home = join(scratch, "home"), bin = join(scratch, "bin");
  mkdirSync(home, { recursive: true }); mkdirSync(bin, { recursive: true });
  // An office that asked Ask for Hermes' browser and connectors and configured an MCP server.
  const office = "mcp_servers:\n  fictional-office:\n    command: /synthetic/bin/false\nplatform_toolsets:\n  acp: [hermes-acp, connections, browser]\nagent:\n  disabled_toolsets: []\nvault:\n  onepassword:\n    enabled: true\n  bitwarden:\n    enabled: true\n";
  writeFileSync(join(home, "config.yaml"), mergePropertyPolicy(office, readFileSync(join(PACK_DIR, "config.yaml"), "utf8")));
  for (const name of ["agent-browser", "chromium", "google-chrome", "uvx", "npx", "lightpanda", "op", "bw"]) {
    writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n"); chmodSync(join(bin, name), 0o755);
  }
  const env = {
    PATH: `${bin}:/usr/bin:/bin`, HOME: join(scratch, "user"), HERMES_HOME: home,
    OPENAI_API_KEY: "fictional", COMPOSIO_API_KEY: "fictional", BROWSERBASE_API_KEY: "fictional", BROWSERBASE_PROJECT_ID: "fictional",
    BROWSER_USE_API_KEY: "fictional", CAMOFOX_URL: "http://127.0.0.1:9", BROWSER_CDP_URL: "http://127.0.0.1:9",
    AGENT_BROWSER_EXECUTABLE_PATH: join(bin, "chromium"), FAL_KEY: "fictional", ELEVENLABS_API_KEY: "fictional",
    HASS_TOKEN: "fictional", HASS_URL: "http://127.0.0.1:9", XAI_API_KEY: "fictional",
    // Read the trees, never write bytecode into them.
    PYTHONDONTWRITEBYTECODE: "1",
  };
  const stdout = execFileSync(python!, ["-c", PROBE, tree, JSON.stringify(MOUNTED)], { env, encoding: "utf8", timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
  const line = stdout.split("\n").find(text => text.startsWith("PROBE "));
  if (!line) throw new Error("probe printed no result");
  return JSON.parse(line.slice(6)) as Probe;
}

const excluded = (tool: string) => /^(?:browser_|kanban_)/.test(tool) ||
  ["browser_exec", "cronjob_manage", "computer_use", "image_generate", "text_to_speech", "manage_connections", "manage_catalog"].includes(tool);
/** Every broker RealBud mounts over ACP, under its real server name, with Hermes'
 * `mcp__<server>__<tool>` name (tools/mcp_tool_schema.py `mcp_prefixed_tool_name`). */
const MOUNTED: Array<[string, string]> = [
  [BROWSER_SERVER, "browser_tabs"], ["connected-apps", "execute"], ["memory-proposals", "memory_propose"], [WEB_RESEARCH_SERVER, "read_page"],
  [SIGN_IN_SERVER, "open_for_sign_in"], [REMINDERS_SERVER, "set_reminder"], [WORKSPACE_VIEWS_SERVER, "views_list"],
  [WORKFLOW_SETTINGS_SERVER, "workflow_settings_read"], [BANK_SOURCE_SERVER, "bank_accounts_list"], [MCP_CONNECTORS_SERVER, "list"], [HERMIOS_CRM_SERVER, "crm_search"],
].map(([server, tool]) => [server, `mcp__${server.replace(/[^A-Za-z0-9_]/g, "_")}__${tool}`]);
const brokers = MOUNTED.map(([, tool]) => tool);
const today = ["delegate_task", "execute_code", "memory", "patch", "process_manage", "read_file", "search_files", "session_search",
  "skill_manage", "skill_view", "skills_list", "terminal", "todo_list", "web_extract", "web_search", "write_file"];

// Ungated: pinned Hermes merges a server named like a built-in toolset into that
// toolset, so a disabled name would strip the broker's every tool from Ask.
it("mounts no broker under a toolset name the pack disables", () => {
  for (const [server] of MOUNTED) expect(WORKER_DISABLED_TOOLSETS as readonly string[]).not.toContain(server);
});

describe.runIf(Boolean(python && candidate) && process.platform !== "win32")("Ask's effective tools on Hermes 0.21.5", () => {
  let result: Probe;
  it("resolves the pack's selection, not the office's or configured MCP", () => {
    result = probe(candidate!);
    expect(result.enabled.some(name => name.startsWith("mcp-"))).toBe(false);
    expect(result.enabled).not.toContain("browser");
    expect(result.enabled).not.toContain("connections");
  });
  it("gives the parent today's tools and none of the excluded ones", () => {
    expect(result.parent).toEqual(today);
    expect(result.parent.filter(excluded)).toEqual([]);
  });
  it("keeps RealBud's mounted brokers", () => {
    expect(result.mounted).toEqual([...today, ...brokers].sort());
  });
  it("gives a subagent no excluded tool, even one it asks for, and never memory or delegation", () => {
    for (const tools of [result.children.inherit, result.children.ask]) {
      expect(tools.filter(excluded)).toEqual([]);
      expect(tools).not.toContain("delegate_task");
      expect(tools).not.toContain("memory");
    }
    expect(result.children.inherit).toEqual(expect.arrayContaining(brokers));
  });
  it("refuses to borrow a Codex or Claude Code login", () => {
    expect(result.adopt_external_logins).toBe(false);
  });
  it("turns off a detected password manager, and reads the turn budget and review cap", () => {
    expect(result.vaults).toEqual({ onepassword: { installed: true, enabled: false }, bitwarden: { installed: true, enabled: false } });
    expect(result.run_budget_seconds).toBe(840);
    expect(result.review_input_budget).toBe(120000);
  });
  it.runIf(Boolean(current))("matches 0.21.3's Ask tools apart from the Hermes browser 0.21.3 still advertises", () => {
    const older = probe(current!);
    expect(older.parent.filter(tool => !tool.startsWith("browser_"))).toEqual(result.parent);
    expect(older.adopt_external_logins).toBeNull();
    expect(older.vaults).toEqual(result.vaults);
    expect(older.run_budget_seconds).toBe(840);
    expect(older.review_input_budget).toBe(120000);
  });
});
