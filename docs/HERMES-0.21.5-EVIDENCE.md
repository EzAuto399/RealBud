# Hermes 0.21.5 qualification — evidence

Date: 2026-10-02. Status: **recommended** (owner decision, 2026-10-02):
`HERMES_RECOMMENDED_VERSION` is `0.21.5`; 0.21.3 (and 0.21.2) stay installable and
compatible as rollback. Three gates remain open (live contract, packaged upgrade, Windows);
see "Remaining gates".

Source review: `docs/HERMES-0.21.5-ADOPTION-REVIEW-2026-10-02.md`.
Receipts: `outputs/hermes-0.21.5-qualification-2026-10-02/` (`receipt.json`, per-release logs,
the staging driver and the QA runner).

Evidence tier reached: **source → local tests → staged runtime (local, macOS arm64)**.
No packaged build, installed device, live model or customer evidence.

## Identity

| | |
|---|---|
| Tag | `v2026.9.24` |
| Tag object | `e3dd27ee2d8b011737a4eea8e3eb3d711ab78690` |
| **Tag commit** (peeled `^{}`) | `f97608f178d1ffeca59860195ab7da295f7c8e5f` |
| `install.sh` | `2017ddf0cc7bc6cfb70d40dc9fba1d916f47dbcccf5fe73bdee2cf93a11262af` |
| `install.ps1` | `0a80dfeb7434229933bac32e73140d10086dff81bd84b156e71be9abc87cddf2` |

Resolved with `git ls-remote https://github.com/NousResearch/hermes-agent refs/tags/v2026.9.24*`.
The review's `f97608f1…` is the commit; `e3dd27ee` is the annotated tag object and must not
be used as a commit. Installer digests come from
`raw.githubusercontent.com/NousResearch/hermes-agent/<commit>/scripts/<file>` (the 0.21.3
method) and reproduce the review's local-blob hashes exactly. Both scripts changed since 0.21.3.

Catalog: `server/hermes-releases.ts` (installable, recommended) and `server/hermes-pin.ts`
`HERMES_COMPATIBLE_RELEASES` (`0.21.5` / `2026.9.24`). Tests pin the commit, both digests,
the exact product/calendar pair, that a fresh install and the default bootstrap plan now
take 0.21.5, and that 0.21.3 stays installable as rollback.

## What was run

Each release was staged into its own scratch `HOME`, `REALBUD_DATA_DIR` and
`REALBUD_HERMES_HOME` through `startRuntimeUpdate({ home, release, firstInstall: true })`:
sha256-checked installer, reviewed stages only, fresh candidate directory, then
`verifyRuntime`. `hermes update` was never used. The real `~/.realbud` and the installed
RealBud were not touched. 0.21.3 was staged the same way as the control.

| Check | 0.21.5 | 0.21.3 (control) |
|---|---|---|
| Stage via `startRuntimeUpdate` | pass, 217 s | pass, 204 s |
| `verifyRuntime` (HEAD = tag commit, clean tree, ACP start) | pass, `f97608f1` | pass, `345cd2b0` |
| Document tools import check | ready | ready |
| `--version` | `v0.21.5 (2026.9.24)` | `v0.21.3 (2026.9.14)` |
| `qa:acp-smoke` | pass, protocolVersion 1, authMethods `[hermes-setup]` | pass, same |
| `qa-hermes-mcp-isolation --cli --install-root` | pass: configured MCP contacted 0 times, explicit broker initialize + tools/list, 5 inert metadata GETs, no inference | pass, same |
| same, `--memory-proposals` | pass: proposal-only broker discovered, no approval tool | pass, same |
| `qa:hermes-contract` | **fail** at `real provider must answer OK` | **fail**, same point |

This is the **first recorded tag-exact ACP smoke for 0.21.3** as well; the 0.21.3 promotion
(c9d43db) had none.

No QA script needed a new flag: `qa-acp-smoke` takes the command, `qa-hermes-mcp-isolation`
already has `--cli`/`--install-root`, and `qa-hermes-contract` resolves the worker from
`REALBUD_HERMES_HOME`. `qa-hermes-mcp-isolation` requires Node 24; a first pass under the
default Node 22 was refused by its own guard and was rerun under 24.21.0.

