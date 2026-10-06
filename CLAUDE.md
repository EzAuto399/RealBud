# RealBud

Our OpenMausBot fork. Product name is **RealBud**. Never ship as PropertyMe (PMS trademark), Hermes or OpenMausBot. Every line here should change what you do; if it doesn't, delete it.

## Product

- Direction (owner, 2026-09-21): `docs/decisions/2026-09-21-business-os-and-austin-workflows.md`. RealBud is a standalone, extensible business work OS; Austin Realty is the first workflow pack. That supersedes the earlier PM-only scope and fixed screens. Keep core permissions, source truth and recovery while integrating the three Austin workflows.
- Proof and open gates: `docs/BUSINESS-DESKTOP-2026-09-21.md`. `docs/NEXT-WAVE.md` and `docs/PM-DAY.md` are older PM references, not scope limits. Source-account access and live portal actions still need the customer's authority.
- UI direction (owner, 2026-10-05, supersedes 2 Oct): full desktop shell with calm defaults: icon rail (Desk / Work / Schedule, Workspace at the foot; internal key stays `you`, every `#you-*` link keeps working), a context sidebar, tabs across main, main content, a right context panel (Evidence, Approvals waiting and Today on by default) and a slim bottom status bar. Staff choose what shows through Show/Hide and "Arrange Desk" with "Reset to recommended"; safety, approval and recovery cards can't be hidden. uiarc/animate-ui are copied in and ported to our tokens, with no new runtime packages. Decision: `docs/decisions/2026-10-05-desktop-shell-and-ui-components.md`. Bud can apply rule changes through approval cards (`server/workflow-settings-broker.ts`).
- Design: `DESIGN.md` + `docs/PRODUCT-DESIGN-PLAN.md`. Routines: `docs/ROUTINES.md`. Identity: `docs/IDENTITY.md`. Workflow: `docs/WORKFLOW-PLAN.md`. Resume prompt: `docs/GOAL-PROMPT.md`. Data lives in `~/.realbud`; never point a dev or QA run at it.
- Desk (`server/desk.ts`, `/api/desk`) owns the book: add/edit/remove properties (`POST/DELETE /api/desk/properties`), per-property options and hands facts; `never` rules are locked. First run lands on Desk; engines stay out of onboarding.
- Schedule = named loops on the RealBud clock (`server/routines.ts`, `/api/loops`): morning-arrears and owner-letter are built; inbound-triage ("Morning priorities") is available but off until an office enables it. A loop is never a bot turn, a prompt or a second agent: no prompt-runner, no MAUS roster, no Hermes cron UI (`cron_mode: deny` stays).

## Hard boundaries

- RealBud owns the visible window. The pinned Hermes profile `property` is headless only (`pack/property/`, `server/hermes-pack.ts`); models attach there. Never launch Hermes.app, never edit Hermes source, never register Claude/Codex/Grok (or dev subagents) as RealBud agents.
- Hermes pin and reviewed releases: `server/hermes-pin.ts`, `server/hermes-releases.ts`. Read current source; don't track upstream main or trust an old doc's version. Keep profile isolation. A fallback fixture is never evidence that real sources were checked.
- Upstream OpenMausBot: reuse reviewed harness and safety patterns only, with no agent roster or model shop. Customisation goes through scoped RealBud APIs and versioned definitions; legacy plugin routes are not an extension sandbox. Vendor credentials stay outside customer- and Hermes-controlled storage before anyone claims vendor-only custody.
- Browser work (`docs/decisions/2026-09-23-browser-task-authority.md`): Bud completes tasks in the person's selected signed-in session. The fence (`server/portal-fence.ts`, `server/browser-runtime.ts`, `docs/PORTAL-WORK.md`) enforces account scope, task permission, per-instance approval for pay/sign/send/notice showing the actual recipient, amount or content, and Stop on every route. Credentials never pass through Bud. Hermes' own browser and vault tools stay out of the worker.
- Dev work never touches live customer accounts, sends anything, deploys, or puts secrets in fixtures.

## Working in this tree

- Node 24 + pnpm (the shell default may be Node 22: use `~/.nvm/versions/node/v24.21.0/bin`). Commands:
  - `pnpm typecheck`; `pnpm exec tsc -p tsconfig.server.json` for server only
  - `pnpm test`; `pnpm exec vitest run <file>` for one file
  - `pnpm check:electron`
  - `pnpm qa` (typecheck + test + two-device gate + `scripts/qa-e2e.mjs`)
  - `website/` and `managed-gateway/` run `node --experimental-strip-types --test`
- The server runs under `--experimental-strip-types`, and tsc/vitest don't catch this: no TS parameter properties, enums, namespaces or `import =`.
- Renderer QA (`scripts/qa-*.mjs`, see `docs/QA-LIVE-DEBUG.md`) needs `PLAYWRIGHT_MODULE=/Users/yo-da/projects/hermios/node_modules/playwright/index.mjs` and `CHROME_EXECUTABLE="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"`. A script that serves the "Built React UI" reads `dist/`: build to scratch with `pnpm exec vite build --outDir <scratch>` and pass `REALBUD_UI_DIR`. Never overwrite the shared `dist/`.
- Postgres integration tests gate on `REALBUD_TEST_POSTGRES=1` (+ `REALBUD_TEST_POSTGRES_BIN`). A skipped or environment-gated test is never a pass.
- `.claude/rules/` holds path-scoped idioms (authority at the boundary, private storage, durable execution, copy rules, packaging). Read the matching rule before editing that area.
- **Shared checkout.** A long-running Codex app session and other Claude sessions edit and build here.
  - Before editing, run `find . -path ./node_modules -prune -o -path ./dist-server -prune -o -type f -mmin -60 -print` and stay off files touched in the last hour unless the task needs them. When it does, re-read right before writing.
  - Never revert, reformat, stash or `git add -A` others' work. Never commit or push unless asked.
  - No package builds or Postgres suites while another build runs.
  - Coordinate with peer Claude sessions through `SendMessage` and name the files you own.
