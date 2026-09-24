#!/usr/bin/env node
// Hermes browser boundary: Ask (ACP toolset hermes-acp) and its delegated
// subagents must be offered no Hermes browser_* or browser_vault_* tool, with
// browser dependencies present. Runs the admitted runtime's own tool
// selection (model_tools.get_tool_definitions, delegate_tool_toolsets) against
// a throwaway profile written by RealBud's applyPropertyPack and the worker
// environment from hardenHermesChildEnv. Rerun after every Hermes upgrade.
//
//   REALBUD_TEST_HERMES_RUNTIME=<runtime>/hermes-agent node scripts/testing/hermes-browser-boundary.mjs
//
// Read-only against the runtime (python -B, no install, no network, no model).
// Every profile, home and dependency here is a temporary fictional fixture;
// no real ~/.realbud or ~/.hermes data is read. Exit 1 when a checked scenario
// offers a browser tool, or when the positive control sees none (a probe that
// cannot see browser tools proves nothing).
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const runtime = process.env.REALBUD_TEST_HERMES_RUNTIME?.trim();
if (!runtime) { console.error('Set REALBUD_TEST_HERMES_RUNTIME to the admitted runtime\'s hermes-agent directory.'); process.exit(2); }
const python = join(resolve(runtime), 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
if (!existsSync(python)) { console.error(`No runtime Python at ${python}.`); process.exit(2); }

const temp = realpathSync(mkdtempSync(join(tmpdir(), 'realbud-browser-boundary-')));
const home = join(temp, 'home'), hermesRoot = join(temp, 'hermes'), deps = join(temp, 'deps');
// Nothing the server modules read at import may point at a real home.
Object.assign(process.env, { HOME: home, USERPROFILE: home, REALBUD_DATA_DIR: join(temp, 'data'), REALBUD_HERMES_HOME: hermesRoot });
delete process.env.HERMES_HOME;

const PROBE = String.raw`
import json, sys
sys.path.insert(0, sys.argv[1])
from types import SimpleNamespace
from model_tools import get_tool_definitions
from tools.delegate_tool_toolsets import _resolve_child_toolsets
from tools.browser_tool_install import check_browser_requirements
from tools.browser_vault_tool import _check_vault_available
from agent.delegation_context import delegated_child_context
from acp_adapter.session import _expand_acp_enabled_toolsets

def offered(enabled, disabled=None):
    defs = get_tool_definitions(enabled_toolsets=enabled, disabled_toolsets=disabled, quiet_mode=True) or []
    return sorted(n for n in (d["function"]["name"] for d in defs) if n.startswith("browser"))

acp = _expand_acp_enabled_toolsets(["hermes-acp"])
parent = SimpleNamespace(enabled_toolsets=acp, disabled_toolsets=None)
out = {"requirements": bool(check_browser_requirements()), "vault": bool(_check_vault_available()), "ask": offered(acp)}
with delegated_child_context():
    for role in ("leaf", "orchestrator"):
        for ask in (None, ["browser"]):
            enabled, disabled = _resolve_child_toolsets(parent, ask, role)
            out["child_" + role + ("_asking_browser" if ask else "")] = offered(enabled, disabled)
print("PROBE " + json.dumps(out))
`;

const exe = (path, body) => { writeFileSync(path, body); chmodSync(path, 0o755); };

try {
  for (const dir of [home, join(deps, 'bin'), join(deps, 'ms-playwright', 'chromium-1000')]) mkdirSync(dir, { recursive: true });
  exe(join(deps, 'bin', 'agent-browser'), '#!/bin/sh\necho 0.0.0-fictional\n');
  exe(join(deps, 'chromium'), '#!/bin/sh\nexit 0\n');
  writeFileSync(join(temp, 'probe.py'), PROBE);

  const { applyPropertyPack } = await import('../../server/hermes-pack.ts');
  const { hardenHermesChildEnv } = await import('../../server/drivers/acp/hermes.ts');
  const profile = join(hermesRoot, 'profiles', 'property');
  // An office that had pointed Hermes at a running browser, Camofox, Lightpanda
  // and its own signed-in profile before RealBud installed or repaired.
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  writeFileSync(join(profile, 'config.yaml'), 'browser:\n  cloud_provider: camofox\n  cdp_url: http://127.0.0.1:9\n  engine: lightpanda\n  use_real_profile: true\n', { mode: 0o600 });
  applyPropertyPack(hermesRoot);

  const basePath = process.platform === 'win32' ? process.env.PATH : '/usr/bin:/bin';
  const withDeps = {
    PATH: `${join(deps, 'bin')}${process.platform === 'win32' ? ';' : ':'}${basePath}`,
    AGENT_BROWSER_EXECUTABLE_PATH: join(deps, 'chromium'),
    PLAYWRIGHT_BROWSERS_PATH: join(deps, 'ms-playwright'),
    BROWSER_CDP_URL: 'http://127.0.0.1:9',
    CAMOFOX_URL: 'http://127.0.0.1:9',
  };
  const worker = extra => {
    const env = { HOME: home, USERPROFILE: home, REALBUD_HERMES_HOME: hermesRoot, SYSTEMROOT: process.env.SYSTEMROOT, ...extra };
    hardenHermesChildEnv(env);
    return env;
  };
  const probe = (label, env) => {
    // `hermes -p property` runs with the profile as its Hermes home.
    const run = spawnSync(python, ['-B', join(temp, 'probe.py'), resolve(runtime)], {
      cwd: resolve(runtime), env: { ...Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)), HERMES_HOME: profile },
      encoding: 'utf8', timeout: 120_000,
    });
    const line = run.stdout?.split('\n').find(l => l.startsWith('PROBE '));
    if (!line) throw new Error(`${label}: probe failed (${run.status}): ${(run.stderr || '').slice(-600)}`);
    const result = JSON.parse(line.slice(6));
    const tools = [...new Set(Object.entries(result).filter(([, v]) => Array.isArray(v)).flatMap(([, v]) => v))].sort();
    return { label, ...result, offeredAnywhere: tools };
  };

  const scenarios = [
    // Worker env as RealBud builds it, office browser config repaired, every
    // env-level dependency present (agent-browser on PATH, Chromium named by
    // AGENT_BROWSER_EXECUTABLE_PATH and PLAYWRIGHT_BROWSERS_PATH, CDP, Camofox).
    { ...probe('worker', worker(withDeps)), expect: 'none' },
    // Positive control: the same dependencies without RealBud's env hardening.
    { ...probe('control-unhardened-env', { HOME: home, SYSTEMROOT: process.env.SYSTEMROOT, ...withDeps }), expect: 'some' },
  ];
  // Residual, reported not gated: agent-browser/npx in a system directory and
  // a Playwright Chromium under the person's own home are machine state that
  // no Hermes 0.21.3 setting or worker variable hides from ACP. RealBud's ACP
  // driver stops the parent turn on a native browser call; delegated children
  // are not visible to it.
  mkdirSync(join(home, process.platform === 'darwin' ? 'Library/Caches' : '.cache', 'ms-playwright', 'chromium-1000'), { recursive: true });
  scenarios.push({ ...probe('residual-machine-chromium', worker({ PATH: withDeps.PATH })), expect: 'report' });

  const failures = scenarios.filter(s => (s.expect === 'none' && s.offeredAnywhere.length) || (s.expect === 'some' && !s.offeredAnywhere.length));
  console.log(JSON.stringify({ runtime: resolve(runtime), scenarios, ok: failures.length === 0 }, null, 1));
  for (const s of scenarios) console.log(`${s.expect === 'report' ? 'REPORT' : failures.includes(s) ? 'FAIL' : 'PASS'} ${s.label}: ${s.offeredAnywhere.length} browser tools offered${s.offeredAnywhere.length ? ` (${s.offeredAnywhere.join(', ')})` : ''}`);
  process.exitCode = failures.length ? 1 : 0;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