## What failed, and what it means

`qa-hermes-contract` is a live-provider canary. In a scratch home there is no model
provider, and no credentials were supplied, so it stops at its ping on both releases
after the earlier assertions (supported release, workroom ready) passed. It is a
**blocked** check, not evidence about 0.21.5 behaviour: turns, warm follow-up, fresh-process
replay, approvals and file tools were **not** exercised. Running it needs a qualification
home with a managed (non-customer) model route.

## Promotion (2026-10-02)

Owner decision: 0.21.5 is the recommended release for every new install and update.
Changed: `HERMES_RECOMMENDED_VERSION = "0.21.5"` (`server/hermes-releases.ts`), catalog and
compatibility comments (`server/hermes-pin.ts`), `scripts/stage-hermes-candidate.ts` TARGET, and
the tests (`hermes-release-admission`, `hermes-update`: the staged non-recommended candidate is
now 0.21.3). The bundled skill set was diffed against `f97608f1`: the same 58 names as 0.21.3,
so `OFF_SCOPE_BUNDLED_SKILLS` needed no review beyond the reopening below.
Not claimed: the managed-model wire proof (`server/managed-model-wire.native.test.ts`) was run
against 0.21.3 only and must be re-run on 0.21.5 (comment in `server/hermes-pack.ts`).

## Bundled `powerpoint` skill reopened (2026-10-02)

`skills/productivity/powerpoint/SKILL.md` at `f97608f1`: create, read and edit local .pptx files
with python-pptx; offline, no account, no network. Third-party imports in its scripts: `pptx`
and `lxml` (already locked). The optional `pptx_render.py` shells out to a local `soffice`
and `pdftoppm` only when already installed and otherwise reports `rendered: false`.

- `server/hermes-pack.ts`: moved from `OFF_SCOPE_BUNDLED_SKILLS` to
  `PREVIOUSLY_OFF_SCOPE_BUNDLED_SKILLS`: 47 hidden + 7 reopened + hermes-agent, pdf, xlsx, docx = 58.
  Repair removes it from an existing `skills.disabled`; office-hidden names stay hidden.
- `server/hermes-document-deps.lock.json` (PyPI JSON API): `python-pptx 1.0.2` (MIT,
  `python_pptx-1.0.2-py3-none-any.whl`, sha256 `160838e0…5cba`) and its hard dependency
  `xlsxwriter 3.2.9` (BSD-2-Clause, `xlsxwriter-3.2.9-py3-none-any.whl`, sha256 `9a5db42b…ec5b3`).
  XlsxWriter is needed: `pptx.chart.data` imports it, and the skill's `pptx_create.py` imports
  that module. Both are pure wheels (`any`), so every locked target (macOS arm64/x86_64, Windows
  amd64, cp311–cp313) is covered. Other python-pptx dependencies are already present: lxml
  (locked), Pillow and typing-extensions (runtime-provided). No copyleft.
- Readiness: the lock's `import` field is the live import check, so `documentTools` now also
  requires `import pptx` and `import xlsxwriter`.
- Proof (scratch uv venv, CPython 3.11.15, darwin-arm64, runtime-provided packages added with uv,
  deleted afterwards): `ensureDocumentDeps` → `ready, installed: true, darwin-arm64-cp311`;
  second call `installed: false`; `documentToolsStatus` ready. The skill's own `pptx_create.py`
  wrote a 2-slide deck with bullets, notes and a bar chart, and `pptx_read.py --outline` read it
  back (slide count, texts, chart categories/values, notes); a direct python-pptx save/read round
  trip also passed. Not run: cp312/cp313, Intel Mac, Windows, and the packaged runtime.

## Remaining gates

Done: staged runtime and ACP smoke (above); **1. memory admission**
(`server/hermes-memory-review.ts` admits the 0.21.5 commit as
`MEMORY_REVIEW_CANDIDATE_RUNTIME`, with `matched_entry` on destructive proposals);
2. ACP toolsets (`server/hermes-pack.ts`); 3. config migrations (below).

Open:

1. **Live ACP contract after install**: `qa:hermes-contract` with a managed (non-customer)
   model route; approval expiry (300 s vs 900 s card), terminal `tool_call_update` events,
   cancellation; plus re-running the managed-model wire proof on 0.21.5.
2. **Packaged upgrade**: fresh install, 0.21.3 → 0.21.5 in place, interrupted setup, restart,
   rollback to 0.21.3.
3. **Windows**: installer, cold ACP session, cancellation, profile isolation, document tools
   (including python-pptx); memory review stays blocked.

## Config migrations (gate 3, 2026-10-02)

`server/hermes-0215-migration.native.test.ts` runs Hermes' own `migrate_config(interactive=False,
quiet=True)` (`hermes_cli/config.py`, steps in `hermes_cli/config_migrations.py`) from the
v2026.9.24 tree (`f97608f1`) on property profiles written by RealBud's `applyPropertyPack` into
private real-path temp dirs, then Repair (`applyPropertyPack` again), then reads the result with
the v2026.9.14 tree (`345cd2b0`). The office carries its own model choice (Sonnet `xhigh`),
memory limit, a hidden skill, a `platform_toolsets.cli` list and an MCP server marked with the old
editor's `disabled: true`. Python 3.11 (uv venv with Hermes' dependencies), Node 24.21.0.

| Profile | 45 (connections) | 46 (MCP `disabled`) | Workroom ready after migration | After Repair |
|---|---|---|---|---|
| Today's pack, unstamped | not run (unversioned files get only legacy steps) | `enabled: false` | **yes**, no Repair needed | ready, stamp 46 kept |
| Today's pack, stamped 44 | skipped: `agent.disabled_toolsets` names `connections` | `enabled: false` | **yes**, no Repair needed | ready, stamp 46 kept |
| 0.21.3-era pack, unstamped | not run | `enabled: false` | no (was already no: pre-0.21.5 policy) | ready |
| 0.21.3-era pack, stamped 44 | **appends `connections`** to the office's `acp` and `cli` lists | `enabled: false` | no (as before) | ready; ACP list replaced, `disabled_toolsets` subtracts `connections` from `cli` |

"0.21.3-era pack" is today's output with `agent.disabled_toolsets` removed and an office-saved
`platform_toolsets.acp: [web, terminal, file, browser]`. Every case ends at `_config_version: 46`.

- **ACP tools:** on every migrated profile, ready or repaired, Hermes resolves Ask's toolsets
  without `connections`, `browser` or any `mcp-*`, and the parent's tools equal today's 16.
  `server/hermes-pack.acp-tools.test.ts` rerun on both trees: 7/7 pass.
- **Office settings:** model, effort, memory limit, hidden skill, `cli` list and the MCP server
  (now `enabled: false`, `disabled` gone) survive migration and Repair; approvals stay `manual`.
- **Rollback:** 0.21.3 reads the stamped-46 profile (`check_config_version` = 46 / 44), its
  `migrate_config` leaves the bytes unchanged (no refusal, no downgrade), and the profile stays
  workroom-ready.
- **Advisory warning:** Hermes' `validate_platform_toolsets` reports `no_mcp` in
  `platform_toolsets.acp` as an unknown toolset, though `_get_platform_tools` honours it. No config
  change; it shows in `hermes config migrate`/`doctor` output only.
- **No pack change needed.** Readiness already catches the one harmful case (stamped 0.21.3-era
  profile), and `worker-auto-setup.ts` `policyStale` routes it to Repair (not re-verified end to end here).

Run (10/10 pass; skipped without the env vars, 10 skipped):
`REALBUD_TEST_HERMES_PYTHON=<venv>/bin/python REALBUD_TEST_HERMES_0215_TREE=<f97608f1 tree>
REALBUD_TEST_HERMES_0213_TREE=<345cd2b0 tree> pnpm exec vitest run server/hermes-0215-migration.native.test.ts`.
Evidence tier: source → local tests against upstream source trees. Not exercised: Hermes itself
triggering a migration in the packaged runtime (`hermes update`, `doctor`, profile copy and the
console run `migrate_config`; RealBud's ACP launch does not), and the real 0.21.3 → 0.21.5 upgrade.