- **Evidence tiers**, named in every report: source → local tests → packaged build → installed device → live integration → customer acceptance. Fixtures, fictional providers and unsigned packages are never customer proof. Receipts go to `outputs/<topic>-<date>/`. Checkpoints go to `docs/<TOPIC>-<YYYY-MM-DD>.md`, linked from `docs/GOAL-PROMPT.md` and `docs/END-STATE.md`.

## How we work

1. **Plan first, then move.** For multi-step work, state in 2–3 sentences what you think the owner is after and the plan, then proceed. The owner prefers momentum. Stop and ask only when scope is genuinely ambiguous or a step is irreversible or outward-facing. Each step gets the check that will prove it. Two failed tries on one step: stop, write down what failed, re-plan. If pausing mid-task, leave a checkpoint a fresh session can resume from.
2. **Smallest change that works.** Understand first: read the code the change touches and trace the real flow. Then stop at the first rung that holds:
   1. Does this need to exist?
   2. Does it already exist in this repo?
   3. Does the stdlib do it?
   4. Does a platform feature do it?
   5. Does an installed dependency do it?
   6. Can it be one line?
   7. Only then, write the minimum.

   No unrequested dependencies, renames, refactors or abstractions. Deletion over addition, boring over clever. Never cut trust-boundary validation, authority checks, data-loss handling, recovery paths or accessibility. Weigh UX (users), DX (the next dev) and AX (the next agent). Look at a target before deleting or overwriting it.
3. **Own the bug.** Reproduce it first; if you can't, say what you need. Fix the root cause: grep every caller and fix the shared function once. Then rerun the same reproduction. Never silence an error to make it go away.
4. **Verify before saying done.**
   - Run the tests and read the output yourself.
   - For UI, open it and try to break it: empty input, double submit, refresh, keyboard only, 390px width.
   - A check you didn't run is not a pass. Say so.
   - Report in a few lines: what you picked, what you gave up and why, plus the evidence tier.
5. **Lessons.** When the owner corrects you, add one line under Lessons: "When X, do Y". If the same mistake happens twice, the lesson is unclear: rewrite it. Ask before changing anything above Lessons unless the owner asked for the edit.

## Models and delegation (Claude 5.5 series)

- The interactive session (Opus 5.5 or Fable 5.1) spends itself on scope, integration, judgment and final verification. Bounded work is delegated.
- **Opus 5.5 subagents** (`model: "opus"`, also the default via `CLAUDE_CODE_SUBAGENT_MODEL=opus` in `.claude/settings.json`) do surveys, implementations and reviews. Project agents in `.claude/agents/`: `repo-surveyor` (reads), `implementer` (edits an explicit file list), `test-runner` (runs and reports, never edits), `reviewer` (reports, never edits).
- **Sonnet 5.5** (`model: "sonnet"`) handles mechanical sweeps. Pass `model: "fable"` only when a packet truly needs it.
- **Astra 6 Ultra** = Codex `gpt-6-astra` at `ultra` effort. The owner wants it used to save Claude usage on independent design or code review and on grunt work (QA selector updates, copy sweeps): `codex exec -m gpt-6-astra -c model_reasoning_effort=ultra -s read-only|workspace-write --skip-git-repo-check -o <out.md> - < prompt.md` (`-i` attaches screenshots). Its sandbox can't bind ports or launch a browser, so run the QA scripts yourself.
- **Every packet** gets one job, a file-ownership list, a done condition and a short report format. Run independent packets in parallel and in the background, and never poll. Never put two writers on one file. A report is evidence to verify, not a claim to relay: rerun the decisive check before telling the owner.
- Subagents inherit every boundary here. They are dev tooling only.

## Skills

Use a skill when it fits the request:
- `code-review` / `simplify`: diff review / cleanup
- `security-review`: auth, input, secrets, payments
- `run`: launch the app and look
- `gsd:debug`: stubborn bugs with persistent state
- `claude-code-setup:claude-automation-recommender`: hooks, skills and agents worth adding
- `windows-release`: Windows builds
- `ponytail`: the minimal-diff ladder above (plugin)

## Lessons
- When scripting build → install, gate the install on the build's success and on the new app's version string; never swap /Applications from a stale release/ folder.
<!-- Newest on top. "When X, do Y". Delete what no longer applies. -->
- When a Package Windows run for `main` is building an installer you need, merge nothing into `main` until it finishes; every push cancels the running build (`cancel-in-progress`). Batch the merges instead.
- When testing in a VM on this Mac, keep at least 30 GB free on the internal disk; a full host disk corrupted the Windows VM beyond repair (6 Oct).
- When changing `electron-builder.yml` files or extraResources, run `electron-builder --dir` locally and check the packaged `/api/health` version before merging; a regex test on the YAML once shipped a config that built no installer.
- When adding a UI control, click it in the running app and confirm it changes something visible (including on an empty book); remove decorative controls rather than ship no-ops.
- When moving UI controls, check 390px: below 600px only `.rb-sidebar-navigation` shows, so footer-only entries vanish on phones.
- When a QA script fails on copy or server behaviour another session changed, report it to that session; don't rewrite their fixture expectations.
- When the owner says "simpler", relocate rarely-used controls into one collapsed place; remove duplicate surfaces, not capabilities.
